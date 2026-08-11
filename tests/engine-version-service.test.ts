/**
 * engine-version-service.test.ts — the version registry's INVARIANTS
 * (delivery execution plan §1.2d).
 *
 * Uses an in-memory fake repository rather than a database: the behaviour under
 * test is business logic (immutability, complete-matrix, pin precedence,
 * retirement semantics), not SQL. The DB-backed paths are covered by the
 * existing e2e suites.
 *
 * Each test here pins a rule whose violation fails SILENTLY in production — a
 * customer gets the wrong build, or a token promises features that do not
 * exist, with nothing thrown and nothing logged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { EngineVersionService } from '../src/licensing/engine-version.service';
import type { EngineVersionEntity } from '../src/licensing/entities/engine-version.entity';

/** Minimal in-memory stand-in for Repository<EngineVersionEntity>. */
function fakeRepo() {
  const rows: EngineVersionEntity[] = [];
  const matches = (row: any, where: any) =>
    Object.entries(where || {}).every(([k, v]) => {
      if (v && typeof v === 'object' && '_value' in (v as any)) {
        return ((v as any)._value as any[]).includes(row[k]); // In([...])
      }
      return row[k] === v;
    });
  return {
    rows,
    create: (o: any) => ({ ...o }),
    save: async (o: any) => {
      const list = Array.isArray(o) ? o : [o];
      for (const item of list) {
        const i = rows.findIndex((r) => r.version === item.version && r.plan === item.plan);
        if (i >= 0) rows[i] = item; else rows.push(item);
      }
      return o;
    },
    findOne: async ({ where }: any) => rows.find((r) => matches(r, where)) || null,
    find: async ({ where }: any = {}) => (where ? rows.filter((r) => matches(r, where)) : [...rows]),
  } as any;
}

/**
 * A build carries REAL bytes, because a version is only complete when its
 * bundle is actually downloadable — a metadata-only row resolves and then 404s
 * in the browser (see isComplete). Distinct bytes per (version, plan) so
 * content-addressed storage keeps them separate.
 */
function bytesFor(version: string, plan: string) {
  return Buffer.from(`export const engine="${version}:${plan}";`);
}

function buildInput(version: string, plan: string, features: string[] = ['text.bold']) {
  const bytes = bytesFor(version, plan);
  return {
    version, plan,
    supportedFeatures: features,
    bundleKey: `engine/${version}/${plan}.js`,
    bundleSha256: createHash('sha256').update(bytes).digest('hex'),
    bundleBytes: bytes.length,
    bytes,
  };
}

/** In-memory stand-in for the engine_defaults pointer table. */
function fakeDefaultsRepo() {
  const rows: any[] = [];
  return {
    rows,
    create: (o: any) => ({ ...o }),
    save: async (o: any) => {
      const i = rows.findIndex((r) => r.scope === o.scope);
      if (i >= 0) rows[i] = o; else rows.push(o);
      return o;
    },
    findOne: async ({ where }: any) => rows.find((r) => r.scope === where.scope) || null,
    find: async () => [...rows],
  } as any;
}

/** In-memory BundleStorage (§1.4a) — same contract, no filesystem. */
function fakeStorage() {
  const blobs = new Map<string, Buffer>();
  return {
    blobs,
    put: async (bytes: Buffer) => {
      const d = createHash('sha256').update(bytes).digest('hex');
      blobs.set(d, bytes);
      return d;
    },
    get: async (d: string) => (blobs.has(d) ? { bytes: blobs.get(d)!, sha256: d } : null),
    has: async (d: string) => blobs.has(d),
  } as any;
}

let repo: any;
let defaultsRepo: any;
let storage: any;
let svc: EngineVersionService;
beforeEach(() => {
  repo = fakeRepo();
  defaultsRepo = fakeDefaultsRepo();
  storage = fakeStorage();
  svc = new EngineVersionService(repo, defaultsRepo, storage);
});

