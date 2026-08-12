/**
 * session.controller.ts — POST /delivery/session (execution plan §1.3).
 *
 * ─── This is the most exposed surface in the architecture (T20) ─────────────
 * It is a POST, so it is NEVER CDN-cached: every anonymous request from every
 * end-user of every customer reaches origin. B2's "the CDN absorbs abuse" is
 * true of the *engine* endpoint, not this one.
 *
 * Layered defence, in order of usefulness:
 *   1. per-install-ID limits  — the most meaningful signal for anonymous callers
 *   2. per-Origin limits      — a browser sends Origin automatically; unusual
 *                               volume from one domain is real signal
 *   3. per-IP limits          — blunt and easily bypassed; a floor, not a wall
 *   4. cheap by design        — stateless (T17), no DB write per anonymous
 *                               session. The best protection is that abuse
 *                               costs us almost nothing to serve
 *
 * ─── Never an oracle ────────────────────────────────────────────────────────
 * A bad, revoked, expired, or origin-blocked key returns the SAME shape as an
 * anonymous free session: HTTP 200 with the free plan. The caller cannot
 * distinguish "not a real key" from "revoked" from "wrong domain", so this
 * endpoint cannot be used to probe key validity. The reason is logged
 * server-side only. Same posture as the existing portal refresh endpoint.
 *
 * ─── Never a dead end ───────────────────────────────────────────────────────
 * A customer whose subscription lapsed mid-session gets a working FREE editor,
 * not a blank page or an error. Downgrade, never break.
 */
import { Controller, Post, Get, Body, Query, Req, Res, HttpCode, Optional } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators';
import { loadThrottleConfig } from '../config/throttle.config';
import { DeliverySessionService } from './session.service';
import { EngineVersionService } from '../licensing/engine-version.service';
import { SessionRequestDto, RefreshSessionDto } from './dto/session.dto';
import { recordSessionUsage } from './usage-log';
import { RefreshLogService } from '../portal/refresh-log.service';
import { SharingDetectorService } from '../portal/sharing-detector.service';
import { LicenseActivationService } from './license-activation.service';
import { EntitlementEventsService } from './entitlement-events.service';

const T = loadThrottleConfig();

@Controller('delivery')
export class DeliverySessionController {
  constructor(
    private readonly sessions: DeliverySessionService,
    private readonly versions: EngineVersionService,
    // @Optional so DeliveryModule still resolves where PortalModule is absent
    // (a DB-less deployment). Anti-sharing is a detection layer, not a gate —
    // its absence must never stop a session being issued.
    @Optional() private readonly refreshLog?: RefreshLogService,
    @Optional() private readonly sharing?: SharingDetectorService,
    // §2.4 activation. @Optional for the same reason; a probe test asserts it
    // is actually injected rather than silently undefined.
    @Optional() private readonly activations?: LicenseActivationService,
    // §2.3 instant upgrade push.
    @Optional() private readonly events?: EntitlementEventsService,
  ) {}

