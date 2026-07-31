/**
 * security.module.ts — registers the global auth + RBAC guards at the APP ROOT,
 * UNCONDITIONALLY (independent of DB_ENABLED). This is the fix for the guard
 * coverage being coupled to a config flag: guards now always exist, so a
 * protected route can never be served unguarded because auth "wasn't loaded".
 *
 * The guards inject AuthService with @Optional(): when the auth backend isn't
 * wired (DB off / no user store), JwtAuthGuard denies every non-@Public() route
 * (fail closed). When AuthModule IS loaded, its exported AuthService satisfies
 * the optional injection and full auth/RBAC applies.
 */
import { Global, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { loadThrottleConfig } from '../config/throttle.config';

const throttle = loadThrottleConfig();

@Global()
@Module({
  imports: [
    // Rate limiting. ONE global throttler applies to every route (the broad
    // default). Sensitive routes TIGHTEN it per-route with @Throttle({ default:
    // {...} }) (see auth/billing controllers); the webhook OPTS OUT with
    // @SkipThrottle(). A single named throttler avoids the trap where extra
    // named throttlers apply to ALL routes globally.
    // Storage is in-memory (per-instance) — fine for a single node; a shared
    // store (Redis) is a scale-out concern documented for later.
    ThrottlerModule.forRoot([
      { name: 'default', ttl: throttle.defaultTtlMs, limit: throttle.defaultLimit },
    ]),
  ],
  providers: [
    // Global validation as a PROVIDER (not a bootstrap-only call), so the exact
    // same pipe applies in production AND in tests — no config drift between
    // main.ts and a test app. whitelist strips unknown fields;
    // forbidNonWhitelisted rejects them (400); transform coerces types.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
    // Guard order matters (APP_GUARDs run in registration order): rate-limit
    // FIRST (cheapest, protects everything incl. @Public routes), THEN
    // authenticate (JwtAuthGuard), THEN authorize (PermissionsGuard).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class SecurityModule {}