describe('publishBuild — immutability', () => {
  it('publishes a build', async () => {
    const row = await svc.publishBuild(buildInput('1.3.0', 'free'));
    expect(row.version).toBe('1.3.0');
    expect(row.status).toBe('published');
    expect(row.channel).toBe('internal'); // never straight to stable
  });

  it('REFUSES to overwrite an existing (version, plan)', async () => {
    await svc.publishBuild(buildInput('1.3.0', 'free'));
    // Immutability is the basis of integrity hashes, watermarking and rollback:
    // "serve v1.3.0 again" must mean the same bytes.
    await expect(svc.publishBuild(buildInput('1.3.0', 'free')))
      .rejects.toThrow(/immutable/i);
  });

  it('refuses a build with no feature manifest', async () => {
    // Without it the T14 intersection cannot be computed and every session for
    // this build would silently grant zero features.
    await expect(svc.publishBuild({ ...buildInput('1.3.0', 'free'), supportedFeatures: [] }))
      .rejects.toThrow(/supportedFeatures/);
  });

  it('refuses a malformed integrity hash', async () => {
    await expect(svc.publishBuild({ ...buildInput('1.3.0', 'free'), bundleSha256: 'nope' }))
      .rejects.toThrow(/SHA-256/);
  });
});

describe('isComplete / promote — the complete-matrix invariant', () => {
  it('a version with only one plan is incomplete', async () => {
    await svc.publishBuild(buildInput('1.3.0', 'free'));
    expect(await svc.isComplete('1.3.0'))
      .toEqual({ complete: false, missingPlans: ['premium'] });
  });

  it('a version with every plan is complete', async () => {
    await svc.publishBuild(buildInput('1.3.0', 'free'));
    await svc.publishBuild(buildInput('1.3.0', 'premium'));
    expect(await svc.isComplete('1.3.0')).toEqual({ complete: true, missingPlans: [] });
  });

  it('REFUSES to promote an incomplete version', async () => {
    await svc.publishBuild(buildInput('1.3.0', 'free'));
    // Promoting half a version to stable would strand every Pro customer:
    // they would resolve to 1.3.0 and find no premium bundle to serve.
    await expect(svc.promote('1.3.0', 'stable')).rejects.toThrow(/no build for premium/i);
  });

  it('promotes every plan of a complete version together', async () => {
    await svc.publishBuild(buildInput('1.3.0', 'free'));
    await svc.publishBuild(buildInput('1.3.0', 'premium'));
    await svc.promote('1.3.0', 'stable');
    expect((await repo.find()).map((r: any) => r.channel)).toEqual(['stable', 'stable']);
  });
});

describe('retire — never delete', () => {
  it('marks every plan retired but keeps the rows', async () => {
    await svc.publishBuild(buildInput('1.0.0', 'free'));
    await svc.publishBuild(buildInput('1.0.0', 'premium'));
    await svc.retire('1.0.0', 'superseded');
    const rows = await repo.find();
    expect(rows).toHaveLength(2);                       // still serveable to pins
    expect(rows.every((r: any) => r.status === 'retired')).toBe(true);
  });
});

describe('default pointers — and the rollback mechanism', () => {
  beforeEach(async () => {
    for (const v of ['1.2.0', '1.3.0']) {
      await svc.publishBuild(buildInput(v, 'free'));
      await svc.publishBuild(buildInput(v, 'premium'));
    }
  });

  it('sets and reads the global default', async () => {
    await svc.setDefault('global', '1.3.0');
    expect(await svc.defaultsFor('stable'))
      .toEqual({ channelDefault: null, globalDefault: '1.3.0' });
  });

  it('a channel default is read alongside the global one', async () => {
    await svc.setDefault('global', '1.2.0');
    await svc.setDefault('channel:beta', '1.3.0');
    expect(await svc.defaultsFor('beta'))
      .toEqual({ channelDefault: '1.3.0', globalDefault: '1.2.0' });
    // A stable caller must not see the beta pointer.
    expect(await svc.defaultsFor('stable'))
      .toEqual({ channelDefault: null, globalDefault: '1.2.0' });
  });

  it('ROLLBACK: moving the pointer back is one write, no rebuild', async () => {
    await svc.setDefault('global', '1.3.0');           // bad release goes out
    await svc.setDefault('global', '1.2.0');           // roll it back
    expect((await svc.defaultsFor('stable')).globalDefault).toBe('1.2.0');
    // Both versions' bundles are untouched — immutability is what makes this
    // safe, and what keeps per-licence watermarking viable later.
    expect((await repo.find()).every((r: any) => r.status === 'published')).toBe(true);
  });

  it('REFUSES to default to an incomplete version', async () => {
    await svc.publishBuild(buildInput('1.4.0', 'free')); // premium missing
    await expect(svc.setDefault('global', '1.4.0'))
      .rejects.toThrow(/no downloadable bundle for premium/i);
  });

  it('REFUSES to default to a retired version', async () => {
    await svc.retire('1.2.0');
    await expect(svc.setDefault('global', '1.2.0')).rejects.toThrow(/retired/i);
  });

  it('REFUSES to default to a version whose BYTES are missing (F1)', async () => {
    // Rows without bytes are the dangerous case: they look complete, promote
    // cleanly, resolve at session time, and then 404 in the browser. Counting
    // rows instead of bytes made this reachable in one admin action.
    const meta = (plan: string) => ({
      version: '5.0.0', plan,
      supportedFeatures: ['text.bold'],
      bundleKey: `engine/5.0.0/${plan}.js`,
      bundleSha256: (plan === 'free' ? 'a' : 'b').repeat(64),
      bundleBytes: 100,
      // no bytes — a legal metadata-only publish
    });
    await svc.publishBuild(meta('free'));
    await svc.publishBuild(meta('premium'));

    expect(await svc.isComplete('5.0.0'))
      .toEqual({ complete: false, missingPlans: ['free', 'premium'] });
    await expect(svc.promote('5.0.0', 'stable')).rejects.toThrow(/DOWNLOADABLE/i);
    await expect(svc.setDefault('global', '5.0.0')).rejects.toThrow(/downloadable/i);
  });

  it('an unconfigured default reads as null so resolution fails closed', async () => {
    expect(await svc.defaultsFor('stable'))
      .toEqual({ channelDefault: null, globalDefault: null });
  });
});

