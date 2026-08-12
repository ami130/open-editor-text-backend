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
  Injectable, BadRequestException, NotFoundException, Inject, Optional, Logger,
} from '@nestjs/common';
import { Repository, In } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { BUNDLE_STORAGE, BundleStorage, digestOf } from '../delivery/bundle-storage';
import { EngineVersionEntity, EngineChannel } from './entities/engine-version.entity';
import {
  EngineDefaultEntity, GLOBAL_SCOPE, channelScope,
} from './entities/engine-default.entity';
import { EngineDefaultHistoryEntity } from './entities/engine-default-history.entity';
import { EngineCanaryEntity } from './entities/engine-canary.entity';
import { inCanary } from './canary';
import {
  resolveVersion, resolveFeatures, missingFromBuild, channelAllows,
  eligibleAsDefault, ALL_FEATURES,
} from './version-resolution';

/** Plans that must have a build before a version may be published. */
export const REQUIRED_PLANS = ['free', 'premium'] as const;

/**
 * The plan served when the registry cannot decide (missing rows, DB error, or a
 * package whose features no single build fully covers).
 *
 * Deliberately the RICHER plan: over-serving costs bandwidth, under-serving
 * silently removes features a customer paid for. Only one of those is
 * recoverable without a support ticket.
 */
