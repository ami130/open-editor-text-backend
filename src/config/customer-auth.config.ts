/**
 * customer-auth.config.ts — config for the CUSTOMER self-serve portal auth
 * (magic-link + short-lived session). Deliberately SEPARATE from the admin
 * `auth.config.ts`:
 *   • Its own secrets, so a customer session token can never be forged into an
 *     admin token (or vice-versa) even if one secret leaks.
 *   • A magic-link is a short-lived, single-use JWT emailed to the customer; the
 *     session is a short-lived httpOnly cookie JWT. No passwords — customers were
 *     created implicitly at checkout and never had one.
 *
 * The tokens also carry a `type` ('magic' | 'customer') that the customer guard
 * pins, so a magic-link token is never accepted as a session and vice-versa.
 */

export interface CustomerAuthConfig {
  /** Secret for the emailed single-use magic-link token. */
  magicSecret: string;
  /** Secret for the customer session token (cookie). Distinct from magicSecret. */
  sessionSecret: string;
  /** Magic-link TTL (short — it's a one-time login link). */
  magicTtl: string;   // e.g. '15m'
  /** Customer session TTL (short — portal is low-frequency). */
  sessionTtl: string; // e.g. '30m'
  /** httpOnly cookie name for the customer session. */
  sessionCookieName: string;
  /** Secure cookie flag — true in production (HTTPS). */
  cookieSecure: boolean;
  cookieSameSite: 'lax' | 'strict' | 'none';
  /** Public base URL used to build the magic-link the customer clicks. */
  portalBaseUrl: string;
  isProduction: boolean;
}

export const CUSTOMER_AUTH_CONFIG = 'CUSTOMER_AUTH_CONFIG';

const DEV_MAGIC_SECRET = 'dev-customer-magic-secret-change-me';
const DEV_SESSION_SECRET = 'dev-customer-session-secret-change-me';

export function loadCustomerAuthConfig(env: NodeJS.ProcessEnv = process.env): CustomerAuthConfig {
  const isProduction = (env.NODE_ENV || 'development') === 'production';
  const magicSecret = (env.CUSTOMER_MAGIC_SECRET || '').trim() || DEV_MAGIC_SECRET;
  const sessionSecret = (env.CUSTOMER_SESSION_SECRET || '').trim() || DEV_SESSION_SECRET;

  if (isProduction) {
    if (magicSecret === DEV_MAGIC_SECRET || sessionSecret === DEV_SESSION_SECRET) {
      throw new Error('CUSTOMER_MAGIC_SECRET and CUSTOMER_SESSION_SECRET must be set in production.');
    }
    if (magicSecret === sessionSecret) {
      throw new Error('CUSTOMER_MAGIC_SECRET and CUSTOMER_SESSION_SECRET must be different.');
    }
    for (const [name, val] of [
      ['CUSTOMER_MAGIC_SECRET', magicSecret],
      ['CUSTOMER_SESSION_SECRET', sessionSecret],
    ] as const) {
      if (val.length < 24) throw new Error(`${name} must be at least 24 chars in production.`);
      if (/change[-_ ]?me|placeholder|example|secret-here|your-secret/i.test(val)) {
        throw new Error(`${name} looks like a placeholder — set a real random secret in production.`);
      }
    }
  }

  return {
    magicSecret,
    sessionSecret,
    magicTtl: (env.CUSTOMER_MAGIC_TTL || '15m').trim(),
    sessionTtl: (env.CUSTOMER_SESSION_TTL || '30m').trim(),
    sessionCookieName: (env.CUSTOMER_SESSION_COOKIE || 'oe_customer').trim(),
    cookieSecure: String(env.CUSTOMER_COOKIE_SECURE || (isProduction ? 'true' : 'false')).toLowerCase() === 'true',
    cookieSameSite: parseSameSite(env.CUSTOMER_COOKIE_SAMESITE, isProduction ? 'strict' : 'lax'),
    portalBaseUrl: (env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000').trim().replace(/\/+$/, ''),
    isProduction,
  };
}

function parseSameSite(raw: string | undefined, dflt: 'lax' | 'strict' | 'none'): 'lax' | 'strict' | 'none' {
  const v = String(raw || '').toLowerCase();
  return v === 'lax' || v === 'strict' || v === 'none' ? v : dflt;
}
