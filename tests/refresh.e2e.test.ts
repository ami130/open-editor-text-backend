/**
 * refresh.e2e.test.ts — Phase 4c: the public silent-refresh endpoint + its
 * threat model. Proves the SECURITY properties, not just the happy path:
 *   • a valid near-expiry token refreshes → a NEW token that the REAL editor
 *     verifier accepts, for the same license (in place).
 *   • UNIFORM responses: garbage token, unknown lic, and a REVOKED license all
 *     return the identical generic { refreshed:false } — no oracle.
 *   • delivery-time revocation: a revoked license never refreshes.
 *   • Origin/domain match: wrong Origin on a domain-bound license is refused.
 *   • per-KEY rate limit: repeated refreshes of the same key eventually refuse.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EmailService } from '../src/billing/email.service';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { LicenseService } from '../src/licensing/license.service';
import { RefreshService } from '../src/portal/refresh.service';
import { RefreshLogService } from '../src/portal/refresh-log.service';
import { LicenseSignerService } from '../src/licensing/license-signer.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CustomerEntity } from '../src/licensing/entities/customer.entity';
import { LicenseEntity } from '../src/licensing/entities/license.entity';
import { RefreshEventEntity } from '../src/portal/entities/refresh-event.entity';
import type { Repository } from 'typeorm';

// @ts-expect-error — JS module (dev/test import into the sibling monorepo)
import { verifyLicense, importEs256PublicKey } from '../../open-editor/packages/entitlements/src/index.js';

let app: INestApplication;
let base: string;
let keyring: Array<{ kid: string; alg: string; key: unknown }>;
let licenses: Repository<LicenseEntity>;
let licenseSvc: LicenseService;
let customerId: string;

beforeAll(async () => {
  process.env.DB_ENABLED = 'true';
  process.env.DB_DRIVER ||= 'sqljs';
  const { generateKeyPair } = await import('../src/licensing/license-signer.service');
  const kp = generateKeyPair();
  process.env.LICENSE_PRIVATE_KEY = kp.privateKeyPem;
  process.env.LICENSE_KID = 'oe-refresh-test';
  process.env.AUTH_ACCESS_SECRET = 'test-access-secret';
  process.env.AUTH_REFRESH_SECRET = 'test-refresh-secret';
  process.env.CUSTOMER_MAGIC_SECRET = 'test-customer-magic-secret';
  process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret';
  process.env.SEED_ADMIN_EMAIL = 'admin@refresh.test';
  process.env.SEED_ADMIN_PASSWORD = 'sup3r-secret-pw';
  // Loosen per-IP throttle so the rate-limit test can exercise the per-KEY limit.
  process.env.THROTTLE_AUTH_LIMIT = '1000';

  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot()] }).compile();
  app = mod.createNestApplication({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  const signer = app.get(LicenseSignerService);
  keyring = [{ kid: 'oe-refresh-test', alg: 'ES256', key: await importEs256PublicKey(signer.publicJwk()) }];

  licenses = app.get<Repository<LicenseEntity>>(getRepositoryToken(LicenseEntity));
  licenseSvc = app.get(LicenseService);
  const customers = app.get<Repository<CustomerEntity>>(getRepositoryToken(CustomerEntity));
  const c = await customers.save(customers.create({ name: 'Ada', email: 'ada@buyer.com', domains: ['ada.com'] }));
  customerId = c.id;
});

afterAll(async () => {
  await app?.close();
  delete process.env.DB_ENABLED; delete process.env.DB_DRIVER; delete process.env.THROTTLE_AUTH_LIMIT;
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

/** Mint a license for the test customer and return its token + row. */
async function mintLicense(domains: string[] = ['ada.com']) {
  const lic = await licenseSvc.issueFromSnapshot({
    customerId, features: ['export.pdf'], domains, planName: 'Pro', domainBound: domains.length > 0,
  });
  return lic;
}

