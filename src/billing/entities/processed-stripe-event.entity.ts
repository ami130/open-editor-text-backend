/**
 * processed-stripe-event.entity.ts — an idempotency ledger for Stripe webhooks.
 *
 * Stripe delivers events AT LEAST ONCE (retries on non-2xx, network hiccups,
 * manual re-sends). Before acting on an event we INSERT its id here; a primary-
 * key conflict means we've already handled it → skip. This guarantees a paid
 * checkout mints exactly ONE license no matter how many times the event lands.
 */
import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('processed_stripe_events')
export class ProcessedStripeEventEntity {
  /** The Stripe event id (evt_...). Primary key = the dedup guarantee. */
  @PrimaryColumn({ type: 'varchar', length: 200 })
  eventId!: string;

  @Column({ type: 'varchar', length: 80, default: '' })
  type!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