describe('resolveForLicence — version first, then features', () => {
  beforeEach(async () => {
    await svc.publishBuild(buildInput('1.2.0', 'premium', ['text.bold']));
    await svc.publishBuild(buildInput('1.3.0', 'premium', ['text.bold', 'table.merge']));
    await svc.promote('1.2.0', 'stable').catch(() => {});
    // 1.2.0 has no free build in this fixture, so promote() refuses — set the
    // channel directly, which is what matters for these assertions.
    for (const r of await repo.find()) r.channel = 'stable';
  });

  it('serves the global default and intersects features with that build', async () => {
    const out = await svc.resolveForLicence(
      { packageFeatures: ['text.bold', 'table.merge'], plan: 'premium' },
      { globalDefault: '1.3.0' },
    );
    expect(out.version).toBe('1.3.0');
    expect(out.features).toEqual(['table.merge', 'text.bold']);
    expect(out.missing).toEqual([]);
    expect(out.source).toBe('global');
  });

  it('a PIN wins over the global default', async () => {
    const out = await svc.resolveForLicence(
      { pinnedVersion: '1.2.0', packageFeatures: ['text.bold'], plan: 'premium' },
      { globalDefault: '1.3.0' },
    );
    expect(out.version).toBe('1.2.0');
    expect(out.source).toBe('pin');
  });

  it('a pinned OLD build never promises a feature it lacks — and reports the gap', async () => {
    // The customer pays for table.merge, but is pinned to a build without it.
    // The token must not claim it (the editor would gate it ON and it would do
    // nothing); the shortfall is reported separately for alerting.
    const out = await svc.resolveForLicence(
      { pinnedVersion: '1.2.0', packageFeatures: ['text.bold', 'table.merge'], plan: 'premium' },
      { globalDefault: '1.3.0' },
    );
    expect(out.features).toEqual(['text.bold']);
    expect(out.missing).toEqual(['table.merge']);
  });

  it('a retired version is still served to a PIN', async () => {
    await svc.retire('1.2.0');
    const out = await svc.resolveForLicence(
      { pinnedVersion: '1.2.0', packageFeatures: ['text.bold'], plan: 'premium' },
      { globalDefault: '1.3.0' },
    );
    expect(out.version).toBe('1.2.0'); // retirement stops new installs, not existing ones
  });

  it('a retired version is NOT served as a default', async () => {
    await svc.retire('1.3.0');
    await expect(svc.resolveForLicence(
      { packageFeatures: ['text.bold'], plan: 'premium' },
      { globalDefault: '1.3.0' },
    )).rejects.toThrow(/retired/);
  });

  it('a stable customer is not given a beta default', async () => {
    for (const r of await repo.find()) if (r.version === '1.3.0') r.channel = 'beta';
    await expect(svc.resolveForLicence(
      { channel: 'stable', packageFeatures: ['text.bold'], plan: 'premium' },
      { globalDefault: '1.3.0' },
    )).rejects.toThrow(/beta channel/);
  });

  it('fails clearly when no default is configured at all', async () => {
    await expect(svc.resolveForLicence(
      { packageFeatures: ['text.bold'], plan: 'premium' }, {},
    )).rejects.toThrow(/no engine version/i);
  });

  it('fails clearly when the resolved version has no build for the plan', async () => {
    await expect(svc.resolveForLicence(
      { packageFeatures: ['text.bold'], plan: 'free' },
      { globalDefault: '1.3.0' },
    )).rejects.toThrow(/no free build/i);
  });
});

