/**
 * engine-version.service.ts — the version REGISTRY (delivery execution plan
 * §1.2). Publishing builds, moving the default pointer, and resolving which
 * build a given licence receives.
 *
 * The pure decision logic lives in version-resolution.ts and is unit-tested
 * exhaustively; this file is the database-facing half.
 *
 * TWO INVARIANTS ENFORCED HERE, both of which fail SILENTLY if skipped:
 *
 *   1. COMPLETE MATRIX — a version is only resolvable once EVERY active plan
 *      has a build. Publishing v1.3.0 with only a free bundle would leave a Pro
 *      customer resolving to a version with nothing to serve them, discovered
 *      at session time rather than at publish time.
 *
 *   2. IMMUTABILITY — a published (version, plan) row is never edited. New
 *      content is a new version. Integrity hashes, watermarking, and rollback
 *      all assume the bytes behind a version never change.
 */
import {
  Injectable, BadRequestException, NotFoundException, Inject, Optional,
} from '@nestjs/common';
import { Repository, In } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { BUNDLE_STORAGE, BundleStorage, digestOf } from '../delivery/bundle-storage';
import { EngineVersionEntity, EngineChannel } from './entities/engine-version.entity';
import {
  EngineDefaultEntity, GLOBAL_SCOPE, channelScope,
} from './entities/engine-default.entity';
import {
  resolveVersion, resolveFeatures, missingFromBuild, channelAllows,
  eligibleAsDefault,
} from './version-resolution';

/** Plans that must have a build before a version may be published. */
export const REQUIRED_PLANS = ['free', 'premium'] as const;

export interface PublishBuildInput {
  version: string;
  plan: string;
  supportedFeatures: string[];
  bundleKey: string;
  bundleSha256: string;
  bundleBytes: number;
  channel?: EngineChannel;
  notes?: string;
  /**
   * The bundle's actual bytes (§1.4a). Stored BEFORE the row is committed, and
   * verified against `bundleSha256`.
   *
   * Optional only so that metadata-only tests and legacy callers still work; a
   * publish without bytes produces a row whose bundle cannot be downloaded, so
   * the admin API always supplies them.
   */
  bytes?: Buffer;
}

export interface ResolveForLicenceInput {
  pinnedVersion?: string | null;
  overrideVersion?: string | null;
  channel?: string | null;
  /** Features the customer's PACKAGE grants (source of truth for entitlement). */
  packageFeatures: readonly string[];
  /** Which bundle they should receive: 'free' | 'premium'. */
  plan: string;
}

export interface ResolvedDelivery {
  version: string;
  plan: string;
  bundleKey: string;
  bundleSha256: string;
  /** package.features ∩ this build's supportedFeatures (T14). */
  features: string[];
  /** Paid features this build cannot provide — for logging, never sent to the client. */
  missing: string[];
  /** Which chain step decided the version — surfaced in logs and admin views. */
  source: string;
}

@Injectable()
export class EngineVersionService {
  constructor(
    @InjectRepository(EngineVersionEntity)
    private readonly versions: Repository<EngineVersionEntity>,
    @InjectRepository(EngineDefaultEntity)
    private readonly defaults: Repository<EngineDefaultEntity>,
    /**
     * Where bundle BYTES live (§1.4a). Optional so metadata-only tests can
     * construct the service without a filesystem; when absent, publishing with
     * bytes is refused rather than silently dropping them.
     */
    @Optional() @Inject(BUNDLE_STORAGE)
    private readonly storage: BundleStorage | null = null,
  ) {}

  // ── Default pointers (steps 3 and 4 of the resolution chain) ──────────────

  /**
   * Point a scope at a version. This is also the ROLLBACK mechanism: moving
   * 'global' back to an earlier version undoes a bad release in seconds,
   * without touching a single published bundle.
   *
   * Refuses an incomplete or retired version — a default must be something
   * every plan can actually be served.
   */
  async setDefault(scope: string, version: string): Promise<EngineDefaultEntity> {
    const { complete, missingPlans } = await this.isComplete(version);
    if (!complete) {
      throw new BadRequestException(
        `Cannot make ${version} a default: no downloadable bundle for `
        + `${missingPlans.join(', ')}. Making this the default would point every new `
        + 'session at a version whose bundle cannot be fetched.',
      );
    }
    const rows = await this.versions.find({ where: { version } });
    if (rows.some((r) => !eligibleAsDefault(r.status))) {
      throw new BadRequestException(`Cannot make ${version} a default: it is retired.`);
    }
    const existing = await this.defaults.findOne({ where: { scope } });
    if (existing) {
      existing.version = version;
      return this.defaults.save(existing);
    }
    return this.defaults.save(this.defaults.create({ scope, version }));
  }

