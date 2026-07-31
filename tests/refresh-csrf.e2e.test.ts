/**
 * refresh-csrf.e2e.test.ts — regression for H1 + L7.
 *
 * Boots with ADMIN_CORS_ORIGINS set (the production posture that exposed H1)
 * AND a BFF_SHARED_SECRET, then proves:
 *   • the trusted BFF (correct X-BFF-Secret) can refresh — even with NO Origin
 *     and even with an Origin that isn't in the allowlist (it's server-to-server);
 *   • a browser call from an ALLOWED origin can refresh;
 *   • a call with a MISMATCHED origin and no secret is rejected (403);
 *   • a call with NO origin and NO secret is rejected (403) — closes L7.
 *
 * Isolated file: envs must be set before AppModule import (config captured then).
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let app: import('@nestjs/common').INestApplication;
let base: string;
const PANEL_ORIGIN = 'https://admin.example.com';
const BFF_SECRET = 'bff-shared-secret-value-1234567890';

beforeAll(async () => {
  process.env.DB_ENABLED = 'true';
  process.env.DB_DRIVER ||= 'sqljs';
  process.env.AUTH_ACCESS_SECRET = 'csrf-access-secret-abcdefghij';
  process.env.AUTH_REFRESH_SECRET = 'csrf-refresh-secret-klmnopqrst';
  process.env.ADMIN_CORS_ORIGINS = PANEL_ORIGIN;
  process.env.BFF_SHARED_SECRET = BFF_SECRET;
  process.env.SEED_ADMIN_EMAIL = 'csrf@test.com';
  process.env.SEED_ADMIN_PASSWORD = 'csrf-pw-123456';
  const { generateKeyPair } = await import('../src/licensing/license-signer.service');
  const kp = generateKeyPair();
  process.env.LICENSE_PRIVATE_KEY = kp.privateKeyPem;
  process.env.LICENSE_KID = 'csrf-kid';

  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../src/app.module');
  const cookieParser = (await import('cookie-parser')).default;
  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot()] }).compile();
  app = mod.createNestApplication({ logger: false });
  app.use(cookieParser());
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

afterAll(async () => {
  await app?.close();
  delete process.env.DB_ENABLED;
  delete process.env.DB_DRIVER;
  delete process.env.ADMIN_CORS_ORIGINS;
  delete process.env.BFF_SHARED_SECRET;
});

async function loginCookie(): Promise<string> {
  const r = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BFF-Secret': BFF_SECRET },
    body: JSON.stringify({ email: 'csrf@test.com', password: 'csrf-pw-123456' }),
  });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

const refresh = (cookie: string, headers: Record<string, string>) =>
  fetch(`${base}/auth/refresh`, { method: 'POST', headers: { Cookie: cookie, ...headers } });

describe('refresh CSRF gate (H1 + L7) with ADMIN_CORS_ORIGINS + BFF secret set', () => {
  it('trusted BFF (correct secret, NO Origin) can refresh — the H1 regression', async () => {
    const cookie = await loginCookie();
    const r = await refresh(cookie, { 'X-BFF-Secret': BFF_SECRET });
    expect(r.status).toBe(201);
    expect((await r.json()).accessToken).toBeTruthy();
  });

  it('trusted BFF secret works even with a non-allowlisted Origin (server-to-server)', async () => {
    const cookie = await loginCookie();
    const r = await refresh(cookie, { 'X-BFF-Secret': BFF_SECRET, Origin: 'http://backend:8787' });
    expect(r.status).toBe(201);
  });

  it('browser call from an ALLOWED origin can refresh', async () => {
    const cookie = await loginCookie();
    const r = await refresh(cookie, { Origin: PANEL_ORIGIN });
    expect(r.status).toBe(201);
  });

  it('MISMATCHED origin + no secret → 403', async () => {
    const cookie = await loginCookie();
    const r = await refresh(cookie, { Origin: 'https://attacker.com' });
    expect(r.status).toBe(403);
  });

  it('NO origin + NO secret → 403 (L7 closed when a BFF secret is enforced)', async () => {
    const cookie = await loginCookie();
    const r = await refresh(cookie, {});
    expect(r.status).toBe(403);
  });

  it('WRONG secret → 403', async () => {
    const cookie = await loginCookie();
    const r = await refresh(cookie, { 'X-BFF-Secret': 'nope' });
    expect(r.status).toBe(403);
  });
});