describe('publishBuild with BYTES — atomicity and integrity (§1.4a, R42)', () => {
  const bytes = Buffer.from('export const engine = "real";');
  const realSha = createHash('sha256').update(bytes).digest('hex');
  const withBytes = (version = '1.3.0', plan = 'free') => ({
    ...buildInput(version, plan), bundleSha256: realSha, bundleBytes: bytes.length, bytes,
  });

  it('stores the bytes and records the row', async () => {
    const row = await svc.publishBuild(withBytes());
    expect(row.bundleSha256).toBe(realSha);
    expect(await storage.has(realSha)).toBe(true);
  });

  it('REFUSES bytes whose hash disagrees with the manifest', async () => {
    // The build declares a hash; re-hashing what arrived proves the bytes that
    // landed are the bytes that were built. Corruption caught at publish time
    // instead of in a customer's browser.
    await expect(svc.publishBuild({
      ...withBytes(), bundleSha256: 'd'.repeat(64),
    })).rejects.toThrow(/hash mismatch/i);
  });

  it('REFUSES bytes whose length disagrees with the manifest', async () => {
    await expect(svc.publishBuild({ ...withBytes(), bundleBytes: 999_999 }))
      .rejects.toThrow(/size mismatch/i);
  });

  it('writes NO registry row when the bytes are rejected', async () => {
    // The ordering that matters (R42): a failed upload must leave the version
    // non-existent and retryable, never a row that resolves at session time and
    // then 404s at download time.
    await expect(svc.publishBuild({
      ...withBytes(), bundleSha256: 'd'.repeat(64),
    })).rejects.toThrow();
    expect(repo.rows).toHaveLength(0);
    expect(await svc.isComplete('1.3.0')).toEqual({
      complete: false, missingPlans: ['free', 'premium'],
    });
  });

  it('stores bytes BEFORE committing the row', async () => {
    // Proven by construction: if storage throws, no row may exist.
    const exploding = { ...storage, put: async () => { throw new Error('disk full'); } };
    const svc2 = new EngineVersionService(repo, defaultsRepo, exploding as any);
    await expect(svc2.publishBuild(withBytes())).rejects.toThrow(/disk full/);
    expect(repo.rows).toHaveLength(0);
  });

  it('refuses bytes when no storage is configured, rather than dropping them', async () => {
    // Silently discarding the bytes would produce exactly the undownloadable
    // row this section exists to prevent.
    const svc2 = new EngineVersionService(repo, defaultsRepo, null as any);
    await expect(svc2.publishBuild(withBytes())).rejects.toThrow(/no BundleStorage/i);
  });
});

