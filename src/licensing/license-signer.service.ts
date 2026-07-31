/**
 * license-signer.service.ts — the production license SIGNER.
 *
 * Signs ES256 (ECDSA P-256 + SHA-256) license JWS tokens in the SAME format as
 * @openeditors/entitlements, so the editor's existing offline verifier accepts
 * them unchanged. This is the server-side re-implementation the entitlements
 * dev-issuer explicitly anticipates ("the production license service
 * re-implements issuance server-side with KMS-held keys; same token format").
 *
 * Security: the private key comes from config (env secret). It is used only
 * here, in memory, at signing time — never returned, logged, or persisted.
 * The corresponding PUBLIC key is exposed (JWKS) so editors can verify offline.
 */
import { Injectable, Inject, ServiceUnavailableException } from '@nestjs/common';
import {
  generateKeyPairSync, createSign, createVerify, createPublicKey, randomUUID,
} from 'node:crypto';
import { LICENSE_CONFIG, LicenseConfig } from '../config/license.config';

/** The claims we read back off one of OUR OWN verified tokens (Phase 4 refresh). */
export interface VerifiedTokenClaims {
  lic: string;
  customer: string;
  features: string[];
  domains: string[];
  iat: number;
  exp: number;
  kid: string;
}

export interface LicensePayloadInput {
  features: string[];
  domains: string[];
  customer: string;
  plan?: string;
  limits?: Record<string, number>;
  ttlSeconds?: number;
  /** issued-at override (unix seconds); default now. */
  iat?: number;
  /**
   * License-id override. Default: a fresh collision-safe id. Refresh (Phase 4c)
   * passes the EXISTING `lic` so a re-minted token keeps the same identity —
   * the row's licId and the token's `lic` claim stay in lockstep across refreshes
   * (audit M3: prevents orphaning a handed-back token).
   */
  lic?: string;
}

export interface SignedLicense {
  token: string;
  lic: string;
  iat: number;
  exp: number;
  kid: string;
}

@Injectable()
export class LicenseSignerService {
  constructor(@Inject(LICENSE_CONFIG) private readonly cfg: LicenseConfig) {}

  /** Whether minting is available (a private key is configured). */
  get enabled(): boolean { return this.cfg.enabled; }
  get kid(): string { return this.cfg.kid; }

  /**
   * Sign a license token. Throws 503 if no key is configured. Clamps the TTL to
   * the safe ceiling so we never mint a token the verifier would reject for an
   * over-long lifetime.
   */
  sign(input: LicensePayloadInput): SignedLicense {
    if (!this.cfg.enabled) {
      throw new ServiceUnavailableException('License signing key is not configured on the server.');
    }
    const iat = typeof input.iat === 'number' ? input.iat : Math.floor(Date.now() / 1000);
    const ttl = Math.min(input.ttlSeconds || this.cfg.defaultTtlSeconds, this.cfg.maxTtlSeconds);
    const exp = iat + ttl;
    // License id: caller-preserved on a refresh re-mint (input.lic), else a fresh
    // collision-safe id (128-bit UUID). Was Math.random() with only 32 bits —
    // collisions on the DB unique index would fail a valid mint.
    const lic = input.lic || `oe-${iat}-${randomUUID()}`;

    const header = { alg: 'ES256', kid: this.cfg.kid, typ: 'JWT' };
    const payload = {
      lic,
      customer: input.customer,
      plan: input.plan || 'custom',
      features: input.features,
      domains: input.domains,
      limits: input.limits || {},
      iat,
      exp,
    };

    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    // Node ECDSA emits DER; JWS/WebCrypto want raw r||s (P1363, 64 bytes).
    const der = createSign('SHA256').update(signingInput).end().sign(this.cfg.privateKeyPem);
    const sig = derToP1363(der, 32);
    const token = `${signingInput}.${b64url(sig)}`;
    return { token, lic, iat, exp, kid: this.cfg.kid };
  }

  /**
   * The public JWK for the CURRENT signing key (kid/alg/use set). Derived from
   * the private key; exposes NOTHING secret (Node's public JWK export never
   * includes the private scalar `d`).
   */
  publicJwk(): Record<string, unknown> {
    if (!this.cfg.enabled) {
      throw new ServiceUnavailableException('License signing key is not configured on the server.');
    }
    const jwk = createPublicKey(this.cfg.privateKeyPem).export({ format: 'jwk' }) as Record<string, unknown>;
    return { ...jwk, kid: this.cfg.kid, alg: 'ES256', use: 'sig' };
  }

