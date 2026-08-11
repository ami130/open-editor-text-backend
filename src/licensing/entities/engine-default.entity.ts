/**
 * engine-default.entity.ts — the DEFAULT VERSION POINTERS (delivery §1.2).
 *
 * One row per scope:
 *   'global'           the fallback every caller lands on
 *   'channel:beta'     overrides global for callers opted into beta
 *   'channel:internal' likewise for internal
 *
 * WHY A POINTER TABLE RATHER THAN A FLAG ON THE VERSION ROW:
 * a ROLLBACK is a pointer move here — "point global back at 1.2.0" — which
 * takes effect immediately, needs no rebuild, and leaves every published bundle
 * untouched. That is what lets bundles stay immutable (the basis of integrity
 * hashes and watermarking) while still being able to undo a bad release in
 * seconds. Marking versions active/inactive instead would mean mutating
 * published rows, and per-licence watermarking would then require rebuilding
 * every customer's bundle to roll back.
 *
 * Steps 3 and 4 of the resolution chain read this table; steps 1 and 2 (pin and
 * admin override) live on the licence row and take precedence over it — so a
 * pointer move never disturbs a pinned customer.
 */
import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/** Scope key. 'global' or `channel:${EngineChannel}`. */
export const GLOBAL_SCOPE = 'global';
export const channelScope = (channel: string): string => `channel:${channel}`;

@Entity('engine_defaults')
export class EngineDefaultEntity {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  scope!: string;

  /**
   * The version this scope points at. Empty string means "not configured" —
   * resolution then falls through to the next chain step, and ultimately fails
   * closed rather than guessing a version.
   */
  @Column({ type: 'varchar', length: 32 })
  version!: string;

  @UpdateDateColumn()
  updatedAt!: Date;
}
