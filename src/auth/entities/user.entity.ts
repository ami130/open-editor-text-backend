/**
 * user.entity.ts — an ADMIN-PANEL user (staff), NOT an editor customer. Holds
 * roles; roles hold permissions. The password is stored only as a bcrypt hash
 * (never plaintext), and is excluded from default selects so it can't leak.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, ManyToMany, JoinTable,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { RoleEntity } from './role.entity';

@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200, unique: true })
  email!: string;

  @Column({ type: 'varchar', length: 120, default: '' })
  name!: string;

  /**
   * bcrypt hash. `select: false` so it is NOT returned by ordinary finds —
   * queries that need it (login) must ask for it explicitly. Never serialized
   * to a response.
   */
  @Column({ type: 'varchar', length: 100, select: false })
  passwordHash!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  /**
   * Bumped whenever all sessions must be invalidated (password change, forced
   * logout). Access AND refresh tokens carry this; a mismatch rejects the token
   * (checked on every request, so revocation is immediate).
   */
  @Column({ type: 'int', default: 0 })
  tokenVersion!: number;

  /**
   * The id (jti) of the CURRENTLY-valid refresh token. Refresh rotation stores
   * a fresh jti here; presenting a refresh token whose jti != this one means an
   * already-rotated (replayed/stolen) token — reuse detection then revokes the
   * whole family by bumping tokenVersion. Empty = no active refresh session.
   */
  @Column({ type: 'varchar', length: 64, default: '' })
  refreshTokenId!: string;

  @ManyToMany(() => RoleEntity, (r) => r.users, { eager: true })
  @JoinTable({ name: 'user_roles' })
  roles!: RoleEntity[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  /** Flattened, de-duplicated permission keys across all roles. */
  permissionKeys(): string[] {
    const set = new Set<string>();
    for (const role of this.roles || []) {
      for (const perm of role.permissions || []) set.add(perm.key);
    }
    return [...set];
  }
}
