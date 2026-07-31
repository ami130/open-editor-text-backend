/**
 * setup-env.ts — vitest global setup, runs BEFORE any test module (and thus
 * before source modules capture config at import time).
 *
 * Rate-limit config is read once at module load (throttle.config.ts). The e2e
 * suites legitimately fire many logins from the same loopback IP, which would
 * trip the strict `auth` bucket. We raise all buckets to a high ceiling here so
 * throttling never interferes with functional tests. The throttler GUARD stays
 * active (the real guard stack is exercised); a dedicated test
 * (throttle.e2e.test.ts) proves the limiting itself with its own low limits.
 */
process.env.THROTTLE_LIMIT ||= '100000';
process.env.THROTTLE_AUTH_LIMIT ||= '100000';
process.env.THROTTLE_CHECKOUT_LIMIT ||= '100000';
