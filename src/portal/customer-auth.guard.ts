/**
 * customer-auth.guard.ts — protects authenticated PORTAL routes with the
 * customer SESSION token (Phase 4a). Distinct from the admin JwtAuthGuard:
 *   • Portal routes are marked @Public() so the GLOBAL admin guard lets them
 *     through, then THIS guard enforces the customer session on the ones that
 *     need it. (Login routes use @Public alone; authed routes add @UseGuards.)
 *   • The session comes from the httpOnly cookie the BFF sets, OR a Bearer
 *     token the BFF forwards server-to-server — either is accepted.
 *   • The token is type:'customer' under a SEPARATE secret, so an admin token
 *     can never satisfy this guard and a customer token can never satisfy the
 *     admin guard. On success, request.customer = { sub, email }.
 */
import {
  Injectable, CanActivate, ExecutionContext, UnauthorizedException, Inject,
} from '@nestjs/common';
import { CustomerAuthService } from './customer-auth.service';
import { CUSTOMER_AUTH_CONFIG, CustomerAuthConfig } from '../config/customer-auth.config';

@Injectable()
export class CustomerAuthGuard implements CanActivate {
  constructor(
    @Inject(CustomerAuthService) private readonly auth: CustomerAuthService,
    @Inject(CUSTOMER_AUTH_CONFIG) private readonly cfg: CustomerAuthConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException('customer session required');
    const claims = this.auth.verifySession(token); // throws 401 on bad sig/expiry/type
    // Revocation check (audit M4): the token's epoch must still match the
    // customer's current sessionEpoch. A logout/forced-revoke bumps the epoch,
    // instantly invalidating every outstanding session — the stateless JWT's
    // server-side kill switch (mirrors the admin tokenVersion).
    const epoch = await this.auth.currentEpoch(claims.sub);
    if (epoch === null || epoch !== claims.epoch) {
      throw new UnauthorizedException('customer session revoked');
    }
    req.customer = claims;
    return true;
  }

  private extractToken(req: {
    headers: Record<string, string | undefined>;
    cookies?: Record<string, string>;
  }): string | null {
    const cookie = req.cookies?.[this.cfg.sessionCookieName];
    if (cookie) return cookie;
    const header = req.headers['authorization'] || '';
    const [scheme, token] = header.split(' ');
    if (scheme === 'Bearer' && token) return token;
    return null;
  }
}
