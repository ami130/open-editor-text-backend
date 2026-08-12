/**
 * engine-canary.entity.ts — an in-progress gradual release (§2.7).
 *
 * ONE ROW PER SCOPE (unique index), because "the canary for global" is a single
 * fact. Starting a second canary for the same scope replaces the first rather
 * than layering two partial rollouts nobody could reason about.
 *
 * Halting DELETES the row rather than setting a flag: the resolution chain then
 * has nothing to consider, which is the safest possible state during an
 * incident. A paused-but-present canary invites "why is 5% still on the bad
 * version?" at exactly the wrong moment.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('engine_canaries')
export class EngineCanaryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** 'global' or 'channel:<name>' — the same scope vocabulary as defaults. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  scope!: string;

  /** The version being trialled. */
  @Column({ type: 'varchar', length: 32 })
  version!: string;

  /** 0–100. Clamped on write; 0 effectively disables without deleting. */
  @Column({ type: 'int', default: 0 })
  percent!: number;

  /** Who started it, for the audit trail. */
  @Column({ type: 'varchar', length: 128, default: '' })
  actor!: string;

  @Column({ type: 'varchar', length: 500, default: '' })
  reason!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
