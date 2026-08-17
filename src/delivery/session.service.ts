/**
 * session.service.ts — the delivery SESSION endpoint's logic (execution plan
 * §1.3). Answers one question per call: *who is this caller, which engine build
 * do they get, and what may they use in it?*
 *
 * ─── T17: STATELESS SESSIONS ─────────────────────────────────────────────────
 * The existing licence model stores ONE token per licence row (`lic.token`).
 * That cannot work here: a single customer has thousands of end-users, each
 * loading the editor in their own browser, all needing a live session at once.
 * A sessions table would mean a database write per end-user per page load —
 * exactly the traffic shape this architecture exists to avoid.
 *
 * So delivery sessions are STATELESS: everything needed is inside the signed
 * token. Nothing is written per session. The licence row is read, never updated,
 * and `lic.token` (the portal's own licence-refresh flow) is left untouched.
 *
 * ─── Token model ────────────────────────────────────────────────────────────
 *   sessionToken  15 min  carries plan + resolved features + version
 *   refreshToken  30 days rotated on every use
 *
 * The short session lifetime is what makes entitlement changes land quickly: an
 * upgrade is visible within one refresh cycle even if the push (§2.3) is missed
 * entirely. The licence key itself crosses the network roughly once a month
 * instead of on every request.
 *
 * ─── The anonymous path ─────────────────────────────────────────────────────
 * No key → the free plan. NO DATABASE ROW is created: an anonymous caller is a
 * signed token and nothing else. `/session` is a POST and therefore never
 * CDN-cached, so every anonymous request reaches origin — it is the single most
 * exposed surface in the architecture (T20), and the best defence is that it
 * costs us almost nothing to serve.
 */
import { Injectable, Inject, Optional } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { LicenseEntity } from '../licensing/entities/license.entity';
import { LicenseSignerService } from '../licensing/license-signer.service';
import { EngineVersionService } from '../licensing/engine-version.service';
import { EngineChannel } from '../licensing/entities/engine-version.entity';
import { BundleUrlSigner } from './bundle-url-signer';
import { hostAllowed } from '../licensing/domain-policy';
import { LicenseInstallService } from './license-install.service';
import { WatermarkService } from './watermark.service';
import { DefaultPackageService } from '../licensing/default-package.service';
import { DELIVERY_CONFIG, type DeliveryConfig } from '../config/delivery.config';

/** Lifetimes. Session is deliberately short — see the header. */
export const SESSION_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 3600;

/** Free plan id used for anonymous and unlicensed callers. */
export const FREE_PLAN = 'free';
export const PREMIUM_PLAN = 'premium';

/**
 * Sentinel meaning "grant everything this build supports".
 *
 * WHY IT EXISTS: entitlement is normally `package.features ∩ build.features`.
 * An anonymous free caller has NO package, so passing an empty feature list
 * intersects to nothing — a free user would receive a working free bundle with
 * every feature switched off. (Caught by the delivery e2e test: the anonymous
 * session returned zero features.)
 *
 * The free tier is not "a package with no features"; it is "whatever the free
 * BUILD contains". The build itself is the entitlement boundary — premium code
 * is not in it — so there is nothing further to restrict.
 */
/**
 * ⚠️ RETIRED FROM THE SESSION PATH (Stage 2a/2b), kept as a LAST-RESORT fallback.
 *
 * This sentinel means "everything the build supports". It used to be what every
 * anonymous visitor and every refused licence received, which made the free
 * tier a property of how the bundle was COMPILED rather than something an admin
 * controls. Both paths now resolve the admin-designated package instead.
 *
 * It survives at exactly two call sites, reachable only when
 * DefaultPackageService is absent — i.e. a deployment without the licensing
 * module. That is asserted NOT to happen in production by the @Optional()
 * injection sweep in tests/install-cap-probe.test.ts, which fails loudly if the
 * service ever resolves to undefined.
 *
 * It is deliberately NOT deleted: removing it would mean a module-less
 * deployment returns an EMPTY feature list, which intersects to nothing and
 * hands the user an editor with every feature disabled. A too-generous fallback
 * in a configuration that should never occur beats a broken editor.
 *
 * `resolveFeatures` still honours it (version-resolution.ts), which is what
 * makes it a working fallback rather than a dead constant.
 */