describe('Phase 4c — public refresh endpoint', () => {
  it('refreshes a valid token → a NEW token the real editor verifier accepts, in place (same row)', async () => {
    const lic = await mintLicense();
    const oldToken = lic.token;
    const oldId = lic.id;

    const r = await post('/portal/refresh', { token: oldToken }, { Origin: 'https://ada.com' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.refreshed).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.token).not.toBe(oldToken);        // genuinely fresh

    // The new token verifies for the bound domain.
    const v = await verifyLicense(body.token, { keyring, hostname: 'ada.com' });
    expect(v.valid).toBe(true);

    // Re-minted IN PLACE: the SAME license row now holds the new token.
    const row = await licenses.findOne({ where: { id: oldId } });
    expect(row!.token).toBe(body.token);
    // licId PRESERVED (M3 fix): the row identity is stable across refresh, so a
    // handed-back token always resolves next time — no orphaning under a race.
    expect(row!.licId).toBe(lic.licId);
  });

  it('C1: refuses to refresh once the paid TERM has ended (renewUntil passed), uniformly', async () => {
    const svc = app.get(RefreshService);
    const lic = await mintLicense(); // once-term → renewUntil = iat + 30d
    const row = await licenses.findOne({ where: { id: lic.id } });
    // Drive time to JUST AFTER the term boundary and refresh at the service level.
    const afterTerm = row!.renewUntil + 1;
    const res = await svc.refresh(lic.token, 'https://ada.com', afterTerm);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('term-ended');
    // And BEFORE the boundary it still refreshes (control).
    const before = await svc.refresh(lic.token, 'https://ada.com', row!.issuedAt + 10);
    expect(before.ok).toBe(true);
  });

  it('#3: a refresh near the term boundary mints a token whose exp does NOT outlive renewUntil', async () => {
    const svc = app.get(RefreshService);
    const lic = await mintLicense(); // once-term (30d)
    const row = await licenses.findOne({ where: { id: lic.id } });
    // Refresh 1 second before the term ends — the 30d TTL would push exp ~30d PAST
    // renewUntil without the clamp (audit #3). The clamp must cap exp at renewUntil.
    const nearBoundary = row!.renewUntil - 1;
    const res = await svc.refresh(lic.token, 'https://ada.com', nearBoundary);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // exp is CLAMPED to the paid term — without the clamp it would be ~30d past.
      expect(res.expiresAt).toBeLessThanOrEqual(row!.renewUntil);
      // still valid at the refresh instant (iat=nearBoundary, ttl>=1 → exp>nearBoundary).
      expect(res.expiresAt).toBeGreaterThan(nearBoundary);
    }
    // renewUntil itself is unchanged (term never extended by refresh).
    const after = await licenses.findOne({ where: { id: lic.id } });
    expect(after!.renewUntil).toBe(row!.renewUntil);
  });

  it('C1: a fresh license stamps renewUntil = issuedAt + term (not perpetual)', async () => {
    const lic = await mintLicense();
    const row = await licenses.findOne({ where: { id: lic.id } });
    expect(row!.renewUntil).toBe(row!.issuedAt + 30 * 24 * 3600); // once/default term
    expect(row!.renewUntil).toBeGreaterThan(0);
  });

  it('B2: a near-expiry refresh sends the expiry reminder EXACTLY ONCE, then never again this term', async () => {
    const svc = app.get(RefreshService);
    const email = app.get(EmailService);
    const spy = vi.spyOn(email, 'sendExpiryReminderEmail').mockResolvedValue(true);
    try {
      const lic = await mintLicense(); // finite (once/30d) term, customer has an email
      const row = await licenses.findOne({ where: { id: lic.id } });
      // 3 days before the boundary → inside the 7-day reminder window.
      const nearExpiry = row!.renewUntil - 3 * 24 * 3600;

      const res1 = await svc.refresh(lic.token, 'https://ada.com', nearExpiry);
      expect(res1.ok).toBe(true);
      // Fire-and-forget send is dispatched after commit — allow the microtask to run.
      await new Promise((r) => setTimeout(r, 20));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ to: 'ada@buyer.com', daysLeft: 3 });
      // reminderSentAt was marked in-txn (idempotency).
      const afterFirst = await licenses.findOne({ where: { id: lic.id } });
      expect(afterFirst!.reminderSentAt).toBeGreaterThan(0);

      // A SECOND near-expiry refresh must NOT re-send (once per term).
      const res2 = await svc.refresh(afterFirst!.token, 'https://ada.com', nearExpiry + 60);
      expect(res2.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(spy).toHaveBeenCalledTimes(1); // still exactly one
    } finally {
      spy.mockRestore();
    }
  });

  it('B2: a refresh FAR from expiry does NOT send a reminder (outside the window)', async () => {
    const svc = app.get(RefreshService);
    const email = app.get(EmailService);
    const spy = vi.spyOn(email, 'sendExpiryReminderEmail').mockResolvedValue(true);
    try {
      const lic = await mintLicense();
      const row = await licenses.findOne({ where: { id: lic.id } });
      // 20 days before a 30-day boundary → well outside the 7-day window.
      const farFromExpiry = row!.renewUntil - 20 * 24 * 3600;
      const res = await svc.refresh(lic.token, 'https://ada.com', farFromExpiry);
      expect(res.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('UNIFORM: a garbage token returns the generic { refreshed:false } (no oracle)', async () => {
    const r = await post('/portal/refresh', { token: 'not-a-real-token.aaa.bbb' }, { Origin: 'https://ada.com' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ refreshed: false });
  });

  it('UNIFORM: a REVOKED license returns the identical generic response (delivery-time revocation)', async () => {
    const lic = await mintLicense();
    lic.status = 'revoked';
    await licenses.save(lic);
    const r = await post('/portal/refresh', { token: lic.token }, { Origin: 'https://ada.com' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ refreshed: false }); // same shape as garbage
  });

  it('ORIGIN: a domain-bound license refuses a mismatched Origin', async () => {
    const lic = await mintLicense(['ada.com']);
    const r = await post('/portal/refresh', { token: lic.token }, { Origin: 'https://evil.example' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ refreshed: false });
  });

  it('ORIGIN: the matching Origin still succeeds (control for the test above)', async () => {
    const lic = await mintLicense(['ada.com']);
    const r = await post('/portal/refresh', { token: lic.token }, { Origin: 'https://ada.com' });
    expect((await r.json()).refreshed).toBe(true);
  });

  it('F1: a domain-bound license with NO Origin header SUCCEEDS (defense-in-depth, not a hard gate)', async () => {
    // The editor refresh client can't set Origin (browser-forbidden header); a
    // real browser attaches it, but a non-browser host (SSR/webview) sends none.
    // A MISSING Origin must NOT block a valid, in-term, unrevoked license — only a
    // PRESENT-but-WRONG Origin does (the test above). Term/revocation/rate-limit
    // are the real gates.
    const lic = await mintLicense(['ada.com']);
    const r = await post('/portal/refresh', { token: lic.token }); // no Origin header
    expect(r.status).toBe(200);
    expect((await r.json()).refreshed).toBe(true);
  });

  it('PER-KEY RATE LIMIT: repeated refreshes of the SAME key eventually refuse', async () => {
    const lic = await mintLicense();
    let refusedAfter = -1;
    // The per-key limit defaults to 5/hour. Each success re-mints (new token),
    // but the limiter is keyed by the license row's rolling licId; drive it via
    // the freshly-returned token each time to keep presenting a valid key.
    let token = lic.token;
    for (let i = 0; i < 8; i += 1) {
      const r = await post('/portal/refresh', { token }, { Origin: 'https://ada.com' });
      const body = await r.json();
      if (!body.refreshed) { refusedAfter = i; break; }
      token = body.token;
    }
    expect(refusedAfter).toBeGreaterThan(0);   // it DID start refusing
    expect(refusedAfter).toBeLessThanOrEqual(6); // at/under the ~5 limit (+margin)
  });

  it('a missing/empty token is rejected by DTO validation (400)', async () => {
    const r = await post('/portal/refresh', {});
    expect(r.status).toBe(400);
  });

  it('5b: a SUCCESSFUL refresh persists a refresh_events row WITH the licId (not null)', async () => {
    const events = app.get<Repository<RefreshEventEntity>>(getRepositoryToken(RefreshEventEntity));
    const lic = await mintLicense();
    const r = await post('/portal/refresh', { token: lic.token }, { Origin: 'https://ada.com' });
    expect((await r.json()).refreshed).toBe(true);
    const rows = await events.find({ where: { licId: lic.licId } });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[rows.length - 1];
    expect(row.outcome).toBe('refreshed');
    expect(row.origin).toBe('https://ada.com'); // origin captured
    expect(row.licId).toBe(lic.licId);           // 5b fix: NOT null on success
  });

  it('5b: a refused (garbage) refresh also persists a row (outcome=refused)', async () => {
    const events = app.get<Repository<RefreshEventEntity>>(getRepositoryToken(RefreshEventEntity));
    const before = await events.count();
    const r = await post('/portal/refresh', { token: 'garbage.aaa.bbb' }, { Origin: 'https://x.test' });
    expect((await r.json()).refreshed).toBe(false);
    expect(await events.count()).toBe(before + 1);
  });

  it('5b: retention prune deletes events older than the window, keeps recent ones', async () => {
    const events = app.get<Repository<RefreshEventEntity>>(getRepositoryToken(RefreshEventEntity));
    const logSvc = app.get(RefreshLogService);
    // Insert one ancient row (400 days ago) and one fresh row.
    const old = await events.save(events.create({
      licId: 'prune-old', ip: '', origin: '', outcome: 'refreshed',
      createdAt: new Date(Date.now() - 400 * 24 * 3600 * 1000),
    }));
    const fresh = await events.save(events.create({ licId: 'prune-fresh', ip: '', origin: '', outcome: 'refreshed' }));
    // Force a prune "now" (bypass the 1h throttle by advancing the clock arg).
    await logSvc.maybePrune(Date.now() + 2 * 60 * 60 * 1000);
    expect(await events.findOne({ where: { id: old.id } })).toBeNull();     // pruned
    expect(await events.findOne({ where: { id: fresh.id } })).toBeTruthy(); // kept
  });
});
