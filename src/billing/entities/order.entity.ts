/**
 * order.entity.ts — a purchase attempt and its outcome: the bridge between a
 * Stripe Checkout Session and an issued LicenseEntity.
 *
 * Lifecycle: created `pending` when we start Checkout → flipped to `fulfilled`
 * by the (signature-verified, idempotent) webhook, which mints the license and
 * links it here. The buyer's details are snapshotted at checkout time so the
 * order is a durable record of the sale even if the package/customer changes.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { PackageEntity } from '../../licensing/entities/package.entity';
import { LicenseEntity } from '../../licensing/entities/license.entity';

export type OrderStatus = 'pending' | 'fulfilled' | 'failed' | 'expired';

@Entity('orders')
export class OrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The Stripe Checkout Session id (cs_...). Unique — one order per session. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 200 })
  stripeSessionId!: string;

  /** The Stripe event id that fulfilled this order (idempotency audit trail). */
  @Column({ type: 'varchar', length: 200, default: '' })
  stripeEventId!: string;

  // The package being bought. SET NULL on delete keeps the order's history even
  // if the package is later removed; the snapshot fields below preserve terms.
  @ManyToOne(() => PackageEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'packageId' })
  package!: PackageEntity | null;

  /** Snapshot of the sale terms at checkout time (authoritative, server-set). */
  @Column({ type: 'varchar', length: 120, default: '' })
  packageName!: string;

  @Column({ type: 'int', default: 0 })
  amountCents!: number;

  @Column({ type: 'varchar', length: 8, default: 'USD' })
  currency!: string;

  /**
   * Snapshot of the package's feature ids + domain-binding at checkout time, so
   * the order can be fulfilled even if the package is edited/deleted between
   * checkout and payment (the sale's terms are fixed at purchase). JSON text.
   */
  @Column({ type: 'simple-json' })
  featureIds!: string[];

  @Column({ type: 'boolean', default: true })
  domainBound!: boolean;

  /** Snapshot of the package's signed-token lifetime (seconds) at checkout, so
   *  a self-serve license gets the PLAN's term, not the signer default. (L3) */
  @Column({ type: 'int', default: 0 })
  licenseTtlSeconds!: number;

  /** Snapshot of the package's billing interval at checkout (once/monthly/yearly/
   *  lifetime), so fulfillment + the Phase-4 refresh endpoint know the sold term
   *  even if the package is later edited. (Phase 3) */
  @Column({ type: 'varchar', length: 16, default: 'once' })
  billingInterval!: string;

  /** Snapshot of the package's refresh policy at checkout ('auto'|'manual').
   *  Consumed by Phase 4's refresh endpoint; a label in Phase 3. (Phase 3) */
  @Column({ type: 'varchar', length: 8, default: 'manual' })
  refreshPolicy!: string;

  /** Buyer details collected at checkout. */
  @Column({ type: 'varchar', length: 200 })
  customerEmail!: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  customerName!: string;

  /** Domains the buyer entered (for domain-bound licenses). JSON text. */
  @Column({ type: 'simple-json' })
  domains!: string[];

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: OrderStatus;

  /** The license minted on fulfillment (null until paid + fulfilled). */
  @ManyToOne(() => LicenseEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'licenseId' })
  license!: LicenseEntity | null;

  /**
   * Whether the license key has already been shown on the success page. The
   * key is returned to the buyer's browser exactly ONCE; subsequent reads of
   * the success endpoint (a leaked/replayed session-id URL) get a "already
   * retrieved — check your email" response instead of the bearer token.
   */
  @Column({ type: 'boolean', default: false })
  licenseDelivered!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