export const ALL_BUILD_FEATURES = '*';

export interface SessionRequest {
  /** Licence key (Path A). Absent for anonymous/free callers. */
  licenceKey?: string | null;
  /** Anonymous install identifier (Path B, T18) — used for rate limiting + usage. */
  installId?: string | null;
  /** Requesting page origin, for domain validation. */
  origin?: string | null;
  /** Explicit version request (customer pinning). */
  version?: string | null;
}

export interface SessionResponse {
  sessionToken: string;
  refreshToken: string;
  expiresAt: number;
  plan: string;
  features: string[];
  version: string;
  /**
   * Where the loader fetches the engine, and what it must hash to (§1.5).
   *
   * `url` is the content-addressed path from §1.4 — ready to fetch, already
   * signed when the plan is premium (R44). `sha256` is what the loader verifies
   * the downloaded bytes against BEFORE decoding, catching truncated downloads,
   * mangling proxies, and poisoned caches.
   */
  engine: { key: string; sha256: string; url: string };

  /**
   * §2.4 ACTIVATION — the buyer's licence key, handed over exactly once.
   *
   * Present ONLY when this caller had no key of their own and a pending
   * activation matched their install id (i.e. they just bought premium from
   * inside this editor). The loader stores it and sends it on every later
   * session, so this field appears once in a licence's whole lifetime.
   *
   * Absent on every other response — it is never echoed back to a caller who
   * already supplied a key.
   */
  licenceKey?: string;
}

/** Why a session was refused. Never surfaced verbatim — see the controller. */
export type SessionRefusal =
  | 'invalid-key' | 'revoked' | 'expired' | 'origin-blocked' | 'no-version'
  // §2.4 — a NEW install beyond the licence's seat cap. Distinct from
  // 'origin-blocked' so support can tell "wrong domain" from "too many
  // machines"; the customer-facing result is identical (a working free editor).
  | 'install-cap';

@Injectable()
export class DeliverySessionService {
  constructor(
    @InjectRepository(LicenseEntity)
    private readonly licences: Repository<LicenseEntity>,
    private readonly signer: LicenseSignerService,
    private readonly versions: EngineVersionService,
    private readonly urls: BundleUrlSigner,
    // @Optional so a deployment without the delivery entities registered still
    // boots — the cap is then simply not enforced rather than crashing the
    // session endpoint. Injection is verified by test, because an @Optional
    // dependency that silently resolves to undefined is exactly how the
    // anti-sharing detector was inert for a whole phase.
    @Optional() private readonly installs?: LicenseInstallService,
    // §2.5 per-licence watermarking. @Optional: absent = unmarked bundles.
    @Optional() private readonly watermarks?: WatermarkService,
    // Stage 2a — the admin-defined free tier. @Optional so a deployment without
    // it falls back to the previous sentinel behaviour rather than failing.
    @Optional() private readonly defaultPackage?: DefaultPackageService,
    // Only `anonymousFreeBundleOnly` is read here. @Optional because every
    // other dependency on this constructor is, and a missing config must not
    // stop sessions being issued — absent simply means "derive the plan".
    @Optional() @Inject(DELIVERY_CONFIG) private readonly deliveryCfg?: DeliveryConfig,
  ) {}

