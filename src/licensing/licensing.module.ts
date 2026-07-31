/**
 * licensing.module.ts — the license engine.
 *
 * The SIGNER + JWKS need only the signing key (no DB), so they're always
 * available. The DB-backed LicenseService (issue/renew/revoke + entities) is
 * registered only when the database is enabled — matching the "AI/JWKS work
 * without a DB; licensing records need one" design.
 */
import { Global, Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LICENSE_CONFIG, loadLicenseConfig } from '../config/license.config';
import { loadDatabaseConfig } from '../config/database.config';
import { LicenseSignerService } from './license-signer.service';
import { JwksController } from './jwks.controller';
import { LicenseService } from './license.service';
import { FeatureCatalogService } from './feature-catalog.service';
import { FeatureEntity } from './entities/feature.entity';
import { PackageEntity } from './entities/package.entity';
import { CustomerEntity } from './entities/customer.entity';
import { LicenseEntity } from './entities/license.entity';

const ENTITIES = [FeatureEntity, PackageEntity, CustomerEntity, LicenseEntity];

// @Global so LicenseService/LicenseSignerService are visible app-wide from a
// SINGLE forRoot() import (in app.module). AdminModule then consumes them
// without re-importing forRoot() — which previously double-registered the
// module and ran the feature-catalog sync twice. (I1)
@Global()
@Module({})
export class LicensingModule {
  static forRoot(): DynamicModule {
    const dbEnabled = loadDatabaseConfig().enabled;

    const providers: any[] = [
      { provide: LICENSE_CONFIG, useFactory: () => loadLicenseConfig() },
      LicenseSignerService,
    ];
    const imports: any[] = [];
    const controllers: any[] = [JwksController];

    if (dbEnabled) {
      imports.push(TypeOrmModule.forFeature(ENTITIES));
      providers.push(LicenseService, FeatureCatalogService);
    }

    return {
      module: LicensingModule,
      imports,
      controllers,
      providers,
      exports: [LicenseSignerService, ...(dbEnabled ? [LicenseService, FeatureCatalogService] : [])],
    };
  }
}
