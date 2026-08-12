/**
 * license-install.service.ts — the install-ID cap (§2.4).
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 * A licence may be used by at most `maxInstalls` distinct browser installs.
 * The cap is ADDITIVE: the licence key remains the primary credential and the
 * domain gate (T11) still applies. This only bounds HOW MANY machines one key
 * serves — which is precisely the hole the localhost exemption leaves open.
 *
 * ─── WHY "ADDITIVE" IS THE WHOLE DESIGN ─────────────────────────────────────
 * An install id lives in localStorage and is reset by clearing site data. If it
 * were the sole credential, a paying customer clearing their browser would lose
 * premium — and worse, a customer who legitimately churns through machines
 * would eventually be locked out of the product they paid for. Both are far
 * more damaging than the sharing they would prevent.
 *
 * So enforcement is asymmetric ON PURPOSE:
 *
 *   • A KNOWN install always passes. Once a seat exists it keeps working, even
 *     if the cap is later lowered below the current count.
 *   • A NEW install past the cap is refused PREMIUM — it still gets a working
 *     free editor, never a broken page (the same never-a-dead-end contract the
 *     rest of delivery follows).
 *   • Refusals are recorded, so the customer's real usage is visible to support
 *     and a genuine multi-machine customer can be upgraded rather than argued
 *     with.
 *
 * ─── FAILURE POSTURE: FAIL OPEN ─────────────────────────────────────────────
 * Every path here is wrapped so a database problem CANNOT cost a paying
 * customer their premium features. If the cap cannot be evaluated, the licence
 * is honoured. An anti-sharing control that takes premium away from payers
 * during an outage is a worse bug than the sharing it prevents.
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LicenseInstallEntity } from './entities/license-install.entity';

/**
 * Default seats per licence when a package does not specify.
 *
 * 5 covers the real shapes of legitimate use — laptop + desktop + a second
 * browser + CI + a rebuilt machine — while making a key posted to a team chat
 * stop working quickly. It is a package-level default, not a hard limit: see
 * `maxInstalls` on PackageEntity for the per-plan override.
 */
export const DEFAULT_MAX_INSTALLS = 5;

export interface InstallCheck {
  /** May this caller receive their PAID plan? False = fall back to free. */
  allowed: boolean;
  /** Distinct non-blocked installs on this licence, after the check. */
  count: number;
  /** The cap applied (0 = unlimited). */
  cap: number;
  /** True only when this call created a new seat, for logging. */
  isNew: boolean;
}

const ALLOW: InstallCheck = { allowed: true, count: 0, cap: 0, isNew: false };

@Injectable()
export class LicenseInstallService {
  private readonly log = new Logger(LicenseInstallService.name);

  constructor(
    @InjectRepository(LicenseInstallEntity)
    private readonly installs: Repository<LicenseInstallEntity>,
  ) {}

  /**
   * Evaluate (and record) one install against a licence's cap.
   *
   * `cap <= 0` means unlimited — the default for every existing package, so
   * this feature is inert until a plan opts in. A missing installId (private
   * browsing, storage blocked) is ALWAYS allowed: the loader degrades to
   * anonymous by design, and punishing that would break legitimate users on
   * locked-down browsers.
   */
  async check(licId: string, installId: string | null, origin: string | null, cap: number): Promise<InstallCheck> {
    const max = Number(cap) || 0;
    if (max <= 0) return ALLOW;
    if (!licId) return ALLOW;
    // No install id → cannot be attributed to a seat. Allow: see above.
    if (!installId) return ALLOW;

    try {
      const existing = await this.installs.findOne({ where: { licId, installId } });

      if (existing) {
        // KNOWN SEAT — always allowed, even if it was previously blocked and
        // the cap has since been raised, and even if the count now exceeds the
        // cap because the cap was lowered. Touch lastSeenAt/origin for support.
        const wasBlocked = existing.blocked;
        const count = await this.activeCount(licId);
        if (wasBlocked && count >= max) {
          // Still over cap: keep it blocked, but refresh the sighting so the
          // customer's real usage stays visible.
          await this.touch(existing, origin, true);
          return { allowed: false, count, cap: max, isNew: false };
        }
        await this.touch(existing, origin, false);
        return { allowed: true, count, cap: max, isNew: false };
      }

      // NEW SEAT — count what is already active, then decide.
      const count = await this.activeCount(licId);
      const overCap = count >= max;

      await this.record(licId, installId, origin, overCap);

      if (overCap) {
        this.log.warn(
          `install cap reached: licId=${licId} installs=${count} cap=${max} — new install refused premium`,
        );
        return { allowed: false, count, cap: max, isNew: true };
      }
      return { allowed: true, count: count + 1, cap: max, isNew: true };
    } catch (err) {
      // FAIL OPEN. A DB error must never downgrade a paying customer.
      this.log.error(`install check failed for licId=${licId}; allowing (fail-open): ${String(err)}`);
      return ALLOW;
    }
  }

  /** Distinct seats currently counting against the cap (blocked ones do not). */
  private activeCount(licId: string): Promise<number> {
    return this.installs.count({ where: { licId, blocked: false } });
  }

  /**
   * Insert a seat. The unique index makes a concurrent duplicate impossible;
   * if two tabs race, one insert loses and we treat that as "already known",
   * which is the correct outcome rather than an error.
   */
  private async record(licId: string, installId: string, origin: string | null, blocked: boolean): Promise<void> {
    try {
      await this.installs.insert({
        licId,
        installId,
        origin: (origin || '').slice(0, 255),
        blocked,
      });
    } catch {
      /* unique-violation from a concurrent tab: the seat exists, nothing to do */
    }
  }

  private async touch(row: LicenseInstallEntity, origin: string | null, blocked: boolean): Promise<void> {
    try {
      await this.installs.update(
        { id: row.id },
        { origin: (origin || row.origin || '').slice(0, 255), blocked },
      );
    } catch {
      /* best-effort: a failed touch must not affect entitlement */
    }
  }

  /** Seats for a licence — powers the portal/admin view and support queries. */
  async listForLicence(licId: string): Promise<LicenseInstallEntity[]> {
    return this.installs.find({ where: { licId }, order: { lastSeenAt: 'DESC' } });
  }

  /**
   * Release a seat so the customer can re-activate elsewhere (support action,
   * and the recovery path for "I cleared my browser / replaced my laptop").
   * Deleting rather than flagging keeps the count honest.
   */
  async release(licId: string, installId: string): Promise<boolean> {
    const res = await this.installs.delete({ licId, installId });
    return (res.affected || 0) > 0;
  }
}
