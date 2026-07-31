/**
 * decorators.ts — route metadata + param decorators for admin auth/RBAC.
 *   @Public()                     — skip auth on a route (e.g. login).
 *   @RequirePermissions('x','y')  — route needs ALL listed permission keys.
 *   @CurrentUser()                — inject the authenticated claims into a handler.
 */
import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AccessClaims } from './auth.service';

export const IS_PUBLIC_KEY = 'oe:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'oe:permissions';
export const RequirePermissions = (...perms: string[]) => SetMetadata(PERMISSIONS_KEY, perms);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessClaims | undefined => {
    const req = ctx.switchToHttp().getRequest();
    return req.user;
  },
);
