/**
 * seed.service.ts — makes a fresh install immediately usable, idempotently:
 *   1. Sync the permission catalog into the `permissions` table.
 *   2. Ensure a built-in "admin" role holding the wildcard '*' permission.
 *   3. Ensure a first admin user (from env SEED_ADMIN_EMAIL/PASSWORD) with that
 *      role — created only if it doesn't exist (never overwrites a real user).
 *
 * Runs on boot. Safe to run repeatedly. In production, if no SEED_ADMIN_PASSWORD
 * is set and no admin user exists, it logs a clear warning rather than creating
 * a weak default account.
 */
import { Injectable, OnModuleInit, Inject, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { PermissionEntity } from './entities/permission.entity';
import { RoleEntity } from './entities/role.entity';
import { UserEntity } from './entities/user.entity';
import { PERMISSION_CATALOG, SUPER_PERMISSION } from './permission-catalog';
import { AuthService } from './auth.service';

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly log = new Logger('SeedService');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seed();
  }

  async seed(): Promise<void> {
    await this.dataSource.transaction(async (mgr) => {
      const permRepo = mgr.getRepository(PermissionEntity);
      const roleRepo = mgr.getRepository(RoleEntity);
      const userRepo = mgr.getRepository(UserEntity);

      // 1. Permission catalog (upsert) + the wildcard.
      await permRepo.save(permRepo.create({ key: SUPER_PERMISSION, description: 'All permissions (super admin)' }));
      for (const p of PERMISSION_CATALOG) {
        await permRepo.save(permRepo.create({ key: p.key, description: p.description }));
      }

      // 2. Built-in "admin" role with the wildcard.
      let adminRole = await roleRepo.findOne({ where: { name: 'admin' } });
      const wildcard = await permRepo.findOne({ where: { key: SUPER_PERMISSION } });
      if (!adminRole) {
        adminRole = roleRepo.create({
          name: 'admin', description: 'Full access', system: true,
          permissions: wildcard ? [wildcard] : [],
        });
        await roleRepo.save(adminRole);
      }

      // 3. First admin user (idempotent; only if absent).
      const email = (process.env.SEED_ADMIN_EMAIL || 'admin@example.com').toLowerCase().trim();
      const existing = await userRepo.findOne({ where: { email } });
      if (existing) return;

      // A real password is REQUIRED. The weak dev default ('admin1234') is used
      // ONLY when explicitly opted in via SEED_DEV_ADMIN=true — never inferred
      // from NODE_ENV (which is 'staging'/'prod'/unset in many real deploys and
      // must not leak a default admin with wildcard perms). (I4)
      const password = process.env.SEED_ADMIN_PASSWORD || '';
      const devOptIn = String(process.env.SEED_DEV_ADMIN || '').toLowerCase() === 'true';
      if (!password && !devOptIn) {
        this.log.warn(`No admin user and no SEED_ADMIN_PASSWORD — skipping admin seed. Set SEED_ADMIN_PASSWORD (or SEED_DEV_ADMIN=true for a throwaway dev admin).`);
        return;
      }
      if (!password) this.log.warn(`Seeding DEV admin ${email} with the default password — dev only; change immediately.`);

      const hash = await this.auth.hashPassword(password || 'admin1234');
      const user = userRepo.create({ email, name: 'Administrator', passwordHash: hash, active: true, roles: adminRole ? [adminRole] : [] });
      try {
        await userRepo.save(user);
        this.log.log(`Seeded admin user: ${email}`);
      } catch (e) {
        // Concurrent multi-instance boot can race the find→save; the unique
        // email constraint rejects the loser — that's fine, the admin exists.
        this.log.warn(`Admin seed skipped (already created by a concurrent boot): ${email}`);
      }
    });
  }
}