  /**
   * Open a session.
   *
   * A licence that fails validation for ANY reason falls back to the FREE plan
   * rather than erroring. That is deliberate: a customer whose subscription
   * lapsed mid-session should get a working free editor, not a blank page. The
   * refusal reason is returned for logging, never for the client to act on.
   */
  async open(
    req: SessionRequest,
    defaults: { channelDefault?: string | null; globalDefault?: string | null },
  ): Promise<{ session: SessionResponse; refusal?: SessionRefusal }> {
    const resolved = req.licenceKey
      // Defaults are threaded in so the PLAN is decided against the very build
      // the version chain is about to resolve — no second lookup, no drift.
      ? await this.resolveLicensed({ ...req, ...defaults })
      /**
       * STAGE 2a — no key → the ADMIN-DEFINED free package.
       *
       * This used to be the `'*'` sentinel ("everything this build supports"),
       * which meant the free tier was decided by HOW THE BUNDLE WAS COMPILED.
       * An admin could not change it; removing a feature from free needed a
       * developer and a rebuild.
       *
       * Now it is data. `featuresForAnonymous()` is CACHE-FIRST and never
       * touches the database on this path (R1/T17) — the anonymous route is the
       * hottest and most exposed in the system, and it performed zero queries
       * before this change. It must still perform zero.
       *
       * It also never returns nothing: a database outage keeps serving the last
       * known good list, and a cold process with no cache falls back to a small
       * built-in set rather than an empty one (R3).
       *
       * ⚠️ Only the ANONYMOUS path moved. The six REFUSAL paths
       * (invalid-key / revoked / expired / origin-blocked / install-cap) still
       * use the sentinel deliberately — whether a revoked licence should get the
       * admin's free package or something narrower is a product decision, not a
       * refactor, and is scoped as Stage 2b.
       */
      : await this.resolveAnonymous(defaults);

    const licence = resolved.licence;
    const delivery = await this.versions.resolveForLicence(
      {
        // A licence-level pin always wins; a client-supplied `version` is only
        // honoured when the licence has no pin of its own, so a customer cannot
        // escape an admin's deliberate pinning by asking for another build.
        pinnedVersion: licence?.pinnedVersion || req.version || null,
        overrideVersion: licence?.overrideVersion || null,
        channel: (licence?.channel as EngineChannel) || 'stable',
        packageFeatures: resolved.features,
        plan: resolved.plan,
        /**
         * §2.7 — the stable identity used to bucket this caller into a gradual
         * release. Licence id where one exists (survives cleared storage and is
         * shared across that customer's browsers), otherwise the install id.
         *
         * Both are stable per caller, which is the whole requirement: bucketing
         * must give the SAME answer on every page load, or an editor would flip
         * between versions and re-download a different bundle each time.
         */
        canaryIdentity: licence?.licId || req.installId || null,
      },
      defaults,
    );

    const now = Math.floor(Date.now() / 1000);
    // Resolve the digest this caller actually receives (see engine.sha256 below).
    // Fails open to the base digest, so a watermarking problem can never stop a
    // paying customer loading their editor.
    const engineSha = resolved.plan === PREMIUM_PLAN && licence?.licId && this.watermarks
      ? await this.watermarks.digestForLicence(delivery.bundleSha256, licence.licId)
      : delivery.bundleSha256;

    const session = this.signer.sign({
      customer: licence?.customer?.id || 'anonymous',
      plan: resolved.plan,
      features: delivery.features,
      domains: licence?.domains || [],
      // The version §1.2 RESOLVED — never what the client asked for (R40).
      version: delivery.version,
      ttlSeconds: SESSION_TTL_SECONDS,
      iat: now,
      // Keep the licence identity stable across sessions where one exists, so
      // logs and anti-sharing detection can correlate them.
      lic: licence?.licId,
    });
    const refresh = this.signer.sign({
      customer: licence?.customer?.id || 'anonymous',
      plan: resolved.plan,
      features: delivery.features,
      domains: licence?.domains || [],
      version: delivery.version,
      ttlSeconds: REFRESH_TTL_SECONDS,
      iat: now,
      lic: licence?.licId,
    });

    return {
      refusal: resolved.refusal,
      session: {
        sessionToken: session.token,
        refreshToken: refresh.token,
        expiresAt: session.exp,
        plan: resolved.plan,
        features: delivery.features,
        version: delivery.version,
        engine: {
          key: delivery.bundleKey,
          // §2.5 — PREMIUM bundles are watermarked per licence, so a leaked
          // copy is attributable. The digest here is what the loader verifies
          // BEFORE executing, so it must be the watermarked one or every
          // premium load would fail its integrity check.
          //
          // Free bundles are never watermarked: free users have nothing worth
          // leaking, and they are the bulk of traffic — keeping their bundle
          // byte-identical preserves the shared CDN cache the whole design
          // depends on.
          sha256: engineSha,
          url: this.bundleUrl(delivery.version, delivery.plan, engineSha),
        },
      },
    };
  }

