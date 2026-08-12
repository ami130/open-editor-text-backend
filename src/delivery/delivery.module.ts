/**
 * delivery.module.ts — runtime engine delivery (execution plan §1.3).
 *
 * Registered only when the database is enabled, matching the existing pattern:
 * signing and JWKS work without a DB, but resolving a licence to a build needs
 * one. Without a database the module is simply absent rather than half-working.
 *
 * EngineVersionService and LicenseSignerService both come from the @Global
 * LicensingModule, so they are not re-provided here — re-registering them would
 * create a second instance and silently split state.
 */
import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { loadDatabaseConfig } from '../config/database.config';
import { LicenseEntity } from '../licensing/entities/license.entity';
import { LicenseInstallEntity } from './entities/license-install.entity';
import { PortalModule } from '../portal/portal.module';
import { DeliverySessionService } from './session.service';
import { DeliverySessionController } from './session.controller';
import { EngineController } from './engine.controller';
import { BundleUrlSigner } from './bundle-url-signer';
import { LicenseInstallService } from './license-install.service';

@Module({})
export class DeliveryModule {
  static forRoot(): DynamicModule {
    if (!loadDatabaseConfig().enabled) {
      return { module: DeliveryModule };
    }
    return {
      module: DeliveryModule,
      imports: [
        // LicenseInstallEntity backs the §2.4 seat cap.
        TypeOrmModule.forFeature([LicenseEntity, LicenseInstallEntity]),
        // For the anti-sharing fetch-log + detector on /delivery/refresh.
        // Sibling modules do not see each other's exports automatically, so
        // this import is what makes those @Optional() injections resolve —
        // without it they would be `undefined` and detection would silently
        // never run.
        PortalModule.forRoot(),
      ],
      // EngineController serves bundle bytes (§1.4); BundleUrlSigner protects
      // the premium ones (R44). DELIVERY_CONFIG and BUNDLE_STORAGE come from
      // the @Global LicensingModule, which owns EngineVersionService.
      controllers: [DeliverySessionController, EngineController],
      providers: [DeliverySessionService, BundleUrlSigner, LicenseInstallService],
      exports: [DeliverySessionService, BundleUrlSigner, LicenseInstallService],
    };
  }
}
