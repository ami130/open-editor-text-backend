/**
 * engine-default-history.entity.ts — every change to a default pointer (§2.8).
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `engine_defaults` stores only the CURRENT pointer. That is all serving needs,
 * and it is precisely the wrong shape during an incident:
 *
 *   03:00. Sessions are failing. You know v1.4.0 is bad. Rolling back means
 *   naming the version to go back to — and the only record of what was
 *   serving an hour ago is a value that has already been overwritten.
 *
 * Without history, "roll back" becomes "guess a version number, under pressure,
 * on a system every customer is hitting simultaneously". With it, rollback is a
 * lookup: the previous row IS the last-known-good target.
 *
 * ─── APPEND-ONLY ────────────────────────────────────────────────────────────
 * Rows are never updated or deleted. This doubles as the audit trail for "who
 * changed what every customer receives, and when" — a question that currently
 * has no answer beyond a log line that may have rotated away.
 *
 * Volume is trivial: a row per deliberate release or rollback, not per request.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn,
} from 'typeorm';

@Entity('engine_default_history')
@Index(['scope', 'createdAt'])
export class EngineDefaultHistoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** 'global' or 'channel:stable' etc — the pointer that moved. */
  @Column({ type: 'varchar', length: 32 })
  scope!: string;

  /**
   * What it pointed at BEFORE this change. Empty for the very first set.
   * This is the field rollback actually reads.
   */
  @Column({ type: 'varchar', length: 32, default: '' })
  fromVersion!: string;

  /** What it points at after this change. */
  @Column({ type: 'varchar', length: 32 })
  toVersion!: string;

  /** 'release' | 'rollback' — so an incident is distinguishable from a launch. */
  @Column({ type: 'varchar', length: 16, default: 'release' })
  kind!: string;

  /** Who did it. Empty when performed by an automated process. */
  @Column({ type: 'varchar', length: 128, default: '' })
  actor!: string;

  /** Free-text reason, for the incident write-up. */
  @Column({ type: 'varchar', length: 500, default: '' })
  reason!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
