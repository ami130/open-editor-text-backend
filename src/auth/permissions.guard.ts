/**
 * permissions.guard.ts — RBAC enforcement. Reads @RequirePermissions(...) and
 * checks the authenticated user's claims hold ALL of them. The wildcard '*'
 * (seeded admin) satisfies any requirement. Runs after JwtAuthGuard, so
 * request.user is present.
 *
 * This is the REAL gate: the frontend's /admin routing is cosmetic; a request
 * without the required permission is rejected here regardless of what UI the
 * caller used.
 */
import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './decorators';
import { SUPER_PERMISSION } from './permission-catalog';
import type { AccessClaims } from './auth.service';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true; // no permission gate on this route

    const req = ctx.switchToHttp().getRequest();
    const user: AccessClaims | undefined = req.user;
    const held = new Set(user?.perms || []);
    if (held.has(SUPER_PERMISSION)) return true; // admin wildcard

    const missing = required.filter((p) => !held.has(p));
    if (missing.length) {
      throw new ForbiddenException(`missing permission(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
