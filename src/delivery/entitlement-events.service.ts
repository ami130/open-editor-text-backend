/**
 * entitlement-events.service.ts — the push side of §2.3 "instant upgrade".
 *
 * ─── WHAT THIS IS ───────────────────────────────────────────────────────────
 * A tiny in-memory pub/sub. Editors hold an open Server-Sent Events connection;
 * when a licence changes (payment fulfilled, activation armed, plan changed,
 * revoked) we publish one nudge and the editor refreshes in ~2s instead of
 * waiting up to 15 minutes for its timer.
 *
 * ─── THE MESSAGE CARRIES NO CREDENTIALS. EVER. ──────────────────────────────
 * This is the single most important property here, so it is enforced by the
 * type: an event is `{ reason }` and nothing else. It says "something about you
 * changed, go ask /session again" — it never carries a licence key, a session
 * token, or entitlement details.
 *
 * Why that matters: a subscriber is identified by a licId or installId, and
 * neither is a secret (installIds are written to our own logs). If the stream
 * carried the key, anyone who learned an id could listen and be handed a
 * licence. Because it carries only a nudge, the worst an eavesdropper learns is
 * that *something changed* — and to actually get anything they still need the
 * real credential, or a single-use activation claim that the legitimate browser
 * will consume first.
 *
 * ─── WHY IN-MEMORY IS CORRECT, NOT A SHORTCUT ───────────────────────────────
 * An SSE connection is already pinned to one process — it is a held socket, so
 * a shared store would not make another instance able to write to it anyway.
 * Multi-instance deployments need a fan-out (Redis pub/sub) so every process
 * publishes to its own subscribers; that is a Phase-2B concern, deliberately
 * not built now against infrastructure that does not exist yet.
 *
 * Crucially, correctness does NOT depend on delivery. The engine's timed
 * refresh remains the guarantee (§1.3 + D1); push is only ever an optimisation.
 * A missed event costs latency, never entitlement.
 *
 * ─── BOUNDED ON PURPOSE ─────────────────────────────────────────────────────
 * Every open connection is memory held for as long as a tab stays open, and
 * /delivery/events is a public endpoint. Both the number of channels and the
 * subscribers per channel are capped, so a hostile client cannot grow this
 * without limit.
 */
import { Injectable, Logger } from '@nestjs/common';

/** Why a subscriber should re-check. Deliberately coarse — never entitlement data. */
export type EntitlementReason = 'purchased' | 'changed' | 'revoked';

export interface EntitlementEvent {
  reason: EntitlementReason;
}

export type EntitlementListener = (event: EntitlementEvent) => void;

/**
 * Caps. Chosen to be generous for real use and hostile to abuse:
 * a customer might legitimately have many tabs open; nobody needs 50.
 */
export const MAX_CHANNELS = 50_000;
export const MAX_SUBSCRIBERS_PER_CHANNEL = 50;

@Injectable()
export class EntitlementEventsService {
  private readonly log = new Logger(EntitlementEventsService.name);

  /** channel key → listeners. A channel is a licId or an installId. */
  private readonly channels = new Map<string, Set<EntitlementListener>>();

  /**
   * Subscribe to a channel. Returns an unsubscribe function.
   *
   * Returns null when a cap is hit rather than throwing: a refused subscription
   * must degrade to "this editor uses its timer", which is the normal path
   * anyway — never a failed page load.
   */
  subscribe(channel: string, listener: EntitlementListener): (() => void) | null {
    const key = (channel || '').trim();
    if (!key) return null;

    let set = this.channels.get(key);
    if (!set) {
      if (this.channels.size >= MAX_CHANNELS) {
        this.log.warn(`channel cap (${MAX_CHANNELS}) reached — refusing new channel`);
        return null;
      }
      set = new Set();
      this.channels.set(key, set);
    }
    if (set.size >= MAX_SUBSCRIBERS_PER_CHANNEL) {
      this.log.warn(`subscriber cap reached for one channel — refusing`);
      // Drop the channel again if we just created it and it stayed empty.
      if (set.size === 0) this.channels.delete(key);
      return null;
    }

    set.add(listener);
    return () => this.unsubscribe(key, listener);
  }

  private unsubscribe(channel: string, listener: EntitlementListener): void {
    const set = this.channels.get(channel);
    if (!set) return;
    set.delete(listener);
    // Delete the empty Set, or `channels` grows forever with dead keys and the
    // cap eventually refuses real customers.
    if (set.size === 0) this.channels.delete(channel);
  }

  /**
   * Publish to a channel. Returns how many listeners were notified (0 is
   * normal and not an error — nobody has that editor open right now).
   *
   * A throwing listener must not stop the others: one wedged connection
   * cannot be allowed to silently starve every other tab on the same licence.
   */
  publish(channel: string | null | undefined, reason: EntitlementReason): number {
    const key = (channel || '').trim();
    if (!key) return 0;
    const set = this.channels.get(key);
    if (!set || set.size === 0) return 0;

    let sent = 0;
    for (const listener of [...set]) {
      try {
        listener({ reason });
        sent += 1;
      } catch (err) {
        this.log.warn(`entitlement listener threw; dropping it: ${String(err)}`);
        this.unsubscribe(key, listener);
      }
    }
    if (sent) this.log.log(`pushed '${reason}' to ${sent} subscriber(s) on ${key.slice(0, 24)}`);
    return sent;
  }

  /** Observability + tests. */
  stats(): { channels: number; subscribers: number } {
    let subscribers = 0;
    for (const set of this.channels.values()) subscribers += set.size;
    return { channels: this.channels.size, subscribers };
  }
}
