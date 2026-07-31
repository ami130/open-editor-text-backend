/**
 * refresh.controller.ts — the PUBLIC license refresh endpoint (Phase 4c).
 *
 *   POST /portal/refresh   { token }  →  { token, expiresAt }   (uniform 200)
 *                                     →  generic 200 { refreshed:false } on any refusal
 *
 * UNIFORM RESPONSES (anti-oracle): a bad/unknown/revoked/rate-limited/
 * origin-blocked request ALL return the SAME generic body + status. The caller
 * can never distinguish "not a real key" from "revoked" from "throttled" — the
 * endpoint is not a key-validation oracle. Only a genuine, eligible refresh
 * returns a token. Per-IP throttle (global) + per-key limiter (in the service)
 * + Origin match + IP/Origin logging all ship here, together.
 */
import { Controller, Post, Body, Req, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators';
import { loadThrottleConfig } from '../config/throttle.config';
import { RefreshService } from './refresh.service';
import { RefreshLogService } from './refresh-log.service';
import { SharingDetectorService } from './sharing-detector.service';
import { RefreshTokenDto } from './dto/refresh.dto';

const T = loadThrottleConfig();

@Controller('portal')
export class RefreshController {
  constructor(
    private readonly refresh: RefreshService,
    private readonly log: RefreshLogService,
    private readonly detector: SharingDetectorService,
  ) {}

  // Per-IP throttle (the `auth` bucket is tight). The per-KEY limit is enforced
  // inside RefreshService. Both apply; the stricter bites first.
  @Throttle({ default: { ttl: T.authTtlMs, limit: T.authLimit } })
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refreshToken(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    const origin = req.headers['origin'] ? String(req.headers['origin']) : null;
    const ip = req.ip || null;
    const result = await this.refresh.refresh(dto.token, origin);

    if (result.ok) {
      // Persist WITH the licId (5b fix — success used to log licId:null, breaking
      // per-key correlation for the anti-sharing detector).
      await this.log.record({ outcome: 'refreshed', licId: result.licId, ip, origin });
      // Anti-sharing check (5c): AFTER logging this event, evaluate the key's
      // recent spread and soft-flag if anomalous. Best-effort + fire-and-forget —
      // it must add neither latency nor a failure mode to the customer's refresh.
      void this.detector.evaluateAndFlag(result.licId).catch(() => undefined);
      return { refreshed: true, token: result.token, expiresAt: result.expiresAt };
    }
    // Log the REAL reason (server-side only) for Phase-5 anomaly detection, but
    // return a UNIFORM generic body regardless — the caller learns nothing
    // (term-ended looks identical to refused/rate-limited/origin-blocked).
    await this.log.record({ outcome: result.reason, licId: result.licId, ip, origin });
    return { refreshed: false };
  }
}
