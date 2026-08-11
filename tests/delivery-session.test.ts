/**
 * delivery-session.test.ts — the delivery session service (§1.3).
 *
 * Fakes the repository and signer so the behaviour under test is the SESSION
 * POLICY, not TypeORM or crypto (both covered elsewhere). Every case here pins
 * a rule that, if broken, either leaks entitlement or breaks a paying customer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DeliverySessionService, SESSION_TTL_SECONDS, REFRESH_TTL_SECONDS,
  FREE_PLAN, PREMIUM_PLAN,
} from '../src/delivery/session.service';
import { BundleUrlSigner } from '../src/delivery/bundle-url-signer';

const NOW = 1_800_000_000;

/**
 * A REAL BundleUrlSigner (§1.4). Deliberately not a stub: it is pure and cheap,
 * and using the real one means these tests also cover the URL actually handed
 * to the loader — including that premium URLs come out signed.
 */
const urlSigner = (publicBaseUrl = '') => new BundleUrlSigner({
  bundleDir: '/tmp/unused',
  urlSigningSecret: 'test-secret',
  signingEnabled: true,
  urlTtlSeconds: 600,
  publicBaseUrl,
});

/** Signer stub: records what it was asked to sign; never does real crypto. */
function fakeSigner(validKeys: Record<string, any> = {}) {
  const signed: any[] = [];
  return {
    signed,
    sign: (input: any) => {
      signed.push(input);
      return {
        token: `tok:${input.plan}:${input.ttlSeconds}`,
        lic: input.lic || 'anon',
        iat: NOW,
        exp: NOW + input.ttlSeconds,
        kid: 'k1',
      };
    },
    verifyOwnToken: (t: string) => validKeys[t] ?? null,
  } as any;
}

/** Version service stub — the real one is tested in engine-version-service.test.ts. */
function fakeVersions(supported: string[] = ['text.bold', 'export.pdf']) {
  return {
    resolveForLicence: async (input: any) => ({
      version: input.pinnedVersion || '1.3.0',
      plan: input.plan,
      bundleKey: `engine/${input.plan}.js`,
      bundleSha256: 'b'.repeat(64),
      features: input.packageFeatures.filter((f: string) => supported.includes(f)).sort(),
      missing: input.packageFeatures.filter((f: string) => !supported.includes(f)).sort(),
      source: input.pinnedVersion ? 'pin' : 'global',
    }),
  } as any;
}

function licenceRepo(rows: any[] = []) {
  return {
    findOne: async ({ where }: any) => rows.find((r) => r.licId === where.licId) || null,
  } as any;
}

const DEFAULTS = { globalDefault: '1.3.0', channelDefault: null };