  /**
   * The content-addressed URL the loader fetches (§1.4).
   *
   * Free bundles are plain and cacheable by anyone. PREMIUM bundles carry a
   * short-lived signature (R44) as a QUERY parameter, deliberately not a path
   * segment — the path stays the cache key, so a CDN still stores one copy per
   * bundle while the per-user part varies harmlessly.
   */
  private bundleUrl(version: string, plan: string, sha256: string): string {
    // ABSOLUTE when a public base is configured (B4). The loader runs on the
    // CUSTOMER'S domain, so a relative path would resolve against their server
    // and 404. Relative is kept as the default for local development and
    // same-origin deployments.
    const path = `${this.urls.publicBaseUrl}/engine/${version}/${plan}/${sha256}.js`;
    if (plan !== PREMIUM_PLAN) return path;
    const { exp, sig } = this.urls.sign(sha256);
    return `${path}?exp=${exp}&sig=${sig}`;
  }

  /**
   * Re-mint a session token that is near (or past) expiry.
   *
   * ─── WHY THIS IS NOT THE PORTAL'S /refresh ──────────────────────────────
   * That endpoint refreshes a LICENCE: it looks up a licence row by `lic`, and
   * updates the stored token in place. A delivery session is the opposite
   * shape — stateless (T17), often ANONYMOUS with no licence row at all, and
   * held concurrently by thousands of end-users of the same customer. Routing
   * delivery refreshes through it would fail outright for free users and would
   * write to a licence row on every end-user's timer for paid ones.
   *
   * ─── WHY IT IS NEEDED AT ALL ────────────────────────────────────────────
   * A session token lives 15 minutes. Anyone who leaves the editor open longer
   * than that — which is to say, anyone writing a real document — would find
   * their token expired and premium silently switched off mid-sentence.
   *
   * The refresh token is the credential here, NOT the licence key: the licence
   * key never has to be re-sent, and a refresh cannot mint entitlements that
   * were not already granted, because the plan and features are re-resolved
   * from the licence (or the free tier) exactly as `open()` does.
   */
  async refresh(
    token: string,
    origin: string | null,
    defaults: { channelDefault?: string | null; globalDefault?: string | null },
    fallbackToken?: string | null,
  ): Promise<{ session: SessionResponse; refusal?: SessionRefusal; licId?: string | null }> {
    // ⚠️ TWO TOKENS, BECAUSE THE FIRST ONE EXPIRES (E3).
    //
    // The engine refreshes using whatever is in `licenseKey` — the 15-minute
    // SESSION token. That is fine while the tab is open, but a tab left closed
    // over lunch comes back with a token past its `exp`, which fails
    // verification. Without a second chance the caller drops to FREE even
    // though a perfectly valid 30-day refresh token was sitting right there,
    // and a paying customer is silently downgraded by taking a break.
    //
    // So the long-lived refresh token is accepted as a fallback. Both carry the
    // same `lic` claim, and entitlements are re-resolved from the licence
    // below, so this widens recovery WITHOUT widening what can be granted.
    const claims = this.signer.verifyOwnToken(token)
      || (fallbackToken ? this.signer.verifyOwnToken(fallbackToken) : null);

    // Neither verified: not an error the client can act on — it simply falls
    // back to a fresh anonymous session, exactly like a bad licence key does.
    // No oracle, no dead end.
    if (!claims) return { ...(await this.open({ origin }, defaults)), licId: null };

    // Re-resolve from the LICENCE, never from the token's own claims. A licence
    // revoked or downgraded since the token was issued must take effect on the
    // next refresh — otherwise a 30-day refresh token would keep premium alive
    // for a month after cancellation.
    const licenceKey = claims.lic ? await this.keyForLicence(claims.lic) : null;
    // `licId` is returned so the caller can attribute this refresh to a licence
    // in the anti-sharing fetch-log. It is NOT part of the response body — it
    // would be a licence-validity oracle there.
    return { ...(await this.open({ licenceKey, origin }, defaults)), licId: claims.lic ?? null };
  }

