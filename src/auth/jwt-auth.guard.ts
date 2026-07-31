/**
 * jwt-auth.guard.ts — verifies the Bearer access token on every route EXCEPT
 * those marked @Public(). On success it attaches verified claims to
 * request.user (read by @CurrentUser + PermissionsGuard).
 *
 * SECURE BY DEFAULT + FAIL CLOSED:
 *   • Registered GLOBALLY at the app root (SecurityModule), independent of
 *     DB_ENABLED — so guard coverage never disappears because of a config flag.
 *   • AuthService is OPTIONAL: if the auth backend isn't wired (no DB / no user
 *     store), a non-@Public() route is DENIED (503), never served unguarded.
 *   • Revocation is enforced on EVERY request: the token's tokenVersion + the
 *     user's active flag are re-checked against the DB, so logout / password
 *     change / deactivation kill outstanding ACCESS tokens immediately (not
 *     just refresh tokens). @Public() routes skip all of this.
 */
import {
  Injectable, CanActivate, ExecutionContext, UnauthorizedException,
  ServiceUnavailableException, Optional, Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './decorators';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional() @Inject(AuthService) private readonly auth?: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (isPublic) return true;

    // Fail closed: a protected route with no auth backend is never served.
    if (!this.auth) {
      throw new ServiceUnavailableException('authentication is not configured on this server');
    }

    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('missing bearer token');
    // verifyActiveAccess checks signature/expiry/type AND that the session is
    // still valid (tokenVersion match + user active) — DB-backed revocation.
    req.user = await this.auth.verifyActiveAccess(token);
    return true;
  }
}
