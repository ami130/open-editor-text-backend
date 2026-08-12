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
import { Controller, Post, Body, Query, Req, HttpCode, Optional } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators';
import { loadThrottleConfig } from '../config/throttle.config';
import { DeliverySessionService } from './session.service';
import { EngineVersionService } from '../licensing/engine-version.service';
import { SessionRequestDto, RefreshSessionDto } from './dto/session.dto';
import { recordSessionUsage } from './usage-log';
import { RefreshLogService } from '../portal/refresh-log.service';
import { SharingDetectorService } from '../portal/sharing-detector.service';

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
  ) {}

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

    const { session, refusal } = await this.sessions.open(
      {
        licenceKey: dto.licenceKey ?? null,
        installId: dto.installId ?? null,
        version: dto.version ?? null,
        origin,
      },
      defaults,
    );

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
