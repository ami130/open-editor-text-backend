/**
 * portal.module.ts — the self-serve CUSTOMER portal (Phase 4). DB-gated like
 * BillingModule/AdminModule. Passwordless magic-link auth (4a) + (later) the
 * my-licenses reveal and the public refresh endpoint (4b/4c).
 *
 * Reuses the GLOBAL LicensingModule's LicenseService/LicenseSignerService and
 * the billing EmailService (re-provided here so this module can inject it
 * without importing BillingModule's full graph). Its own JwtModule.register({})
 * mirrors AuthModule — secrets/TTLs are passed per sign/verify call.
 */
import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { CUSTOMER_AUTH_CONFIG, loadCustomerAuthConfig } from '../config/customer-auth.config';
import { BILLING_CONFIG, loadBillingConfig } from '../config/billing.config';
import { CustomerEntity } from '../licensing/entities/customer.entity';
import { LicenseEntity } from '../licensing/entities/license.entity';
import { EmailService } from '../billing/email.service';
import { CustomerAuthService } from './customer-auth.service';
import { CustomerAuthGuard } from './customer-auth.guard';
import { PortalAuthController } from './portal-auth.controller';
import { PortalLicenseController } from './portal-license.controller';
import { PortalLicenseService } from './portal-license.service';
import { RefreshController } from './refresh.controller';
import { RefreshService } from './refresh.service';
import { RefreshRateLimiter } from './refresh-rate-limiter';
import { RefreshLogService } from './refresh-log.service';
import { RefreshEventEntity } from './entities/refresh-event.entity';
import { SharingDetectorService } from './sharing-detector.service';

@Module({})
export class PortalModule {
  static forRoot(): DynamicModule {
    return {
      module: PortalModule,
      imports: [
        TypeOrmModule.forFeature([CustomerEntity, LicenseEntity, RefreshEventEntity]),
        JwtModule.register({}), // secrets/TTLs passed per sign/verify call
      ],
      controllers: [PortalAuthController, PortalLicenseController, RefreshController],
      providers: [
        { provide: CUSTOMER_AUTH_CONFIG, useFactory: () => loadCustomerAuthConfig() },
        // EmailService needs BILLING_CONFIG; re-provide it locally so PortalModule
        // is self-contained (BillingModule provides its own copy for its graph).
        { provide: BILLING_CONFIG, useFactory: () => loadBillingConfig() },
        EmailService,
        CustomerAuthService,
        CustomerAuthGuard,
        PortalLicenseService,
        RefreshService,
        RefreshRateLimiter,
        RefreshLogService,
        SharingDetectorService,
      ],
      // Exported so the DELIVERY refresh endpoint can log fetches and run
      // anti-sharing detection (§2 security). Without this the @Optional()
      // injections there resolve to undefined and the feature silently does
      // nothing — the exact failure mode that made this gap invisible before.
      exports: [CustomerAuthService, RefreshLogService, SharingDetectorService],
    };
  }
}
