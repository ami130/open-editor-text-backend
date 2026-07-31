/**
 * sharing-detector.service.ts — Phase 5c anti-sharing detection. Reads the
 * persisted refresh fetch-log (`refresh_events`, Phase 5b) and decides whether a
 * license looks SHARED: one key refreshing from many distinct origins/IPs within
 * a window.
 *
 * SOFT by design (locked decision): detection sets a soft `flaggedAt` on the
 * license — it KEEPS WORKING — and surfaces in admin for a human to confirm a
 * revoke. No auto-revoke (a CDN / many-PoP / rotating-office-IP customer looks
 * exactly like sharing; false positives would cut off paying customers).
 *
 * Runs INLINE on refresh (cheap, indexed on (licId, createdAt)) — no scheduler.
 */
import { Injectable, Inject } from '@nestjs/common';
import { Repository, MoreThan, In } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { RefreshEventEntity } from './entities/refresh-event.entity';
import { LicenseEntity } from '../licensing/entities/license.entity';

export interface SharingSignal {
  anomalous: boolean;
  distinctOrigins: number;
  distinctIps: number;
  reason: string;
}

@Injectable()
export class SharingDetectorService {
  private readonly windowMs: number;
  private readonly maxOrigins: number;
  private readonly maxIps: number;

  constructor(
    @InjectRepository(RefreshEventEntity) private readonly events: Repository<RefreshEventEntity>,
    @InjectRepository(LicenseEntity) private readonly licenses: Repository<LicenseEntity>,
  ) {
    this.windowMs = intOr(process.env.SHARING_WINDOW_MS, 24 * 3600 * 1000); // 24h
    // Thresholds are EXCLUSIVE ceilings: > N distinct trips the flag. Generous by
    // default so legitimate prod+staging+www (already ≤ a few) never trips.
    this.maxOrigins = intOr(process.env.SHARING_MAX_ORIGINS, 5);
    this.maxIps = intOr(process.env.SHARING_MAX_IPS, 10);
  }

  // Outcomes that count as "this KEY was actually presented from this origin/IP":
  //   • refreshed     — a valid, on-domain refresh.
  //   • origin-blocked — the key WAS valid (resolved to this license) but came from
  //     a domain it isn't bound to. This is the STRONGEST sharing signal (audit C3):
  //     a domain-bound key being used on many unauthorized sites. Excluding it (the
  //     old bug) made domain-bound keys — the ones worth protecting — nearly
  //     unflaggable. term-ended is also key-resolved but not sharing-relevant.
  // Excluded: 'refused' (garbage/unknown/revoked — licId may be empty, and a random
  // refused hit shouldn't implicate the customer) and 'rate-limited' (already a hit).
  private static readonly COUNTED_OUTCOMES = ['refreshed', 'origin-blocked'];

  /**
   * Evaluate a license's recent refresh activity. Counts events where the KEY was
   * genuinely presented (refreshed OR origin-blocked — see COUNTED_OUTCOMES).
   * `nowMs` injectable for tests.
   */
  async evaluate(licId: string, nowMs: number = Date.now()): Promise<SharingSignal> {
    if (!licId) return { anomalous: false, distinctOrigins: 0, distinctIps: 0, reason: '' };
    const since = new Date(nowMs - this.windowMs);
    const rows = await this.events.find({
      where: { licId, outcome: In(SharingDetectorService.COUNTED_OUTCOMES), createdAt: MoreThan(since) },
      select: ['origin', 'ip'],
    });
    const origins = new Set<string>();
    const ips = new Set<string>();
    for (const r of rows) {
      if (r.origin) origins.add(r.origin);
      if (r.ip) ips.add(r.ip);
    }
    const dO = origins.size;
    const dI = ips.size;
    const overOrigins = dO > this.maxOrigins;
    const overIps = dI > this.maxIps;
    const anomalous = overOrigins || overIps;
    const hrs = Math.round(this.windowMs / 3600000);
    const parts: string[] = [];
    if (overOrigins) parts.push(`${dO} distinct origins`);
    if (overIps) parts.push(`${dI} distinct IPs`);
    return {
      anomalous,
      distinctOrigins: dO,
      distinctIps: dI,
      reason: anomalous ? `${parts.join(' + ')} in ${hrs}h` : '',
    };
  }

  /**
   * Evaluate and, if anomalous, SET the soft flag on the license (idempotent —
   * refreshes the reason but keeps the FIRST flaggedAt so admins see when it
   * started). Never changes `status`; the license keeps working. Returns the
   * signal. Best-effort: a detector failure must never break the refresh path,
   * so callers wrap this in try/catch (or ignore the promise).
   */
  async evaluateAndFlag(licId: string, nowMs: number = Date.now()): Promise<SharingSignal> {
    const signal = await this.evaluate(licId, nowMs);
    if (!signal.anomalous) return signal;
    const lic = await this.licenses.findOne({ where: { licId }, select: ['id', 'flaggedAt'] });
    if (!lic) return signal;
    // TARGETED column update — NOT a full-entity save (audit D1). This runs
    // fire-and-forget OUTSIDE the refresh transaction; a full save of a stale
    // snapshot could clobber a concurrent refresh's freshly-minted token/exp.
    // Updating only the two flag columns can never stomp the token row fields.
    // First-seen flaggedAt is preserved; flagReason always reflects current spread.
    const patch: { flagReason: string; flaggedAt?: number } = { flagReason: signal.reason };
    if (!lic.flaggedAt) patch.flaggedAt = Math.floor(nowMs / 1000);
    await this.licenses.update({ id: lic.id }, patch);
    return signal;
  }
}

function intOr(raw: string | undefined, dflt: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
