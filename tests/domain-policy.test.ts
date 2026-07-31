/**
 * domain-policy.test.ts — Phase 5a: the SHARED domain matcher + normalization.
 * Pins apex↔www auto-pairing, the reconciled `*.base`-includes-apex wildcard,
 * public-suffix rejection, and matcher parity with the editor's domain-check.js.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeDomains, assertDomainsAcceptable, hostMatchesPattern, hostAllowed,
} from '../src/licensing/domain-policy';

// The editor's matcher — imported to PROVE server↔editor parity (dev/test import).
// @ts-expect-error — JS module, no types.
import { hostMatchesPattern as editorMatch } from '../../open-editor/packages/entitlements/src/domain-check.js';

describe('normalizeDomains — apex↔www auto-pair', () => {
  it('a bare apex adds www', () => {
    expect(normalizeDomains(['example.com']).sort()).toEqual(['example.com', 'www.example.com']);
  });
  it('a www host adds the apex', () => {
    expect(normalizeDomains(['www.example.com']).sort()).toEqual(['example.com', 'www.example.com']);
  });
  it('does NOT www-pair a non-apex host (app.example.com is intentional)', () => {
    expect(normalizeDomains(['app.example.com'])).toEqual(['app.example.com']);
  });
  it('does NOT pair wildcards', () => {
    expect(normalizeDomains(['*.example.com'])).toEqual(['*.example.com']);
  });
  it('lowercases, strips FQDN dot + port, de-dups', () => {
    expect(normalizeDomains(['Example.COM.', 'example.com:443']).sort())
      .toEqual(['example.com', 'www.example.com']);
  });
  it('drops empties', () => {
    expect(normalizeDomains(['', '  '])).toEqual([]);
  });
});

describe('hostMatchesPattern — reconciled wildcard (apex-inclusive, single sub-level)', () => {
  it('exact host', () => {
    expect(hostMatchesPattern('example.com', 'example.com')).toBe(true);
    expect(hostMatchesPattern('www.example.com', 'example.com')).toBe(false);
  });
  it('*.base matches one sub-level', () => {
    expect(hostMatchesPattern('app.example.com', '*.example.com')).toBe(true);
  });
  it('*.base ALSO matches the apex (the reconciliation)', () => {
    expect(hostMatchesPattern('example.com', '*.example.com')).toBe(true);
  });
  it('*.base does NOT match a two-level sub', () => {
    expect(hostMatchesPattern('a.b.example.com', '*.example.com')).toBe(false);
  });
  it('malformed → false (fail closed)', () => {
    // @ts-expect-error deliberately bad input
    expect(hostMatchesPattern(null, 'example.com')).toBe(false);
    expect(hostMatchesPattern('example.com', '*.')).toBe(false);
  });
});

describe('server ↔ editor matcher PARITY', () => {
  const hosts = ['example.com', 'www.example.com', 'app.example.com', 'a.b.example.com', 'other.com'];
  const patterns = ['example.com', 'www.example.com', '*.example.com'];
  it('the server matcher agrees with the editor matcher on every host×pattern', () => {
    for (const h of hosts) {
      for (const p of patterns) {
        expect(hostMatchesPattern(h, p)).toBe(editorMatch(h, p));
      }
    }
  });
});

describe('hostAllowed', () => {
  it('true if ANY pattern matches', () => {
    expect(hostAllowed('www.example.com', ['example.com', 'www.example.com'])).toBe(true);
    expect(hostAllowed('evil.com', ['example.com', '*.example.com'])).toBe(false);
  });
});

describe('assertDomainsAcceptable', () => {
  const reject = (msg: string): never => { throw new Error(msg); };
  it('accepts a normal host + normal wildcard', () => {
    expect(() => assertDomainsAcceptable(['example.com', '*.brand.com'], reject)).not.toThrow();
  });
  it('rejects a single-label base (*.com / bare tld)', () => {
    expect(() => assertDomainsAcceptable(['*.com'], reject)).toThrow(/too broad/);
  });
  it('rejects a shared public-hosting suffix', () => {
    expect(() => assertDomainsAcceptable(['myshopify.com'], reject)).toThrow(/shared public-hosting/);
    expect(() => assertDomainsAcceptable(['*.vercel.app'], reject)).toThrow(/shared public-hosting/);
  });
  it('A1: rejects a multi-label ccTLD REGISTRY suffix (co.uk etc.) — not just single-label', () => {
    expect(() => assertDomainsAcceptable(['co.uk'], reject)).toThrow(/shared public-hosting/);
    expect(() => assertDomainsAcceptable(['com.au'], reject)).toThrow(/shared public-hosting/);
    expect(() => assertDomainsAcceptable(['*.co.uk'], reject)).toThrow(/shared public-hosting/);
    // A www-input that normalizes to the bare registry suffix is also caught.
    expect(() => assertDomainsAcceptable(normalizeDomains(['www.co.uk']), reject)).toThrow(/shared public-hosting/);
  });
  it('still ACCEPTS a real site under a ccTLD (e.g. acme.co.uk)', () => {
    expect(() => assertDomainsAcceptable(normalizeDomains(['acme.co.uk']), reject)).not.toThrow();
  });
});
