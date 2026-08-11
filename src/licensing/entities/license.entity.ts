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

  /**
   * A SANDBOX licence: real entitlements, no commercial meaning (§1.8).
   *
   * ─── WHY NOT REUSE `package.isFree` ─────────────────────────────────────
   * They answer different questions. `isFree` is a STOREFRONT label — "this
   * plan costs nothing" — and implies `priceCents = 0`. A test licence is the
   * opposite shape: it grants a full PREMIUM package so staging exercises the
   * real premium path, while never counting as revenue. Overloading `isFree`
   * would both misreport the plan's price and quietly change free-tier logic.
   *
   * ─── WHAT IT IS FOR ─────────────────────────────────────────────────────
   * §1.8 requires test licences that are "clearly marked and non-billable".
   * Without a distinct flag, a licence issued to validate a staging deploy is
   * indistinguishable from a paying customer's: it lands in revenue queries,
   * cannot be swept before a billing reconciliation, and the admin UI cannot
   * warn that it is not a real sale.
   *
   * ─── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────
   * It does NOT change entitlement resolution. A test licence must behave
   * EXACTLY like the real thing — same features, same channel rules, same
   * expiry — or staging stops being a rehearsal for production, which is the
   * entire reason it exists.
   */
  @Column({ type: 'boolean', default: false })
  isTest!: boolean;

  // ── Runtime delivery: which engine BUILD this licence receives (§1.2) ─────
  // These are the first two steps of the four-step resolution chain
  // (pin → override → channel default → global default). Empty string means
  // "not set", so the chain falls through to the next step.

  /**
   * The customer's explicit version pin. ABSOLUTE: a pinned licence is never
   * moved by a new default, a channel promotion, a canary rollout, OR a
   * rollback. Pinning is a promise — breaking it once destroys trust in the
   * feature permanently, which is why it is checked before the admin override.
   */
  @Column({ type: 'varchar', length: 32, default: '' })
  pinnedVersion!: string;

  /** Admin "switch this one customer" — e.g. move them off a bad build. */
  @Column({ type: 'varchar', length: 32, default: '' })
  overrideVersion!: string;

  /**
   * Why the override exists. MANDATORY when overrideVersion is set: an
   * unexplained override rots — someone is moved back to dodge a bug, then
   * forgotten for years, quietly missing features they pay for.
   */
  @Column({ type: 'varchar', length: 300, default: '' })
  overrideReason!: string;

  /** Unix seconds when the override should be reviewed; 0 = never set. */
  @Column({ type: 'int', default: 0 })
  overrideReviewAt!: number;

  /**
   * Opt-in release channel: 'stable' | 'beta' | 'internal'. Leaving beta does
   * NOT auto-downgrade (T15) — content written by a newer engine may not open
   * in an older one, so the customer is held until stable catches up.
   */
  @Column({ type: 'varchar', length: 16, default: 'stable' })
  channel!: string;

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
