/**
 * portal-auth.e2e.test.ts — Phase 4a: self-serve customer portal magic-link auth.
 *
 * Proves the security-critical properties, not just the happy path:
 *   • anti-enumeration: request-link returns the SAME response for a known and an
 *     unknown email, and only actually emails a known customer.
 *   • single-use: a magic link works exactly once (nonce burned on consume).
 *   • session gating: /portal/me needs a valid customer session.
 *   • TYPE ISOLATION: an admin token is rejected on a customer route, and a
 *     customer session is rejected on an admin route (separate secrets + type).
 *
 * EmailService is faked to capture the emitted magic link (the token the customer
 * would click), so the test can drive the verify step.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { EmailService } from '../src/billing/email.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CustomerEntity } from '../src/licensing/entities/customer.entity';
import { LicenseEntity } from '../src/licensing/entities/license.entity';
import { LicenseService } from '../src/licensing/license.service';
import type { Repository } from 'typeorm';

let app: INestApplication;
let base: string;
let adminToken: string;
let adaId: string;      // customer "Ada"
let bobLicenseId: string; // a license owned by a DIFFERENT customer "Bob"
let adaLicenseId: string; // a license owned by Ada

// Fake email: capture the last portal link (and license emails, harmlessly).
const mail = { lastPortalLink: null as string | null, lastPortalTo: null as string | null };
const fakeEmail = {
  async sendPortalLink(input: { to: string; customerName: string; link: string }) {
    mail.lastPortalTo = input.to; mail.lastPortalLink = input.link; return true;
  },
  async sendLicenseEmail() { return true; },
};

/** Pull the ?token= out of a captured magic link. */
function tokenFromLink(link: string): string {
  const u = new URL(link);
  return u.searchParams.get('token') || '';
}

beforeAll(async () => {
  process.env.DB_ENABLED = 'true';
  process.env.DB_DRIVER ||= 'sqljs';
  const { generateKeyPair } = await import('../src/licensing/license-signer.service');
  const kp = generateKeyPair();
  process.env.LICENSE_PRIVATE_KEY = kp.privateKeyPem;
  process.env.LICENSE_KID = 'oe-portal-test';
  process.env.AUTH_ACCESS_SECRET = 'test-access-secret';
  process.env.AUTH_REFRESH_SECRET = 'test-refresh-secret';
  process.env.CUSTOMER_MAGIC_SECRET = 'test-customer-magic-secret';
  process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret';
  process.env.SEED_ADMIN_EMAIL = 'admin@portal.test';
  process.env.SEED_ADMIN_PASSWORD = 'sup3r-secret-pw';

  const modBuilder = Test.createTestingModule({ imports: [AppModule.forRoot()] });
  modBuilder.overrideProvider(EmailService).useValue(fakeEmail);
  const mod = await modBuilder.compile();
  app = mod.createNestApplication({ logger: false });
  app.use(cookieParser());
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  // Seed two customers directly (checkout normally creates them).
  const customers = app.get<Repository<CustomerEntity>>(getRepositoryToken(CustomerEntity));
  const ada = await customers.save(customers.create({ name: 'Ada', email: 'ada@buyer.com', domains: ['ada.com'] }));
  const bob = await customers.save(customers.create({ name: 'Bob', email: 'bob@buyer.com', domains: ['bob.com'] }));
  adaId = ada.id;

  // Mint a license for each via the snapshot path (no live package needed).
  const licenseSvc = app.get(LicenseService);
  const adaLic = await licenseSvc.issueFromSnapshot({
    customerId: ada.id, features: ['export.pdf'], domains: ['ada.com'], planName: 'Pro', domainBound: true,
  });
  adaLicenseId = adaLic.id;
  const bobLic = await licenseSvc.issueFromSnapshot({
    customerId: bob.id, features: ['export.pdf'], domains: ['bob.com'], planName: 'Pro', domainBound: true,
  });
  bobLicenseId = bobLic.id;

  const login = await post('/auth/login', { email: 'admin@portal.test', password: 'sup3r-secret-pw' });
  adminToken = (await login.json()).accessToken;
});