describe('restoreBundleBytes — repair without breaking immutability (G3)', () => {
  const input = () => buildInput('1.3.0', 'free');

  it('restores bytes that went missing, and reports it', async () => {
    const b = input();
    await svc.publishBuild(b);
    storage.blobs.clear();                    // redeploy wiped the disk

    expect((await svc.isComplete('1.3.0')).complete).toBe(false);
    const r = await svc.restoreBundleBytes('1.3.0', 'free', b.bytes);
    expect(r).toEqual({
      version: '1.3.0', plan: 'free', sha256: b.bundleSha256, restored: true,
    });
    expect(await storage.has(b.bundleSha256)).toBe(true);
  });

  it('REFUSES bytes that are not the originally published bundle', async () => {
    // This is what keeps "restore" from becoming "edit". A version's meaning
    // can never change; only its bytes can be put back.
    await svc.publishBuild(input());
    storage.blobs.clear();
    await expect(
      svc.restoreBundleBytes('1.3.0', 'free', Buffer.from('DIFFERENT CONTENT')),
    ).rejects.toThrow(/refusing to restore/i);
  });

  it('is idempotent — re-running a repair script is safe', async () => {
    const b = input();
    await svc.publishBuild(b);
    // Bytes are already present; restoring must be a no-op, not an error.
    const r = await svc.restoreBundleBytes('1.3.0', 'free', b.bytes);
    expect(r.restored).toBe(false);
  });

  it('404s an unknown build rather than inventing one', async () => {
    await expect(svc.restoreBundleBytes('9.9.9', 'free', Buffer.from('x')))
      .rejects.toThrow(/unknown build/i);
  });

  it('a restored version becomes promotable again', async () => {
    // The whole point: recovery without forcing a version bump on customers.
    for (const plan of ['free', 'premium']) {
      await svc.publishBuild(buildInput('1.3.0', plan));
    }
    storage.blobs.clear();
    await expect(svc.promote('1.3.0', 'stable')).rejects.toThrow(/DOWNLOADABLE/i);

    for (const plan of ['free', 'premium']) {
      await svc.restoreBundleBytes('1.3.0', plan, bytesFor('1.3.0', plan));
    }
    await expect(svc.promote('1.3.0', 'stable')).resolves.toBeDefined();
  });
});

describe('listVersionsWithHealth — surfacing byte drift (G3)', () => {
  it('reports bytesPresent per build', async () => {
    await svc.publishBuild(buildInput('1.3.0', 'free'));
    await svc.publishBuild(buildInput('1.3.0', 'premium'));

    let rows = await svc.listVersionsWithHealth();
    expect(rows.every((r) => r.bytesPresent)).toBe(true);

    storage.blobs.clear();
    rows = await svc.listVersionsWithHealth();
    // Rows survive, bytes do not — exactly what a redeploy onto an ephemeral
    // filesystem looks like, and previously only discoverable by trying to
    // promote and reading the error.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.bytesPresent)).toBe(false);
  });
});

describe('readBundle — the registry is the authority (§1.4)', () => {
  const bytes = Buffer.from('export const engine = "served";');
  const realSha = createHash('sha256').update(bytes).digest('hex');
  const publish = (version: string, plan: string) => svc.publishBuild({
    ...buildInput(version, plan), bundleSha256: realSha, bundleBytes: bytes.length, bytes,
  });

  it('returns the bytes for a matching (version, plan, digest)', async () => {
    await publish('1.3.0', 'free');
    const got = await svc.readBundle('1.3.0', 'free', realSha);
    expect(got?.bytes.equals(bytes)).toBe(true);
  });

  it('returns null for an unknown version, plan, or digest', async () => {
    await publish('1.3.0', 'free');
    expect(await svc.readBundle('9.9.9', 'free', realSha)).toBeNull();
    expect(await svc.readBundle('1.3.0', 'premium', realSha)).toBeNull();
    expect(await svc.readBundle('1.3.0', 'free', 'e'.repeat(64))).toBeNull();
  });

  it('refuses a digest that belongs to a DIFFERENT (version, plan)', async () => {
    // Without this the premium bundle could be pulled through the free plan's
    // unsigned path — bypassing the R44 signature entirely.
    const premiumBytes = Buffer.from('PREMIUM ONLY');
    const premiumSha = createHash('sha256').update(premiumBytes).digest('hex');
    await svc.publishBuild({
      ...buildInput('1.3.0', 'premium'),
      bundleSha256: premiumSha, bundleBytes: premiumBytes.length, bytes: premiumBytes,
    });
    // The premium digest exists in storage, but not under the free label.
    expect(await svc.readBundle('1.3.0', 'free', premiumSha)).toBeNull();
  });

  it('still serves a RETIRED version — pinned customers must keep working', async () => {
    await publish('1.3.0', 'free');
    await svc.retire('1.3.0', 'superseded');
    const got = await svc.readBundle('1.3.0', 'free', realSha);
    expect(got?.bytes.equals(bytes)).toBe(true);
  });

  it('is case-insensitive about the digest from the URL', async () => {
    await publish('1.3.0', 'free');
    expect(await svc.readBundle('1.3.0', 'free', realSha.toUpperCase())).not.toBeNull();
  });
});
