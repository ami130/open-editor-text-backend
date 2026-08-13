/**
 * Stage 2a — the admin-defined free tier.
 *
 * The properties here are the guardrails, not the happy path. This code decides
 * what EVERY unlicensed visitor on the internet receives, and it sits on the
 * hottest, most exposed endpoint in the system.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DefaultPackageService, MINIMAL_FALLBACK_FEATURES, CACHE_TTL_MS,
} from '../src/licensing/default-package.service';

const pkgRow = (id: string, features: string[]) => ({
  id, name: `pkg-${id}`, features: features.map((f) => ({ id: f })),
});

function svc(opts: {
  designated?: string | null;
  packages?: Record<string, ReturnType<typeof pkgRow>>;
  throwOn?: 'defaults' | 'packages';
} = {}) {
  const defaults = {
    findOne: async () => {
      if (opts.throwOn === 'defaults') throw new Error('db down');
      return opts.designated ? { id: 'anonymous', packageId: opts.designated } : null;
    },
    save: async (r: unknown) => r,
    create: (r: unknown) => r,
  };
  const packages = {
    findOne: async ({ where }: { where: { id: string } }) => {
      if (opts.throwOn === 'packages') throw new Error('db down');
      return opts.packages?.[where.id] ?? null;
    },
  };
  return new DefaultPackageService(defaults as never, packages as never);
}

describe('anonymous feature resolution', () => {
  it('serves the designated package\'s features', async () => {
    const s = svc({ designated: 'p1', packages: { p1: pkgRow('p1', ['text.bold', 'insert.table']) } });
    await s.warm();
    expect(s.featuresForAnonymous()).toEqual(['text.bold', 'insert.table']);
  });

  it('R1: reads from CACHE, not the database, on the hot path', async () => {
    // The anonymous route performed ZERO queries before Stage 2a (T17). It must
    // still perform zero — a query here would put the most exposed endpoint in
    // the system behind the database.
    const packages = { p1: pkgRow('p1', ['text.bold']) };
    const s = svc({ designated: 'p1', packages });
    await s.warm();

    let queries = 0;
    // @ts-expect-error reaching into the private repo to count calls
    const orig = s.packages.findOne;
    // @ts-expect-error same
    s.packages.findOne = async (...a: unknown[]) => { queries += 1; return orig(...a); };

    for (let i = 0; i < 50; i += 1) s.featuresForAnonymous();
    expect(queries).toBe(0);
  });

  it('R3: a DATABASE OUTAGE keeps serving the last known good list', async () => {
    // This is the property that makes Stage 2a safe. Before it, a DB blip cost
    // free users nothing; it must still cost them nothing.
    const s = svc({ designated: 'p1', packages: { p1: pkgRow('p1', ['text.bold', 'list.bullet']) } });
    await s.warm();
    const good = s.featuresForAnonymous();

    // @ts-expect-error simulate the database going away
    s.defaults.findOne = async () => { throw new Error('db down'); };
    // Force the cache stale so a refresh is attempted and fails.
    await s.warm();

    expect(s.featuresForAnonymous()).toEqual(good);
  });

  it('R3: a cold process with NO cache falls back to a minimal set, never nothing', async () => {
    const s = svc({ throwOn: 'defaults' });
    await s.warm();
    const out = s.featuresForAnonymous();
    expect(out.length).toBeGreaterThan(0);
    expect(out).toEqual([...MINIMAL_FALLBACK_FEATURES]);
  });

  it('the minimal set is SMALL — an incident must not give paid features away', () => {
    // If we cannot tell what someone is entitled to, handing out everything
    // would leak premium silently. A visibly reduced editor is recoverable.
    expect(MINIMAL_FALLBACK_FEATURES.length).toBeLessThan(12);
    expect(MINIMAL_FALLBACK_FEATURES.some((f) => f.startsWith('export.'))).toBe(false);
  });

  it('an EMPTY designated package is refused, not obeyed', async () => {
    // Obeying it would disable the editor for every anonymous visitor, with no
    // error anywhere and no obvious cause.
    const s = svc({ designated: 'p1', packages: { p1: pkgRow('p1', []) } });
    await s.warm();
    expect(s.featuresForAnonymous()).toEqual([...MINIMAL_FALLBACK_FEATURES]);
  });

  it('a DELETED designated package falls back rather than crashing', async () => {
    const s = svc({ designated: 'ghost', packages: {} });
    await s.warm();
    expect(s.featuresForAnonymous()).toEqual([...MINIMAL_FALLBACK_FEATURES]);
  });

  it('designate() REFUSES a package that grants nothing', async () => {
    const s = svc({ designated: null, packages: { empty: pkgRow('empty', []) } });
    await expect(s.designate('empty')).rejects.toThrow(/grants no features/i);
  });

  it('designate() applies immediately, not after the TTL', async () => {
    const s = svc({ designated: null, packages: { p2: pkgRow('p2', ['text.italic']) } });
    // designate() re-reads through the same repo, so point the stub at p2.
    // @ts-expect-error stub swap
    s.defaults.findOne = async () => ({ id: 'anonymous', packageId: 'p2' });
    await s.designate('p2');
    expect(s.featuresForAnonymous()).toEqual(['text.italic']);
  });

  it('a burst of sessions triggers ONE refresh, not one per request', async () => {
    let loads = 0;
    const s = svc({ designated: 'p1', packages: { p1: pkgRow('p1', ['text.bold']) } });
    // @ts-expect-error count refreshes
    const orig = s.defaults.findOne;
    // @ts-expect-error same
    s.defaults.findOne = async (...a: unknown[]) => { loads += 1; return orig(...a); };

    // All cold-cache calls in the same tick should share one in-flight load.
    for (let i = 0; i < 20; i += 1) s.featuresForAnonymous();
    await new Promise((r) => setTimeout(r, 10));
    expect(loads).toBe(1);
  });

  it('CACHE_TTL is short enough that an admin change lands quickly', () => {
    // An admin edit that took minutes to appear would look broken.
    expect(CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
  });
});
