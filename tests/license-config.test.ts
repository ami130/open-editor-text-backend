/**
 * license-config.test.ts — the production guard on LICENSE_PRIVATE_KEY (audit #2).
 *
 * Pure, no DB, no crypto. Mirrors the auth/customer-auth prod-guard contract:
 * production must FAIL LOUD on a missing/placeholder signing key (else every
 * mint/JWKS/refresh silently 503s — a hidden money-path outage), while dev just
 * leaves the signer disabled.
 */
import { describe, it, expect } from 'vitest';
import { loadLicenseConfig } from '../src/config/license.config';

// A minimal, structurally-valid-looking PEM (content isn't parsed by the loader —
// it makes no crypto calls; it only shape-checks the header in production).
const REAL_PEM = '-----BEGIN PRIVATE KEY-----\nMIGHAgEA...\n-----END PRIVATE KEY-----';

const env = (over: Record<string, string> = {}) => over as NodeJS.ProcessEnv;

describe('loadLicenseConfig — production guard (audit #2)', () => {
  it('DEV: a missing key is fine — signer simply disabled (never insecure)', () => {
    const c = loadLicenseConfig(env({ NODE_ENV: 'development' }));
    expect(c.enabled).toBe(false);
  });

  it('PROD: a missing key THROWS (loud failure, not a silent 503 outage)', () => {
    expect(() => loadLicenseConfig(env({ NODE_ENV: 'production' })))
      .toThrow(/LICENSE_PRIVATE_KEY must be set in production/i);
  });

  it('PROD: a non-PEM value THROWS', () => {
    expect(() => loadLicenseConfig(env({ NODE_ENV: 'production', LICENSE_PRIVATE_KEY: 'not-a-pem' })))
      .toThrow(/must be a PEM private key/i);
  });

  it('PROD: a placeholder-looking key THROWS', () => {
    const placeholder = '-----BEGIN PRIVATE KEY-----\nchange-me\n-----END PRIVATE KEY-----';
    expect(() => loadLicenseConfig(env({ NODE_ENV: 'production', LICENSE_PRIVATE_KEY: placeholder })))
      .toThrow(/placeholder/i);
  });

  it('PROD: a real PEM boots with the signer ENABLED', () => {
    const c = loadLicenseConfig(env({ NODE_ENV: 'production', LICENSE_PRIVATE_KEY: REAL_PEM }));
    expect(c.enabled).toBe(true);
    expect(c.privateKeyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('PROD: accepts a \\n-escaped single-line PEM (env-friendly)', () => {
    const escaped = REAL_PEM.replace(/\n/g, '\\n');
    const c = loadLicenseConfig(env({ NODE_ENV: 'production', LICENSE_PRIVATE_KEY: escaped }));
    expect(c.enabled).toBe(true);
  });
});
