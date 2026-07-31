/**
 * rbac.service.ts — admin-facing role & user management (the "create roles /
 * assign permissions / create staff users" flow).
 *
 * Security invariants enforced here (not just in the controller):
 *   • Permission keys must exist in the catalog. The wildcard '*' can NEVER be
 *     granted through the API — it is reserved for the seeded system admin role,
 *     so the panel can't mint a new super-admin (privilege-escalation guard).
 *   • `system` roles (the seeded "admin") are immutable and undeletable.
 *   • A role still assigned to users can't be deleted.
 *   • Changing a user's roles / active flag / password bumps their tokenVersion,
 *     so the change takes effect on their very next request (no stale sessions).
 *   • The last remaining active admin (a user whose effective perms include '*')
 *     can't be deactivated or stripped of admin — prevents locking everyone out.
 *   • passwordHash is never selected or returned.
 */
import {
  Injectable, Inject, NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { Repository, In } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { RoleEntity } from '../auth/entities/role.entity';
import { PermissionEntity } from '../auth/entities/permission.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { AuthService } from '../auth/auth.service';
import { SUPER_PERMISSION } from '../auth/permission-catalog';

/** A user shape safe to return (no passwordHash, flattened perms). */
export interface SafeUser {
  id: string;
  email: string;
  name: string;
  active: boolean;
  roles: { id: string; name: string }[];
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class RbacService {
  constructor(
    @InjectRepository(RoleEntity) private readonly roles: Repository<RoleEntity>,
    @InjectRepository(PermissionEntity) private readonly perms: Repository<PermissionEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  // ---- Permissions (read-only catalog) ------------------------------------

  /** The full catalog the UI shows as assignable checkboxes. The wildcard is
   *  intentionally excluded — it is not assignable via the panel. */
  listPermissions(): Promise<PermissionEntity[]> {
    return this.perms
      .createQueryBuilder('p')
      .where('p.key != :star', { star: SUPER_PERMISSION })
      .orderBy('p.key', 'ASC')
      .getMany();
  }

  // ---- Roles ---------------------------------------------------------------

  listRoles(): Promise<RoleEntity[]> {
    return this.roles.find({ order: { name: 'ASC' } });
  }

  async createRole(name: string, description: string, keys: string[], actorPerms: string[] = []): Promise<RoleEntity> {
    const cleanName = name.trim();
    if (!cleanName) throw new BadRequestException('role name is required');
    const dupe = await this.roles.findOne({ where: { name: cleanName } });
    if (dupe) throw new ConflictException('a role with that name already exists');
    const permissions = await this.resolvePermissions(keys, actorPerms);
    const role = this.roles.create({ name: cleanName, description: (description || '').trim(), system: false, permissions });
    return this.roles.save(role);
  }

  async updateRole(id: string, patch: { name?: string; description?: string; permissions?: string[] }, actorPerms: string[] = []): Promise<RoleEntity> {
    const role = await this.roles.findOne({ where: { id } });
    if (!role) throw new NotFoundException('role not found');
    // System roles (seeded admin) are immutable — editing them could remove the
    // wildcard and lock everyone out, or silently re-scope the super role.
    if (role.system) throw new BadRequestException('system roles cannot be modified');

    if (patch.name !== undefined) {
      const cleanName = patch.name.trim();
      if (!cleanName) throw new BadRequestException('role name cannot be empty');
      const dupe = await this.roles.findOne({ where: { name: cleanName } });
      if (dupe && dupe.id !== id) throw new ConflictException('a role with that name already exists');
      role.name = cleanName;
    }
    if (patch.description !== undefined) role.description = patch.description.trim();
    if (patch.permissions !== undefined) role.permissions = await this.resolvePermissions(patch.permissions, actorPerms);

    const saved = await this.roles.save(role);
    // Anyone holding this role may have gained/lost access — force their tokens
    // to re-mint so the new permission set is reflected immediately.
    await this.invalidateUsersWithRole(id);
    return saved;
  }

  async deleteRole(id: string): Promise<void> {
    const role = await this.roles.findOne({ where: { id }, relations: { users: true } });
    if (!role) throw new NotFoundException('role not found');
    if (role.system) throw new BadRequestException('system roles cannot be deleted');
    if (role.users && role.users.length > 0) {
      throw new ConflictException('role is still assigned to users; unassign it first');
    }
    await this.roles.delete(id);
  }

  // ---- Admin users ---------------------------------------------------------

  async listUsers(): Promise<SafeUser[]> {
    const users = await this.users.find({ order: { createdAt: 'DESC' } });
    return users.map((u) => this.toSafeUser(u));
  }

  async createUser(input: { email: string; name?: string; password: string; roleIds?: string[] }, actor?: { perms: string[] }): Promise<SafeUser> {
    const email = input.email.toLowerCase().trim();
    const existing = await this.users.findOne({ where: { email } });
    if (existing) throw new ConflictException('a user with that email already exists');
    const roles = await this.resolveRoles(input.roleIds || []);
    this.assertActorCanGrantRoles(roles, actor?.perms || []); // H3: no escalation-by-assignment
    const passwordHash = await this.auth.hashPassword(input.password);
    const user = this.users.create({ email, name: (input.name || '').trim(), passwordHash, active: true, roles });
    const saved = await this.users.save(user);
    return this.toSafeUser(saved);
  }

  async updateUser(id: string, patch: { name?: string; active?: boolean; roleIds?: string[]; password?: string }, actor?: { perms: string[]; sub?: string }): Promise<SafeUser> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('user not found');

    // Determine what super-admin-ness would look like AFTER this change, and
    // refuse if it would remove the last active user-manager (lockout guard).
    const willBeActive = patch.active !== undefined ? patch.active : user.active;
    const willBeRoles = patch.roleIds !== undefined ? await this.resolveRoles(patch.roleIds) : user.roles;
    const willManageUsers = willBeActive && this.rolesGrantUserManagement(willBeRoles);
    if (!willManageUsers && await this.isLastActiveAdmin(user)) {
      throw new BadRequestException('cannot remove the last active administrator');
    }

    // H3: escalation guards on role assignment.
    if (patch.roleIds !== undefined) {
      const actorPerms = actor?.perms || [];
      // (a) You can't assign roles granting permissions you don't hold.
      this.assertActorCanGrantRoles(willBeRoles, actorPerms);
      // (b) You can't change YOUR OWN roles unless you're a super-admin — stops a
      // limited user-manager from self-escalating by editing their own account.
      if (actor?.sub && actor.sub === user.id && !actorPerms.includes(SUPER_PERMISSION)) {
        throw new BadRequestException('you cannot change your own roles');
      }
    }

    let mustInvalidate = false;
    if (patch.name !== undefined) user.name = patch.name.trim();
    if (patch.active !== undefined && patch.active !== user.active) { user.active = patch.active; mustInvalidate = true; }
    if (patch.roleIds !== undefined) { user.roles = willBeRoles; mustInvalidate = true; }
    if (patch.password !== undefined) { user.passwordHash = await this.auth.hashPassword(patch.password); mustInvalidate = true; }

    const saved = await this.users.save(user);
    // Role/active/password changes must invalidate outstanding tokens so the
    // change is enforced on the next request.
    if (mustInvalidate) await this.auth.bumpTokenVersion(user.id);
    return this.toSafeUser(saved);
  }

  async deleteUser(id: string): Promise<void> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('user not found');
    if (await this.isLastActiveAdmin(user)) {
      throw new BadRequestException('cannot delete the last active administrator');
    }
    await this.users.delete(id);
  }

  // ---- helpers -------------------------------------------------------------

  /** Resolve + validate permission keys against the catalog; reject unknown
   *  keys and the wildcard (never assignable through the panel). Also enforces
   *  (H3) that the ACTOR may only grant permissions they themselves hold — a
   *  non-super-admin can't mint a role broader than their own authority. */
  private async resolvePermissions(keys: string[] = [], actorPerms: string[] = []): Promise<PermissionEntity[]> {
    const wanted = [...new Set(keys.map((k) => String(k || '').trim()).filter(Boolean))];
    if (wanted.includes(SUPER_PERMISSION)) {
      throw new BadRequestException('the wildcard permission cannot be assigned to a role');
    }
    if (wanted.length === 0) return [];
    const found = await this.perms.find({ where: { key: In(wanted) } });
    if (found.length !== wanted.length) {
      const known = new Set(found.map((p) => p.key));
      const bad = wanted.filter((k) => !known.has(k));
      throw new BadRequestException(`unknown permission(s): ${bad.join(', ')}`);
    }
    // Privilege ceiling: unless the actor is a super-admin (*), every requested
    // permission must be one the actor already holds.
    if (!actorPerms.includes(SUPER_PERMISSION)) {
      const held = new Set(actorPerms);
      const over = wanted.filter((k) => !held.has(k));
      if (over.length) {
        throw new BadRequestException(`cannot grant permission(s) you don't hold: ${over.join(', ')}`);
      }
    }
    return found;
  }

  /** H3: a non-super-admin may only assign roles whose permissions are a subset
   *  of their own. Prevents escalation by assigning a pre-existing broad role. */
  private assertActorCanGrantRoles(roles: RoleEntity[], actorPerms: string[]): void {
    if (actorPerms.includes(SUPER_PERMISSION)) return;
    const held = new Set(actorPerms);
    for (const role of roles) {
      for (const p of role.permissions || []) {
        if (p.key === SUPER_PERMISSION || !held.has(p.key)) {
          throw new BadRequestException(`cannot assign role "${role.name}" — it grants permissions you don't hold`);
        }
      }
    }
  }

  /** Resolve role ids → entities; reject unknown ids. */
  private async resolveRoles(ids: string[] = []): Promise<RoleEntity[]> {
    const wanted = [...new Set(ids.map((i) => String(i || '').trim()).filter(Boolean))];
    if (wanted.length === 0) return [];
    const found = await this.roles.find({ where: { id: In(wanted) } });
    if (found.length !== wanted.length) throw new BadRequestException('one or more role ids are invalid');
    return found;
  }

  /**
   * Do these roles grant the ability to manage users/roles — i.e. hold the
   * wildcard or `user.manage`? This (not mere admin-area access) is what the
   * lockout guard protects: you must never remove the last person who can
   * create/repair admin accounts.
   */
  private rolesGrantUserManagement(roles: RoleEntity[]): boolean {
    return roles.some((r) => (r.permissions || []).some((p) => p.key === SUPER_PERMISSION || p.key === 'user.manage'));
  }

  /** Is `user` the only remaining active user-manager in the system? */
  private async isLastActiveAdmin(user: UserEntity): Promise<boolean> {
    if (!user.active || !this.rolesGrantUserManagement(user.roles || [])) return false;
    const all = await this.users.find();
    const managers = all.filter((u) => u.active && this.rolesGrantUserManagement(u.roles || []));
    return managers.length === 1 && managers[0].id === user.id;
  }

  /** Bump tokenVersion for every user holding a given role. */
  private async invalidateUsersWithRole(roleId: string): Promise<void> {
    const holders = await this.users
      .createQueryBuilder('u')
      .leftJoin('u.roles', 'r')
      .where('r.id = :roleId', { roleId })
      .getMany();
    for (const u of holders) await this.auth.bumpTokenVersion(u.id);
  }

  private toSafeUser(u: UserEntity): SafeUser {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      active: u.active,
      roles: (u.roles || []).map((r) => ({ id: r.id, name: r.name })),
      permissions: u.permissionKeys(),
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  }
}