  /**
   * STAGE 2b — what a caller whose licence was REFUSED receives.
   *
   * These six paths used to return the `'*'` sentinel, i.e. "everything the
   * build supports". So a revoked or expired licence silently received a RICHER
   * editor than the admin-defined free tier — the free package could be
   * trimmed, and a refused customer would still get everything. That is exactly
   * backwards.
   *
   * Now they resolve the same admin-defined package an anonymous visitor gets,
   * through the same cache (so still no query on this path).
   *
   * `revoked` alone is policy-driven, because it is the only refusal that is a
   * DELIBERATE decision about the customer rather than an honest snag — a
   * lapsed subscription, an unregistered domain, one machine too many, a typo'd
   * key. See RevokedPolicy for why it defaults to the forgiving option.
   *
   * ─── THE BUNDLE MUST FOLLOW THE FEATURES HERE TOO ───────────────────────
   * This returned a hardcoded `plan: FREE_PLAN` even after the anonymous path
   * learned to derive it. Since `featuresForRefusal` deliberately hands back
   * the SAME list an anonymous visitor gets, that asymmetry meant a default
   * package containing premium features gave a stranger 55 and a customer whose
   * subscription had lapsed only 53 — the intersection quietly dropped what the
   * free build cannot serve. A paying customer having a bad day ended up worse
   * off than someone who never paid, which is the same "exactly backwards"
   * failure this method was written to fix, one layer down.
   *
   * So the plan is derived from the features actually granted, through the same
   * helper the anonymous path uses. `revoked` needs no special case: when the
   * policy narrows its features, the derivation narrows the bundle to match.
   */
  private async refused(
    reason: SessionRefusal,
    defaults: { channelDefault?: string | null; globalDefault?: string | null },
  ): Promise<{
    plan: string; features: string[]; licence: LicenseEntity | null; refusal: SessionRefusal;
  }> {
    const features = this.defaultPackage
      ? this.defaultPackage.featuresForRefusal(reason)
      : [ALL_BUILD_FEATURES];
    return {
      plan: await this.planForDefaultTier(features, defaults),
      features,
      licence: null,
      refusal: reason,
    };
  }

  /**
   * Which BUILD can serve the admin's free tier — shared by the anonymous and
   * refusal paths so the two can never drift apart again.
   *
   * ⚠️ ONLY a DESIGNATED package may escalate. `featuresForAnonymous()` always
   * returns a usable list, so a cold process or a database outage yields the
   * built-in MINIMAL_FALLBACK set — seven features no free build is guaranteed
   * to cover. Deriving from that would push every visitor onto the PREMIUM
   * bundle at exactly the moment the system is least healthy, giving the export
   * code away as a side effect of an outage. A resilience path must degrade
   * toward the cheaper bundle, never the richer one.
   *
   * `hasDesignation()` is sync and query-free, reading the same cache the
   * features came from. (`current()` answers the same question but is async and
   * costs two queries — R1/T17 forbids that here.)
   */
  private async planForDefaultTier(
    features: string[],
    defaults: { channelDefault?: string | null; globalDefault?: string | null },
  ): Promise<string> {
    if (this.deliveryCfg?.anonymousFreeBundleOnly) return FREE_PLAN;
    if (!this.defaultPackage?.hasDesignation()) return FREE_PLAN;

    // Threaded in rather than looked up: the plan must be decided against the
    // very build the version chain is about to resolve, and a second lookup
    // could disagree if a default moved in between.
    const versionForPlan = defaults.channelDefault || defaults.globalDefault;
    return versionForPlan
      ? this.versions.planForFeatures(versionForPlan, features)
      : FREE_PLAN;
  }

