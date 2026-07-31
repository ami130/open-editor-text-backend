/**
 * duration-policy.ts — the single source of truth mapping a package's
 * `billingInterval` to how long its licenses live and whether they auto-renew.
 *
 * Phase 3 introduces the admin-facing "lifetime" duration. Before Phase 3,
 * `billingInterval` (once/monthly/yearly) and `licenseTtlSeconds` were ORTHOGONAL
 * — the signer read a raw TTL number and ignored the interval entirely. This map
 * is what finally lets the interval DRIVE the token lifetime.
 *
 * IMPORTANT — no crypto changes ride on this. The signer still hard-clamps every
 * TTL to `cfg.maxTtlSeconds` (≈ the verifier's ~3y ceiling), so a "lifetime"
 * license is simply a token minted at that ceiling and RE-MINTED on renewal
 * (`refreshPolicy: 'auto'`) — never an infinite `exp`. That "perpetual via
 * renewal" model already existed; Phase 3 only names it.
 *
 * `refreshPolicy` is PERSISTED and SNAPSHOTTED in Phase 3 but is a policy LABEL
 * here — the actual auto-refresh endpoint is Phase 4. Storing it now gives Phase 4
 * the field it needs without building refresh runtime early.
 */
import { SAFE_MAX_TTL, DEFAULT_TTL_SECONDS } from '../config/license.config';

