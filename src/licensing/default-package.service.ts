/**
 * default-package.service.ts — resolves what an UNLICENSED visitor receives
 * (Stage 2a).
 *
 * ─── R1: THE ANONYMOUS PATH MUST NOT WAIT ON THE DATABASE ───────────────────
 * Today an anonymous session performs ZERO database reads — that is T17, and it
 * is why a database blip currently costs free users nothing. Naively looking up
 * the designated package on every session would put a query on the hottest,
 * most exposed endpoint in the system and hand it a new failure mode.
 *
 * So the resolved feature list is CACHED IN MEMORY and refreshed on a TTL. A
 * session reads a variable, never a table. The database is consulted only when
 * the cache is cold or stale, and even then a failure does not propagate.
 *
 * ─── R3: IT MUST NEVER RETURN NOTHING ───────────────────────────────────────
 * Three things can go wrong: the seed never ran, an admin deleted the package
 * despite the guard, or the database is unreachable. In all three the editor
 * must still work. The order of preference is:
 *
 *   1. the designated package's features            (the intended answer)
 *   2. the LAST KNOWN GOOD list, even if stale      (a blip changes nothing)
 *   3. a minimal built-in set                       (last resort, logged loudly)
 *
 * (2) is what makes a database outage invisible rather than catastrophic: the
 * cache simply keeps serving what it served a minute ago.
 *
 * The minimal set is deliberately SMALL rather than generous. If we cannot tell
 * what the customer is entitled to, handing out everything would give paid
 * features away during an incident — the failure would be silent and expensive.
 * A visibly reduced editor is recoverable; revenue given away is not.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PackageEntity } from './entities/package.entity';
import { DefaultPackageEntity, DEFAULT_PACKAGE_ID } from './entities/default-package.entity';

/**
 * Last-resort feature set, used only when the designated package cannot be
 * resolved AND nothing has ever been cached.
 *
 * Typing/undo/clipboard are not in this list because they are ALWAYS_ON in the
 * engine and cannot be gated at all — including them would imply they were
 * optional.
 */
export const MINIMAL_FALLBACK_FEATURES = Object.freeze([
  'text.bold',
  'text.italic',
  'text.underline',
  'paragraph.headings',
  'list.bullet',
  'list.ordered',
  'insert.link',
]);

/** How long a resolved list is trusted before a refresh is attempted. */
export const CACHE_TTL_MS = 30_000;

/**
 * What a REVOKED licence falls back to (Stage 2b).
 *
 * This is a PRICING decision, not an engineering one, so it is configuration
 * rather than a hardcoded choice — consistent with the rest of the
 * dynamic-package work, where what a tier contains is data an admin controls.
 *
 *   'free'    — a revoked licence behaves like any unlicensed visitor. Forgiving;
 *               the customer keeps a normal free editor and can come back.
 *   'minimal' — a revoked licence drops to the small built-in set. Creates
 *               pressure to resolve non-payment or abuse.
 *
 * Defaults to 'free' because revocation is sometimes a mistake (wrong licence
 * revoked, a billing glitch), and the cost of being wrong is asymmetric: over-
 * serving a genuinely bad actor costs a little; crippling a legitimate
 * customer's site over an admin error costs trust.
 *
 * The OTHER refusals are deliberately not configurable. invalid-key is
 * effectively an anonymous visitor; expired / origin-blocked / install-cap are
 * honest customers hitting a snag — a lapsed subscription, an unregistered
 * domain, one machine too many. Punishing those would be punishing the people
 * most likely to pay you.
 */
export type RevokedPolicy = 'free' | 'minimal';

export function loadRevokedPolicy(env: NodeJS.ProcessEnv = process.env): RevokedPolicy {
  return String(env.LICENSE_REVOKED_FALLBACK || '').toLowerCase() === 'minimal'
    ? 'minimal'
    : 'free';
}

interface Cached {
  features: string[];
  packageId: string | null;
  at: number;
}

@Injectable()
export class DefaultPackageService {
  private readonly log = new Logger(DefaultPackageService.name);

  /** Last known good. Survives database outages; see R3. */
  private cache: Cached | null = null;

  /** In-flight refresh, so a burst of sessions triggers ONE query, not N. */
  private inflight: Promise<void> | null = null;

  constructor(
    @Optional() @InjectRepository(DefaultPackageEntity)
    private readonly defaults?: Repository<DefaultPackageEntity>,
    @Optional() @InjectRepository(PackageEntity)
    private readonly packages?: Repository<PackageEntity>,
  ) {}

