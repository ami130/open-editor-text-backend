/**
 * admin.module.ts — the guarded admin REST API (packages/customers/licenses/
 * features). DB-only (all resources are persisted). Reuses LicenseService from
 * LicensingModule for issue/renew/revoke, and registers the entities its
 * controllers/services touch.
 */
import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PackageEntity } from '../licensing/entities/package.entity';
import { FeatureEntity } from '../licensing/entities/feature.entity';
import { CustomerEntity } from '../licensing/entities/customer.entity';
import { LicenseEntity } from '../licensing/entities/license.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { RoleEntity } from '../auth/entities/role.entity';
import { PermissionEntity } from '../auth/entities/permission.entity';
import { PackageAdminService } from './package-admin.service';
import { RbacService } from './rbac.service';
import { EngineAdminController } from './engine-admin.controller';
import {
  FeatureAdminController, PackageAdminController, CustomerAdminController, LicenseAdminController,
  PermissionAdminController, RoleAdminController, UserAdminController,
} from './admin.controller';

@Module({})
export class AdminModule {
  static forRoot(): DynamicModule {
    return {
      module: AdminModule,
      // Register the repositories this module's controllers/services use.
      // LicenseService (+ signer) come from the GLOBAL LicensingModule imported
      // once in app.module — NOT re-imported here (that double-registered it). (I1)
      // AuthService comes from the GLOBAL AuthModule (RbacService injects it).
      imports: [
        TypeOrmModule.forFeature([
          PackageEntity, FeatureEntity, CustomerEntity, LicenseEntity,
          UserEntity, RoleEntity, PermissionEntity,
        ]),
      ],
      controllers: [
        FeatureAdminController, PackageAdminController, CustomerAdminController, LicenseAdminController,
        PermissionAdminController, RoleAdminController, UserAdminController,
        // Runtime delivery §1.2 — publish/promote/default/retire engine versions.
        EngineAdminController,
      ],
      providers: [PackageAdminService, RbacService],
    };
  }
}
