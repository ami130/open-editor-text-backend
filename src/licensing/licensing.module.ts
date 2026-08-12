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
import { EngineVersionService } from './engine-version.service';
import { FeatureEntity } from './entities/feature.entity';
import { PackageEntity } from './entities/package.entity';
import { CustomerEntity } from './entities/customer.entity';
import { LicenseEntity } from './entities/license.entity';
import { EngineVersionEntity } from './entities/engine-version.entity';
import { EngineDefaultEntity } from './entities/engine-default.entity';
import {
  DELIVERY_CONFIG, DeliveryConfig, loadDeliveryConfig,
} from '../config/delivery.config';
import { BUNDLE_STORAGE } from '../delivery/bundle-storage';
import { LocalBundleStorage } from '../delivery/local-bundle-storage';
import { S3BundleStorage } from '../delivery/s3-bundle-storage';

const ENTITIES = [
  FeatureEntity, PackageEntity, CustomerEntity, LicenseEntity,
  // Runtime delivery §1.2 — the engine version registry + default pointers.
  EngineVersionEntity, EngineDefaultEntity,
];

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
      providers.push(LicenseService, FeatureCatalogService, EngineVersionService);
      // Bundle storage (§1.4a) is provided HERE rather than in DeliveryModule
      // because EngineVersionService lives in this module and injects it. A
      // provider registered in DeliveryModule would not be visible to it.
      providers.push(
        { provide: DELIVERY_CONFIG, useFactory: () => loadDeliveryConfig() },
        {
          provide: BUNDLE_STORAGE,
          // §2.0 — driver chosen by config. Defaults to LOCAL, so an existing
          // deployment keeps its exact current behaviour; moving to object
          // storage is a deliberate act, never a side effect of upgrading.
          useFactory: (cfg: DeliveryConfig) => (
            cfg.storageDriver === 's3'
              ? new S3BundleStorage({
                bucket: cfg.s3.bucket,
                region: cfg.s3.region,
                endpoint: cfg.s3.endpoint || undefined,
                accessKeyId: cfg.s3.accessKeyId || undefined,
                secretAccessKey: cfg.s3.secretAccessKey || undefined,
                forcePathStyle: cfg.s3.forcePathStyle,
                prefix: cfg.s3.prefix || undefined,
              })
              : new LocalBundleStorage(cfg.bundleDir)
          ),
          inject: [DELIVERY_CONFIG],
        },
      );
    }

    return {
      module: LicensingModule,
      imports,
      controllers,
      providers,
      exports: [
        LicenseSignerService,
        ...(dbEnabled
          ? [
            LicenseService, FeatureCatalogService, EngineVersionService,
            // Exported so the engine endpoint and its URL signer can inject them.
            DELIVERY_CONFIG, BUNDLE_STORAGE,
          ]
          : []),
      ],
    };
  }
}
