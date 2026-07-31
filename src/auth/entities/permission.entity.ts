/**
 * permission.entity.ts — a granular admin capability, e.g. "package.create",
 * "license.issue". These gate ADMIN actions in the backend (distinct from the
 * editor-feature licenses sold to customers). Seeded from a fixed catalog.
 */
import { Entity, PrimaryColumn, Column, ManyToMany } from 'typeorm';
import { RoleEntity } from './role.entity';

@Entity('permissions')
export class PermissionEntity {
  /** The permission key, e.g. "package.create". */
  @PrimaryColumn({ type: 'varchar', length: 100 })
  key!: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  description!: string;

  @ManyToMany(() => RoleEntity, (r) => r.permissions)
  roles?: RoleEntity[];
}
