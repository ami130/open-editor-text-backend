/**
 * auth.module.ts — admin auth + RBAC. Loaded only when the DB is enabled
 * (users/roles live in the DB). Provides AuthService (+ config), the auth
 * controller, and the seed. GLOBAL so the app-root guards in SecurityModule can
 * @Optional()-inject AuthService. The guards themselves live in SecurityModule
 * (always loaded), so guard coverage is NOT tied to this module loading. (C2)
 */
import { Global, Module, DynamicModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AUTH_CONFIG, loadAuthConfig } from '../config/auth.config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SeedService } from './seed.service';
import { UserEntity } from './entities/user.entity';
import { RoleEntity } from './entities/role.entity';
import { PermissionEntity } from './entities/permission.entity';

export const AUTH_ENTITIES = [UserEntity, RoleEntity, PermissionEntity];

@Global()
@Module({})
export class AuthModule {
  static forRoot(): DynamicModule {
    return {
      module: AuthModule,
      imports: [
        JwtModule.register({}),           // secrets/TTLs passed per-sign/verify call
        TypeOrmModule.forFeature(AUTH_ENTITIES),
      ],
      controllers: [AuthController],
      providers: [
        { provide: AUTH_CONFIG, useFactory: () => loadAuthConfig() },
        AuthService,
        SeedService,
      ],
      exports: [AuthService, AUTH_CONFIG],
    };
  }
}
