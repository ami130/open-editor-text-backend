/**
 * watermark.service.ts — per-licence premium bundles (§2.5).
 *
 * ─── THE CACHING TRADE-OFF, AND WHY THIS SHAPE ──────────────────────────────
 * Phase 1 is built on content-addressed, immutable URLs: everyone downloads the
 * SAME file, so a CDN serves it once and caches it forever. Watermarking gives
 * each licence DIFFERENT bytes, which by definition cannot be shared.
 *
 * PREMIUM ONLY, deliberately. Free users have nothing worth leaking, and they
 * are the overwhelming majority of traffic — so the free bundle keeps a perfect
 * shared cache, and the cost is confined to the small paying population.
 *
 * And within that population the immutable property SURVIVES: a licence's
 * watermarked bundle is deterministic, generated once, stored under its own
 * content hash, and then served with the same `immutable` caching as any other
 * bundle. Customer A's cache is as good as before; it simply is not shared with
 * customer B.
 *
 * ─── FAILS OPEN, ON PURPOSE ─────────────────────────────────────────────────
 * If watermarking cannot be performed — no secret configured, storage error,
 * bundle missing — the customer gets the ORDINARY premium bundle. They have
 * paid; an anti-leak measure that withholds a product from a paying customer is
 * a worse outcome than an untraceable copy. Every failure is logged so the gap
 * is visible rather than silent.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { BUNDLE_STORAGE, BundleStorage } from './bundle-storage';
import { DELIVERY_CONFIG, DeliveryConfig } from '../config/delivery.config';
import { applyWatermark, digestOf } from './watermark';

@Injectable()
export class WatermarkService {
  private readonly log = new Logger(WatermarkService.name);

  /**
   * In-process memo of licId → watermarked digest, so a returning customer
   * costs one map lookup instead of re-hashing the bundle on every session.
   * Safe to lose: it is a pure function of (bundle, licence), so a cold process
   * simply regenerates identical bytes and lands on the same digest.
   */
  private readonly memo = new Map<string, string>();

  constructor(
    @Optional() @Inject(BUNDLE_STORAGE) private readonly storage?: BundleStorage,
    @Optional() @Inject(DELIVERY_CONFIG) private readonly cfg?: DeliveryConfig,
  ) {}

  /** Is watermarking available at all? */
  get enabled(): boolean {
    return !!(this.storage && this.secret());
  }

  /**
   * A key DERIVED from the URL-signing secret rather than the secret itself.
   *
   * Same trust boundary (both are server-only), but separate purposes must not
   * share key material: if one is ever rotated, leaked, or reused in a context
   * with different exposure, the other must not be affected. Derivation costs
   * nothing and removes that coupling entirely.
   */
  private secret(): string {
    const base = (this.cfg?.urlSigningSecret || '').trim();
    if (!base) return '';
    return createHmac('sha256', base).update('watermark-v1').digest('hex');
  }

  /**
   * The derived key, for the admin TRACE tool only.
   *
   * Exposed rather than duplicating the derivation in the admin controller —
   * two copies of a key derivation is exactly how they silently drift apart and
   * tracing starts returning "no match" for genuine leaks.
   */
  traceSecret(): string {
    return this.secret();
  }

  /**
   * The digest this licence should receive for a given premium bundle.
   *
   * Returns the ORIGINAL digest unchanged when watermarking is unavailable or
   * fails — see the fail-open note in the header.
   */
  async digestForLicence(baseSha256: string, licId: string | null | undefined): Promise<string> {
    const lic = (licId || '').trim();
    if (!lic || !this.enabled) return baseSha256;

    const memoKey = `${baseSha256}::${lic}`;
    const cached = this.memo.get(memoKey);
    if (cached) return cached;

    try {
      const source = await this.storage!.get(baseSha256);
      if (!source) {
        this.log.warn(`watermark skipped: base bundle ${baseSha256.slice(0, 12)}… not in storage`);
        return baseSha256;
      }

      const marked = applyWatermark(source.bytes, this.secret(), lic);
      const digest = digestOf(marked);

      // Content-addressed: writing identical bytes twice is a no-op, so a
      // concurrent second request for the same licence cannot corrupt anything.
      if (!(await this.storage!.has(digest))) {
        await this.storage!.put(marked);
        this.log.log(`watermarked bundle for ${lic.slice(0, 20)}… -> ${digest.slice(0, 12)}…`);
      }

      this.memo.set(memoKey, digest);
      return digest;
    } catch (err) {
      // FAIL OPEN. A paying customer must still receive their product.
      this.log.error(`watermarking failed for ${lic}; serving unmarked bundle: ${String(err)}`);
      return baseSha256;
    }
  }

  /**
   * Is this digest one WE generated as a watermark of the registered bundle?
   *
   * The serve endpoint gates on the REGISTRY: only a registered digest may be
   * served under a given version/plan. Watermarked digests are deliberately not
   * registered, so that gate would 404 them.
   *
   * Rather than weaken it, the controller asks this — and the proof is already
   * in hand. A premium URL carries an HMAC signature over its digest (R44),
   * which the controller verifies BEFORE reaching here. A caller therefore
   * cannot invent a digest: only this server could have signed one. So the
   * remaining question is merely "is it a premium bundle we hold?", which is a
   * storage lookup, not a scan over every licence.
   *
   * (An earlier version of this method re-derived the watermark for every known
   * licence on every request — correct, but O(licences) of hashing on a hot,
   * public path. The signature already provides the guarantee that scan was
   * trying to establish.)
   */
  async isKnownWatermark(digest: string): Promise<boolean> {
    if (!this.enabled || !digest) return false;
    try {
      return await this.storage!.has(digest);
    } catch {
      return false;
    }
  }
}
