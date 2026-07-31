/**
 * license.entity.ts — an issued license RECORD.
 *
 * Note the split between the DB record and the signed token:
 *   • The record is the source of truth for status/renewal (perpetual by
 *     design — a license can be renewed forever).
 *   • The signed token has a bounded lifetime (≤ ~3y, the verifier's ceiling),
 *     so "perpetual" is realized by RE-MINTING on renewal. The record's status
 *     is what "revoke" flips — the current token simply isn't renewed and
 *     expires.
 * We snapshot the granted `features`/`domains` on the license so a later change
 * to the package doesn't retroactively alter already-issued licenses.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { CustomerEntity } from './customer.entity';
import { PackageEntity } from './package.entity';

export type LicenseStatus = 'active' | 'revoked' | 'expired';

@Entity('licenses')
export class LicenseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The `lic` claim inside the signed token (human-referenceable id). */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  licId!: string;

  @ManyToOne(() => CustomerEntity, (c) => c.licenses, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerId' })
  customer!: CustomerEntity;

  // NOT eager: list() must not join/duplicate; load relations explicitly.
  @ManyToOne(() => PackageEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'packageId' })
  package!: PackageEntity | null;

  /**
   * Snapshot of the plan name + price at issue time. Kept ON the license so the
   * sale's terms survive even if the package is later renamed/repriced/deleted
   * (onDelete SET NULL nulls the relation, but this history remains). (I5)
   */
  @Column({ type: 'varchar', length: 120, default: '' })
  planName!: string;

  @Column({ type: 'int', default: 0 })
  planPriceCents!: number;

  @Column({ type: 'varchar', length: 8, default: 'USD' })
  planCurrency!: string;

  /** Snapshot of granted feature ids at issue time. */
  @Column({ type: 'simple-json' })
  features!: string[];

  /** Snapshot of bound domains at issue time. */
  @Column({ type: 'simple-json' })
  domains!: string[];

  /**
   * The admin-controlled lifecycle state. NOTE: 'expired' is NOT stored here —
   * expiry is time-based and derived (see effectiveStatus / isExpired). This
   * column only records deliberate admin actions: 'active' vs 'revoked'.
   */
  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: LicenseStatus;

  /** The currently-issued signed JWS token (re-minted on renewal). */
  @Column({ type: 'text' })
  token!: string;

  /** Key id used to sign the current token (for rotation/audit). */
  @Column({ type: 'varchar', length: 64 })
  kid!: string;

  @Column({ type: 'int' })
  issuedAt!: number; // unix seconds (token iat)

  @Column({ type: 'int' })
  expiresAt!: number; // unix seconds (token exp)

  /**
   * The paid-TERM boundary (unix seconds): silent refresh (Phase 4c) re-mints a
   * fresh token ONLY while now < renewUntil. This is what stops "renew forever"
   * (audit C1) — billing is one-time-per-term (mode:'payment'), so a monthly
   * license is a 30-day term, not a recurring charge; past renewUntil the token
   * lapses within one TTL and the customer re-purchases (or an admin extends).
   * Set at issue = issuedAt + term(interval) for FINITE intervals.
   * -1 = INFINITE_TERM sentinel (audit B1): a `lifetime` license is TRULY perpetual
   *      — refresh re-mints forever, never term-ends. Stored as -1 (not a far-future
   *      timestamp) because this column is a MySQL `int` (max ~year 2038) and the old
   *      "far-future" value was a real ~3y wall, the exact bug B1 fixes.
   *  0 = legacy/pre-Phase-4c row → term DERIVED from createdAt+interval (see
   *      effectiveRenewUntil); a legacy lifetime row is treated as perpetual too.
   */
  @Column({ type: 'int', default: 0 })
  renewUntil!: number;

  /**
   * Anti-sharing SOFT FLAG (Phase 5c): unix seconds when this license tripped the
   * sharing detector (one key seen from many domains/IPs), else 0. This is
   * DELIBERATELY separate from `status` — a flagged license KEEPS WORKING (soft
   * signal, not enforcement). It surfaces in the admin UI for a human to review
   * and decide whether to revoke. Cleared (set 0) if an admin dismisses it.
   */
  @Column({ type: 'int', default: 0 })
  flaggedAt!: number;

  /** Short human-readable reason for the flag (e.g. "6 distinct origins in 24h").
   *  Empty when not flagged. Informational only. (Phase 5c) */
  @Column({ type: 'varchar', length: 200, default: '' })
  flagReason!: string;

  /**
   * Expiry-reminder idempotency (audit B2): unix seconds the "your access is ending
   * soon" email was sent for the CURRENT term, else 0. Set inline on refresh when a
   * FINITE-term token nears renewUntil, so the reminder fires exactly once per term
   * (not on every near-expiry refresh). Admin `renew` resets it to 0 — a fresh term
   * earns a fresh reminder. Lifetime licenses (renewUntil = INFINITE_TERM) never
   * reach the near-expiry window, so they never trip this.
   */
  @Column({ type: 'int', default: 0 })
  reminderSentAt!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  /** True if the current token is past its exp (time-based, not stored). */
  isExpired(now: number = Math.floor(Date.now() / 1000)): boolean {
    return now >= this.expiresAt;
  }

  /**
   * The EFFECTIVE status combining the stored lifecycle with time: a revoked
   * license is revoked; otherwise an active-but-past-exp license is 'expired'.
   * This is what admin/reporting should display — the DB never writes
   * 'expired', so reading `status` alone would wrongly show an old license as
   * 'active' forever. (I6)
   */
  effectiveStatus(now: number = Math.floor(Date.now() / 1000)): LicenseStatus {
    if (this.status === 'revoked') return 'revoked';
    return this.isExpired(now) ? 'expired' : 'active';
  }
}
