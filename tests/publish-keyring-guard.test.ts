/**
 * publish-keyring-guard.test.ts — a bundle may only be published to the backend
 * whose keyring it carries.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Licences are verified OFFLINE against a public key compiled into the engine
 * bundle. A bundle built with one environment's keyring therefore cannot verify
 * licences issued by another — and the failure is SILENT in the worst way: the
 * session resolves, the bytes download, the SHA-256 matches, /health stays
 * green, and every paying customer quietly drops to the free tier.
 *
 * That exact shape already reached production once, as an EMPTY keyring. It was
 * found by a person clicking, weeks later. Introducing a second environment
 * makes the mismatched-keyring variant a live risk: one wrong `API=` and a
 * staging bundle lands on production, breaking everyone at once.
 *
 * `verify-bundles.mjs` checks a keyring is PRESENT. Nothing checked it was the
 * RIGHT one. This guard does, before a single byte is uploaded.
 *
 * ─── VERIFIED BY HAND, ALL THREE PATHS ──────────────────────────────────────
 *   match     oe-prod-2 bundle → production   → publishes
 *   mismatch  oe-prod-2 bundle → local        → refuses, exit 1
 *   keyless   no keyring at all               → refuses
 * The mismatch case used the real production bundle against the real local
 * backend — not a simulation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(__dirname, '..', 'scripts', 'publish-local-bundles.mjs'),
  'utf-8',
);

/** The extraction the guard performs, mirrored so its behaviour can be tested. */
const extractKid = (bundle: string) => {
  const m = bundle.match(/licenseKeys:\[\{kid:"([^"]+)"/);
  return m ? m[1] : null;
};

describe('keyring extraction', () => {
  it('reads the kid out of a real bundle shape', () => {
    expect(extractKid('a=1,licenseKeys:[{kid:"oe-prod-2",jwk:{kty:"EC"}}],b=2'))
      .toBe('oe-prod-2');
  });

  it('returns null for an EMPTY keyring — the bug that shipped', () => {
    expect(extractKid('enforceFreeTier:!0,licenseKey:null,licenseKeys:[],x=1')).toBeNull();
    expect(extractKid('licenseKeys:null')).toBeNull();
  });

  it('is not fooled by the destructuring default present in every build', () => {
    // `keyring:n=[]` appears inside the verify function of EVERY bundle,
    // working or broken. Matching it would report a healthy bundle as keyless —
    // which is exactly the wrong turn taken while diagnosing the real incident.
    expect(extractKid('async function pr(e,t={}){const{keyring:n=[],hostname:o=""}=t;'))
      .toBeNull();
  });
});

describe('publish guard', () => {
  it('refuses when the bundle carries no keyring', () => {
    expect(src).toMatch(/if \(!bundleKid\)/);
    expect(src).toMatch(/carries NO licence keyring/);
  });

  it('refuses when the bundle kid is not in the backend JWKS', () => {
    expect(src).toMatch(/if \(!backendKids\.includes\(bundleKid\)\)/);
    expect(src).toMatch(/KEYRING MISMATCH/);
  });

  it('refuses rather than publishing blind when the JWKS cannot be read', () => {
    // Failing OPEN here would defeat the guard entirely: an unreachable JWKS is
    // exactly when a typo'd API host is most likely.
    expect(src).toMatch(/if \(!backendKids\.length\)/);
  });

  it('checks BEFORE any bytes are uploaded', () => {
    const guardAt = src.indexOf('KEYRING MISMATCH');
    const uploadAt = src.indexOf('bundleBase64');
    expect(guardAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(uploadAt);
  });

  it('names the exact rebuild command in every keyring refusal', () => {
    // A guard that blocks without saying what to do just gets worked around.
    //
    // Scoped to the THREE keyring refusals by their opening words. An earlier
    // version filtered on "keyring appears in the next 400 chars", which also
    // matched the unrelated login-failure die() that merely sits above this
    // block — the test failed for a reason that had nothing to do with the
    // guard.
    const refusals = src
      .split('die(')
      .slice(1)
      .filter((s) => /^[`'"](The built bundle carries NO|Could not read|KEYRING MISMATCH)/.test(s.trim()));
    expect(refusals.length).toBe(3);
    for (const r of refusals) {
      expect(r.slice(0, 900)).toMatch(/DELIVERY_LICENSE_KEYS|jwks\.json/);
    }
  });
});
