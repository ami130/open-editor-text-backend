/**
 * §2.7 canary bucketing. Stickiness is the property everything else rests on.
 */
import { describe, it, expect } from 'vitest';
import { bucketOf, inCanary } from '../src/licensing/canary';

describe('canary bucketing', () => {
  it('IS STICKY — the same caller gets the same answer every time', () => {
    // If this were false the editor would re-download a different bundle on
    // every reload, destroying the immutable cache and making bug reports
    // unreproducible.
    const id = 'oe-lic-12345';
    const first = inCanary(id, '1.4.0', 5);
    for (let i = 0; i < 500; i += 1) {
      expect(inCanary(id, '1.4.0', 5)).toBe(first);
    }
  });

  it('distributes roughly evenly across identities', () => {
    let hits = 0;
    const N = 10_000;
    for (let i = 0; i < N; i += 1) if (inCanary(`lic-${i}`, '1.4.0', 10)) hits += 1;
    const pct = (hits / N) * 100;
    // 10% target; allow a generous band so the test is not flaky.
    expect(pct).toBeGreaterThan(8);
    expect(pct).toBeLessThan(12);
  });

  it('RE-SHUFFLES per release — the same 5% are not the guinea pig forever', () => {
    // Without version-salting, one unlucky group absorbs every bad build while
    // everyone else never sees one.
    const ids = Array.from({ length: 2000 }, (_, i) => `lic-${i}`);
    const a = new Set(ids.filter((id) => inCanary(id, '1.4.0', 10)));
    const b = new Set(ids.filter((id) => inCanary(id, '1.5.0', 10)));
    const overlap = [...a].filter((id) => b.has(id)).length;
    // Independent draws → overlap should be ~10% of a, nowhere near all of it.
    expect(overlap).toBeLessThan(a.size * 0.5);
  });

  it('0% means nobody; 100% means everybody', () => {
    const ids = Array.from({ length: 300 }, (_, i) => `lic-${i}`);
    expect(ids.some((id) => inCanary(id, '1.4.0', 0))).toBe(false);
    expect(ids.every((id) => inCanary(id, '1.4.0', 100))).toBe(true);
  });

  it('CLAMPS a bad percentage — a typo must never mean a full rollout', () => {
    // 1000 in an admin form must not silently become 100%… it must behave as
    // 100 only because it was clamped, and negatives must mean nobody.
    expect(inCanary('lic-1', '1.4.0', -50)).toBe(false);
    expect(inCanary('lic-1', '1.4.0', 1000)).toBe(true); // clamped to 100
  });

  it('an UNIDENTIFIABLE caller is never in the canary', () => {
    // It could not be kept there consistently, so it must not be put there.
    expect(inCanary(null, '1.4.0', 50)).toBe(false);
    expect(inCanary('', '1.4.0', 50)).toBe(false);
    expect(inCanary('   ', '1.4.0', 50)).toBe(false);
    expect(bucketOf('', 'x')).toBeNull();
  });

  it('no canary version means no canary', () => {
    expect(inCanary('lic-1', '', 100)).toBe(false);
  });

  it('a ramp is MONOTONIC — nobody leaves the canary as the percentage grows', () => {
    // Going 5% -> 25% must only ADD callers. If someone dropped out they would
    // move backwards to the old bundle, which is a downgrade mid-release.
    const ids = Array.from({ length: 1000 }, (_, i) => `lic-${i}`);
    const at5 = ids.filter((id) => inCanary(id, '1.4.0', 5));
    const at25 = new Set(ids.filter((id) => inCanary(id, '1.4.0', 25)));
    for (const id of at5) expect(at25.has(id)).toBe(true);
  });
});
