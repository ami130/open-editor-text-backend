/**
 * throttle.e2e.test.ts — proves the rate limiter actually bites. Uses a LOW
 * auth limit set BEFORE the app modules are imported (config is captured at
 * import time), then hammers /auth/login past the limit and asserts 429. Also
 * confirms the Stripe webhook is EXEMPT from throttling.
 *
 * Isolated in its own file so its low limits don't affect the other suites
 * (which run with the generous ceilings from setup-env.ts).
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let app: import('@nestjs/common').INestApplication;
let base: string;

beforeAll(async () => {
  // Low limits — MUST be set before importing AppModule (throttle.config.ts
  // reads them at module load). Override the generous ceilings from setup-env.
  process.env.THROTTLE_AUTH_LIMIT = '3';
  process.env.THROTTLE_AUTH_TTL_MS = '60000';
  process.env.THROTTLE_LIMIT = '1000';
  process.env.DB_ENABLED = 'true';
  process.env.DB_DRIVER ||= 'sqljs';
  process.env.AUTH_ACCESS_SECRET = 'thr-access';
  process.env.AUTH_REFRESH_SECRET = 'thr-refresh';
  process.env.SEED_ADMIN_EMAIL = 'thr@test.com';
  process.env.SEED_ADMIN_PASSWORD = 'thr-pw-12345';
  const { generateKeyPair } = await import('../src/licensing/license-signer.service');
  const kp = generateKeyPair();
  process.env.LICENSE_PRIVATE_KEY = kp.privateKeyPem;
  process.env.LICENSE_KID = 'thr-kid';
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';

  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../src/app.module');
  const cookieParser = (await import('cookie-parser')).default;
  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot()] }).compile();
  app = mod.createNestApplication({ logger: false, rawBody: true });
  app.use(cookieParser());
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

afterAll(async () => {
  await app?.close();
  delete process.env.DB_ENABLED;
  delete process.env.DB_DRIVER;
  delete process.env.THROTTLE_AUTH_LIMIT;
  delete process.env.THROTTLE_AUTH_TTL_MS;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('rate limiting (Phase G)', () => {
  it('login is limited: after the auth limit is exceeded, further attempts get 429', async () => {
    // Wrong password (401) still counts against the limit. Fire well past 3.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await post('/auth/login', { email: 'thr@test.com', password: 'wrong' });
      statuses.push(r.status);
    }
    // First few are 401 (bad creds), then the limiter kicks in with 429.
    expect(statuses).toContain(429);
    // And it's the LATER attempts that are blocked, not the first.
    expect(statuses[0]).not.toBe(429);
  });

  it('the Stripe webhook is EXEMPT from rate limiting (Stripe retries must not be dropped)', async () => {
    // Fire many unsigned webhook calls; they fail signature (400), never 429.
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await post('/billing/webhook', { id: 'evt', type: 'x' }, { 'stripe-signature': 'nope' });
      statuses.push(r.status);
    }
    expect(statuses.every((s) => s !== 429)).toBe(true);
    expect(statuses.every((s) => s === 400)).toBe(true); // bad signature, not rate-limited
  });
});
