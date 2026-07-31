/**
 * refresh-log.service.ts — records each license-refresh attempt (Phase 4c log +
 * Phase 5b persistence). Writes BOTH a structured Logger line (ops visibility)
 * AND a `refresh_events` row (the queryable store the Phase-5c anti-sharing
 * detector reads: "one key from many domains/IPs in a window").
 *
 * The token is a bearer credential and is NEVER logged or stored. Persistence is
 * best-effort: a DB hiccup writing an audit row must NEVER break a customer's
 * refresh, so the insert is caught + logged, not thrown. Rows are pruned on a
 * rolling retention window so the table stays bounded.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Repository, LessThan } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { RefreshEventEntity } from './entities/refresh-event.entity';

export type RefreshOutcome =
  | 'refreshed'      // a fresh token was minted
  | 'refused'        // valid-but-not-eligible (revoked / bad token / unknown)
  | 'term-ended'     // the paid term (renewUntil) has passed — no more renewal (C1)
  | 'rate-limited'   // per-key limit hit
  | 'origin-blocked'; // Origin didn't match the license's bound domains

// How long persisted events are kept. Long enough for the detector's window +
// admin review, bounded so the table can't grow forever. Env-tunable.
const RETENTION_MS = intOr(process.env.REFRESH_EVENT_RETENTION_MS, 30 * 24 * 3600 * 1000); // 30d
// Prune at most this often (cheap amortized housekeeping on the write path).
const PRUNE_EVERY_MS = 60 * 60 * 1000; // 1h

@Injectable()
export class RefreshLogService {
  private readonly log = new Logger('LicenseRefresh');
  private lastPruneMs = 0;

  constructor(
    @InjectRepository(RefreshEventEntity) private readonly events: Repository<RefreshEventEntity>,
  ) {}

  /** Log + persist one refresh attempt. Best-effort persistence (never throws). */
  async record(evt: { outcome: RefreshOutcome; licId?: string | null; ip?: string | null; origin?: string | null }): Promise<void> {
    // Structured line — uniform for every outcome so log volume isn't an oracle.
    this.log.log(
      `refresh outcome=${evt.outcome} lic=${evt.licId || '-'} ip=${evt.ip || '-'} origin=${evt.origin || '-'}`,
    );
    try {
      await this.events.insert({
        licId: (evt.licId || '').slice(0, 64),
        ip: (evt.ip || '').slice(0, 64),
        origin: (evt.origin || '').slice(0, 255),
        outcome: evt.outcome,
      });
      await this.maybePrune();
    } catch (e) {
      // Audit persistence must never break the refresh path.
      this.log.warn(`refresh event persist failed: ${(e as Error).message}`);
    }
  }

  /** Delete events older than the retention window, at most once per PRUNE_EVERY_MS.
   *  `nowMs` injectable for tests. */
  async maybePrune(nowMs: number = Date.now()): Promise<void> {
    if (nowMs - this.lastPruneMs < PRUNE_EVERY_MS) return;
    this.lastPruneMs = nowMs;
    const cutoff = new Date(nowMs - RETENTION_MS);
    await this.events.delete({ createdAt: LessThan(cutoff) });
  }
}

function intOr(raw: string | undefined, dflt: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