  /**
   * ALL public keys for the JWKS endpoint: the current signing key PLUS every
   * retired key. This is what makes rotation safe — licenses signed by an old
   * key still verify because their `kid`'s public key is still published. On
   * rotation you move the old PUBLIC pem into LICENSE_RETIRED_KEYS and set a new
   * private key + kid.
   */
  publicJwks(): Array<Record<string, unknown>> {
    if (!this.cfg.enabled) {
      throw new ServiceUnavailableException('License signing key is not configured on the server.');
    }
    const keys = [this.publicJwk()];
    for (const rk of this.cfg.retiredPublicKeys) {
      try {
        const jwk = createPublicKey(rk.publicKeyPem).export({ format: 'jwk' }) as Record<string, unknown>;
        keys.push({ ...jwk, kid: rk.kid, alg: 'ES256', use: 'sig' });
      } catch {
        // a malformed retired key must not break the whole JWKS — skip it.
      }
    }
    return keys;
  }

  /**
   * Verify one of OUR OWN tokens server-side (Phase 4 refresh) and return its
   * claims, or null if it isn't a valid, well-formed, correctly-SIGNED token we
   * issued. This is the server twin of the editor's offline verifier: it pins
   * ES256, checks the signature against the CURRENT public key (matched by the
   * header `kid`; retired keys don't sign new tokens so we verify against the
   * live key only), and does NOT enforce `exp` — the refresh flow decides what
   * to do with an expired-but-authentic token. Never throws.
   */
  verifyOwnToken(token: string): VerifiedTokenClaims | null {
    if (!this.cfg.enabled) return null;
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    let header: { alg?: string; kid?: string };
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    // Pin the algorithm; resolve the key by the token's kid — current OR retired
    // (H1: a pre-rotation token must still refresh, as it still verifies in the
    // editor via the published JWKS).
    if (header.alg !== 'ES256' || !header.kid) return null;
    const pem = this.pemForKid(header.kid);
    if (!pem) return null; // unknown / never-ours kid

    let der: Buffer;
    try {
      der = p1363ToDer(Buffer.from(s, 'base64url'));
    } catch {
      return null;
    }
    let ok = false;
    try {
      ok = createVerify('SHA256').update(`${h}.${p}`).end().verify(createPublicKey(pem), der);
    } catch {
      return null; // a malformed retired PEM must not throw
    }
    if (!ok) return null;

    // Shape-check the claims we rely on.
    const lic = typeof payload.lic === 'string' ? payload.lic : '';
    const customer = typeof payload.customer === 'string' ? payload.customer : '';
    const features = Array.isArray(payload.features) ? (payload.features as string[]) : [];
    const domains = Array.isArray(payload.domains) ? (payload.domains as string[]) : [];
    const iat = typeof payload.iat === 'number' ? payload.iat : 0;
    const exp = typeof payload.exp === 'number' ? payload.exp : 0;
    if (!lic || !exp) return null;
    return { lic, customer, features, domains, iat, exp, kid: header.kid };
  }

  /**
   * The PEM whose PUBLIC half verifies a token signed under `kid` — the current
   * signing key, or any retired key still published in the JWKS. Returns null for
   * an unknown kid. Enables refresh to accept pre-rotation tokens (H1).
   */
  private pemForKid(kid: string): string | null {
    if (kid === this.cfg.kid) return this.cfg.privateKeyPem; // public half derived by createPublicKey
    const retired = this.cfg.retiredPublicKeys.find((r) => r.kid === kid);
    return retired ? retired.publicKeyPem : null;
  }
}

// (verifyOwnToken lives on the service — see below.)

/** Generate a fresh P-256 keypair (for the seed/bootstrap CLI). Not a service dep. */
export function generateKeyPair(): { privateKeyPem: string; publicKeyPem: string; publicJwk: Record<string, unknown> } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    publicJwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
  };
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Fixed-length r||s (P1363, JWS/WebCrypto) → DER ECDSA (what Node's verify wants).
 *  Inverse of derToP1363; used by verifyOwnToken. */
function p1363ToDer(sig: Buffer): Buffer {
  if (sig.length % 2 !== 0) throw new Error('bad P1363 signature length');
  const size = sig.length / 2;
  const encodeInt = (raw: Buffer): Buffer => {
    // strip leading zeros
    let start = 0;
    while (start < raw.length - 1 && raw[start] === 0x00) start += 1;
    let bytes = raw.subarray(start);
    // if high bit set, prepend 0x00 so it's a positive INTEGER
    if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const r = encodeInt(sig.subarray(0, size));
  const s = encodeInt(sig.subarray(size));
  const body = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/** DER ECDSA signature → fixed-length r||s (P1363). Mirrors the entitlements issuer. */
function derToP1363(der: Buffer, size: number): Buffer {
  let offset = 2; // skip SEQUENCE tag + length
  if (der[1] & 0x80) offset += der[1] & 0x7f; // long-form length
  const read = (): Buffer => {
    if (der[offset++] !== 0x02) throw new Error('bad DER integer');
    const len = der[offset++];
    const start = offset;
    offset += len;
    let bytes = der.subarray(start, offset);
    while (bytes.length > size && bytes[0] === 0x00) bytes = bytes.subarray(1);
    const out = Buffer.alloc(size);
    bytes.copy(out, size - bytes.length);
    return out;
  };
  return Buffer.concat([read(), read()]);
}
