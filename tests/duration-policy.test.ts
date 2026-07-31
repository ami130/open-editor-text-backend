/**
 * duration-policy.test.ts — the interval→{ttl, refreshPolicy} map (Phase 3).
 *
 * Pure, no DB, no crypto. Pins the "lifetime" behavior (max safe TTL + auto),
 * the subscription/one-time mappings, exhaustiveness, and the effectiveTtl
 * override precedence (PHASE-3-PLAN §7 option B).
 */
import { describe, it, expect } from 'vitest';
import {
  durationPolicy, effectiveTtlSeconds, asBillingInterval, BILLING_INTERVALS,
  INFINITE_TERM, isInfiniteTerm, stampedRenewUntil, effectiveRenewUntil,
  isTermActive, clampTtlToTerm, carriedRenewUntilFor, termSeconds,
} from '../src/licensing/duration-policy';
import { SAFE_MAX_TTL, DEFAULT_TTL_SECONDS } from '../src/config/license.config';

const DAY = 24 * 3600;

describe('durationPolicy', () => {
  it('lifetime → the max safe TTL + auto-renew (perpetual-via-renewal)', () => {
    expect(durationPolicy('lifetime')).toEqual({ ttlSeconds: SAFE_MAX_TTL, refreshPolicy: 'auto' });
  });

  it('yearly → a 365-day TTL + auto-renew', () => {
    expect(durationPolicy('yearly')).toEqual({ ttlSeconds: 365 * DAY, refreshPolicy: 'auto' });
  });

  it('monthly → a 30-day TTL + auto-renew', () => {
    expect(durationPolicy('monthly')).toEqual({ ttlSeconds: 30 * DAY, refreshPolicy: 'auto' });
  });

  it('once → the short default TTL + manual (a one-time buy has no renewal loop)', () => {
    expect(durationPolicy('once')).toEqual({ ttlSeconds: DEFAULT_TTL_SECONDS, refreshPolicy: 'manual' });
  });

  it('lifetime never exceeds the signer clamp ceiling (verifier-safe by construction)', () => {
    // SAFE_MAX_TTL *is* the clamp value; the signer does min(ttl, maxTtlSeconds),
    // so a lifetime TTL is exactly the ceiling and can never be rejected.
    expect(durationPolicy('lifetime').ttlSeconds).toBeLessThanOrEqual(SAFE_MAX_TTL);
    expect(durationPolicy('lifetime').ttlSeconds).toBeGreaterThan(365 * DAY);
  });

  it('is total over every declared BillingInterval (no interval left unmapped)', () => {
    for (const interval of BILLING_INTERVALS) {
      const p = durationPolicy(interval);
      expect(p.ttlSeconds).toBeGreaterThan(0);
      expect(['auto', 'manual']).toContain(p.refreshPolicy);
    }
  });

  it('an unknown interval falls back to the safe default (never throws)', () => {
    // @ts-expect-error — deliberately passing an out-of-type value.
    expect(durationPolicy('quarterly')).toEqual({ ttlSeconds: DEFAULT_TTL_SECONDS, refreshPolicy: 'manual' });
  });

  it("matches the migration backfill rule: only 'once' is manual, every other interval is auto", () => {
    // The Phase-3 migration backfills refreshPolicy for pre-existing rows with
    // `SET 'auto' WHERE billingInterval IN ('monthly','yearly','lifetime')` (else
    // the 'manual' default). That SQL runs only on prod MySQL and can't be unit-
    // tested here, so this pins the RULE it encodes — if durationPolicy ever
    // changes which intervals auto-renew, this fails and the migration must follow.
    const AUTO_INTERVALS = ['monthly', 'yearly', 'lifetime'];
    for (const interval of BILLING_INTERVALS) {
      const expected = AUTO_INTERVALS.includes(interval) ? 'auto' : 'manual';
      expect(durationPolicy(interval).refreshPolicy).toBe(expected);
    }
  });
});

