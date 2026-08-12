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
      ? await this.resolveLicensed(req)
      // No key → the free tier. ALL_BUILD_FEATURES, not [] — see the sentinel's
      // docstring: an empty list would intersect to nothing and hand the user a
      // free bundle with every feature disabled.
      : {
        plan: FREE_PLAN,
        features: [ALL_BUILD_FEATURES],
        licence: null,
        refusal: undefined as SessionRefusal | undefined,
      };

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
      },
      defaults,
    );

    const now = Math.floor(Date.now() / 1000);
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
          sha256: delivery.bundleSha256,
          url: this.bundleUrl(delivery.version, delivery.plan, delivery.bundleSha256),
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
   * The stored licence token for a licence id, if the licence is still usable.
   *
   * Returns null for a missing, revoked, or expired licence so the caller
   * degrades to the free tier rather than trusting a stale refresh token.
   */
  private async keyForLicence(licId: string): Promise<string | null> {
    const licence = await this.licences.findOne({ where: { licId } });
    if (!licence || licence.status === 'revoked' || licence.isExpired()) return null;
    return licence.token || null;
  }

  /**
   * Validate a licence key and read its entitlements.
   *
   * IMPORTANT — the PACKAGE is the source of truth for features, not the
   * licence's stored `features` snapshot (T14). The snapshot records what was
   * sold and when; using it as the live gate means a customer never receives
   * features added to their plan after purchase. The snapshot is used only as a
   * fallback for legacy rows with no package relation.
   */
  private async resolveLicensed(req: SessionRequest): Promise<{
    plan: string;
    features: string[];
    licence: LicenseEntity | null;
    refusal?: SessionRefusal;
  }> {
    const claims = this.signer.verifyOwnToken(req.licenceKey as string);
    if (!claims) return { plan: FREE_PLAN, features: [ALL_BUILD_FEATURES], licence: null, refusal: 'invalid-key' };

    const licence = await this.licences.findOne({
      where: { licId: claims.lic },
      relations: ['package', 'package.features', 'customer'],
    });
    if (!licence) return { plan: FREE_PLAN, features: [ALL_BUILD_FEATURES], licence: null, refusal: 'invalid-key' };
    if (licence.status === 'revoked') {
      return { plan: FREE_PLAN, features: [ALL_BUILD_FEATURES], licence: null, refusal: 'revoked' };
    }
    if (licence.isExpired()) {
      return { plan: FREE_PLAN, features: [ALL_BUILD_FEATURES], licence: null, refusal: 'expired' };
    }
    if (!this.originAllowed(req.origin, licence.domains)) {
      return { plan: FREE_PLAN, features: [ALL_BUILD_FEATURES], licence: null, refusal: 'origin-blocked' };
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
        return { plan: FREE_PLAN, features: [ALL_BUILD_FEATURES], licence: null, refusal: 'install-cap' };
      }
    }

    const features = licence.package?.features?.length
      ? licence.package.features.map((f) => f.id)
      : licence.features; // legacy rows with no package relation

    // Any licence granting a premium feature receives the premium bundle. Which
    // of those features are actually usable is decided by the intersection in
    // EngineVersionService, not here.
    const plan = features.some((f) => f.startsWith('export.')) ? PREMIUM_PLAN : FREE_PLAN;
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
