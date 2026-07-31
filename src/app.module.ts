/**
 * app.module.ts — root module. Loads .env, then composes feature modules.
 *
 * Two deployment shapes, chosen by DB_ENABLED:
 *   • DB OFF  → AI proxy + license signer/JWKS + health. No admin/licensing DB
 *     surface. (An "AI-only" deployment.)
 *   • DB ON   → additionally: auth (RBAC) + admin API + DB-backed licensing.
 *
 * Auth/Admin are DB-only (users/roles/packages live in MySQL), so they're
 * included only when the DB is enabled. This keeps the AI-only mode dependency-
 * free and avoids registering global auth guards when there's no user store.
 */
import { Module, DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from './ai/ai.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { LicensingModule } from './licensing/licensing.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { BillingModule } from './billing/billing.module';
import { PortalModule } from './portal/portal.module';
import { SecurityModule } from './auth/security.module';
import { ObservabilityModule } from './observability/observability.module';
import { loadDatabaseConfig } from './config/database.config';

@Module({})
export class AppModule {
  static forRoot(): DynamicModule {
    const dbEnabled = loadDatabaseConfig().enabled;
    const imports = [
      // In tests, IGNORE the on-disk .env — each e2e sets its own env in
      // beforeAll, and a dev/local .env (DB creds, SMTP, CORS…) would otherwise
      // leak in and break isolation. Prod/dev still load .env normally.
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: process.env.NODE_ENV === 'test' }),
      // SecurityModule ALWAYS registers the global auth+RBAC guards (fail
      // closed), independent of DB — so no route is ever served unguarded
      // because auth "wasn't loaded". AuthModule (below) supplies AuthService
      // when the DB is on; without it, protected routes deny with 503.
      SecurityModule,
      ObservabilityModule,
      DatabaseModule.forRoot(),
      HealthModule,
      AiModule,
      LicensingModule.forRoot(),  // @Global — single import; providers visible app-wide
      ...(dbEnabled ? [AuthModule.forRoot(), AdminModule.forRoot(), BillingModule.forRoot(), PortalModule.forRoot()] : []),
    ];
    return { module: AppModule, imports };
  }
}