describe('perpetual (lifetime) term — audit B1', () => {
  const NOW = 1_800_000_000;
  const THREE_YEARS = 3 * 365 * 24 * 3600;

  it('stampedRenewUntil: lifetime → the INFINITE_TERM sentinel (never a finite wall)', () => {
    expect(stampedRenewUntil('lifetime', NOW)).toBe(INFINITE_TERM);
    // A finite interval is still now + its term.
    expect(stampedRenewUntil('monthly', NOW)).toBe(NOW + 30 * 24 * 3600);
    expect(stampedRenewUntil('yearly', NOW)).toBe(NOW + 365 * 24 * 3600);
    expect(stampedRenewUntil('once', NOW)).toBe(NOW + termSeconds('once'));
  });

  it('isInfiniteTerm recognizes ONLY the sentinel', () => {
    expect(isInfiniteTerm(INFINITE_TERM)).toBe(true);
    expect(isInfiniteTerm(-1)).toBe(true);
    expect(isInfiniteTerm(0)).toBe(false);      // legacy = derive, not perpetual
    expect(isInfiniteTerm(NOW)).toBe(false);
    expect(isInfiniteTerm(undefined)).toBe(false);
  });

  it('effectiveRenewUntil: sentinel → +∞ (a lifetime license is never term-ended)', () => {
    expect(effectiveRenewUntil({ renewUntil: INFINITE_TERM })).toBe(Number.POSITIVE_INFINITY);
    // A LEGACY lifetime row (renewUntil=0) is perpetual too — derived, not a 3y wall.
    expect(effectiveRenewUntil({ renewUntil: 0, intervalForTerm: 'lifetime', issuedAt: NOW }))
      .toBe(Number.POSITIVE_INFINITY);
    // A finite row still derives a finite boundary.
    expect(effectiveRenewUntil({ renewUntil: 0, intervalForTerm: 'monthly', issuedAt: NOW }))
      .toBe(NOW + 30 * 24 * 3600);
  });

  it('isTermActive: a lifetime term is active EVEN far past the old ~3y wall (the B1 fix)', () => {
    const wayAfterOldWall = NOW + THREE_YEARS + 10 * 24 * 3600; // beyond SAFE_MAX_TTL
    // Sentinel row: still active.
    expect(isTermActive({ renewUntil: INFINITE_TERM }, wayAfterOldWall)).toBe(true);
    // Legacy lifetime row: still active.
    expect(isTermActive({ renewUntil: 0, intervalForTerm: 'lifetime', issuedAt: NOW }, wayAfterOldWall))
      .toBe(true);
    // Contrast: a monthly term HAS ended by then (proves the gate still bites for finite terms).
    expect(isTermActive({ renewUntil: 0, intervalForTerm: 'monthly', issuedAt: NOW }, wayAfterOldWall))
      .toBe(false);
  });

  it('clampTtlToTerm: a perpetual term never shrinks the token TTL', () => {
    // Sentinel boundary → ttl passes through untouched (signer still caps at SAFE_MAX_TTL).
    expect(clampTtlToTerm(SAFE_MAX_TTL, INFINITE_TERM, NOW)).toBe(SAFE_MAX_TTL);
    // +∞ boundary (as the refresh path passes) → also untouched.
    expect(clampTtlToTerm(SAFE_MAX_TTL, Number.POSITIVE_INFINITY, NOW)).toBe(SAFE_MAX_TTL);
    // A finite term still clamps.
    expect(clampTtlToTerm(100 * DAY, NOW + 10 * DAY, NOW)).toBe(10 * DAY);
  });

  it('carriedRenewUntilFor: a perpetual term carries the STORABLE sentinel, not +∞', () => {
    // Regenerate/rebind carry this into an int column — must be -1, never Infinity.
    expect(carriedRenewUntilFor({ renewUntil: INFINITE_TERM })).toBe(INFINITE_TERM);
    expect(carriedRenewUntilFor({ renewUntil: 0, intervalForTerm: 'lifetime', issuedAt: NOW }))
      .toBe(INFINITE_TERM);
    // A finite boundary passes through unchanged.
    expect(carriedRenewUntilFor({ renewUntil: NOW + 30 * DAY })).toBe(NOW + 30 * DAY);
  });
});

describe('asBillingInterval', () => {
  it('accepts known intervals, rejects everything else', () => {
    expect(asBillingInterval('lifetime')).toBe('lifetime');
    expect(asBillingInterval('once')).toBe('once');
    expect(asBillingInterval('quarterly')).toBeNull();
    expect(asBillingInterval('')).toBeNull();
    expect(asBillingInterval(null)).toBeNull();
    expect(asBillingInterval(undefined)).toBeNull();
  });
});

describe('effectiveTtlSeconds (override precedence — plan §7 option B)', () => {
  it('an explicit positive override always wins over the derived value', () => {
    expect(effectiveTtlSeconds({ billingInterval: 'lifetime', ttlOverrideSeconds: 7 * DAY })).toBe(7 * DAY);
  });

  it('no override → derives from the interval (so monthly→lifetime updates automatically)', () => {
    expect(effectiveTtlSeconds({ billingInterval: 'monthly' })).toBe(30 * DAY);
    expect(effectiveTtlSeconds({ billingInterval: 'lifetime' })).toBe(SAFE_MAX_TTL);
    expect(effectiveTtlSeconds({ billingInterval: 'monthly', ttlOverrideSeconds: null })).toBe(30 * DAY);
  });

  it('a zero/negative override is ignored (treated as "no override")', () => {
    expect(effectiveTtlSeconds({ billingInterval: 'monthly', ttlOverrideSeconds: 0 })).toBe(30 * DAY);
    expect(effectiveTtlSeconds({ billingInterval: 'yearly', ttlOverrideSeconds: -5 })).toBe(365 * DAY);
  });

  it('an unknown stored interval degrades to the "once" default', () => {
    expect(effectiveTtlSeconds({ billingInterval: 'bogus' })).toBe(DEFAULT_TTL_SECONDS);
  });
});
