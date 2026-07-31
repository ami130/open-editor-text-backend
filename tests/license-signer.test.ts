/**
 * license-signer.test.ts — THE critical test: a license signed by our backend
 * signer is accepted by the EDITOR's real offline verifier
 * (@openeditors/entitlements). If this passes, our production issuer is
 * byte-compatible with what the editor checks — the whole commercial model
 * hinges on it. We import the real verifier by relative path (dev/test only;
 * tests never ship).
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll } from 'vitest';
import { LicenseSignerService, generateKeyPair } from '../src/licensing/license-signer.service';
import { loadLicenseConfig } from '../src/config/license.config';
// The REAL editor verifier + registry (relative into the sibling monorepo).
// @ts-expect-error — JS module, no types; fine for a dev/test import.
import { verifyLicense, importEs256PublicKey, REASON } from '../../open-editor/packages/entitlements/src/index.js';

let signer: LicenseSignerService;
let keyring: Array<{ kid: string; alg: string; key: unknown }>;
const KID = 'oe-test-key-1';

beforeAll(async () => {
  const kp = generateKeyPair();
  const cfg = loadLicenseConfig({
    LICENSE_PRIVATE_KEY: kp.privateKeyPem,
    LICENSE_KID: KID,
  } as NodeJS.ProcessEnv);
  signer = new LicenseSignerService(cfg);
  // Build the verifier keyring from our signer's PUBLIC jwk (what a JWKS endpoint serves).
  const key = await importEs256PublicKey(signer.publicJwk());
  keyring = [{ kid: KID, alg: 'ES256', key }];
});

const verify = (token: string, hostname = 'customer.com', now?: number) =>
  verifyLicense(token, { keyring, hostname, now });

describe('LicenseSignerService ↔ editor verifier compatibility', () => {
  it('a signed license VERIFIES and grants exactly its features', async () => {
    const { token } = signer.sign({
      features: ['export.pdf', 'export.docx', 'text.bold'],
      domains: ['customer.com'],
      customer: 'cust-1',
      plan: 'Pro',
    });
    const res = await verify(token);
    expect(res.valid).toBe(true);
    expect(res.payload.features).toEqual(['export.pdf', 'export.docx', 'text.bold']);
    expect(res.payload.customer).toBe('cust-1');
  });

  it('CRYPTO ROBUSTNESS: 400 freshly-signed licenses ALL verify (exercises short-r/s DER→P1363)', async () => {
    // ~1/256 of signatures have a short r or s component; a broken r||s
    // conversion would fail intermittently. Loop many times to catch it.
    for (let i = 0; i < 400; i++) {
      const { token } = signer.sign({ features: ['export.pdf'], domains: ['customer.com'], customer: `c${i}` });
      const res = await verify(token);
      expect(res.valid, `iteration ${i}`).toBe(true);
    }
  });

  it('lic ids are unique across many rapid mints (UUID, not 32-bit random)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      ids.add(signer.sign({ features: ['export.pdf'], domains: ['x.com'], customer: 'c', iat: 1000 }).lic);
    }
    expect(ids.size).toBe(2000); // no collisions even with the SAME iat second
  });

  it('TAMPERING with the token breaks verification (bad signature)', async () => {
    const { token } = signer.sign({ features: ['export.pdf'], domains: ['customer.com'], customer: 'c' });
    // flip a char in the payload segment
    const [h, p, s] = token.split('.');
    const tampered = `${h}.${p.slice(0, -2)}${p.slice(-2) === 'AA' ? 'BB' : 'AA'}.${s}`;
    const res = await verify(tampered);
    expect(res.valid).toBe(false);
  });

  it('DOMAIN binding: rejects a host not in the license domains', async () => {
    const { token } = signer.sign({ features: ['export.pdf'], domains: ['customer.com'], customer: 'c' });
    const res = await verify(token, 'attacker.com');
    expect(res.valid).toBe(false);
    expect(res.reason).toBe(REASON.DOMAIN);
  });

  it('DOMAIN binding: wildcard *.base matches subdomains', async () => {
    const { token } = signer.sign({ features: ['export.pdf'], domains: ['*.customer.com'], customer: 'c' });
    expect((await verify(token, 'app.customer.com')).valid).toBe(true);
  });

  it('EXPIRY: a token past exp is rejected', async () => {
    const iat = Math.floor(Date.now() / 1000) - 10000;
    const { token, exp } = signer.sign({ features: ['export.pdf'], domains: ['customer.com'], customer: 'c', iat, ttlSeconds: 3600 });
    // verify "now" well after exp
    const res = await verify(token, 'customer.com', exp + 100);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe(REASON.EXPIRED);
  });

  it('a DIFFERENT signing key is rejected (unknown kid / bad signature)', async () => {
    const other = generateKeyPair();
    const otherSigner = new LicenseSignerService(loadLicenseConfig({ LICENSE_PRIVATE_KEY: other.privateKeyPem, LICENSE_KID: KID } as NodeJS.ProcessEnv));
    const { token } = otherSigner.sign({ features: ['export.pdf'], domains: ['customer.com'], customer: 'c' });
    // same kid label but different key → signature won't verify against our keyring
    expect((await verify(token)).valid).toBe(false);
  });

  it('TTL is clamped under the verifier lifetime ceiling', async () => {
    const { iat, exp } = signer.sign({ features: ['export.pdf'], domains: ['x.com'], customer: 'c', ttlSeconds: 999 * 24 * 3600 });
    const lifetime = exp - iat;
    const ceiling = 3 * 366 * 24 * 3600 + 30 * 24 * 3600;
    expect(lifetime).toBeLessThan(ceiling);
  });
});

describe('KEY ROTATION (real, not just claimed)', () => {
  it('after rotating to a new key, a license signed by the OLD key still verifies via retired JWKS', async () => {
    // Old key mints a license.
    const oldKp = generateKeyPair();
    const OLD_KID = 'oe-old';
    const oldSigner = new LicenseSignerService(loadLicenseConfig({ LICENSE_PRIVATE_KEY: oldKp.privateKeyPem, LICENSE_KID: OLD_KID } as NodeJS.ProcessEnv));
    const oldLicense = oldSigner.sign({ features: ['export.pdf'], domains: ['customer.com'], customer: 'c' });

    // Rotate: new private key + kid, old PUBLIC key retired into JWKS config.
    const newKp = generateKeyPair();
    const rotated = new LicenseSignerService(loadLicenseConfig({
      LICENSE_PRIVATE_KEY: newKp.privateKeyPem,
      LICENSE_KID: 'oe-new',
      LICENSE_RETIRED_KEYS: JSON.stringify([{ kid: OLD_KID, publicKeyPem: oldKp.publicKeyPem }]),
    } as NodeJS.ProcessEnv));

    // JWKS now publishes BOTH keys.
    const jwks = rotated.publicJwks();
    expect(jwks.length).toBe(2);
    const kids = jwks.map((k) => k.kid);
    expect(kids).toContain('oe-new');
    expect(kids).toContain(OLD_KID);

    // Build a verifier keyring from the rotated JWKS and verify the OLD license.
    const ring = await Promise.all(jwks.map(async (jwk) => ({ kid: jwk.kid, alg: 'ES256', key: await importEs256PublicKey(jwk) })));
    const res = await verifyLicense(oldLicense.token, { keyring: ring, hostname: 'customer.com' });
    expect(res.valid).toBe(true); // old license survives the rotation

    // And a NEW license (new kid) also verifies against the same JWKS.
    const newLicense = rotated.sign({ features: ['export.pdf'], domains: ['customer.com'], customer: 'c2' });
    expect((await verifyLicense(newLicense.token, { keyring: ring, hostname: 'customer.com' })).valid).toBe(true);
  });

  it('H1: verifyOwnToken (the refresh path) accepts a token signed by a RETIRED key after rotation', () => {
    // Old key mints a token.
    const oldKp = generateKeyPair();
    const OLD_KID = 'oe-old-refresh';
    const oldSigner = new LicenseSignerService(loadLicenseConfig({ LICENSE_PRIVATE_KEY: oldKp.privateKeyPem, LICENSE_KID: OLD_KID } as NodeJS.ProcessEnv));
    const oldToken = oldSigner.sign({ features: ['export.pdf'], domains: ['customer.com'], customer: 'c' }).token;

    // Rotate; retire the old PUBLIC key.
    const newKp = generateKeyPair();
    const rotated = new LicenseSignerService(loadLicenseConfig({
      LICENSE_PRIVATE_KEY: newKp.privateKeyPem,
      LICENSE_KID: 'oe-new-refresh',
      LICENSE_RETIRED_KEYS: JSON.stringify([{ kid: OLD_KID, publicKeyPem: oldKp.publicKeyPem }]),
    } as NodeJS.ProcessEnv));

    // The rotated signer must STILL verify the retired-key token (else refresh
    // would refuse every pre-rotation customer — the H1 bug).
    const claims = rotated.verifyOwnToken(oldToken);
    expect(claims).not.toBeNull();
    expect(claims!.kid).toBe(OLD_KID);
    expect(claims!.features).toEqual(['export.pdf']);

    // A token from a genuinely UNKNOWN kid is still rejected.
    const strangerKp = generateKeyPair();
    const strangerToken = new LicenseSignerService(loadLicenseConfig({ LICENSE_PRIVATE_KEY: strangerKp.privateKeyPem, LICENSE_KID: 'stranger' } as NodeJS.ProcessEnv))
      .sign({ features: ['export.pdf'], domains: ['customer.com'], customer: 'x' }).token;
    expect(rotated.verifyOwnToken(strangerToken)).toBeNull();
  });

  it('JWKS exposes only PUBLIC material (no private scalar d)', () => {
    for (const jwk of signer.publicJwks()) {
      expect(jwk.d).toBeUndefined();
      expect(jwk.kty).toBe('EC');
      expect(jwk.crv).toBe('P-256');
    }
  });
});

describe('signer gating', () => {
  it('throws a clear error when no key is configured', () => {
    const off = new LicenseSignerService(loadLicenseConfig({} as NodeJS.ProcessEnv));
    expect(off.enabled).toBe(false);
    expect(() => off.sign({ features: ['export.pdf'], domains: ['x'], customer: 'c' })).toThrow(/not configured/i);
  });
});