  /**
   * GET /delivery/events — the §2.3 push channel (Server-Sent Events).
   *
   * An editor holds this open and re-checks /session the moment its
   * entitlement changes, instead of waiting up to 15 minutes for its timer.
   *
   * ⚠️ THE STREAM CARRIES NO CREDENTIALS. Every message is `{reason}` and
   * nothing more — "something changed, go ask /session again". A subscriber is
   * identified by a licId or installId, and NEITHER IS A SECRET (installIds are
   * written to our own logs). If this stream carried a key, anyone who learned
   * an id could listen and be handed a licence. Because it carries only a
   * nudge, an eavesdropper learns at most that something changed and must still
   * present the real credential to /session to get anything.
   *
   * SSE rather than WebSockets: one-way is all this needs, it survives proxies
   * that mangle upgrades, and the browser reconnects on its own — so a dropped
   * connection self-heals without any client logic.
   *
   * PUSH IS NEVER THE GUARANTEE. The engine's timed refresh remains
   * authoritative (§1.3 + D1); a missed event costs latency, never entitlement.
   */
  @Throttle({ default: { ttl: T.authTtlMs, limit: T.authLimit } })
  @Public()
  @Get('events')
  events_(
    @Query('lic') lic: string | undefined,
    @Query('installId') installId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    const channel = (lic || installId || '').trim();
    if (!this.events || !channel) {
      // Nothing to subscribe to → 204 rather than an error. The editor simply
      // keeps using its timer, which is the normal path anyway.
      res.status(204).end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and friends buffer streamed responses by default, which delays
      // or swallows events entirely. This is the documented opt-out.
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const send = (evt: { reason: string }) => {
      // Only the reason crosses the wire. See the warning above.
      res.write(`data: ${JSON.stringify({ reason: evt.reason })}\n\n`);
    };

    const unsubscribe = this.events.subscribe(channel, send);
    if (!unsubscribe) {
      // Cap reached — close cleanly so the client falls back to its timer.
      res.end();
      return;
    }

    // Comment-only heartbeat: keeps proxies and load balancers from reaping an
    // idle connection, and costs 2 bytes. Not an event, so clients ignore it.
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    // BOTH events: 'close' fires when the client goes away, 'error' on a broken
    // pipe. Missing either leaks a listener and an interval per dropped tab.
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  @Throttle({ default: { ttl: T.authTtlMs, limit: T.authLimit } })
  @Public()
  @Post('session')
  @HttpCode(200)
  async openSession(@Body() dto: SessionRequestDto, @Req() req: Request) {
    const origin = req.headers.origin ? String(req.headers.origin) : null;

    // Default pointers come from the engine_defaults table. A licence-level
    // channel would refine this; 'stable' is the right assumption before the
    // licence is resolved, and a licence pin/override wins over both anyway.
    // Unconfigured defaults resolve to null → the session fails closed rather
    // than guessing a version that may not exist.
    const defaults = await this.versions.defaultsFor('stable');

    /**
     * §2.4 ACTIVATION. A caller with NO key of their own may have just bought
     * premium from inside this very editor. If a pending activation matches
     * their install id, redeem it and continue as though they had presented the
     * key all along — so the upgrade lands on THIS page load, with no pasting.
     *
     * Only for keyless callers, deliberately: a caller who already sent a key
     * must never have it silently swapped for another.
     *
     * The claim is SINGLE-USE and expiring (see LicenseActivationService).
     * That is not optional hardening — install ids are written to the logs
     * below, so a standing "this id gets premium" mapping would make any log
     * reader a permanent free customer.
     */
    let activatedKey: string | null = null;
    if (!dto.licenceKey && dto.installId && this.activations) {
      const licId = await this.activations.claim(dto.installId, origin);
      if (licId) activatedKey = await this.sessions.keyForLicence(licId);
    }

    const { session, refusal } = await this.sessions.open(
      {
        licenceKey: dto.licenceKey ?? activatedKey ?? null,
        installId: dto.installId ?? null,
        version: dto.version ?? null,
        origin,
      },
      defaults,
    );

    // Hand the key over exactly once, so the loader can store it and stop
    // depending on the activation row. Only ever set on a successful claim.
    if (activatedKey && session.plan !== 'free') session.licenceKey = activatedKey;

    // `refusal` is deliberately NOT in the response — surfacing it would turn
    // this endpoint into a key-validation oracle. It exists for server-side
    // logging and alerting only.
    recordSessionUsage({
      installId: dto.installId ?? null,
      origin,
      plan: session.plan,
      version: session.version,
      licensed: !!dto.licenceKey,
      refusal: refusal ?? null,
    });

    return session;
  }

  /**
   * Re-mint a session token near expiry (D1).
   *
   * Session tokens live 15 minutes; anyone writing a real document outlives
   * that. The engine's own refresh scheduler calls this in the background, so
   * a long editing session never silently loses premium mid-sentence.
   *
   * RESPONSE SHAPE IS FIXED BY THE ENGINE: it posts `{ token }` and reads back
   * `{ refreshed, token }` (editor-license-refresh.js). Matching that contract
   * means no engine change is needed — the loader just points it here.
   *
   * Always 200 with a usable token: a stale or unverifiable refresh token
   * yields a fresh ANONYMOUS session rather than an error, so a lapsed
   * customer keeps a working free editor instead of a broken one.
   */
  @Throttle({ default: { ttl: T.authTtlMs, limit: T.authLimit } })
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refreshSession(
    @Body() dto: RefreshSessionDto,
    @Query('refreshToken') queryRefreshToken: string | undefined,
    @Req() req: Request,
  ) {
    const origin = req.headers.origin ? String(req.headers.origin) : null;
    const defaults = await this.versions.defaultsFor('stable');

    // Accepted from EITHER the body or the query string: the engine's refresh
    // scheduler posts only `{ token }`, so the loader passes the long-lived
    // credential on the URL it controls (E3). A body field is preferred where
    // the caller can set one.
    const fallback = dto.refreshToken ?? queryRefreshToken ?? null;

    const { session, refusal, licId } = await this.sessions.refresh(
      dto.token, origin, defaults, fallback,
    );

    // ─── ANTI-SHARING: log the REFRESH, never the session ───────────────────
    //
    // A licence used across many sites will refresh from each of them, so the
    // signal here is the same as logging every session — at roughly 1/1000th
    // the write volume. `/session` runs on every page load by every end-user;
    // a database row each would be exactly the traffic shape T17's stateless
    // design exists to avoid, on the most exposed endpoint in the architecture.
    // `/delivery/refresh` runs on a ~15-minute timer per open editor instead.
    //
    // Best-effort and awaited only for its side effect: a logging failure must
    // never turn a working refresh into a failed one.
    if (licId && this.refreshLog && this.sharing) {
      const ip = (req.ip || '').toString() || null;
      await this.refreshLog.record({
        // The portal's existing vocabulary, reused deliberately: one uniform
        // log means the detector needs no special case for delivery events.
        outcome: refusal ? 'refused' : 'refreshed', licId, ip, origin,
      }).catch(() => undefined);
      // SOFT by design: this sets a flag for a human to review and the licence
      // KEEPS WORKING. A CDN customer with many points of presence looks exactly
      // like sharing, and cutting off a payer is worse than the sharing itself.
      await this.sharing.evaluateAndFlag(licId).catch(() => undefined);
    }

    void refusal; // never surfaced in the response (no key-validation oracle)

    return {
      // The engine only applies the new token when `refreshed` is true.
      refreshed: true,
      token: session.sessionToken,
      expiresAt: session.expiresAt,
      // Returned so a caller that wants the full picture (plan/features/engine)
      // does not need a second round-trip. The engine ignores the extra fields.
      session,
    };
  }
}
