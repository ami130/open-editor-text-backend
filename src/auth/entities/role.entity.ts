/**
 * role.entity.ts — a named bundle of permissions (e.g. "admin", "manager",
 * "support"). Roles are DYNAMIC — an admin can create roles and assign
 * permissions. A user can hold multiple roles; their effective permissions are
 * the union.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, ManyToMany, JoinTable,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { PermissionEntity } from './permission.entity';
import { UserEntity } from './user.entity';

@Entity('roles')
export class RoleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 60, unique: true })
  name!: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  description!: string;

  /** Built-in roles (e.g. the seeded "admin") can't be deleted. */
  @Column({ type: 'boolean', default: false })
  system!: boolean;

  @ManyToMany(() => PermissionEntity, (p) => p.roles, { eager: true })
  @JoinTable({ name: 'role_permissions' })
  permissions!: PermissionEntity[];

  @ManyToMany(() => UserEntity, (u) => u.roles)
  users?: UserEntity[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