export const PREMIUM_FALLBACK_PLAN = 'premium';

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
  /**
   * §2.7 — the STABLE identity used to bucket this caller into (or out of) a
   * gradual release. A licence id where one exists, otherwise an install id.
   * Absent/empty → never in the canary, because they could not be kept there
   * consistently across page loads.
   */
  canaryIdentity?: string | null;
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
  /** §2.8 — a failed history write must be visible, not swallowed: it is what
   *  a future rollback reads. */
  private readonly log = new Logger(EngineVersionService.name);

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
    /**
     * §2.8 release/rollback history.
     *
     * ⚠️ LAST parameter deliberately. This service is constructed POSITIONALLY
     * in unit tests (`new EngineVersionService(repo, defaults, storage)`), so
     * inserting a parameter in the middle silently shifts `storage` into the
     * wrong slot — which is exactly what happened: 37 tests failed with
     * "bundle bytes were supplied but no BundleStorage is configured".
     *
     * @Optional: when absent, pointer moves still work, they are simply not
     * recorded, and rollback then refuses rather than guessing a target.
     */
    @Optional() @InjectRepository(EngineDefaultHistoryEntity)
    private readonly history?: Repository<EngineDefaultHistoryEntity>,
    /** §2.7 gradual release. Also LAST — see the note above. */
    @Optional() @InjectRepository(EngineCanaryEntity)
    private readonly canaries?: Repository<EngineCanaryEntity>,
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
  async setDefault(
    scope: string,
    version: string,
    audit: { actor?: string; reason?: string; kind?: 'release' | 'rollback' } = {},
  ): Promise<EngineDefaultEntity> {
    const { complete, missingPlans } = await this.isComplete(version);
    if (!complete) {
      throw new BadRequestException(
        `Cannot make ${version} a default: no downloadable bundle for `
        + `${missingPlans.join(', ')}. Making this the default would point every new `
        + 'session at a version whose bundle cannot be fetched.',
      );
    }
    const rows = await this.versions.find({ where: { version } });
    /**
     * A retired version cannot normally become the default — retirement means
     * "stop resolving new sessions here".
     *
     * ⚠️ EXCEPT DURING A ROLLBACK. The incident shape is exactly:
     *   retire v1.3.0 → publish v1.4.0 → v1.4.0 is broken → roll back
     * and refusing here would block the recovery at the only moment it matters,
     * over a policy flag rather than any real problem with the bundle. The
     * bundle is still stored, still complete (checked above), and was serving
     * production an hour ago.
     *
     * So a rollback may target a retired version; a normal release may not.
     */
    if (audit.kind !== 'rollback' && rows.some((r) => !eligibleAsDefault(r.status))) {
      throw new BadRequestException(
        `Cannot make ${version} a default: it is retired. `
        + '(A rollback may still target it — use the rollback endpoint.)',
      );
    }
    const existing = await this.defaults.findOne({ where: { scope } });
    const fromVersion = existing?.version || '';

    const saved = existing
      ? await this.defaults.save(Object.assign(existing, { version }))
      : await this.defaults.save(this.defaults.create({ scope, version }));

    // §2.8 — record the move. `engine_defaults` keeps only the CURRENT pointer,
    // so without this the previous (known-good) version is overwritten and a
    // rollback has nothing to aim at. Best-effort: a history write must never
    // block a release or, worse, a rollback during an incident.
    if (this.history && fromVersion !== version) {
      try {
        await this.history.insert({
          scope,
          fromVersion,
          toVersion: version,
          kind: audit.kind || 'release',
          actor: (audit.actor || '').slice(0, 128),
          reason: (audit.reason || '').slice(0, 500),
        });
      } catch (err) {
        this.log.warn(`could not record default history: ${String(err)}`);
      }
    }
    return saved;
  }

  /**
   * §2.8 — the version this scope was on BEFORE its current one.
   *
   * This is the rollback target, read rather than guessed. Returns null when
   * there is no recorded previous version, which the caller must surface
   * plainly: an incident is the worst possible moment to silently pick a
   * version nobody chose.
   */
  async previousDefault(scope: string): Promise<string | null> {
    if (!this.history) return null;
    const rows = await this.history.find({
      where: { scope },
      order: { createdAt: 'DESC' },
      take: 1,
    });
    const from = rows[0]?.fromVersion || '';
    return from || null;
  }

  /**
   * Roll back a scope to its previous version, in ONE call.
   *
   * Deliberately not "setDefault with the right argument": at 03:00 the failure
   * mode is naming the wrong version, so the safe operation is the one that
   * needs no argument at all. The target comes from history, and every guard in
   * setDefault (bundle completeness, retirement) still applies.
   */
  async rollback(scope: string, audit: { actor?: string; reason?: string } = {}): Promise<{
    scope: string; from: string; to: string;
  }> {
    const current = await this.defaults.findOne({ where: { scope } });
    const target = await this.previousDefault(scope);
    if (!target) {
      throw new BadRequestException(
        `No previous version recorded for '${scope}', so there is nothing to roll back to. `
        + 'Set the default explicitly to a known-good version instead.',
      );
    }
    await this.setDefault(scope, target, { ...audit, kind: 'rollback' });
    return { scope, from: current?.version || '', to: target };
  }

  /**
   * STAGE 1 — which bundle must this package be served?
   *
   * ─── WHY THIS REPLACED A STRING PREFIX ──────────────────────────────────
   * The plan used to be inferred as:
   *
   *     plan = features.some(f => f.startsWith('export.')) ? 'premium' : 'free'
   *
   * That encodes a COINCIDENCE OF NAMING as a business rule. It happens to be
   * correct today only because the two sellable premium features are named
   * `export.pdf` and `export.docx`. Every other premium feature (seo, ai.*,
   * comments, collab) is currently non-sellable, so the flaw is invisible —
   * which is luck, not safety. The moment an admin can sell any of those, a
   * paying customer is served the FREE bundle, which does not contain the code
   * they bought, and the feature silently does nothing.
   *
   * ─── THE RULE ───────────────────────────────────────────────────────────
   * Serve the SMALLEST bundle that actually supports every feature the package
   * grants. That is decided from the registry's `supportedFeatures` — the same
   * data the entitlement intersection already trusts (T14) — so the answer
   * follows what the build genuinely contains rather than what a name suggests.
   *
   * Naturally extends beyond two plans: adding a third bundle later needs no
   * change here, because the question is "which build covers these features?",
   * not "is this premium?".
   *
   * ─── FAILS TOWARD THE CUSTOMER ──────────────────────────────────────────
   * If the registry cannot answer (no rows for this version, DB hiccup), we
   * return the RICHER plan rather than the cheaper one. Over-serving costs
   * bandwidth; under-serving silently breaks a paying customer's features, and
   * of the two only one is recoverable without a support ticket.
   */
  async planForFeatures(version: string, packageFeatures: readonly string[]): Promise<string> {
    const wanted = (packageFeatures || []).filter((f) => f && f !== ALL_FEATURES);
    // Nothing specific requested → the free build is sufficient by definition.
    if (!wanted.length) return 'free';

    try {
      const rows = await this.versions.find({ where: { version } });
      if (!rows.length) return PREMIUM_FALLBACK_PLAN;

      // Cheapest-first, so a package is never handed more bundle than it needs.
      const ordered = [...rows].sort(
        (a, b) => (a.plan === 'free' ? -1 : 1) - (b.plan === 'free' ? -1 : 1),
      );
      for (const row of ordered) {
        const supported = new Set(row.supportedFeatures || []);
        if (wanted.every((f) => supported.has(f))) return row.plan;
      }
      // No single build covers everything the package grants. Serve the richest
      // one: the intersection (T14) will still bound what the token promises,
      // so the customer gets everything that CAN be delivered rather than
      // dropping to free and losing features that were available.
      return PREMIUM_FALLBACK_PLAN;
    } catch (err) {
      this.log.warn(`planForFeatures failed for ${version}; serving ${PREMIUM_FALLBACK_PLAN}: ${String(err)}`);
      return PREMIUM_FALLBACK_PLAN;
    }
  }

  // ── §2.7 gradual release (canary) ─────────────────────────────────────────

  /**
   * The canary version for this caller, or null.
   *
   * Checks the caller's CHANNEL scope first, then global — the same precedence
   * the defaults use, so a channel-scoped trial is not silently overridden by a
   * global one.
   *
   * Never throws: a canary is an optional refinement on top of a working
   * resolution chain, so any failure must degrade to "no canary" rather than
   * failing the session.
   */
  private async canaryFor(
    channel: EngineChannel,
    identity: string | null | undefined,
  ): Promise<string | null> {
    if (!this.canaries || !identity) return null;
    try {
      const rows = await this.canaries.find({
        where: [{ scope: `channel:${channel}` }, { scope: 'global' }],
      });
      if (!rows.length) return null;
      // Channel scope wins over global, matching default resolution.
      const row = rows.find((r) => r.scope === `channel:${channel}`) || rows[0];
      if (!row?.version || row.percent <= 0) return null;
      return inCanary(identity, row.version, row.percent) ? row.version : null;
    } catch (err) {
      this.log.warn(`canary lookup failed; serving the normal default: ${String(err)}`);
      return null;
    }
  }

  /**
   * Start or update a gradual release.
   *
   * Refuses an incomplete version for exactly the reason setDefault does:
   * pointing even 1% of sessions at a version whose bundle cannot be fetched
   * breaks those customers rather than trialling anything.
   */
  async startCanary(
    scope: string,
    version: string,
    percent: number,
    audit: { actor?: string; reason?: string } = {},
  ): Promise<EngineCanaryEntity> {
    if (!this.canaries) {
      throw new BadRequestException('canary storage is not configured');
    }
    const { complete, missingPlans } = await this.isComplete(version);
    if (!complete) {
      throw new BadRequestException(
        `Cannot canary ${version}: no downloadable bundle for ${missingPlans.join(', ')}.`,
      );
    }
    const pct = Math.max(0, Math.min(100, Math.floor(Number(percent) || 0)));
    const existing = await this.canaries.findOne({ where: { scope } });
    const row = existing || this.canaries.create({ scope });
    row.version = version;
    row.percent = pct;
    row.actor = (audit.actor || '').slice(0, 128);
    row.reason = (audit.reason || '').slice(0, 500);
    return this.canaries.save(row);
  }

  /**
   * Stop a gradual release immediately.
   *
   * DELETES the row rather than zeroing it: during an incident the safest state
   * is one the resolution chain does not consider at all. A paused-but-present
   * canary invites "why is 5% still on the bad version?" at the worst moment.
   */
  async haltCanary(scope: string): Promise<{ scope: string; halted: boolean; version: string | null }> {
    if (!this.canaries) return { scope, halted: false, version: null };
    const row = await this.canaries.findOne({ where: { scope } });
    if (!row) return { scope, halted: false, version: null };
    await this.canaries.delete({ id: row.id });
    return { scope, halted: true, version: row.version };
  }

  /** Current gradual releases. */
  async listCanaries(): Promise<EngineCanaryEntity[]> {
    if (!this.canaries) return [];
    return this.canaries.find();
  }

  /** Recent pointer moves — what changed, when, by whom. */
  async defaultHistory(scope?: string, limit = 50): Promise<EngineDefaultHistoryEntity[]> {
    if (!this.history) return [];
    return this.history.find({
      where: scope ? { scope } : {},
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 200),
    });
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

    // §2.7 — is this caller in a gradual release? Resolved BEFORE the chain so
    // the chain itself stays a pure function; the bucketing is sticky, so the
    // same caller receives the same answer on every page load.
    const canaryVersion = await this.canaryFor(callerChannel, input.canaryIdentity);

    const decision = resolveVersion({
      pinnedVersion: input.pinnedVersion,
      overrideVersion: input.overrideVersion,
      canaryVersion,
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