describe('anonymous sessions — the free path must never require anything', () => {
  it('issues a working free session with no key at all', async () => {
    const svc = new DeliverySessionService(licenceRepo(), fakeSigner(), fakeVersions(), urlSigner());
    const { session } = await svc.open({}, DEFAULTS);
    expect(session.plan).toBe(FREE_PLAN);
    expect(session.sessionToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
    expect(session.engine.key).toContain('free');
  });

  it('writes NO database row for an anonymous caller (T17: stateless)', async () => {
    let writes = 0;
    const repo = { ...licenceRepo(), save: async () => { writes += 1; } } as any;
    const svc = new DeliverySessionService(repo, fakeSigner(), fakeVersions(), urlSigner());
    await svc.open({}, DEFAULTS);
    // A DB write per anonymous end-user per page load is exactly the traffic
    // shape this architecture exists to avoid.
    expect(writes).toBe(0);
  });

  it('issues a short session token and a long refresh token', async () => {
    const signer = fakeSigner();
    const svc = new DeliverySessionService(licenceRepo(), signer, fakeVersions(), urlSigner());
    await svc.open({}, DEFAULTS);
    expect(signer.signed.map((s: any) => s.ttlSeconds))
      .toEqual([SESSION_TTL_SECONDS, REFRESH_TTL_SECONDS]);
  });
});

describe('the engine URL and the version claim (§1.4, R40/R41)', () => {
  it('signs the RESOLVED version into both tokens (R40)', async () => {
    // Without a version claim, a valid token could be replayed against any
    // build — escaping pins and channel gating, both of which are version-
    // scoped. It must come from what resolution DECIDED, never from the client.
    const signer = fakeSigner();
    const svc = new DeliverySessionService(licenceRepo(), signer, fakeVersions(), urlSigner());
    await svc.open({}, DEFAULTS);
    expect(signer.signed.map((s: any) => s.version)).toEqual(['1.3.0', '1.3.0']);
  });

  it('returns a content-addressed URL carrying the bundle hash (R41)', async () => {
    const svc = new DeliverySessionService(licenceRepo(), fakeSigner(), fakeVersions(), urlSigner());
    const { session } = await svc.open({}, DEFAULTS);

    // The hash is the cache key. A token here would make every URL unique and
    // drop the CDN hit rate to zero — the failure R41 describes.
    expect(session.engine.url).toBe(`/engine/1.3.0/free/${session.engine.sha256}.js`);
    expect(session.engine.url).not.toContain(session.sessionToken);
  });

  it('returns an ABSOLUTE URL when a public base is configured (B4)', async () => {
    // The loader runs on the CUSTOMER'S domain. A relative "/engine/…" would
    // resolve against their server and 404 — only an absolute URL reaches us.
    const svc = new DeliverySessionService(
      licenceRepo(), fakeSigner(), fakeVersions(),
      urlSigner('https://delivery.openeditor.com'),
    );
    const { session } = await svc.open({}, DEFAULTS);
    expect(session.engine.url)
      .toBe(`https://delivery.openeditor.com/engine/1.3.0/free/${session.engine.sha256}.js`);
  });

  it('stays relative when no public base is set (local / same-origin)', async () => {
    const svc = new DeliverySessionService(licenceRepo(), fakeSigner(), fakeVersions(), urlSigner());
    const { session } = await svc.open({}, DEFAULTS);
    expect(session.engine.url).toMatch(/^\/engine\//);
  });

  it('leaves the FREE bundle URL unsigned — it is public by design (B2)', async () => {
    const svc = new DeliverySessionService(licenceRepo(), fakeSigner(), fakeVersions(), urlSigner());
    const { session } = await svc.open({}, DEFAULTS);
    expect(session.engine.url).not.toContain('sig=');
  });
});

describe('licensed sessions', () => {
  const claims = { lic: 'L1', customer: 'C1', features: [], domains: [], iat: 0, exp: 0, kid: 'k' };

  function premiumLicence(over: any = {}) {
    return {
      licId: 'L1',
      status: 'active',
      domains: [],
      features: ['text.bold'],
      package: { features: [{ id: 'text.bold' }, { id: 'export.pdf' }] },
      customer: { id: 'C1' },
      pinnedVersion: '', overrideVersion: '', channel: 'stable',
      isExpired: () => false,
      ...over,
    };
  }

  it('a licence granting a premium feature receives the PREMIUM bundle', async () => {
    const svc = new DeliverySessionService(
      licenceRepo([premiumLicence()]), fakeSigner({ KEY: claims }), fakeVersions(), urlSigner(),
    );
    const { session } = await svc.open({ licenceKey: 'KEY' }, DEFAULTS);
    expect(session.plan).toBe(PREMIUM_PLAN);
    expect(session.features).toContain('export.pdf');
  });

  it('the PREMIUM bundle URL is signed (R44)', async () => {
    // The premium bundle is no longer protected by absence from npm — it is a
    // URL. Combined with the editor's allowDevHost default, an unsigned premium
    // URL is a premium giveaway.
    const svc = new DeliverySessionService(
      licenceRepo([premiumLicence()]), fakeSigner({ KEY: claims }), fakeVersions(), urlSigner(),
    );
    const { session } = await svc.open({ licenceKey: 'KEY' }, DEFAULTS);
    expect(session.engine.url).toMatch(/\?exp=\d+&sig=[0-9a-f]{64}$/);
    // The hash still leads the path, so the CDN cache key stays per-bundle.
    expect(session.engine.url).toContain(`/${session.engine.sha256}.js?`);
  });

  it('features come from the PACKAGE, not the licence snapshot (T14)', async () => {
    // The snapshot says only text.bold; the package grants export.pdf too.
    // Using the snapshot would silently deny a feature the customer pays for.
    const svc = new DeliverySessionService(
      licenceRepo([premiumLicence({ features: ['text.bold'] })]),
      fakeSigner({ KEY: claims }), fakeVersions(), urlSigner(),
    );
    const { session } = await svc.open({ licenceKey: 'KEY' }, DEFAULTS);
    expect(session.features).toEqual(['export.pdf', 'text.bold']);
  });

  it('falls back to the licence snapshot for legacy rows with no package', async () => {
    const svc = new DeliverySessionService(
      licenceRepo([premiumLicence({ package: null, features: ['text.bold'] })]),
      fakeSigner({ KEY: claims }), fakeVersions(), urlSigner(),
    );
    const { session } = await svc.open({ licenceKey: 'KEY' }, DEFAULTS);
    expect(session.features).toEqual(['text.bold']);
  });

  it('a licence-level pin overrides a client-requested version', async () => {
    // Otherwise a customer could escape an admin's deliberate pinning simply by
    // asking for a different build.
    const svc = new DeliverySessionService(
      licenceRepo([premiumLicence({ pinnedVersion: '1.0.0' })]),
      fakeSigner({ KEY: claims }), fakeVersions(), urlSigner(),
    );
    const { session } = await svc.open({ licenceKey: 'KEY', version: '9.9.9' }, DEFAULTS);
    expect(session.version).toBe('1.0.0');
  });
});

describe('refusals — downgrade to free, never break, never leak why', () => {
  const claims = { lic: 'L1', customer: 'C1', features: [], domains: [], iat: 0, exp: 0, kid: 'k' };
  const base = {
    licId: 'L1', domains: [], features: ['text.bold'],
    package: null, customer: { id: 'C1' },
    pinnedVersion: '', overrideVersion: '', channel: 'stable',
  };

  it('an INVALID key still yields a working free session', async () => {
    const svc = new DeliverySessionService(licenceRepo(), fakeSigner({}), fakeVersions(), urlSigner());
    const { session, refusal } = await svc.open({ licenceKey: 'BAD' }, DEFAULTS);
    expect(session.plan).toBe(FREE_PLAN);
    expect(session.sessionToken).toBeTruthy(); // not an error — a free editor
    expect(refusal).toBe('invalid-key');       // reason is for LOGS only
  });

  it('a REVOKED licence downgrades to free', async () => {
    const svc = new DeliverySessionService(
      licenceRepo([{ ...base, status: 'revoked', isExpired: () => false }]),
      fakeSigner({ KEY: claims }), fakeVersions(), urlSigner(),
    );
    const { session, refusal } = await svc.open({ licenceKey: 'KEY' }, DEFAULTS);
    expect(session.plan).toBe(FREE_PLAN);
    expect(refusal).toBe('revoked');
  });

  it('an EXPIRED licence downgrades to free mid-session rather than breaking', async () => {
    const svc = new DeliverySessionService(
      licenceRepo([{ ...base, status: 'active', isExpired: () => true }]),
      fakeSigner({ KEY: claims }), fakeVersions(), urlSigner(),
    );
    const { session, refusal } = await svc.open({ licenceKey: 'KEY' }, DEFAULTS);
    expect(session.plan).toBe(FREE_PLAN);
    expect(refusal).toBe('expired');
  });

  it('every refusal returns the SAME response shape (no validity oracle)', async () => {
    const shapes = [];
    for (const [key, rows] of [
      ['BAD', []],
      ['KEY', [{ ...base, status: 'revoked', isExpired: () => false }]],
      ['KEY', [{ ...base, status: 'active', isExpired: () => true }]],
    ] as any[]) {
      const svc = new DeliverySessionService(
        licenceRepo(rows), fakeSigner({ KEY: claims }), fakeVersions(), urlSigner(),
      );
      const { session } = await svc.open({ licenceKey: key }, DEFAULTS);
      shapes.push({ plan: session.plan, keys: Object.keys(session).sort().join(',') });
    }
    // Identical plan and identical field set: a caller cannot distinguish
    // "not a real key" from "revoked" from "expired" by probing.
    expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1);
  });
});

describe('domain binding (T11) — domain, never device IP', () => {
  const claims = { lic: 'L1', customer: 'C1', features: [], domains: [], iat: 0, exp: 0, kid: 'k' };
  const bound = (domains: string[]) => ({
    licId: 'L1', status: 'active', domains, features: ['text.bold'],
    package: null, customer: { id: 'C1' },
    pinnedVersion: '', overrideVersion: '', channel: 'stable',
    isExpired: () => false,
  });

  const openWith = async (domains: string[], origin: string | null) => {
    const svc = new DeliverySessionService(
      licenceRepo([bound(domains)]), fakeSigner({ KEY: claims }), fakeVersions(), urlSigner(),
    );
    return svc.open({ licenceKey: 'KEY', origin }, DEFAULTS);
  };

  it('an unbound licence (no domains) works from any origin', async () => {
    const { refusal } = await openWith([], 'https://anywhere.com');
    expect(refusal).toBeUndefined();
  });

  it('a bound licence works on its own domain', async () => {
    const { refusal } = await openWith(['acme.com'], 'https://acme.com');
    expect(refusal).toBeUndefined();
  });

  it('a bound licence works on a subdomain', async () => {
    const { refusal } = await openWith(['acme.com'], 'https://app.acme.com');
    expect(refusal).toBeUndefined();
  });

  it('a bound licence is refused on a different domain (this is the anti-sharing control)', async () => {
    const { refusal, session } = await openWith(['acme.com'], 'https://pirate.com');
    expect(refusal).toBe('origin-blocked');
    expect(session.plan).toBe(FREE_PLAN); // downgraded, not errored
  });

  it('localhost is ALWAYS allowed, or customers cannot develop (T2)', async () => {
    expect((await openWith(['acme.com'], 'http://localhost:3000')).refusal).toBeUndefined();
    expect((await openWith(['acme.com'], 'http://127.0.0.1:5173')).refusal).toBeUndefined();
  });
});
