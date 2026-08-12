/**
 * engine.controller.ts — serves the engine BYTES to the loader (execution plan
 * §1.4). This is the hot path: every editor load that misses the browser cache
 * lands here.
 *
 * ─── THE URL SHAPE, AND WHY IT CHANGED ──────────────────────────────────────
 *
 *     GET /engine/:version/:plan/:digest.js
 *
 * The original design was `/engine/:version/:plan/:token`. That could not work:
 * the session token is unique per user and rotates every 15 minutes, so putting
 * it in the path puts it in the CDN's CACHE KEY. The result is a ~0% hit rate,
 * every request reaching origin, and the cache filling with millions of
 * single-use ~600 KB entries — the exact load the CDN exists to absorb (R41).
 *
 * Content-addressing fixes it: the URL contains the bundle's SHA-256, so the
 * same URL always means the same bytes. One cache entry per bundle, cacheable
 * for a year, and a poisoned cache is detectable because the loader verifies
 * the digest it was promised at /session.
 *
 * ─── WHY THERE IS NO TOKEN CHECK HERE ───────────────────────────────────────
 * Authorisation already happened at POST /session — that is what /session is
 * for. Re-validating here would buy nothing (the caller already holds the
 * bytes' address) and would cost the entire cache.
 *
 * PREMIUM is different: its URL carries a short-lived signature, verified
 * below. See BundleUrlSigner and risk R44 — an unprotected premium bundle
 * combined with the editor's `allowDevHost` default is a premium giveaway.
 */
