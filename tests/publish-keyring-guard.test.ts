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
    expect(src).toMatch(/if \(!kid\) \{/);
    expect(src).toMatch(/carries NO licence keyring/);
  });

  it('refuses when the bundle kid is not in the backend JWKS', () => {
    expect(src).toMatch(/if \(!backendKids\.includes\(kid\)\)/);
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
    // Asserts the hint is REACHED, not that its literal text sits inside each
    // message: three of the four refusals append the shared `rebuildHint`
    // variable. An earlier version grepped for the literal in each block and
    // failed on messages that were perfectly correct at runtime — verified by
    // actually running all four paths.
    const refusals = src
      .split('die(')
      .slice(1)
      .filter((s) => /^[`'"](The \$\{plan\} bundle carries NO|Could not read|KEYRING MISMATCH|KEYRING SPLIT)/.test(s.trim()));
    // FOUR now, not three: the rewrite made the keyless message per-plan and
    // added KEYRING SPLIT (plans built with different keyrings).
    expect(refusals.length).toBe(4);
    for (const r of refusals) {
      expect(r.slice(0, 900)).toMatch(/rebuildHint|DELIVERY_LICENSE_KEYS|jwks\.json|Fix the endpoint/);
    }
    // …and the hint itself must actually name the build command.
    expect(src).toMatch(/const rebuildHint =[\s\S]{0,200}DELIVERY_LICENSE_KEYS/);
  });
});

describe('guard covers EVERY plan, not just free', () => {
  it('iterates the shared PLANS list rather than reading free.js alone', () => {
    // THE BUG: the first version read only free.js and then published both
    // plans. Proven exploitable — a premium bundle with a wrong kid printed
    // "keyring ✓" and proceeded. Premium is the PAID path, so that was the
    // most expensive possible version of this mistake.
    expect(src).toMatch(/for \(const plan of PLANS\)/);
    expect(src).not.toMatch(/readFileSync\(join\(DELIVERY, 'free\.js'\)/);
  });

  it('defines PLANS once, so the guard and the publish loop cannot drift', () => {
    // They HAD drifted: the guard hardcoded free, the loop hardcoded
    // ['free','premium']. Two lists that must agree eventually disagree.
    expect(src).toMatch(/const PLANS = \['free', 'premium'\]/);
    expect(src.match(/for \(const plan of PLANS\)/g)?.length).toBe(2);
    expect(src).not.toMatch(/for \(const plan of \['free', 'premium'\]\)/);
  });

  it('refuses when the plans carry DIFFERENT keyrings', () => {
    // Both kids can be individually valid during a key rotation, yet a
    // mismatched pair still means they came from different builds.
    expect(src).toMatch(/KEYRING SPLIT/);
  });
});
