/**
 * bundle-url-signer.ts — short-lived signatures for PREMIUM bundle URLs
 * (execution plan §1.4, risk R44).
 *
 * ─── THE PROBLEM ────────────────────────────────────────────────────────────
 * §1.4 makes bundle URLs content-addressed and cacheable forever, with no token
 * in the path — that is what gives the CDN a real hit rate. But it also means
 * the URL alone is enough to fetch the bytes.
 *
 * For the FREE bundle that is fine and expected (B2). For PREMIUM it is not:
 * combined with the editor's `allowDevHost: true` default, anyone who could
 * fetch premium.js could serve it from localhost and unlock premium.
 *
 * ─── THE SHAPE ──────────────────────────────────────────────────────────────
 * A query-string signature over (digest, expiry):
 *
 *     /engine/1.3.0/premium/<sha256>.js?exp=<unix>&sig=<hmac>
 *
 * Why a QUERY parameter rather than a path segment: the digest stays the cache
 * key, so the CDN can still store one copy per bundle. Only the signature
 * varies per user, and CDNs are configured to validate-then-ignore it. Putting
 * it in the path would recreate exactly the cache-key explosion §1.4 fixed.
 *
 * WHY HMAC AND NOT THE ES256 LICENCE KEY: this is a symmetric check we perform
 * ourselves on every request, thousands of times a minute. HMAC-SHA256 is
 * microseconds and, unlike the licence key, this secret never leaves our
 * infrastructure — there is no third party who needs to verify it.
 */
import {
  Injectable, Inject, ForbiddenException, ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DELIVERY_CONFIG, DeliveryConfig } from '../config/delivery.config';

export interface SignedBundleUrl {
  /** Unix seconds after which the signature is refused. */
  exp: number;
  /** Hex HMAC over the digest and expiry. */
  sig: string;
}

@Injectable()
export class BundleUrlSigner {
  constructor(@Inject(DELIVERY_CONFIG) private readonly cfg: DeliveryConfig) {}

  get enabled(): boolean {
    return this.cfg.signingEnabled;
  }

  /** Public origin/CDN base for bundle URLs (B4). Empty → relative URLs. */
  get publicBaseUrl(): string {
    return this.cfg.publicBaseUrl;
  }

  /**
   * Sign a premium bundle URL, valid for the configured window.
   *
   * Throws when no secret is configured rather than returning an unsigned URL:
   * silently serving premium unprotected is the failure R44 describes, and a
   * loud misconfiguration error is far better than a quiet giveaway.
   */
  sign(digest: string, now = Math.floor(Date.now() / 1000)): SignedBundleUrl {
    if (!this.cfg.signingEnabled) {
      throw new ServiceUnavailableException(
        'DELIVERY_URL_SECRET is not configured — premium bundles cannot be served '
        + 'without URL signing (see delivery.config.ts).',
      );
    }
    const exp = now + this.cfg.urlTtlSeconds;
    return { exp, sig: this.compute(digest, exp) };
  }

  /**
   * Verify a signature, throwing ForbiddenException when it fails.
   *
   * Expiry is checked BEFORE the signature so an expired-but-valid link is
   * distinguishable in logs from a forged one — the two mean very different
   * things operationally (a slow client vs. someone probing).
   */
  verify(
    digest: string,
    exp: unknown,
    sig: unknown,
    now = Math.floor(Date.now() / 1000),
  ): void {
    if (!this.cfg.signingEnabled) {
      throw new ServiceUnavailableException('bundle URL signing is not configured');
    }
    const expSeconds = Number(exp);
    if (!Number.isFinite(expSeconds) || expSeconds <= 0) {
      throw new ForbiddenException('bundle URL is missing a valid expiry');
    }
    if (expSeconds < now) {
      throw new ForbiddenException('bundle URL has expired — open a new session');
    }
    if (typeof sig !== 'string' || !sig) {
      throw new ForbiddenException('bundle URL is not signed');
    }
    const expected = this.compute(digest, expSeconds);
    // Constant-time compare. A byte-by-byte early exit leaks how much of a
    // guess was correct, which is enough to forge a signature given patience.
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(sig, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException('bundle URL signature is invalid');
    }
  }

  /**
   * The digest is bound INTO the signature, so a signature minted for the free
   * bundle cannot be replayed against the premium one.
   */
  private compute(digest: string, exp: number): string {
    return createHmac('sha256', this.cfg.urlSigningSecret)
      .update(`${digest}.${exp}`)
      .digest('hex');
  }
}