  /**
   * The features an unlicensed visitor receives. Never throws, never blocks on
   * the database when a usable cached value exists.
   */
  featuresForAnonymous(now = Date.now()): string[] {
    const fresh = this.cache && (now - this.cache.at) < CACHE_TTL_MS;
    if (!fresh) {
      // Fire and forget: a stale value is served NOW and the refresh lands for
      // the next caller. Awaiting here would reintroduce exactly the
      // hot-path database dependency this design exists to avoid.
      void this.refresh();
    }
    if (this.cache) return this.cache.features;
    return [...MINIMAL_FALLBACK_FEATURES];
  }

  /**
   * What a caller whose licence was REFUSED receives.
   *
   * Four of the five refusals are honest users hitting a snag (lapsed
   * subscription, unregistered domain, one machine too many, a typo'd key), so
   * they get the same editor an anonymous visitor gets. Only `revoked` — a
   * deliberate admin action — is policy-driven.
   */
  featuresForRefusal(reason: string, policy: RevokedPolicy = loadRevokedPolicy()): string[] {
    if (reason === 'revoked' && policy === 'minimal') {
      return [...MINIMAL_FALLBACK_FEATURES];
    }
    return this.featuresForAnonymous();
  }

  /** Force a synchronous refresh — used at boot and by tests. */
  async warm(): Promise<void> {
    await this.refresh();
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.load().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async load(): Promise<void> {
    if (!this.defaults || !this.packages) return;
    try {
      const row = await this.defaults.findOne({ where: { id: DEFAULT_PACKAGE_ID } });
      if (!row?.packageId) {
        this.noteUnresolvable('no default package is designated');
        return;
      }
      const pkg = await this.packages.findOne({
        where: { id: row.packageId },
        relations: ['features'],
      });
      if (!pkg) {
        this.noteUnresolvable(`designated package ${row.packageId} no longer exists`);
        return;
      }
      const features = (pkg.features || []).map((f) => f.id).filter(Boolean);
      if (!features.length) {
        // An empty package would silently disable the editor for every
        // anonymous visitor. Treat it as unresolvable rather than obeying it.
        this.noteUnresolvable(`designated package ${pkg.name} grants no features`);
        return;
      }
      this.cache = { features, packageId: pkg.id, at: Date.now() };
    } catch (err) {
      // Keep serving the last known good value; see R3.
      this.log.warn(
        `could not refresh the default package (serving ${this.cache ? 'cached' : 'minimal'} features): ${String(err)}`,
      );
    }
  }

  /**
   * Could not resolve a designated package. Keep any cached value — it is more
   * likely to be right than the minimal set — but say so loudly, because this
   * state means an admin's intent is not being applied.
   */
  private noteUnresolvable(why: string): void {
    this.log.error(
      `DEFAULT PACKAGE UNRESOLVABLE: ${why}. `
      + `Anonymous visitors are receiving ${this.cache ? 'the last known good list' : 'the minimal fallback set'}.`,
    );
  }

  /** Current designation, for the admin API. */
  async current(): Promise<{ packageId: string; name: string | null } | null> {
    if (!this.defaults || !this.packages) return null;
    const row = await this.defaults.findOne({ where: { id: DEFAULT_PACKAGE_ID } });
    if (!row?.packageId) return null;
    const pkg = await this.packages.findOne({ where: { id: row.packageId } });
    return { packageId: row.packageId, name: pkg?.name ?? null };
  }

  /**
   * Designate a package. Refuses one that grants nothing — that would disable
   * the editor for every anonymous visitor on the internet, with no error
   * anywhere and no obvious cause.
   */
  async designate(
    packageId: string,
    audit: { actor?: string; reason?: string } = {},
  ): Promise<{ packageId: string; features: number }> {
    if (!this.defaults || !this.packages) {
      throw new Error('default-package storage is not configured');
    }
    const pkg = await this.packages.findOne({
      where: { id: packageId }, relations: ['features'],
    });
    if (!pkg) throw new Error(`unknown package ${packageId}`);
    const count = (pkg.features || []).length;
    if (!count) {
      throw new Error(
        `package "${pkg.name}" grants no features — designating it would leave every `
        + 'anonymous visitor with an editor that does nothing.',
      );
    }

    await this.defaults.save(this.defaults.create({
      id: DEFAULT_PACKAGE_ID,
      packageId,
      actor: (audit.actor || '').slice(0, 128),
      reason: (audit.reason || '').slice(0, 500),
    }));

    // Refresh immediately so the change is live now rather than within a TTL.
    this.cache = null;
    await this.refresh();
    return { packageId, features: count };
  }

  /** Is this package the designated default? Used by the delete guard (R2). */
  async isDesignated(packageId: string): Promise<boolean> {
    if (!this.defaults) return false;
    const row = await this.defaults.findOne({ where: { id: DEFAULT_PACKAGE_ID } });
    return row?.packageId === packageId;
  }
}
