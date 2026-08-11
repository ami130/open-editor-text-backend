/**
 * bundle-url-signer.test.ts — short-lived signatures for PREMIUM bundle URLs
 * (§1.4, risk R44).
 *
 * This is the ONLY thing standing between a content-addressed premium URL and
 * anyone who wants the premium engine for free. Under runtime delivery the
 * premium bundle is no longer protected by "it isn't in the npm package" — it
 * is a URL, and the editor's `allowDevHost: true` default would unlock it on
 * localhost. So the failure modes are tested adversarially, not happily.
 */
import { describe, it, expect } from 'vitest';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { BundleUrlSigner } from '../src/delivery/bundle-url-signer';
import type { DeliveryConfig } from '../src/config/delivery.config';

const cfg = (over: Partial<DeliveryConfig> = {}): DeliveryConfig => ({
  bundleDir: '/tmp/x',
  urlSigningSecret: 'test-secret',
  signingEnabled: true,
  urlTtlSeconds: 600,
  ...over,
});

const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const NOW = 1_800_000_000;

describe('sign + verify — the happy path', () => {
  it('a freshly signed URL verifies', () => {
    const s = new BundleUrlSigner(cfg());
    const { exp, sig } = s.sign(DIGEST, NOW);
    expect(() => s.verify(DIGEST, exp, sig, NOW)).not.toThrow();
  });

  it('expiry is now + the configured TTL', () => {
    const s = new BundleUrlSigner(cfg({ urlTtlSeconds: 300 }));
    expect(s.sign(DIGEST, NOW).exp).toBe(NOW + 300);
  });

  it('stays valid for the whole window, and fails the moment it lapses', () => {
    const s = new BundleUrlSigner(cfg({ urlTtlSeconds: 600 }));
    const { exp, sig } = s.sign(DIGEST, NOW);

    expect(() => s.verify(DIGEST, exp, sig, NOW + 599)).not.toThrow();
    expect(() => s.verify(DIGEST, exp, sig, exp)).not.toThrow();        // boundary: still valid
    expect(() => s.verify(DIGEST, exp, sig, exp + 1)).toThrow(ForbiddenException);
  });
});

describe('forgery — every one of these must be refused', () => {
  const s = new BundleUrlSigner(cfg());
  const valid = s.sign(DIGEST, NOW);

  it('rejects a signature minted for a DIFFERENT bundle (replay)', () => {
    // The whole point of binding the digest INTO the signature: a signature
    // legitimately obtained for one bundle must not unlock another. Without
    // this, any premium customer's URL could be retargeted at any bundle.
    expect(() => s.verify(OTHER, valid.exp, valid.sig, NOW)).toThrow(ForbiddenException);
  });

  it('rejects a tampered expiry (extending the window)', () => {
    // The expiry is signed, so pushing it out invalidates the signature —
    // otherwise a short-lived URL would be trivially made permanent.
    expect(() => s.verify(DIGEST, valid.exp + 86_400, valid.sig, NOW))
      .toThrow(ForbiddenException);
  });

  it('rejects a signature made with a different secret', () => {
    const attacker = new BundleUrlSigner(cfg({ urlSigningSecret: 'wrong-secret' }));
    const forged = attacker.sign(DIGEST, NOW);
    expect(() => s.verify(DIGEST, forged.exp, forged.sig, NOW)).toThrow(ForbiddenException);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 12345],
    ['truncated', 'deadbeef'],
    ['a longer string', 'f'.repeat(128)],
  ])('rejects a %s signature', (_label, sig) => {
    expect(() => s.verify(DIGEST, valid.exp, sig as unknown, NOW)).toThrow(ForbiddenException);
  });

  it.each([
    ['missing', undefined],
    ['non-numeric', 'soon'],
    ['zero', 0],
    ['negative', -1],
  ])('rejects a %s expiry', (_label, exp) => {
    expect(() => s.verify(DIGEST, exp as unknown, valid.sig, NOW)).toThrow(ForbiddenException);
  });
});

describe('misconfiguration fails LOUDLY, never open', () => {
  // Serving premium unsigned is the exact giveaway R44 describes. A missing
  // secret must break the endpoint, not quietly disable the protection.
  const unset = new BundleUrlSigner(cfg({ urlSigningSecret: '', signingEnabled: false }));

  it('refuses to sign without a secret', () => {
    expect(() => unset.sign(DIGEST, NOW)).toThrow(ServiceUnavailableException);
  });

  it('refuses to verify without a secret — it does NOT pass everything', () => {
    expect(() => unset.verify(DIGEST, NOW + 600, 'anything', NOW))
      .toThrow(ServiceUnavailableException);
  });

  it('reports itself disabled so callers can detect the misconfiguration', () => {
    expect(unset.enabled).toBe(false);
    expect(new BundleUrlSigner(cfg()).enabled).toBe(true);
  });
});

describe('signature shape', () => {
  it('is hex, and differs per bundle and per expiry', () => {
    const s = new BundleUrlSigner(cfg());
    const a = s.sign(DIGEST, NOW);
    const b = s.sign(OTHER, NOW);
    const c = s.sign(DIGEST, NOW + 1);

    expect(a.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sig).not.toBe(b.sig);
    expect(a.sig).not.toBe(c.sig);
  });

  it('is deterministic for the same inputs', () => {
    const s = new BundleUrlSigner(cfg());
    expect(s.sign(DIGEST, NOW).sig).toBe(s.sign(DIGEST, NOW).sig);
  });
});
