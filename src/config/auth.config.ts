/**
 * auth.config.ts — admin authentication config (JWT + refresh cookie + bcrypt).
 *
 * SECURITY MODEL:
 *   • Access token: short-lived JWT (default 15m), sent as `Authorization:
 *     Bearer`. Short life = small blast radius if leaked.
 *   • Refresh token: longer-lived JWT delivered in an httpOnly, Secure,
 *     SameSite cookie the browser JS cannot read (XSS-safe); used only to mint
 *     new access tokens, and ROTATED on each use.
 *   • Secrets come from env; separate secrets for access vs refresh so one
 *     can't forge the other. In production these MUST be set (the app refuses
 *     to issue tokens with the insecure dev fallback when NODE_ENV=production).
 *   • Passwords hashed with bcrypt (cost from env).
 */

export interface AuthConfig {
  accessSecret: string;
  refreshSecret: string;
  accessTtl: string;        // e.g. '15m' (jsonwebtoken duration string)
  refreshTtl: string;       // e.g. '7d'
  bcryptRounds: number;
  /** Secure cookie flag — true in production (HTTPS); false for local http dev. */
  cookieSecure: boolean;
  /** SameSite policy for the refresh cookie. */
  cookieSameSite: 'lax' | 'strict' | 'none';
  /** Cookie name for the refresh token. */
  refreshCookieName: string;
  /** Browser origins allowed to call the ADMIN/auth API (CORS + CSRF origin check). */
  adminOrigins: string[];
  /**
   * Shared secret proving a request came from the trusted BFF (the Next server),
   * not a browser. The BFF sends it on /auth/refresh (a server-to-server call
   * the browser never makes directly). Lets the Origin/CSRF check pass for the
   * legitimate proxy WITHOUT trusting a spoofable Origin header. Optional in dev.
   */
  bffSecret: string;
  /** True when running in production (enables strict secret enforcement). */
  isProduction: boolean;
}

export const AUTH_CONFIG = 'AUTH_CONFIG';

// Obvious insecure fallbacks for local dev ONLY. In production the loader
// throws if the real secrets are missing, so these can never ship live.
const DEV_ACCESS_SECRET = 'dev-access-secret-change-me';
const DEV_REFRESH_SECRET = 'dev-refresh-secret-change-me';

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const isProduction = (env.NODE_ENV || 'development') === 'production';
  const accessSecret = (env.AUTH_ACCESS_SECRET || '').trim() || DEV_ACCESS_SECRET;
  const refreshSecret = (env.AUTH_REFRESH_SECRET || '').trim() || DEV_REFRESH_SECRET;

  if (isProduction) {
    if (accessSecret === DEV_ACCESS_SECRET || refreshSecret === DEV_REFRESH_SECRET) {
      throw new Error('AUTH_ACCESS_SECRET and AUTH_REFRESH_SECRET must be set in production.');
    }
    if (accessSecret === refreshSecret) {
      throw new Error('AUTH_ACCESS_SECRET and AUTH_REFRESH_SECRET must be different.');
    }
    // (M4) The dev-string check above only catches the two literal fallbacks.
    // Reject ANY obviously-placeholder or too-weak secret so an operator who
    // copies .env.prod.example and fills only the blanks can't ship a guessable
    // JWT secret and still pass boot. Applies to both JWT secrets + the BFF one.
    for (const [name, val] of [
      ['AUTH_ACCESS_SECRET', accessSecret],
      ['AUTH_REFRESH_SECRET', refreshSecret],
    ] as const) {
      if (val.length < 24) throw new Error(`${name} must be at least 24 chars in production.`);
      if (/change[-_ ]?me|placeholder|example|secret-here|your-secret/i.test(val)) {
        throw new Error(`${name} looks like a placeholder — set a real random secret in production.`);
      }
    }
  }

  return {
    accessSecret,
    refreshSecret,
    accessTtl: (env.AUTH_ACCESS_TTL || '15m').trim(),
    refreshTtl: (env.AUTH_REFRESH_TTL || '7d').trim(),
    bcryptRounds: clampInt(env.AUTH_BCRYPT_ROUNDS, 12, 10, 15),
    cookieSecure: String(env.AUTH_COOKIE_SECURE || (isProduction ? 'true' : 'false')).toLowerCase() === 'true',
    cookieSameSite: parseSameSite(env.AUTH_COOKIE_SAMESITE, isProduction ? 'strict' : 'lax'),
    refreshCookieName: (env.AUTH_REFRESH_COOKIE || 'oe_refresh').trim(),
    adminOrigins: (env.ADMIN_CORS_ORIGINS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    bffSecret: (env.BFF_SHARED_SECRET || '').trim(),
    isProduction,
  };
}

function parseSameSite(raw: string | undefined, dflt: 'lax' | 'strict' | 'none'): 'lax' | 'strict' | 'none' {
  const v = String(raw || '').toLowerCase();
  return v === 'lax' || v === 'strict' || v === 'none' ? v : dflt;
}

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
