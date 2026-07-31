/**
 * license.config.ts — configuration for the license SIGNING key + token policy.
 *
 * SECURITY — THIS IS THE MOST SENSITIVE CONFIG IN THE SYSTEM.
 * The ES256 private key signs every license. Anyone holding it can mint
 * unlimited free licenses for every feature. Therefore:
 *   • It is read ONLY from the environment (LICENSE_PRIVATE_KEY / a PEM), never
 *     committed, never stored in the DB, never returned by any endpoint, never
 *     logged.
 *   • Only LicenseSignerService ever reads it, in memory, at signing time.
 *   • It carries a `kid` (key id) so keys can be ROTATED: publish a new key,
 *     keep old PUBLIC keys in the JWKS so licenses already sold still verify.
 *
 * The token FORMAT matches @openeditors/entitlements exactly (ES256 JWS, same
 * header/payload) so the editor's existing offline verifier accepts our
 * licenses unchanged.
 */

export interface LicenseConfig {
  /** True when a private key is configured (minting available). */
  enabled: boolean;
  /** PKCS8 PEM (P-256). Server-only secret. */
  privateKeyPem: string;
  /** Key id in the JWS header; must match a public key in the editor's keyring. */
  kid: string;
  /**
   * Default signed-token lifetime (seconds). The editor's verifier caps total
   * lifetime at ~3 years + 30 days, so a "perpetual" license is modelled as a
   * long-lived token that is RE-MINTED on renewal — never an infinite exp.
   */
  defaultTtlSeconds: number;
  /** Hard ceiling we never exceed when signing (stays under the verifier cap). */
  maxTtlSeconds: number;
  /** Optional plan label baked into tokens (informational). */
  issuer: string;
  /**
   * RETIRED public keys kept in the JWKS so licenses signed by a PREVIOUS key
   * still verify after rotation (each `{ kid, publicKeyPem }`). Rotation flow:
   * move the old key's PUBLIC pem here, set a new LICENSE_PRIVATE_KEY + KID.
   * New licenses use the new key; old ones keep verifying against these.
   */
  retiredPublicKeys: Array<{ kid: string; publicKeyPem: string }>;
}

export const LICENSE_CONFIG = 'LICENSE_CONFIG';

// The editor's verifier rejects exp-iat > ~3y+30d. Stay safely under it.
const VERIFIER_MAX_LIFETIME = 3 * 366 * 24 * 3600 + 30 * 24 * 3600;
// Exported so the duration policy (a "lifetime" license = a token at this
// ceiling, re-minted on renewal) references the SAME value the signer clamps to,
// instead of duplicating the magic number. The runtime clamp still lives on the
// injected config (`cfg.maxTtlSeconds`); this const is the compile-time twin.
export const SAFE_MAX_TTL = VERIFIER_MAX_LIFETIME - 24 * 3600; // 1-day margin

// Default signed-token lifetime: 30 days (NOT a year). Short TTL + renewal is
// what makes offline revocation meaningful — a revoked license stops working
// within the TTL window instead of up to a year later. Renewal re-mints
// automatically for licenses still in good standing.
export const DEFAULT_TTL_SECONDS = 30 * 24 * 3600;

/** Read + normalize license config from env. Pure; makes no crypto calls. */
export function loadLicenseConfig(env: NodeJS.ProcessEnv = process.env): LicenseConfig {
  const isProduction = (env.NODE_ENV || 'development') === 'production';
  const privateKeyPem = unescapePem(env.LICENSE_PRIVATE_KEY || '');
  const kid = (env.LICENSE_KID || 'oe-key-1').trim();
  const defaultTtl = clampInt(env.LICENSE_DEFAULT_TTL_SECONDS, DEFAULT_TTL_SECONDS, 3600, SAFE_MAX_TTL);

  // (audit #2) Production MUST fail LOUD on a missing/placeholder signing key —
  // mirrors the auth/customer-auth prod guards. Without this, a prod deploy with
  // LICENSE_PRIVATE_KEY unset boots fine but every mint/JWKS/refresh silently 503s
  // (a hidden money-path outage). In dev, an absent key just leaves the signer
  // disabled (enabled:false) — the intended local default, never insecure.
  if (isProduction) {
    const trimmed = privateKeyPem.trim();
    if (trimmed.length === 0) {
      throw new Error('LICENSE_PRIVATE_KEY must be set in production (license signing is disabled without it).');
    }
    if (!/-----BEGIN (?:EC )?PRIVATE KEY-----/.test(trimmed)) {
      throw new Error('LICENSE_PRIVATE_KEY must be a PEM private key (PKCS8/EC) in production.');
    }
    if (/change[-_ ]?me|placeholder|example|your-key|key-here/i.test(trimmed)) {
      throw new Error('LICENSE_PRIVATE_KEY looks like a placeholder — set the real signing key in production.');
    }
  }

  return {
    enabled: privateKeyPem.trim().length > 0,
    privateKeyPem,
    kid,
    defaultTtlSeconds: defaultTtl,
    maxTtlSeconds: SAFE_MAX_TTL,
    issuer: (env.LICENSE_ISSUER || 'open-editor').trim(),
    retiredPublicKeys: parseRetiredKeys(env.LICENSE_RETIRED_KEYS),
  };
}

/** Un-escape a PEM that may arrive with literal `\n` sequences (env single-line). */
function unescapePem(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

/**
 * Parse retired keys from env. Format: JSON array of { kid, publicKeyPem }
 * (publicKeyPem may be \n-escaped). Invalid/empty → []. Never throws.
 */
function parseRetiredKeys(raw: string | undefined): Array<{ kid: string; publicKeyPem: string }> {
  if (!raw || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((k) => k && typeof k.kid === 'string' && typeof k.publicKeyPem === 'string')
      .map((k) => ({ kid: k.kid.trim(), publicKeyPem: unescapePem(k.publicKeyPem) }));
  } catch {
    return [];
  }
}

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
