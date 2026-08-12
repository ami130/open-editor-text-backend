/**
 * license-activation.service.ts — mint and redeem one-time activation claims
 * (§2.4 checkout-time activation).
 *
 * See LicenseActivationEntity for the security argument. The short version:
 * install ids are written to the logs, so a claim must be single-use and
 * short-lived or a log line becomes a permanent free licence.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, LessThan } from 'typeorm';
import { LicenseActivationEntity } from './entities/license-activation.entity';

/**
 * How long an unclaimed activation stays live.
 *
 * Long enough to survive a real purchase flow (pay on a phone, come back to the
 * desktop later, or a delayed webhook), short enough that an install id
 * captured from a log has a narrow window. 48h is the balance; it is not a
 * secret-strength parameter, because the claim is single-use anyway.
 */
export const ACTIVATION_TTL_HOURS = 48;

@Injectable()
export class LicenseActivationService {
  private readonly log = new Logger(LicenseActivationService.name);

  constructor(
    @InjectRepository(LicenseActivationEntity)
    private readonly activations: Repository<LicenseActivationEntity>,
  ) {}

  /**
   * Register a pending activation at fulfilment time.
   *
   * UPSERT by installId rather than insert: a customer who buys twice for the
   * same browser (an upgrade, or a retry after a failed payment) must end up
   * pointing at their NEWEST licence, not colliding with a stale row and
   * silently getting nothing. The unique index makes that collision certain
   * otherwise.
   *
   * Never throws: activation is a convenience on top of a completed purchase.
   * The customer already has their key by email, and a failure here must not
   * roll back or fail a paid order.
   */
  async create(installId: string | null | undefined, licId: string, now = new Date()): Promise<boolean> {
    const id = (installId || '').trim();
    if (!id || !licId) return false;

    const expiresAt = new Date(now.getTime() + ACTIVATION_TTL_HOURS * 3600 * 1000);
    try {
      const existing = await this.activations.findOne({ where: { installId: id } });
      if (existing) {
        // Re-arm the row: new licence, fresh window, unclaimed again.
        await this.activations.update(
          { id: existing.id },
          { licId, expiresAt, claimedAt: null, claimedFromOrigin: '' },
        );
      } else {
        await this.activations.insert({ installId: id, licId, expiresAt, claimedAt: null });
      }
      return true;
    } catch (err) {
      this.log.error(`could not register activation for install ${id}: ${String(err)}`);
      return false;
    }
  }

  /**
   * Redeem a claim. Returns the licId to hand over, or null.
   *
   * ⚠️ THE UPDATE IS THE LOCK. The claim is taken with a CONDITIONAL UPDATE
   * (`claimedAt IS NULL`) and we trust the affected-row count — NOT a
   * read-then-write, which would let two tabs opening simultaneously both see
   * "unclaimed" and both be handed the key. Exactly one caller can observe
   * `affected === 1`, and only that caller receives the licence.
   *
   * Fails CLOSED (returns null) on any error: a broken activation lookup must
   * never hand out a licence it could not verify. This is the opposite posture
   * to the seat cap, which fails open — there, failing open protects a payer;
   * here, failing open would give premium away.
   */
  async claim(installId: string | null | undefined, origin: string | null, now = new Date()): Promise<string | null> {
    const id = (installId || '').trim();
    if (!id) return null;

    try {
      const row = await this.activations.findOne({ where: { installId: id } });
      if (!row) return null;
      // Fast path only — NOT the lock. Verified by disabling both: with only
      // this check removed the suite still passed, and it took removing the
      // conditional UPDATE below to make a replay succeed. The UPDATE is what
      // actually enforces single-use; this just avoids a pointless write.
      if (row.claimedAt) return null;              // already spent
      if (row.expiresAt.getTime() <= now.getTime()) return null; // window closed

      const res = await this.activations.update(
        // The WHERE is the guard: only an UNCLAIMED row is taken.
        { id: row.id, claimedAt: IsNull() },
        { claimedAt: now, claimedFromOrigin: (origin || '').slice(0, 255) },
      );
      if ((res.affected || 0) !== 1) return null;  // lost the race — someone else claimed it

      this.log.log(`activation claimed: install=${id} licId=${row.licId}`);
      return row.licId;
    } catch (err) {
      this.log.error(`activation claim failed for install ${id}; refusing (fail-closed): ${String(err)}`);
      return null;
    }
  }

  /** Pending (unclaimed, unexpired) activation for support/debugging. */
  async pendingFor(installId: string, now = new Date()): Promise<LicenseActivationEntity | null> {
    const row = await this.activations.findOne({ where: { installId } });
    if (!row || row.claimedAt || row.expiresAt.getTime() <= now.getTime()) return null;
    return row;
  }

  /**
   * Drop activations that expired long ago. Claimed rows are KEPT — they are the
   * audit trail showing which browser took which key, and are the only evidence
   * available if a customer disputes an activation.
   */
  async pruneExpired(before = new Date()): Promise<number> {
    const res = await this.activations.delete({ claimedAt: IsNull(), expiresAt: LessThan(before) });
    return res.affected || 0;
  }
}
