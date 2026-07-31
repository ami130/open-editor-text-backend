/**
 * package.entity.ts — a sellable plan the admin composes by hand-picking
 * individual features and setting a price (e.g. Free, Pro, Premium — but any
 * name / any feature combination). Fully dynamic; not hardcoded tiers.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, ManyToMany, JoinTable,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { FeatureEntity } from './feature.entity';

@Entity('packages')
export class PackageEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 500, default: '' })
  description!: string;

  /** Price in the smallest currency unit (e.g. cents) to avoid float issues. */
  @Column({ type: 'int', default: 0 })
  priceCents!: number;

  @Column({ type: 'varchar', length: 8, default: 'USD' })
  currency!: string;

  /**
   * 'once' (one-time purchase) | 'monthly' | 'yearly' (subscription) | 'lifetime'
   * (perpetual, modelled as a max-TTL token re-minted on renewal). The interval
   * DRIVES the license lifetime + refresh policy via `durationPolicy()` (Phase 3);
   * it is no longer orthogonal to the TTL.
   */
  @Column({ type: 'varchar', length: 16, default: 'once' })
  billingInterval!: string;

  /**
   * A storefront/pricing LABEL: this package is offered free. It does NOT change
   * which features the shipped npm bundle unlocks (that is derived from the
   * editor's own catalog). Enforced coherent server-side: isFree ⇒ priceCents=0
   * and billingInterval='once'. (Phase 3)
   */
  @Column({ type: 'boolean', default: false })
  isFree!: boolean;

  /**
   * Whether licenses of this package are meant to auto-renew ('auto') or not
   * ('manual'). DERIVED from the billing interval at save time via
   * `durationPolicy()`. Persisted + snapshotted now so Phase 4's refresh endpoint
   * has it; Phase 3 does NOT build refresh runtime — this is a policy label. (Phase 3)
   */
  @Column({ type: 'varchar', length: 8, default: 'manual' })
  refreshPolicy!: string;

  /** Whether licenses from this package are domain-bound (default yes). */
  @Column({ type: 'boolean', default: true })
  domainBound!: boolean;

  /**
   * Signed-token lifetime for licenses of this package (seconds); renewed on
   * expiry. Default 30 days to match the offline-revocation model: a revoked
   * license stops working within ~one TTL, since the offline verifier can't
   * know about revocation. Keep this SHORT; longer TTLs widen the un-revocable
   * window. (L2)
   */
  @Column({ type: 'int', default: 30 * 24 * 3600 })
  licenseTtlSeconds!: number;

  /**
   * Optional admin escape hatch: an EXPLICIT token lifetime (seconds) that
   * overrides the interval-derived TTL. NULL (the normal case) means "derive from
   * billingInterval" so switching monthly→lifetime updates newly-issued licenses
   * automatically. When set, `effectiveTtlSeconds()` uses it verbatim (still
   * hard-clamped by the signer). (Phase 3, plan §7 option B)
   */
  @Column({ type: 'int', nullable: true })
  ttlOverrideSeconds!: number | null;

  /** Inactive packages can't be purchased/issued but keep their history. */
  @Column({ type: 'boolean', default: true })
  active!: boolean;

  /**
   * Whether this package appears on the PUBLIC self-serve pricing page and can
   * be bought via Stripe Checkout. Distinct from `active`: a package can be
   * active (admin-issuable) yet not publicly sold. Default false — a package is
   * never on the storefront until the admin opts it in.
   */
  @Column({ type: 'boolean', default: false })
  publiclyListed!: boolean;

  /** The exact features this package grants. */
  @ManyToMany(() => FeatureEntity, (f) => f.packages, { eager: true })
  @JoinTable({ name: 'package_features' })
  features!: FeatureEntity[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
