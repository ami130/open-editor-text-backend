/**
 * portal-auth.controller.ts — passwordless auth for the self-serve customer
 * portal (Phase 4a).
 *
 *   POST /portal/request-link  (@Public)  → email a one-time magic link.
 *   POST /portal/verify        (@Public)  → consume the link, set a session cookie.
 *   GET  /portal/me            (customer) → who am I (for the web app).
 *   POST /portal/logout        (customer) → clear the session cookie.
 *
 * Routes are @Public() so the GLOBAL admin JwtAuthGuard lets them through; the
 * authed ones add @UseGuards(CustomerAuthGuard). Login endpoints are on the
 * tight `auth` throttle bucket (anti-spam / anti-brute-force).
 */
import {
  Controller, Post, Get, Body, Res, UseGuards, HttpCode, Inject,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { loadThrottleConfig } from '../config/throttle.config';
import { CUSTOMER_AUTH_CONFIG, CustomerAuthConfig } from '../config/customer-auth.config';
import { CustomerAuthService } from './customer-auth.service';
import { CustomerAuthGuard } from './customer-auth.guard';
import { CurrentCustomer, CustomerClaims } from './current-customer.decorator';
import { RequestLinkDto, VerifyLinkDto } from './dto/portal.dto';

const T = loadThrottleConfig();

@Controller('portal')
export class PortalAuthController {
  constructor(
    private readonly auth: CustomerAuthService,
    @Inject(CUSTOMER_AUTH_CONFIG) private readonly cfg: CustomerAuthConfig,
  ) {}

  /**
   * Request a magic link. ALWAYS returns the same generic 200 whether or not the
   * email maps to a customer — the service only emails if it does. This is the
   * anti-enumeration property: a caller can't learn who is a customer.
   */
  @Throttle({ default: { ttl: T.authTtlMs, limit: T.authLimit } })
  @Public()
  @Post('request-link')
  @HttpCode(200)
  async requestLink(@Body() dto: RequestLinkDto) {
    await this.auth.requestLink(dto.email);
    return { ok: true, message: 'If that email has licenses, a sign-in link is on its way.' };
  }

  /** Consume a magic link → set the customer session cookie. */
  @Throttle({ default: { ttl: T.authTtlMs, limit: T.authLimit } })
  @Public()
  @Post('verify')
  @HttpCode(200)
  async verify(@Body() dto: VerifyLinkDto, @Res({ passthrough: true }) res: Response) {
    const customer = await this.auth.consumeLink(dto.token);
    const session = this.auth.issueSession(customer);
    // Set the cookie (direct-to-backend deployments) AND return the token in the
    // body so a BFF can store it in ITS own httpOnly cookie (the normal path —
    // the token reaches only the trusted BFF server, never the browser directly).
    this.setSessionCookie(res, session);
    return { ok: true, email: customer.email, sessionToken: session };
  }

  @Public()
  @UseGuards(CustomerAuthGuard)
  @Get('me')
  me(@CurrentCustomer() c: CustomerClaims) {
    return { id: c.sub, email: c.email };
  }

  @Public()
  @UseGuards(CustomerAuthGuard)
  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentCustomer() c: CustomerClaims, @Res({ passthrough: true }) res: Response) {
    // Bump the epoch so EVERY outstanding session for this customer dies now,
    // not just the cookie we happen to clear here (audit M4).
    if (c?.sub) await this.auth.bumpSessionEpoch(c.sub);
    res.clearCookie(this.cfg.sessionCookieName, this.cookieBase());
    return { ok: true };
  }

  private setSessionCookie(res: Response, token: string): void {
    res.cookie(this.cfg.sessionCookieName, token, { ...this.cookieBase(), httpOnly: true });
  }

  private cookieBase() {
    return {
      httpOnly: true as const,
      secure: this.cfg.cookieSecure,
      sameSite: this.cfg.cookieSameSite,
      path: '/portal',
    };
  }
}