  /**
   * Read the defaults that apply to a caller on a given channel.
   *
   * An empty-string version is treated as "not configured" so resolution falls
   * through and ultimately fails closed, rather than a blank version silently
   * becoming a lookup for a build that cannot exist.
   */
  async defaultsFor(channel: EngineChannel): Promise<{
    channelDefault: string | null;
    globalDefault: string | null;
  }> {
    const [ch, global] = await Promise.all([
      this.defaults.findOne({ where: { scope: channelScope(channel) } }),
      this.defaults.findOne({ where: { scope: GLOBAL_SCOPE } }),
    ]);
    return {
      channelDefault: ch?.version || null,
      globalDefault: global?.version || null,
    };
  }

  listDefaults(): Promise<EngineDefaultEntity[]> {
    return this.defaults.find();
  }

  // ── Publishing ────────────────────────────────────────────────────────────

  /**
   * Register one built bundle. Refuses to overwrite an existing (version, plan)
   * — immutability is the whole basis of rollback and integrity verification.
   */
  async publishBuild(input: PublishBuildInput): Promise<EngineVersionEntity> {
    const existing = await this.versions.findOne({
      where: { version: input.version, plan: input.plan },
    });
    if (existing) {
      throw new BadRequestException(
        `${input.version} (${input.plan}) is already published. Published builds are `
        + 'immutable — publish a new version instead of replacing this one.',
      );
    }
    if (!input.supportedFeatures?.length) {
      // Without a manifest the T14 intersection cannot be computed, and every
      // session for this build would grant zero features.
      throw new BadRequestException(
        'supportedFeatures is required — it is the right-hand side of the '
        + 'feature intersection. Produce it with the engine\'s build-manifest script.',
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(input.bundleSha256 || '')) {
      throw new BadRequestException('bundleSha256 must be a 64-character SHA-256 hex digest');
    }

    // ── Bytes BEFORE the row (§1.4a, risk R42) ──────────────────────────────
    // Order matters and is the whole point. Storing bytes first means a failed
    // upload leaves NO registry row — the version simply does not exist yet,
    // which is a clean, retryable state.
    //
    // The reverse order produces the worst possible outcome: a row that
    // resolves successfully at session time and then 404s when the loader tries
    // to download it. That failure surfaces in the customer's browser rather
    // than in our publish step.
    if (input.bytes) {
      if (!this.storage) {
        throw new BadRequestException(
          'bundle bytes were supplied but no BundleStorage is configured',
        );
      }
      // Re-hash what we actually received. §1.1 computes a digest at build
      // time; recomputing it here proves the bytes that arrived are the bytes
      // that were built, turning "did the upload corrupt?" into an answered
      // question for the cost of one hash.
      const actual = digestOf(input.bytes);
      if (actual !== input.bundleSha256.toLowerCase()) {
        throw new BadRequestException(
          `bundle hash mismatch: the manifest declares ${input.bundleSha256} but the `
          + `uploaded bytes hash to ${actual}. The upload was corrupted or the wrong `
          + 'file was sent.',
        );
      }
      if (input.bundleBytes && input.bundleBytes !== input.bytes.length) {
        throw new BadRequestException(
          `bundle size mismatch: manifest declares ${input.bundleBytes} bytes but `
          + `${input.bytes.length} were uploaded.`,
        );
      }
      await this.storage.put(input.bytes);
    }

    return this.versions.save(this.versions.create({
      version: input.version,
      plan: input.plan,
      supportedFeatures: input.supportedFeatures,
      bundleKey: input.bundleKey,
      bundleSha256: input.bundleSha256,
      bundleBytes: input.bundleBytes ?? 0,
      channel: input.channel ?? 'internal',
      notes: input.notes ?? '',
      status: 'published',
    }));
  }

  /**
   * Read a bundle's bytes for the engine endpoint (§1.4).
   *
   * The registry is consulted FIRST, and the digest must match the row for that
   * (version, plan). Serving straight from storage by digest alone would let
   * any stored bundle be fetched under any label — most importantly, the
   * PREMIUM bundle could be requested through the free plan's unsigned path,
   * bypassing R44's signature entirely.
   *
   * Returns null for anything unknown so the caller can 404 uniformly: a
   * missing version, a wrong plan, a stale digest, and a bundle whose bytes
   * were never uploaded are indistinguishable to the client, which keeps this
   * route from becoming a probe for what exists.
   */
  async readBundle(
    version: string,
    plan: string,
    digest: string,
  ): Promise<{ bytes: Buffer; sha256: string } | null> {
    if (!this.storage) return null;
    const row = await this.versions.findOne({ where: { version, plan } });
    if (!row) return null;
    // Case-insensitive: the digest arrives from a URL, and the registry stores
    // whatever the manifest declared.
    if (row.bundleSha256.toLowerCase() !== digest.toLowerCase()) return null;

    // A retired version STILL SERVES — customers pinned to it must keep
    // working. Retirement only stops it being resolved as a default (§1.2).
    return this.storage.get(row.bundleSha256.toLowerCase());
  }

  /**
   * Restore the BYTES for an already-published build (§1.4a).
   *
   * WHY THIS IS NOT A CONTRADICTION OF IMMUTABILITY: it cannot change what a
   * version means. The uploaded bytes must hash to the digest the row ALREADY
   * records, so the only possible outcome is restoring exactly the bundle that
   * was published. A different bundle is rejected, not accepted as an update.
   *
   * WHY IT IS NEEDED: rows live in the database and bytes live in storage, and
   * a redeploy onto an ephemeral filesystem separates them. Without a repair
   * path the only remedy is publishing a NEW version — which forces a version
   * bump on customers for what is purely an infrastructure accident, and leaves
   * the original version permanently broken for anyone pinned to it.
   */
  async restoreBundleBytes(
    version: string,
    plan: string,
    bytes: Buffer,
  ): Promise<{ version: string; plan: string; sha256: string; restored: boolean }> {
    if (!this.storage) {
      throw new BadRequestException('no BundleStorage is configured');
    }
    const row = await this.versions.findOne({ where: { version, plan } });
    if (!row) throw new NotFoundException(`unknown build ${version} (${plan})`);

    const expected = row.bundleSha256.toLowerCase();
    const actual = digestOf(bytes);
    if (actual !== expected) {
      throw new BadRequestException(
        `refusing to restore ${version} (${plan}): these bytes hash to ${actual} but the `
        + `published build is ${expected}. Restoring only ever re-uploads the ORIGINAL `
        + 'bundle — publish a new version to ship different content.',
      );
    }

    // Already present: idempotent, so re-running a repair script is safe.
    if (await this.storage.has(expected)) {
      return { version, plan, sha256: expected, restored: false };
    }
    await this.storage.put(bytes);
    return { version, plan, sha256: expected, restored: true };
  }

  /**
   * Is this version complete — does every required plan have a build whose
   * BYTES ARE ACTUALLY DOWNLOADABLE?
   *
   * Checked BEFORE a version may be promoted or made a default. A partial
   * publish is a normal intermediate state (the two bundles are uploaded one at
   * a time); it only becomes a bug if such a version can be resolved.
   *
   * ⚠️ THIS ONCE COUNTED ROWS, NOT BYTES — and that was a hole big enough to
   * take down every new session. `bundleBase64` is optional on the publish DTO,
   * so a metadata-only publish is legal; two such rows satisfied "complete", the
   * version could then be promoted to stable AND made the global default, and
   * every subsequent session resolved to a version whose bundle 404s. One admin
   * action, a blank editor for every new user, and nothing anywhere warned.
   *
   * Storing bytes before the row (see publishBuild) protects the publish path
   * only; this protects the RESOLUTION path, which is where the damage happens.
   */
  async isComplete(version: string): Promise<{ complete: boolean; missingPlans: string[] }> {
    const rows = await this.versions.find({ where: { version } });
    const byPlan = new Map(rows.map((r) => [r.plan, r]));

    const missing: string[] = [];
    for (const plan of REQUIRED_PLANS) {
      const row = byPlan.get(plan);
      if (!row) { missing.push(plan); continue; }
      // A row without retrievable bytes is worse than no row at all: it looks
      // resolvable right up until the loader tries to download it.
      const present = this.storage
        ? await this.storage.has(row.bundleSha256.toLowerCase())
        : false;
      if (!present) missing.push(plan);
    }
    return { complete: missing.length === 0, missingPlans: missing };
  }

  /**
   * Promote every build of a version to a channel (internal → beta → stable).
   * Refuses an incomplete version: promoting a half-published version to stable
   * would strand whichever plan has no bundle.
   */
  async promote(version: string, channel: EngineChannel): Promise<EngineVersionEntity[]> {
    const { complete, missingPlans } = await this.isComplete(version);
    if (!complete) {
      throw new BadRequestException(
        `Cannot promote ${version}: no build for ${missingPlans.join(', ')}. `
        + 'Every plan must have a DOWNLOADABLE bundle before a version is reachable '
        + 'by customers — a published row whose bytes were never uploaded resolves '
        + 'successfully and then 404s in the browser.',
      );
    }
    const rows = await this.versions.find({ where: { version } });
    for (const row of rows) row.channel = channel;
    return this.versions.save(rows);
  }

  /**
   * Retire a version: no new resolutions, but customers PINNED to it keep
   * working. Deliberately not a delete — deleting would break those customers
   * with no recovery path.
   */
  async retire(version: string, notes = ''): Promise<EngineVersionEntity[]> {
    const rows = await this.versions.find({ where: { version } });
    if (!rows.length) throw new NotFoundException(`unknown version ${version}`);
    for (const row of rows) {
      row.status = 'retired';
      if (notes) row.notes = notes;
    }
    return this.versions.save(rows);
  }

  // ── Resolution ────────────────────────────────────────────────────────────

  /**
   * Resolve the build and feature set for one caller.
   *
   * Order matters: the version is decided FIRST (pin → override → channel →
   * global), then features are intersected against whatever build that produced.
   * Doing it the other way round would let a token promise features the served
   * build cannot deliver.
   */
  async resolveForLicence(
    input: ResolveForLicenceInput,
    defaults: { channelDefault?: string | null; globalDefault?: string | null },
  ): Promise<ResolvedDelivery> {
    const callerChannel = (input.channel || 'stable') as EngineChannel;

    const decision = resolveVersion({
      pinnedVersion: input.pinnedVersion,
      overrideVersion: input.overrideVersion,
      channel: callerChannel,
      channelDefault: defaults.channelDefault,
      globalDefault: defaults.globalDefault,
    });
    if (!decision.version) {
      throw new NotFoundException('no engine version is configured for delivery');
    }

    const build = await this.versions.findOne({
      where: { version: decision.version, plan: input.plan },
    });
    if (!build) {
      throw new NotFoundException(
        `no ${input.plan} build for version ${decision.version}`,
      );
    }

    // A pin or explicit override may reach a retired or off-channel build —
    // that is intentional. Only DEFAULT-derived resolutions are constrained,
    // because those are our choice rather than the customer's.
    const customerChose = decision.source === 'pin' || decision.source === 'override';
    if (!customerChose) {
      if (!eligibleAsDefault(build.status)) {
        throw new NotFoundException(`version ${decision.version} is retired`);
      }
      if (!channelAllows(callerChannel, build.channel)) {
        throw new NotFoundException(
          `version ${decision.version} is on the ${build.channel} channel`,
        );
      }
    }

    return {
      version: build.version,
      plan: build.plan,
      bundleKey: build.bundleKey,
      bundleSha256: build.bundleSha256,
      features: resolveFeatures(input.packageFeatures, build.supportedFeatures),
      missing: missingFromBuild(input.packageFeatures, build.supportedFeatures),
      source: decision.source,
    };
  }

  // ── Queries for the admin UI ──────────────────────────────────────────────

  listVersions(): Promise<EngineVersionEntity[]> {
    return this.versions.find({ order: { createdAt: 'DESC' } });
  }

  /**
   * Every published build, annotated with whether its BYTES are actually
   * present (`bytesPresent`).
   *
   * WHY THIS EXISTS: a registry row and its bundle live in two different
   * places, and they can drift. The common way is a redeploy onto an ephemeral
   * filesystem — rows survive in the database, bytes do not. Until now that was
   * only discoverable by trying to promote a version and reading the error.
   *
   * `isComplete` already refuses to promote or default such a version, so this
   * is not a safety net; it is the difference between "something is wrong
   * somewhere" and "these two builds need re-uploading".
   */
  async listVersionsWithHealth(): Promise<
    Array<EngineVersionEntity & { bytesPresent: boolean }>
  > {
    const rows = await this.listVersions();
    return Promise.all(rows.map(async (row) => ({
      ...row,
      bytesPresent: this.storage
        ? await this.storage.has(row.bundleSha256.toLowerCase())
        : false,
    })));
  }

  findBuild(version: string, plan: string): Promise<EngineVersionEntity | null> {
    return this.versions.findOne({ where: { version, plan } });
  }

  listByChannel(channel: EngineChannel): Promise<EngineVersionEntity[]> {
    return this.versions.find({
      where: { channel, status: In(['published']) },
      order: { createdAt: 'DESC' },
    });
  }
}