  /**
   * The stored licence token for a licence id, if the licence is still usable.
   *
   * Returns null for a missing, revoked, or expired licence so the caller
   * degrades to the free tier rather than trusting a stale refresh token — and
   * so §2.4 activation can never resurrect a dead licence.
   *
   * Reads the STORED token rather than re-signing. Re-signing would mint a
   * SECOND valid credential for the same licence with a different lifetime,
   * diverging from the key the customer was emailed and from `lic.token`, which
   * the portal's refresh/regenerate flow treats as the single current key.
   *
   * Public (was private) because the session controller needs it to hand a key
   * to a browser redeeming an activation claim.
   */
  async keyForLicence(licId: string): Promise<string | null> {
    if (!licId) return null;
    const licence = await this.licences.findOne({ where: { licId } });
    if (!licence || licence.status === 'revoked' || licence.isExpired()) return null;
    return licence.token || null;
  }

  /**
   * Validate a licence key and read its entitlements.
   *
   * What an UNLICENSED visitor receives — features AND bundle, both from the
   * admin's designated default package.
   *
   * ─── WHY THE PLAN IS DERIVED, NOT HARDCODED ─────────────────────────────
   * This used to return a literal `plan: FREE_PLAN`. The features came from the
   * admin's package, but the BUNDLE never did — so designating a package that
   * grants `export.pdf` produced a session promising 55 features on a free
   * build that contains no export code, and the T14 intersection then silently
   * dropped the two the admin had deliberately ticked. The panel said 55, the
   * visitor got 53, and nothing explained the gap.
   *
   * `planForFeatures` is the same resolver the LICENSED path already uses: it
   * picks the CHEAPEST build that supports everything the package grants. A
   * bold-and-bullets package still resolves to the free bundle — nobody is
   * pushed onto premium bytes they have no use for.
   *
   * ─── THE TRADE-OFF THIS MAKES EXPLICIT ──────────────────────────────────
   * When the default package DOES grant premium features, every anonymous
   * visitor now downloads the premium bundle — the export implementations
   * included. That is the admin's decision to make and the panel says so at the
   * moment it is made; `DELIVERY_ANONYMOUS_FREE_BUNDLE_ONLY=true` reverses it
   * without a redeploy.
   *
   * ─── WHAT MUST NOT REGRESS ──────────────────────────────────────────────
   * `featuresForAnonymous()` stays CACHE-FIRST (R1/T17): it is synchronous, is
   * never awaited on a database, and keeps serving its last known good list
   * through an outage. The one added await is `planForFeatures`, which resolves
   * against the version registry the caller is ALREADY querying on this path —
   * a query alongside existing ones, not a new dependency on the hot path. With
   * no version resolvable it falls back to FREE, because over-serving an
   * anonymous visitor costs bandwidth for features the token will not carry.
   */
  private async resolveAnonymous(
    defaults: { channelDefault?: string | null; globalDefault?: string | null },
  ): Promise<{
    plan: string;
    features: string[];
    licence: null;
    refusal: SessionRefusal | undefined;
  }> {
    const features = this.defaultPackage
      ? this.defaultPackage.featuresForAnonymous()
      : [ALL_BUILD_FEATURES];

    // The kill switch short-circuits BEFORE the lookup: when it is on there is
    // Anonymous callers have no pin and no override, so the bundle is decided
    // purely by what the admin's tier grants — the same helper the refusal
    // paths use, so an unlicensed visitor and a lapsed customer can never be
    // served different builds for the same feature list.
    return {
      plan: await this.planForDefaultTier(features, defaults),
      features,
      licence: null,
      refusal: undefined,
    };
  }

