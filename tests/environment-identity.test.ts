/**
 * environment-identity.test.ts — /health must say WHICH backend it is.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Every wrong-environment mistake here was invisible until something silently
 * failed: a package built on the local backend and expected in the deployed
 * demo; a licence signed by `oe-dev-1` pasted into a production demo and
 * quietly resolving to free. Nothing ever announced which backend was in play.
 *
 * ─── THE DEFAULT IS THE WHOLE POINT ─────────────────────────────────────────
 * The first draft required `APP_ENV === 'production'` and treated everything
 * else as non-production. That reads as the safe default and is the opposite:
 * this deployment sets NODE_ENV=production and no APP_ENV, so PRODUCTION would
 * have shown the "not production" banner. A banner that cries wolf on the real
 * thing trains you to ignore it — worse than no banner at all.
 *
 * So: APP_ENV wins when set (a staging box built from the production image
 * still identifies as staging), NODE_ENV is the fallback.
 */
import { describe, it, expect } from 'vitest';

/** The resolution in health.controller.ts, mirrored so it can be exercised. */
function describeEnvironment(env: { APP_ENV?: string; NODE_ENV?: string; LICENSE_KID?: string }) {
  const explicit = (env.APP_ENV || '').trim().toLowerCase();
  const nodeEnv = (env.NODE_ENV || '').trim().toLowerCase();
  const name = explicit || nodeEnv || 'unknown';
  return {
    name,
    isProduction: name === 'production' || name === 'prod',
    kid: (env.LICENSE_KID || '').trim(),
  };
}

describe('environment identity', () => {
  it('recognises TODAY\'S production, which sets NODE_ENV only', () => {
    // The regression that matters: no APP_ENV anywhere in this deployment.
    const e = describeEnvironment({ NODE_ENV: 'production', LICENSE_KID: 'oe-prod-2' });
    expect(e.name).toBe('production');
    expect(e.isProduction).toBe(true);
  });

  it('lets APP_ENV override NODE_ENV, so staging built from the prod image is staging', () => {
    const e = describeEnvironment({ APP_ENV: 'staging', NODE_ENV: 'production' });
    expect(e.name).toBe('staging');
    expect(e.isProduction).toBe(false);
  });

  it('treats an unlabelled backend as NOT production', () => {
    const e = describeEnvironment({});
    expect(e.name).toBe('unknown');
    expect(e.isProduction).toBe(false);
  });

  it('reports the signing kid — the identifier that cannot be mis-set', () => {
    // A name is a label someone can get wrong; the kid is the key licences are
    // actually SIGNED with. Two environments reporting the same kid are not
    // isolated, whatever their names claim.
    expect(describeEnvironment({ LICENSE_KID: 'oe-dev-1' }).kid).toBe('oe-dev-1');
    expect(describeEnvironment({}).kid).toBe('');
  });

  it('never exposes private key material', () => {
    const e = describeEnvironment({ APP_ENV: 'production', LICENSE_KID: 'oe-prod-2' });
    expect(Object.keys(e).sort()).toEqual(['isProduction', 'kid', 'name']);
  });

  it('is case- and whitespace-tolerant', () => {
    expect(describeEnvironment({ APP_ENV: '  Production  ' }).isProduction).toBe(true);
    expect(describeEnvironment({ APP_ENV: 'PROD' }).isProduction).toBe(true);
  });
});
