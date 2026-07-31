/**
 * throttle.config.ts — rate-limit knobs (Phase G).
 *
 * Three named buckets: a broad `default` for everything, and tighter `auth`
 * (brute-force / token-spam) and `checkout` (Stripe-session + DB-row abuse)
 * buckets that specific routes opt into. All overridable by env so a deployment
 * can tune without a code change. TTLs are milliseconds (throttler v6).
 */
export interface ThrottleConfig {
  defaultTtlMs: number;
  defaultLimit: number;
  authTtlMs: number;
  authLimit: number;
  checkoutTtlMs: number;
  checkoutLimit: number;
  aiTtlMs: number;
  aiLimit: number;
}

export function loadThrottleConfig(env: NodeJS.ProcessEnv = process.env): ThrottleConfig {
  return {
    // Broad default: 100 requests / minute / IP.
    defaultTtlMs: intOr(env.THROTTLE_TTL_MS, 60_000),
    defaultLimit: intOr(env.THROTTLE_LIMIT, 100),
    // Auth: 10 / minute / IP — login + refresh are expensive + brute-forceable.
    authTtlMs: intOr(env.THROTTLE_AUTH_TTL_MS, 60_000),
    authLimit: intOr(env.THROTTLE_AUTH_LIMIT, 10),
    // Checkout: 15 / 10 minutes / IP — each creates a Stripe session + DB row.
    checkoutTtlMs: intOr(env.THROTTLE_CHECKOUT_TTL_MS, 600_000),
    checkoutLimit: intOr(env.THROTTLE_CHECKOUT_LIMIT, 15),
    // AI proxy: 20 / minute / IP — each call spends LLM tokens/quota. The proxy
    // is @Public (BYO-endpoint model), so this per-IP cap is the front-line cost
    // guard. NOT a substitute for putting your own auth in front when exposing
    // it publicly (see the open-proxy note in ai.controller.ts / DEPLOY.md).
    aiTtlMs: intOr(env.THROTTLE_AI_TTL_MS, 60_000),
    aiLimit: intOr(env.THROTTLE_AI_LIMIT, 20),
  };
}

function intOr(raw: string | undefined, dflt: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