  /**
   * IMPORTANT — the PACKAGE is the source of truth for features, not the
   * licence's stored `features` snapshot (T14). The snapshot records what was
   * sold and when; using it as the live gate means a customer never receives
   * features added to their plan after purchase. The snapshot is used only as a
   * fallback for legacy rows with no package relation.
   */
  private async resolveLicensed(
    req: SessionRequest & { channelDefault?: string | null; globalDefault?: string | null },
  ): Promise<{
    plan: string;
    features: string[];
    licence: LicenseEntity | null;
    refusal?: SessionRefusal;
  }> {
    const claims = this.signer.verifyOwnToken(req.licenceKey as string);
    if (!claims) return this.refused('invalid-key', req);

    const licence = await this.licences.findOne({
      where: { licId: claims.lic },
      relations: ['package', 'package.features', 'customer'],
    });
    if (!licence) return this.refused('invalid-key', req);
    if (licence.status === 'revoked') {
      return this.refused('revoked', req);
    }
    if (licence.isExpired()) {
      return this.refused('expired', req);
    }
    if (!this.originAllowed(req.origin, licence.domains)) {
      return this.refused('origin-blocked', req);
    }

    // §2.4 — SEAT CAP. Last of the checks, deliberately: an invalid, revoked,
    // expired or wrong-domain key must never consume a seat, or a leaked key
    // could exhaust a customer's installs and lock the real owner out.
    //
    // Enforced here rather than at issue time because installs appear as the
    // product is USED, not when it is bought. See LicenseInstallService for why
    // a KNOWN install always passes and why the whole path fails open.
    const cap = licence.package?.maxInstalls ?? 0;
    if (cap > 0 && this.installs) {
      const seat = await this.installs.check(licence.licId, req.installId ?? null, req.origin ?? null, cap);
      if (!seat.allowed) {
        return this.refused('install-cap', req);
      }
    }

    const packageFeatures = licence.package?.features?.length
      ? licence.package.features.map((f) => f.id)
      : licence.features; // legacy rows with no package relation

    /**
     * STAGE 3a — THE TOKEN MUST CARRY THE FULL EFFECTIVE GRANT.
     *
     * A paid token used to list ONLY what the package added — a Pro licence
     * said `['export.pdf']` and nothing else. That worked because the ENGINE
     * granted its own hardcoded FREE_SET unconditionally on top
     * (feature-gate.js: "a real license lists only PREMIUM, so without this
     * layer a paying customer would lose free features").
     *
     * That hardcoded layer is exactly what Stage 3 removes, so the token has to
     * become self-sufficient FIRST. Verified live before writing this: a real
     * production premium token listed `['export.pdf']` alone — tightening the
     * engine on that token would have stripped 53 free features from a paying
     * customer instantly.
     *
     * So the grant is now `free tier ∪ package`. This is BACKWARD COMPATIBLE by
     * construction: today's engine grants the free set anyway, so adding it to
     * the token changes nothing observable now, and makes the token correct for
     * an engine that no longer does. Tokens live ≤30 days, so a fleet becomes
     * fully self-sufficient within one refresh cycle — which is the window the
     * engine change must wait for.
     */
    /**
     * ─── UPDATE: THE PACKAGE IS THE WHOLE TRUTH ─────────────────────────────
     *
     * The union above was a MIGRATION BRIDGE, and it did its job: every live
     * token now carries a full effective grant, so the engine no longer needs
     * its hardcoded FREE_SET blanket (the loader defaults strictEntitlements on).
     *
     * But keeping the union defeats the point of composable packages. Measured:
     * a package built with exactly `[text.bold, list.bullet]` produced a token
     * carrying 53 features, because the default package's baseline was unioned
     * in. An admin could therefore never compose a package BELOW the free tier
     * — the system behaved as two fixed tiers rather than N packages.
     *
     * So a licence now grants EXACTLY what its package lists. `testing bold`
     * means bold and bullet, and nothing else.
     *
     * ⚠️ CONSEQUENCE TO OWN: a package that lists only its premium EXTRAS now
     * grants only those extras. Production's `Pro` package lists
     * [export.pdf, export.docx] alone, so a Pro licence would grant two
     * features and no editing surface at all. Any such package must be
     * re-composed to list everything it intends to sell — which is the honest
     * model: what the admin picks is what the customer gets.
     *
     * The ANONYMOUS path (above) is unchanged and still resolves the default
     * package, so `npm install` with no key keeps working exactly as before.
     */
    const features = [...new Set(packageFeatures)];

    /**
     * STAGE 1 — the served bundle follows what the BUILD supports, not a name.
     *
     * This used to be `features.some(f => f.startsWith('export.'))`, which
     * encoded a coincidence of naming as a business rule. It is correct today
     * only because the two sellable premium features happen to be called
     * `export.pdf` and `export.docx`; every other premium feature is currently
     * non-sellable, so the flaw is invisible. The moment an admin can sell one
     * (AI, comments, collab — the entire point of admin-defined packages) a
     * paying customer is served the FREE bundle, which does not contain the
     * code they bought, and the feature silently does nothing.
     *
     * `planForFeatures` answers the real question instead: which is the
     * smallest build that actually supports everything this package grants?
     *
     * The version used here is the LICENCE-LEVEL one only. A caller-supplied
     * `version` is deliberately ignored for this decision — otherwise a client
     * could name a version whose free build happens to cover its features and
     * talk itself into a cheaper bundle.
     *
     * With no licence-level pin we use the defaults ALREADY RESOLVED by the
     * caller and threaded in — not a fresh lookup. Re-fetching them here would
     * add two queries per licensed session and, worse, could disagree with the
     * version the chain actually picks if a default moved in between.
     */
    const versionForPlan = licence.pinnedVersion
      || licence.overrideVersion
      || req.channelDefault
      || req.globalDefault;
    const plan = versionForPlan
      /**
       * ⚠️ PACKAGE FEATURES, NOT THE UNIONED LIST.
       *
       * Stage 3a adds the free-tier baseline to the TOKEN. Feeding that union
       * here would let the baseline decide the BUNDLE: a free-only package
       * whose baseline happens to include something the free build lacks gets
       * pushed onto the premium bundle. Caught by the Stage 1 "no over-serving"
       * test, which went premium for a package containing only text.bold and
       * text.italic.
       *
       * The bundle must follow what the customer BOUGHT. The baseline is an
       * entitlement floor, not a purchase.
       */
      ? await this.versions.planForFeatures(versionForPlan, packageFeatures)
      // No resolvable version yet (nothing published). Fall back to the RICHER
      // plan: over-serving costs bandwidth, under-serving silently removes paid
      // features, and only one of those is recoverable without a support ticket.
      : PREMIUM_PLAN;

    return { plan, features, licence };
  }