export const BILLING_INTERVALS = ['once', 'monthly', 'yearly', 'lifetime'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export type RefreshPolicy = 'auto' | 'manual';

/**
 * Sentinel `renewUntil` value meaning "no paid-term wall — perpetual" (audit B1).
 * A `lifetime` license stamps this instead of a finite boundary, so silent refresh
 * re-mints FOREVER (each token still clamped to SAFE_MAX_TTL by the signer, so the
 * verifier can never reject it). Chosen as -1 because:
 *   • `renewUntil` is a MySQL `int` (max ~2.1e9 = year 2038) — a "far-future"
 *     timestamp would OVERFLOW the column and, worse, the old ~3y term wall was the
 *     whole bug. -1 is int-safe and can never collide with a real unix-second term.
 *   • 0 already means "legacy row → derive the term from createdAt+interval"; -1 is
 *     a DISTINCT, explicit "deliberately perpetual" marker, not a derive-me default.
 * Every term helper below (effectiveRenewUntil / isTermActive / clampTtlToTerm)
 * treats this as +∞ so a lifetime license is never term-ended, never un-refreshable.
 */
export const INFINITE_TERM = -1;

/** True if a stored renewUntil is the perpetual sentinel (audit B1). */
export function isInfiniteTerm(renewUntil: number | undefined | null): boolean {
  return renewUntil === INFINITE_TERM;
}

export interface DurationPolicy {
  /** Token lifetime (seconds) BEFORE the signer's hard clamp. */
  ttlSeconds: number;
  /** Whether licenses of this interval are meant to auto-renew (Phase 4 runtime). */
  refreshPolicy: RefreshPolicy;
}

const DAY = 24 * 3600;

/**
 * Interval → { ttlSeconds, refreshPolicy }. Pure and total over BillingInterval.
 *
 * - `lifetime` → the max safe TTL + auto-renew (perpetual-via-renewal).
 * - `yearly`/`monthly` → an interval-length TTL + auto-renew (subscription re-mint).
 * - `once` → the short default TTL + manual (a one-time buy has no renewal loop).
 *
 * The signer clamps `ttlSeconds` to `cfg.maxTtlSeconds` regardless, so this can
 * never mint a token the verifier would reject — `lifetime` is that ceiling itself.
 */
export function durationPolicy(interval: BillingInterval): DurationPolicy {
  switch (interval) {
    case 'lifetime':
      return { ttlSeconds: SAFE_MAX_TTL, refreshPolicy: 'auto' };
    case 'yearly':
      return { ttlSeconds: 365 * DAY, refreshPolicy: 'auto' };
    case 'monthly':
      return { ttlSeconds: 30 * DAY, refreshPolicy: 'auto' };
    case 'once':
      return { ttlSeconds: DEFAULT_TTL_SECONDS, refreshPolicy: 'manual' };
    default: {
      // Exhaustiveness guard: adding a BillingInterval without a case is a compile
      // error here, and an unknown value at runtime falls back to the safe default.
      const _never: never = interval;
      void _never;
      return { ttlSeconds: DEFAULT_TTL_SECONDS, refreshPolicy: 'manual' };
    }
  }
}

/**
 * The paid-TERM length (seconds) for an interval — how long a license may keep
 * silently refreshing (audit C1). DISTINCT from `ttlSeconds` (the life of each
 * minted token): the term is the renewal WINDOW, the ttl is one token's life.
 *   • once/monthly/yearly → the interval length (a one-time purchase of that term)
 *   • lifetime → SAFE_MAX_TTL (effectively perpetual; still re-minted, never ∞)
 * `renewUntil = issuedAt + termSeconds(interval)` is stamped on the license at
 * issue; refresh re-mints only while now < renewUntil.
 */
export function termSeconds(interval: BillingInterval): number {
  switch (interval) {
    case 'lifetime': return SAFE_MAX_TTL;
    case 'yearly': return 365 * DAY;
    case 'monthly': return 30 * DAY;
    case 'once': return DEFAULT_TTL_SECONDS;
    default: { const _never: never = interval; void _never; return DEFAULT_TTL_SECONDS; }
  }
}

/**
 * The `renewUntil` value to STAMP on a freshly-issued/renewed license (audit B1).
 * This is the write-side counterpart to `effectiveRenewUntil` (the read side): it
 * returns the perpetual sentinel for `lifetime` (so lifetime licenses have NO term
 * wall and refresh forever), and `nowSec + termSeconds(interval)` for every finite
 * interval. All mint paths that stamp a term (issue / issueFromSnapshot / renew for
 * a lifetime package) MUST use this instead of `nowSec + termSeconds(...)` directly,
 * or lifetime would get the old ~3y wall back. `termSeconds('lifetime')` still
 * returns SAFE_MAX_TTL for its OTHER role (the token-TTL ceiling) — only the TERM
 * boundary is made infinite here.
 */
export function stampedRenewUntil(interval: BillingInterval, nowSec: number): number {
  return interval === 'lifetime' ? INFINITE_TERM : nowSec + termSeconds(interval);
}

/** Narrow an arbitrary string to a known BillingInterval (else null). */
export function asBillingInterval(value: string | null | undefined): BillingInterval | null {
  return (BILLING_INTERVALS as readonly string[]).includes(value ?? '')
    ? (value as BillingInterval)
    : null;
}

/**
 * Clamp a token TTL so the minted `exp` never OUTLIVES the paid term (audit #3).
 * Every mint (issue / issueFromSnapshot / refresh re-mint) runs the requested ttl
 * (or the interval default) through this so `now + ttl <= renewUntil`. Prevents a
 * token minted just before the term boundary from living a full extra TTL past it
 * (e.g. a monthly key working ~60 days on a 30-day term). The signer still applies
 * its own SAFE_MAX_TTL ceiling on top. `requestedTtl` undefined → the caller's
 * default is used first, then clamped. Never returns < 1 (mint must be usable now;
 * callers only mint while now < renewUntil, so headroom is always positive there).
 */
export function clampTtlToTerm(
  requestedTtl: number | undefined,
  renewUntil: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): number | undefined {
  if (isInfiniteTerm(renewUntil)) return requestedTtl; // perpetual → no term to clamp against
  if (!(renewUntil > 0)) return requestedTtl; // no term bound → nothing to clamp
  const headroom = renewUntil - nowSec;       // seconds left until the term ends
  if (headroom <= 0) return requestedTtl;      // already at/past term — leave to callers' gates
  if (typeof requestedTtl !== 'number' || requestedTtl <= 0) return headroom;
  return Math.min(requestedTtl, headroom);
}

/**
 * The paid-term boundary (unix seconds) for an EXISTING license — the SINGLE
 * source of truth for "when does this license stop being renewable/rebindable".
 * A stored `renewUntil > 0` wins; a legacy 0 is DERIVED from the row's original
 * issue (createdAt, else issuedAt) + the term of its interval — so both the
 * refresh gate AND a rebind carry the SAME boundary and never extend a legacy
 * license's term from "now" (audit E1). Callers pass the minimal shape.
 */
export function effectiveRenewUntil(lic: {
  renewUntil?: number;
  createdAt?: Date | string | null;
  issuedAt?: number;
  intervalForTerm?: string | null; // the package's billingInterval, if known
}): number {
  // Perpetual sentinel (lifetime, audit B1): +∞ — never term-ends. Checked BEFORE
  // the `> 0` stored-value branch because -1 is deliberately not > 0.
  if (isInfiniteTerm(lic.renewUntil)) return Number.POSITIVE_INFINITY;
  if (typeof lic.renewUntil === 'number' && lic.renewUntil > 0) return lic.renewUntil;
  // Legacy row (renewUntil=0): derive from createdAt+interval. A legacy LIFETIME row
  // must also be perpetual — otherwise a pre-B1 lifetime license would inherit the
  // old ~3y wall via termSeconds('lifetime'). Guard it explicitly.
  const interval = asBillingInterval(lic.intervalForTerm ?? 'once') ?? 'once';
  if (interval === 'lifetime') return Number.POSITIVE_INFINITY;
  const createdSec = lic.createdAt
    ? Math.floor(new Date(lic.createdAt).getTime() / 1000)
    : (lic.issuedAt || 0);
  return createdSec + termSeconds(interval);
}

/**
 * The paid-term boundary to CARRY onto a regenerated/rebound credential (audit B1).
 * Read-side `effectiveRenewUntil` returns +∞ for a perpetual (lifetime) license,
 * but +∞ can't be stored in the `int renewUntil` column — so this maps perpetual
 * back to the storable INFINITE_TERM sentinel, and passes a finite boundary through
 * unchanged. Regenerate / rebind use this so a lifetime credential swap stays
 * perpetual instead of collapsing to a ~3y (or 30-day 'once') wall.
 */
export function carriedRenewUntilFor(lic: {
  renewUntil?: number;
  createdAt?: Date | string | null;
  issuedAt?: number;
  intervalForTerm?: string | null;
}): number {
  const boundary = effectiveRenewUntil(lic);
  return Number.isFinite(boundary) ? boundary : INFINITE_TERM;
}

/**
 * True while an existing license is still within its paid TERM (now < boundary).
 * The SHARED "may this credential be re-minted?" predicate — the same rule the
 * refresh gate uses (`now >= boundary → refuse`). Regenerate / rebind / portal
 * self-serve regenerate call this so a TERM-ENDED license cannot be re-minted into
 * a fresh live token (audit R1). Without this, `clampTtlToTerm`'s headroom<=0
 * escape hatch would hand those paths a full-TTL token past a dead term. Fresh
 * `issue` never needs it (its term starts now); admin `renew` deliberately EXTENDS
 * the term, so it does not gate on this.
 */
export function isTermActive(
  lic: { renewUntil?: number; createdAt?: Date | string | null; issuedAt?: number; intervalForTerm?: string | null },
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  return nowSec < effectiveRenewUntil(lic);
}

/**
 * The TTL a license issued from this package should use. An explicit
 * `ttlOverrideSeconds` (admin escape hatch) always wins; otherwise the TTL is
 * DERIVED from the interval — so switching a package monthly→lifetime updates the
 * lifetime of newly-issued licenses automatically, with no stale stored number.
 * (Option B of PHASE-3-PLAN §7.)
 */
export function effectiveTtlSeconds(pkg: {
  billingInterval: string;
  ttlOverrideSeconds?: number | null;
}): number {
  if (typeof pkg.ttlOverrideSeconds === 'number' && pkg.ttlOverrideSeconds > 0) {
    return pkg.ttlOverrideSeconds;
  }
  const interval = asBillingInterval(pkg.billingInterval) ?? 'once';
  return durationPolicy(interval).ttlSeconds;
}