import {
  Controller, Get, Param, Query, Res, Headers, NotFoundException, Logger,
  Optional, Inject,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { Throttle } from '@nestjs/throttler';
import { EngineVersionService } from '../licensing/engine-version.service';
import { PREMIUM_PLAN } from './session.service';
import { BundleUrlSigner } from './bundle-url-signer';
import { isValidDigest } from './bundle-storage';
import { BUNDLE_STORAGE, BundleStorage } from './bundle-storage';
import { WatermarkService } from './watermark.service';

/**
 * One year. The URL is content-addressed, so the bytes behind it can never
 * change — `immutable` tells the browser not to even revalidate, which removes
 * a conditional request from every warm load.
 *
 * These headers do nothing visible in local development and are the thing most
 * likely to be silently missing when the CDN arrives in Phase 2, so they are
 * asserted in tests rather than left to inspection.
 */
export const BUNDLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

@Controller('engine')
export class EngineController {
  private readonly log = new Logger(EngineController.name);

  constructor(
    private readonly versions: EngineVersionService,
    private readonly signer: BundleUrlSigner,
    // §2.5 — watermarked premium variants live in storage, not the registry.
    @Optional() @Inject(BUNDLE_STORAGE) private readonly storage?: BundleStorage,
    @Optional() private readonly watermarks?: WatermarkService,
  ) {}

  /**
   * Serve one bundle.
   *
   * The `.js` suffix is part of the path rather than a route extension so the
   * URL looks like a static asset to every proxy between us and the browser —
   * some of which treat extensionless URLs as uncacheable.
   */
  @Get(':version/:plan/:file')
  @Public()
  /**
   * The limit is PER IP, and one corporate NAT, university, or mobile carrier
   * puts thousands of end-users behind a single address. A tight limit here
   * hands those users a blank editor.
   *
   * It was originally 120/min, which a single customer's office would exhaust
   * in under a minute — and until the CDN lands in Phase 2, EVERY request
   * reaches this route. The content is immutable, public (free) or signed
   * (premium), and served straight from disk, so replay is close to harmless;
   * the limit exists only to stop a runaway client, not to ration real loads.
   */
  @Throttle({ default: { limit: 6_000, ttl: 60_000 } })
  async serve(
    @Param('version') version: string,
    @Param('plan') plan: string,
    @Param('file') file: string,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const digest = file.endsWith('.js') ? file.slice(0, -3) : file;

    // Reject a malformed digest before it reaches storage. The digest becomes a
    // filename in the local driver, so this is a path-traversal boundary, not a
    // formatting check.
    if (!isValidDigest(digest)) {
      throw new NotFoundException('unknown bundle');
    }

    // PREMIUM requires a valid short-lived signature (R44). Checked BEFORE the
    // registry lookup so an unsigned probe cannot be used to discover which
    // versions exist.
    if (plan === PREMIUM_PLAN) {
      this.signer.verify(digest, exp, sig);
    }

    // The registry is the authority on which (version, plan, digest) triples
    // are real. Without this check, any stored bundle could be fetched under
    // any version/plan label — including a premium bundle requested under the
    // free plan's unsigned path, which would hand premium away for free.
    let bundle = await this.versions.readBundle(version, plan, digest);

    /**
     * §2.5 — a PREMIUM digest may be a per-licence WATERMARKED variant, which
     * is deliberately not in the registry (registering one row per customer
     * would defeat the point of a registry).
     *
     * The registry gate above is NOT weakened. This path is reachable only
     * when:
     *   1. plan === premium, so the R44 signature was already verified above —
     *      meaning THIS SERVER issued this exact digest; a caller cannot invent
     *      one, and
     *   2. the digest exists in our own bundle storage.
     *
     * Together those are strictly stronger than "is it in the registry",
     * because a signature proves provenance rather than mere membership.
     */
    if (!bundle && plan === PREMIUM_PLAN && this.watermarks && this.storage) {
      if (await this.watermarks.isKnownWatermark(digest)) {
        bundle = await this.storage.get(digest);
      }
    }

    if (!bundle) {
      this.log.warn(`bundle miss: ${version}/${plan}/${digest.slice(0, 12)}…`);
      throw new NotFoundException('unknown bundle');
    }

    const etag = `"${digest}"`;

    res.set({
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': BUNDLE_CACHE_CONTROL,
      // The digest IS the identity, so it is the natural ETag. Costs nothing
      // and lets any intermediate cache revalidate correctly.
      ETag: etag,
      // The loader fetches cross-origin from the customer's page.
      'Access-Control-Allow-Origin': '*',
      /**
       * REQUIRED, and easy to miss: helmet's defaults set
       * `Cross-Origin-Resource-Policy: same-origin` on every response. That
       * tells the browser to BLOCK this bundle when it is loaded from a
       * customer's domain — regardless of CORS — which is the entire point of
       * this endpoint. Overridden explicitly here rather than by weakening
       * helmet globally, so every other route keeps the safer default.
       */
      'Cross-Origin-Resource-Policy': 'cross-origin',
      // Never let a proxy or browser guess a different content type for a file
      // we are about to execute.
      'X-Content-Type-Options': 'nosniff',
    });

    /**
     * Honour conditional requests. We advertise an ETag, so caches and proxies
     * will revalidate with If-None-Match; answering 200 every time re-sends
     * ~600 KB where ~200 bytes would do. Content-addressing makes the
     * comparison trivially correct: matching ETag means byte-identical, always.
     *
     * Handles a comma-separated list and the `W/` weak prefix, since
     * intermediates legitimately send both.
     */
    if (ifNoneMatch && this.etagMatches(ifNoneMatch, digest)) {
      // A 304 must not carry a body or Content-Length.
      res.status(304).end();
      return;
    }

    res.set('Content-Length', String(bundle.bytes.length));
    res.send(bundle.bytes);
  }

  /**
   * Does an `If-None-Match` header match this bundle?
   *
   * Accepts the forms intermediates actually send: a bare tag, a weak tag
   * (`W/"…"`), a comma-separated list, and `*`. Anything unrecognised falls
   * through to a full response — being wrong in that direction costs bandwidth,
   * whereas a false match would serve a stale 304 for content that differs.
   */
  private etagMatches(header: string, digest: string): boolean {
    return header
      .split(',')
      .map((t) => t.trim().replace(/^W\//, '').replace(/^"|"$/g, ''))
      .some((t) => t === digest || t === '*');
  }
}
