/**
 * license-activation.entity.ts — a ONE-TIME, EXPIRING claim that hands a
 * freshly-purchased licence key to the exact browser that bought it (§2.4).
 *
 * ─── THE PROBLEM ────────────────────────────────────────────────────────────
 * Buying premium currently ends with "check your email, copy the key, paste it
 * into your config". That works, but the editor the customer is looking at
 * stays free until they do it. Activation closes the loop: the buyer enters the
 * install id shown in their editor at checkout, and the running editor upgrades
 * itself.
 *
 * ─── WHY THIS IS ONE-TIME AND SHORT-LIVED (THE WHOLE SECURITY ARGUMENT) ─────
 * The obvious design — "installId maps to licence, hand over premium whenever
 * that id appears" — is UNSAFE HERE, and it is worth being explicit about why,
 * because it looks reasonable until you check one fact:
 *
 *   `installId` IS WRITTEN TO THE SERVER LOGS ON EVERY SINGLE SESSION
 *   (see delivery/usage-log.ts).
 *
 * An install id is therefore NOT a secret. If presenting one were enough to
 * receive premium, then anyone who could read a log line — an ops contractor, a
 * log aggregator, a leaked backup — would have permanent free premium, and it
 * would be indistinguishable from legitimate use. That would be a worse hole
 * than the localhost sharing this whole phase set out to close.
 *
 * So the claim is deliberately constrained:
 *
 *   • ONE-TIME. `claimedAt` is set on first use; every later attempt with the
 *     same id returns nothing. A logged id is useless after the first page load
 *     that consumes it.
 *   • EXPIRING. An unclaimed activation dies after `expiresAt` (hours, not
 *     days), so an id captured before the buyer ever loads the editor has a
 *     narrow window rather than an open one.
 *   • NOT THE CREDENTIAL ITSELF. A successful claim returns the real signed
 *     licence key, which is what authorises every later session. The install id
 *     is a delivery mechanism, never a standing entitlement.
 *
 * The residual risk is one page load wide: an attacker who reads a log line
 * BEFORE the buyer's own editor claims it could take the key. That is the same
 * exposure as the licence email itself, it is bounded, and it is recorded —
 * `claimedFromOrigin` and `claimedAt` make a stolen claim visible after the
 * fact rather than silent.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn,
} from 'typeorm';

@Entity('license_activations')
export class LicenseActivationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The install id the buyer typed at checkout. UNIQUE: one pending activation
   * per install at a time, so a second purchase for the same browser replaces
   * rather than queues (see LicenseActivationService.create).
   */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 128 })
  installId!: string;

  /** The licence to hand over. */
  @Column({ type: 'varchar', length: 64 })
  licId!: string;

  /**
   * Set the moment the key is handed out. Non-null = spent, and no amount of
   * replaying the install id will produce the key again. This single column is
   * what makes a logged install id safe.
   */
  @Column({ type: 'datetime', nullable: true, default: null })
  claimedAt!: Date | null;

  /** Where the claim came from — forensics for a disputed or stolen claim. */
  @Column({ type: 'varchar', length: 255, default: '' })
  claimedFromOrigin!: string;

  /** Unclaimed activations die here. Hours, not days — see the header. */
  @Column({ type: 'datetime' })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
