/**
 * auth.controller.ts — admin session endpoints.
 *   POST /auth/login    — credentials → access token (body) + refresh (cookie).
 *   POST /auth/refresh  — refresh cookie → new access token + rotated cookie.
 *   POST /auth/logout   — clears the cookie + bumps tokenVersion (revoke all).
 *   GET  /auth/me       — the current user's identity + permissions.
 *
 * The refresh token lives ONLY in an httpOnly cookie (JS can't read it → XSS
 * can't steal it). The access token is returned in the body for the SPA to hold
 * in memory and send as `Authorization: Bearer`.
 */
import { Controller, Post, Get, Body, Req, Res, Inject, ForbiddenException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { loadThrottleConfig } from '../config/throttle.config';

const T = loadThrottleConfig();
import { AUTH_CONFIG, AuthConfig } from '../config/auth.config';
import { LoginDto } from './dto/login.dto';
import { Public, CurrentUser } from './decorators';
import type { AccessClaims } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
  ) {}

  // Strict rate limit on credential + token endpoints (brute-force / spam).
  // The `auth` named bucket is much tighter than the global default; both apply,
  // so the stricter one bites first. (limits configured in throttle.config.ts)
  @Throttle({ default: { ttl: T.authTtlMs, limit: T.authLimit } })
  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const user = await this.auth.validateCredentials(dto.email, dto.password);
    const pair = await this.auth.issueTokens(user);
    this.setRefreshCookie(res, pair.refreshToken);
    return { accessToken: pair.accessToken, user: publicUser(user) };
  }

  @Throttle({ default: { ttl: T.authTtlMs, limit: T.authLimit } })
  @Public()
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // CSRF defense-in-depth: /auth/refresh authenticates purely on an ambient
    // cookie, so reject cross-origin callers by Origin allowlist (independent
    // of SameSite, which is bypassable if ever set to 'none'). (I3)
    this.assertTrustedOrigin(req);
    const token = req.cookies?.[this.cfg.refreshCookieName];
    const { pair, user } = await this.auth.refresh(String(token || ''));
    this.setRefreshCookie(res, pair.refreshToken);
    return { accessToken: pair.accessToken, user: publicUser(user) };
  }

  @Post('logout')
  async logout(@CurrentUser() claims: AccessClaims, @Res({ passthrough: true }) res: Response) {
    if (claims?.sub) await this.auth.bumpTokenVersion(claims.sub); // revoke all sessions
    res.clearCookie(this.cfg.refreshCookieName, this.cookieBase());
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() claims: AccessClaims) {
    return { id: claims.sub, email: claims.email, permissions: claims.perms };
  }

  /**
   * Authorize a refresh call. The refresh cookie is ambient, so this is the
   * CSRF gate. Two ways to pass:
   *   1. The trusted BFF (Next server) presents the shared BFF secret — the
   *      browser never makes this call directly, the BFF does, holding the
   *      refresh cookie inside its httpOnly session. This is the normal path.
   *   2. A browser call whose Origin is in the admin allowlist (direct-to-API
   *      deployments without a BFF).
   *
   * When a BFF secret IS configured, we REQUIRE one of the two (a missing Origin
   * with no secret is rejected — closes the "no Origin = allow" gap). When it is
   * NOT configured (dev), we fall back to the origin-allowlist behaviour and
   * rely on SameSite for the missing-Origin case.
   */
  private assertTrustedOrigin(req: Request): void {
    // (1) Trusted BFF via shared secret (constant-time compare).
    if (this.cfg.bffSecret) {
      const presented = String(req.headers['x-bff-secret'] || '');
      if (safeEqual(presented, this.cfg.bffSecret)) return;
    }

    const allow = this.cfg.adminOrigins;
    const origin = String(req.headers['origin'] || '').trim();

    if (!allow.length) {
      // Dev / no allowlist: rely on SameSite; allow (matches prior behaviour).
      return;
    }
    if (origin && allow.includes(origin)) return;
    // With an allowlist configured, a MISMATCHED origin is always rejected.
    // A MISSING origin is allowed ONLY when no BFF secret is enforced (a bare
    // browser same-origin call can omit Origin); if a BFF secret is configured,
    // the BFF must present it, so a missing Origin + missing secret is rejected.
    if (!origin && !this.cfg.bffSecret) return;
    throw new ForbiddenException('cross-origin refresh rejected');
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(this.cfg.refreshCookieName, token, {
      ...this.cookieBase(),
      maxAge: 7 * 24 * 3600 * 1000, // aligns with the refresh TTL default
    });
  }

  private cookieBase() {
    return {
      httpOnly: true,
      secure: this.cfg.cookieSecure,
      sameSite: this.cfg.cookieSameSite,
      path: '/auth', // cookie only sent to the auth routes
    };
  }
}

/** Never serialize the password hash. */
function publicUser(user: { id: string; email: string; name: string }): Record<string, unknown> {
  return { id: user.id, email: user.email, name: user.name };
}

/** Constant-time string compare (avoids leaking the secret via timing). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