afterAll(async () => {
  await app?.close();
  delete process.env.DB_ENABLED; delete process.env.DB_DRIVER;
  delete process.env.CUSTOMER_MAGIC_SECRET; delete process.env.CUSTOMER_SESSION_SECRET;
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers });

describe('Phase 4a — customer portal magic-link auth', () => {
  it('request-link for a KNOWN email emails a link and returns generic 200', async () => {
    mail.lastPortalLink = null;
    const r = await post('/portal/request-link', { email: 'ada@buyer.com' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(mail.lastPortalTo).toBe('ada@buyer.com');
    expect(mail.lastPortalLink).toBeTruthy();
  });

  it('request-link for an UNKNOWN email returns the SAME response and emails NOTHING (anti-enumeration)', async () => {
    mail.lastPortalLink = null; mail.lastPortalTo = null;
    const r = await post('/portal/request-link', { email: 'nobody@nowhere.com' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);                 // identical shape to the known case
    expect(mail.lastPortalLink).toBeNull();      // but no email was sent
  });

  it('a magic link signs the customer in and sets a session cookie usable on /portal/me', async () => {
    await post('/portal/request-link', { email: 'ada@buyer.com' });
    const token = tokenFromLink(mail.lastPortalLink!);
    const verify = await post('/portal/verify', { token });
    expect(verify.status).toBe(200);
    const setCookie = verify.headers.get('set-cookie') || '';
    expect(setCookie).toContain('oe_customer=');
    const cookie = setCookie.split(';')[0];

    const me = await get('/portal/me', { Cookie: cookie });
    expect(me.status).toBe(200);
    expect((await me.json()).email).toBe('ada@buyer.com');
  });

  it('a magic link is SINGLE-USE — the second consume of the same link fails (nonce burned)', async () => {
    await post('/portal/request-link', { email: 'ada@buyer.com' });
    const token = tokenFromLink(mail.lastPortalLink!);
    const first = await post('/portal/verify', { token });
    expect(first.status).toBe(200);
    const second = await post('/portal/verify', { token });
    expect(second.status).toBe(401);            // already used
  });

  it('requesting a NEW link invalidates the previous one (nonce rotation)', async () => {
    await post('/portal/request-link', { email: 'ada@buyer.com' });
    const stale = tokenFromLink(mail.lastPortalLink!);
    await post('/portal/request-link', { email: 'ada@buyer.com' }); // rotates nonce
    const r = await post('/portal/verify', { token: stale });
    expect(r.status).toBe(401);                 // the old link no longer works
  });

  it('/portal/me without a session is 401', async () => {
    const r = await get('/portal/me');
    expect(r.status).toBe(401);
  });

  it('TYPE ISOLATION: an ADMIN bearer token is rejected on /portal/me', async () => {
    const r = await get('/portal/me', { Authorization: `Bearer ${adminToken}` });
    expect(r.status).toBe(401);                 // admin token is not a customer session
  });

  it('TYPE ISOLATION: a CUSTOMER session token is rejected on an admin route', async () => {
    await post('/portal/request-link', { email: 'ada@buyer.com' });
    const token = tokenFromLink(mail.lastPortalLink!);
    const verify = await post('/portal/verify', { token });
    const cookie = (verify.headers.get('set-cookie') || '').split(';')[0];
    const sessionToken = cookie.split('=')[1];
    // Present the customer session as a Bearer on an admin route → must be rejected.
    const r = await get('/admin/packages', { Authorization: `Bearer ${sessionToken}` });
    expect(r.status).toBe(401);
  });
});

/** Sign Ada in and return her session cookie for the license routes. */
async function adaCookie(): Promise<string> {
  await post('/portal/request-link', { email: 'ada@buyer.com' });
  const token = tokenFromLink(mail.lastPortalLink!);
  const verify = await post('/portal/verify', { token });
  return (verify.headers.get('set-cookie') || '').split(';')[0];
}

describe('Phase 4c hardening — session revocation (audit M4)', () => {
  it('logout REVOKES all outstanding sessions: the same cookie is dead afterwards (epoch bump)', async () => {
    const cookie = await adaCookie();
    // Works before logout.
    expect((await get('/portal/me', { Cookie: cookie })).status).toBe(200);
    // Logout bumps the customer sessionEpoch.
    const out = await post('/portal/logout', undefined, { Cookie: cookie });
    expect(out.status).toBe(200);
    // The SAME still-unexpired cookie no longer verifies — the epoch moved.
    expect((await get('/portal/me', { Cookie: cookie })).status).toBe(401);
  });
});

describe('Phase 4b — self-serve my-licenses (list / reveal / regenerate)', () => {
  it('lists only the AUTHENTICATED customer\'s licenses, with NO token in the list', async () => {
    const cookie = await adaCookie();
    const r = await get('/portal/licenses', { Cookie: cookie });
    expect(r.status).toBe(200);
    const list = await r.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(1);                 // Ada's one license, not Bob's
    expect(list[0].id).toBe(adaLicenseId);
    expect(list[0].planName).toBe('Pro');
    expect(list[0].effectiveStatus).toBe('active');
    expect(list[0].token).toBeUndefined();       // list never carries the secret
  });

  it('reveals the CURRENT token for the customer\'s own active license', async () => {
    const cookie = await adaCookie();
    const r = await get(`/portal/licenses/${adaLicenseId}/key`, { Cookie: cookie });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.token).toBeTruthy();
    expect(typeof body.token).toBe('string');
    expect(body.view.id).toBe(adaLicenseId);
  });

  it('OWNERSHIP: revealing ANOTHER customer\'s license returns 404 (no id-enumeration oracle)', async () => {
    const cookie = await adaCookie();
    const r = await get(`/portal/licenses/${bobLicenseId}/key`, { Cookie: cookie });
    expect(r.status).toBe(404);                   // Bob's license is invisible to Ada
  });

  it('OWNERSHIP: regenerating ANOTHER customer\'s license returns 404', async () => {
    const cookie = await adaCookie();
    const r = await post(`/portal/licenses/${bobLicenseId}/regenerate`, undefined, { Cookie: cookie });
    expect(r.status).toBe(404);
  });

  it('regenerate revokes the old key and mints a NEW distinct token (old licId dies)', async () => {
    const cookie = await adaCookie();
    // Capture the current token/licId first.
    const before = await (await get(`/portal/licenses/${adaLicenseId}/key`, { Cookie: cookie })).json();
    const oldToken = before.token;

    const regen = await post(`/portal/licenses/${adaLicenseId}/regenerate`, undefined, { Cookie: cookie });
    expect(regen.status).toBe(201);
    const after = await regen.json();
    expect(after.token).toBeTruthy();
    expect(after.token).not.toBe(oldToken);        // genuinely new credential
    expect(after.view.effectiveStatus).toBe('active');

    // The customer now has TWO records (old revoked + new active); the list shows
    // the new one active. The old one no longer reveals a token.
    const list = await (await get('/portal/licenses', { Cookie: cookie })).json();
    const active = list.filter((l: { effectiveStatus: string }) => l.effectiveStatus === 'active');
    expect(active.length).toBe(1);
  });

  it('R1: self-serve regenerate REFUSES a term-ended license (no free resurrection from the portal)', async () => {
    const cookie = await adaCookie();
    // Seed a fresh Ada license and force its paid term to have ended.
    const licenseSvc = app.get(LicenseService);
    const licenses = app.get<Repository<LicenseEntity>>(getRepositoryToken(LicenseEntity));
    const dead = await licenseSvc.issueFromSnapshot({
      customerId: adaId, features: ['export.pdf'], domains: ['ada.com'], planName: 'Pro', domainBound: true, billingInterval: 'monthly',
    });
    await licenses.update({ id: dead.id }, { renewUntil: Math.floor(Date.now() / 1000) - 24 * 3600 });

    const r = await post(`/portal/licenses/${dead.id}/regenerate`, undefined, { Cookie: cookie });
    expect(r.status).toBe(400); // refused — term ended, must re-purchase
    // The dead license was NOT revoked-and-reminted (no resurrection).
    const row = await licenses.findOne({ where: { id: dead.id } });
    expect(row!.status).toBe('active'); // still the original (dead) row, not swapped
  });

  it('license routes require a customer session (401 without cookie)', async () => {
    expect((await get('/portal/licenses')).status).toBe(401);
    expect((await get(`/portal/licenses/${adaLicenseId}/key`)).status).toBe(401);
  });
});