  /**
   * Domain binding (T11). Empty `domains` means unbound — any origin is fine.
   *
   * Deliberately NOT IP-bound: our customer is a company whose thousands of
   * end-users each present a different, changing IP. Binding to one would lock
   * out office networks, mobile users, and multi-server deployments.
   *
   * ⚠️ USES THE CANONICAL MATCHER. This method previously carried its own copy
   * of the matching rule — `host === bare || host.endsWith('.' + bare)` — which
   * was WEAKER than `domain-policy.hostMatchesPattern` in a way that mattered:
   *
   *     a.b.customer.com  vs  *.customer.com   canonical: NO    copy: YES
   *
   * A wildcard is meant to cover ONE label, so arbitrarily deep subdomains were
   * accepted here while the licensing layer rejected them. Two implementations
   * of one security rule will always drift; there is now one.
   */
  private originAllowed(origin: string | null | undefined, domains: string[]): boolean {
    if (!domains?.length) return true;
    if (!origin) return false;
    let host: string;
    try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
    // A developer origin is allowed so customers can build (T2) — but it is
    // NOT a free pass: isDevOrigin() is used by the caller to record that the
    // session was granted on a dev host, so a shared key showing up on
    // hundreds of localhosts is visible rather than invisible.
    if (DeliverySessionService.devOrigin(host)) return true;
    return hostAllowed(host, domains);
  }

  /**
   * Is this a local development origin?
   *
   * Kept deliberately narrow — only true loopback, which can never serve a real
   * site. Anything broader (a .local domain, a private IP range) would be a
   * bypass someone could actually host on.
   */
  private static devOrigin(host: string): boolean {
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host === '[::1]'
      || host.endsWith('.localhost');
  }
}
