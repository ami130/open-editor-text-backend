/**
 * refresh-rate-limiter.ts — a small in-memory PER-KEY (per-license) rate limiter
 * for the public refresh endpoint (Phase 4c). The global ThrottlerGuard already
 * caps per-IP; this adds a per-license cap so a single leaked key can't be
 * refreshed in a tight loop from many IPs (a token farm).
 *
 * In-memory / per-instance (like the existing ThrottlerModule storage) — good
 * enough for single-instance and a sane default; a multi-instance deployment
 * would move this to a shared store (Redis). Documented, not silently assumed.
 *
 * Fixed-window counter keyed by licId: N refreshes per window. Old windows are
 * lazily evicted on access + capped so the map can't grow unbounded.
 */
import { Injectable } from '@nestjs/common';

interface Window { count: number; resetAt: number; }

@Injectable()
export class RefreshRateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly maxKeys = 50_000; // safety cap on map size

  constructor() {
    this.windowMs = intOr(process.env.REFRESH_KEY_WINDOW_MS, 60 * 60 * 1000); // 1h
    this.limit = intOr(process.env.REFRESH_KEY_LIMIT, 5); // 5 refreshes / key / hour
  }

  /**
   * Record a refresh attempt for `licId`. Returns true if ALLOWED, false if the
   * per-key limit is exceeded for the current window. `nowMs` is injectable for
   * tests (defaults to Date.now()).
   */
  allow(licId: string, nowMs: number = Date.now()): boolean {
    const w = this.windows.get(licId);
    if (!w || nowMs >= w.resetAt) {
      // Overflow guard: evict the SINGLE oldest entry (Map keeps insertion order),
      // never clear() the whole map — a global clear would let a flood of distinct
      // keys reset EVERYONE's window at once (audit M4). One-in/one-out bounds the
      // map while preserving every other key's live count.
      if (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      // Re-insert (delete-then-set) so a refreshed window moves to the newest slot,
      // making the eviction order a true LRU on window-start.
      this.windows.delete(licId);
      this.windows.set(licId, { count: 1, resetAt: nowMs + this.windowMs });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count += 1;
    return true;
  }
}

function intOr(raw: string | undefined, dflt: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
