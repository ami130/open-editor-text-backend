/**
 * admin-flow.e2e.test.ts — the FULL admin surface over real HTTP with DB ON
 * (sqljs), auth + RBAC + admin API all wired:
 *
 *   seed → login (JWT) → unauthenticated call rejected (401) → wrong-permission
 *   call rejected (403) → admin creates a package (M1 validation) → creates a
 *   customer → issues a license → the EDITOR verifier accepts it → refresh
 *   rotates tokens → logout revokes the session.
 *
 * Proves the security posture end-to-end: server-side RBAC is the real gate.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { UserEntity } from '../src/auth/entities/user.entity';
import { RoleEntity } from '../src/auth/entities/role.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LicenseSignerService } from '../src/licensing/license-signer.service';

// @ts-expect-error — JS module (dev/test import into the sibling monorepo)
import { verifyLicense, importEs256PublicKey } from '../../open-editor/packages/entitlements/src/index.js';

let app: INestApplication;
let base: string;
let adminToken: string;
let keyring: Array<{ kid: string; alg: string; key: unknown }>;

// Force DB ON with an in-memory sqljs DB, and provide the secrets the modules need.
beforeAll(async () => {
  // DB ON with the in-memory sqljs driver (no MySQL / no native build needed).
  process.env.DB_ENABLED = 'true';
  process.env.DB_DRIVER ||= 'sqljs';
  const { generateKeyPair } = await import('../src/licensing/license-signer.service');
  const kp = generateKeyPair();
  process.env.LICENSE_PRIVATE_KEY = kp.privateKeyPem;
  process.env.LICENSE_KID = 'oe-admin-test';
  process.env.AUTH_ACCESS_SECRET = 'test-access-secret';
  process.env.AUTH_REFRESH_SECRET = 'test-refresh-secret';
  process.env.SEED_ADMIN_EMAIL = 'admin@test.com';
  process.env.SEED_ADMIN_PASSWORD = 'sup3r-secret-pw';

  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot()] }).compile();
  app = mod.createNestApplication({ logger: false });
  app.use(cookieParser());
  // ValidationPipe is an APP_PIPE provider (SecurityModule) — no manual pipe
  // here, so the test uses the SAME validation config as production.
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  const signer = app.get(LicenseSignerService);
  keyring = [{ kid: 'oe-admin-test', alg: 'ES256', key: await importEs256PublicKey(signer.publicJwk()) }];
});

afterAll(async () => {
  await app?.close();
  delete process.env.DB_ENABLED;
  delete process.env.DB_DRIVER;
});

const post = (path: string, body?: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const get = (path: string, token?: string) =>
  fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

// A FRESH admin access token — some tests below revoke the admin's sessions
// (logout/reuse-detection), so tests that must act as admin AFTER those fetch
// their own token rather than reuse the shared `adminToken`.
async function freshAdminToken(): Promise<string> {
  const r = await post('/auth/login', { email: 'admin@test.com', password: 'sup3r-secret-pw' });
  return (await r.json()).accessToken;
}

describe('admin auth + RBAC + full flow', () => {
  it('login with the seeded admin returns an access token', async () => {
    const r = await post('/auth/login', { email: 'admin@test.com', password: 'sup3r-secret-pw' });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.user.email).toBe('admin@test.com');
    adminToken = body.accessToken;
    // refresh cookie is httpOnly (present in Set-Cookie, not readable by JS)
    expect(r.headers.get('set-cookie') || '').toMatch(/oe_refresh=.*HttpOnly/i);
  });

  it('wrong password is rejected (401) and does not leak which field was wrong', async () => {
    const r = await post('/auth/login', { email: 'admin@test.com', password: 'nope' });
    expect(r.status).toBe(401);
  });

  it('an admin route WITHOUT a token is rejected (401)', async () => {
    expect((await get('/admin/packages')).status).toBe(401);
  });

  it('the seeded admin (wildcard) can read the feature catalog', async () => {
    const r = await get('/admin/features/sellable', adminToken);
    expect(r.status).toBe(200);
    const feats = await r.json();
    expect(feats.some((f: { id: string }) => f.id === 'export.pdf')).toBe(true);
    expect(feats.some((f: { id: string }) => f.id === 'dev.smoke')).toBe(false);
  });

  it('the feature catalog HTTP response carries group + kind on every feature', async () => {
    // The admin tree picker groups + badges features by these fields. Prove the
    // REAL backend serialization emits them — a DTO that dropped group/kind
    // would pass the mock-based BFF test but break the tree in production. (Audit H4.)
    const r = await get('/admin/features', adminToken);
    expect(r.status).toBe(200);
    const feats: Array<{ id: string; group?: string; kind?: string }> = await r.json();
    expect(feats.length).toBeGreaterThan(0);
    const KINDS = new Set(['core', 'plugin', 'premium']);
    const missing = feats.filter((f) => !f.group || !f.group.trim() || !KINDS.has(f.kind ?? ''));
    expect(missing.map((f) => f.id), `features missing group/kind in HTTP response: ${missing.map((f) => f.id).join(', ')}`).toEqual([]);
    // Spot-check a known premium + a known core feature carry the right kind.
    expect(feats.find((f) => f.id === 'export.pdf')?.kind).toBe('premium');
    expect(feats.find((f) => f.id === 'text.bold')?.kind).toBe('core');
  });

  it('creating a package with an INVALID price is rejected by DTO validation (400)', async () => {
    const r = await post('/admin/packages', {
      name: 'Bad', priceCents: -5, currency: 'USD', billingInterval: 'once', featureIds: ['export.pdf'],
    }, adminToken);
    expect(r.status).toBe(400);
  });

  it('creating a package with a non-sellable feature is rejected (400)', async () => {
    const r = await post('/admin/packages', {
      name: 'Sneaky', priceCents: 100, currency: 'USD', billingInterval: 'once', featureIds: ['dev.smoke'],
    }, adminToken);
    expect(r.status).toBe(400);
  });

  it('Phase 3 — a lifetime package is accepted and stores refreshPolicy=auto', async () => {
    const r = await post('/admin/packages', {
      name: 'Perpetual', priceCents: 9900, currency: 'USD', billingInterval: 'lifetime',
      featureIds: ['export.pdf'],
    }, adminToken);
    expect(r.status).toBe(201);
    const pkg = await r.json();
    expect(pkg.billingInterval).toBe('lifetime');
    expect(pkg.refreshPolicy).toBe('auto'); // DERIVED server-side, not client-sent
  });

  it('Phase 3 — isFree coerces price 0 and interval once, but NO LONGER hides the package', async () => {
    // `publiclyListed` used to be forced off here: /pricing gave every package
    // a "Buy" button, and order.service refuses a $0 checkout, so a free+listed
    // package rendered a button that could only ever 400.
    //
    // The storefront now renders free as "Free / Get started" with no checkout
    // path (and guards the dialog on priceCents > 0), so the dead-button reason
    // is gone — while hiding it had a real cost: visitors could not see that a
    // free tier existed at all. The zero-price refusal in order.service is
    // untouched and remains the actual protection; see the free-tier checkout
    // test below, which proves a free package still cannot be bought.
    const r = await post('/admin/packages', {
      name: 'Free tier', priceCents: 4900, currency: 'USD', billingInterval: 'yearly',
      isFree: true, publiclyListed: true, featureIds: ['export.pdf'],
    }, adminToken);
    expect(r.status).toBe(201);
    const pkg = await r.json();
    expect(pkg.isFree).toBe(true);
    expect(pkg.priceCents).toBe(0);           // coerced despite the 4900 sent
    expect(pkg.billingInterval).toBe('once'); // coerced despite 'yearly' sent
    expect(pkg.refreshPolicy).toBe('manual'); // once ⇒ manual
    expect(pkg.publiclyListed).toBe(true);    // respected now, not coerced off
  });

  it('a free package still CANNOT be bought, even when publicly listed', async () => {
    // The guarantee that replaced the coercion above. Listing a free package is
    // now allowed, so the refusal has to hold at the checkout boundary — if
    // this ever passes, a $0 order can be opened and the storefront change
    // becomes unsafe.
    const created = await (await post('/admin/packages', {
      name: 'Free listed', priceCents: 0, currency: 'USD', billingInterval: 'once',
      isFree: true, publiclyListed: true, featureIds: ['export.pdf'],
    }, adminToken)).json();

    const r = await post('/billing/checkout', {
      packageId: created.id, email: 'buyer@example.com',
    });
    // NOT 201: the order is never opened. Which rejection you get depends on
    // whether Stripe is configured in this environment — 503 "billing is not
    // configured" fires in the controller before the service is reached, and
    // 400 "no purchasable price" is the price guard itself. Asserting only 400
    // would make this test pass or fail on Stripe config rather than on the
    // behaviour it is guarding, so accept either refusal and assert the thing
    // that actually matters: a free package can never be purchased.
    expect([400, 503]).toContain(r.status);
    expect(r.status).not.toBe(201);
  });

  it('Phase 3 — an unknown billingInterval is rejected by DTO validation (400)', async () => {
    const r = await post('/admin/packages', {
      name: 'Weird', priceCents: 100, currency: 'USD', billingInterval: 'quarterly',
      featureIds: ['export.pdf'],
    }, adminToken);
    expect(r.status).toBe(400);
  });

  it('FULL FLOW: create package → customer → issue license → editor verifies exact features', async () => {
    const pkgRes = await post('/admin/packages', {
      name: 'Pro', priceCents: 4900, currency: 'USD', billingInterval: 'once',
      featureIds: ['export.pdf', 'export.docx'], domainBound: true,
    }, adminToken);
    expect(pkgRes.status).toBe(201);
    const pkg = await pkgRes.json();

    const custRes = await post('/admin/customers', {
      name: 'Acme', email: 'acme@buyer.com', domains: ['acme.com'],
    }, adminToken);
    const customer = await custRes.json();

    const licRes = await post('/admin/licenses', { customerId: customer.id, packageId: pkg.id }, adminToken);
    expect(licRes.status).toBe(201);
    const lic = await licRes.json();
    expect(lic.token).toBeTruthy();

    const res = await verifyLicense(lic.token, { keyring, hostname: 'acme.com' });
    expect(res.valid).toBe(true);
    expect(res.payload.features.sort()).toEqual(['export.docx', 'export.pdf']);
  });

  it('GET /admin/customers?q= searches name+email, case-insensitively, and is injection-safe', async () => {
    await post('/admin/customers', { name: 'Widgets Inc', email: 'buyer@widgets.example', domains: [] }, adminToken);
    await post('/admin/customers', { name: 'Gadgets Co', email: 'purchasing@gadgets.example', domains: [] }, adminToken);

    // Matches by NAME substring.
    const byName = await (await get('/admin/customers?q=Widgets', adminToken)).json();
    expect(byName.some((c: { email: string }) => c.email === 'buyer@widgets.example')).toBe(true);
    expect(byName.some((c: { email: string }) => c.email === 'purchasing@gadgets.example')).toBe(false);

    // Matches by EMAIL substring, case-insensitively.
    const byEmailCi = await (await get('/admin/customers?q=GADGETS', adminToken)).json();
    expect(byEmailCi.some((c: { email: string }) => c.email === 'purchasing@gadgets.example')).toBe(true);

    // No match → empty array, not an error.
    const noMatch = await (await get('/admin/customers?q=zzz-nonexistent-zzz', adminToken)).json();
    expect(noMatch).toEqual([]);

    // A literal `%` in the query must be treated as a literal char, not a
    // SQL wildcard (it would otherwise match everything).
    const literalPercent = await (await get(`/admin/customers?q=${encodeURIComponent('%')}`, adminToken)).json();
    expect(literalPercent).toEqual([]);

    // No `q` at all → unfiltered list (existing behavior unchanged).
    const all = await (await get('/admin/customers', adminToken)).json();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it('refresh rotates the token pair; logout revokes the session', async () => {
    // login fresh to get a refresh cookie
    const login = await post('/auth/login', { email: 'admin@test.com', password: 'sup3r-secret-pw' });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const token = (await login.json()).accessToken;

    const refreshed = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { Cookie: cookie } });
    expect(refreshed.status).toBe(201);
    expect((await refreshed.json()).accessToken).toBeTruthy();

    // logout (bumps tokenVersion → old refresh no longer works)
    const logout = await post('/auth/logout', undefined, token);
    expect(logout.status).toBe(201);
    const afterLogout = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { Cookie: cookie } });
    expect(afterLogout.status).toBe(401);
  });

  it('C1 — logout immediately invalidates the ACCESS token (not just refresh)', async () => {
    const login = await post('/auth/login', { email: 'admin@test.com', password: 'sup3r-secret-pw' });
    const token = (await login.json()).accessToken;
    // the token works now
    expect((await get('/auth/me', token)).status).toBe(200);
    // logout → the SAME access token is rejected on the very next request
    await post('/auth/logout', undefined, token);
    expect((await get('/auth/me', token)).status).toBe(401);
  });

  it('I3 — replaying an OLD refresh token after rotation is detected and revokes the family (401)', async () => {
    const login = await post('/auth/login', { email: 'admin@test.com', password: 'sup3r-secret-pw' });
    const oldCookie = (login.headers.get('set-cookie') || '').split(';')[0];
    // rotate once (old cookie is now stale)
    const rotated = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { Cookie: oldCookie } });
    expect(rotated.status).toBe(201);
    const newCookie = (rotated.headers.get('set-cookie') || '').split(';')[0];
    // replay the OLD (already-rotated) refresh cookie → detected, rejected
    const replay = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { Cookie: oldCookie } });
    expect(replay.status).toBe(401);
    // and reuse revoked the family, so even the NEW cookie no longer works
    const afterReuse = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { Cookie: newCookie } });
    expect(afterReuse.status).toBe(401);
  });

  it('I2 — GET /admin/licenses does NOT expose the signed token', async () => {
    const tok = await freshAdminToken();
    // issue at least one license first
    const pkgRes = await post('/admin/packages', {
      name: 'ListTest', priceCents: 100, currency: 'USD', billingInterval: 'once', featureIds: ['export.pdf'],
    }, tok);
    const pkg = await pkgRes.json();
    const cust = await (await post('/admin/customers', { name: 'L', email: 'l@x.com', domains: ['l.com'] }, tok)).json();
    await post('/admin/licenses', { customerId: cust.id, packageId: pkg.id }, tok);

    const listRes = await get('/admin/licenses', tok);
    const list = await listRes.json();
    expect(list.length).toBeGreaterThan(0);
    for (const lic of list) {
      expect(lic.token).toBeUndefined();          // token never in the list
      expect(lic.effectiveStatus).toBeTruthy();   // effective status IS present
    }
  });

  it('GET /admin/licenses supports ?q= (customer/plan) and ?status= (effective, time-aware) filters', async () => {
    const tok = await freshAdminToken();
    const pkgRes = await post('/admin/packages', {
      name: 'FindableLicensePlan', priceCents: 100, currency: 'USD', billingInterval: 'once', featureIds: ['export.pdf'],
    }, tok);
    const pkg = await pkgRes.json();
    const cust = await (await post('/admin/customers', { name: 'Findable Buyer', email: 'findable-license@x.com', domains: ['findable-license.com'] }, tok)).json();
    const issued = await (await post('/admin/licenses', { customerId: cust.id, packageId: pkg.id }, tok)).json();

    const byEmail = await (await get('/admin/licenses?q=findable-license', tok)).json();
    expect(byEmail.some((l: { id: string }) => l.id === issued.id)).toBe(true);

    const byEmailCi = await (await get('/admin/licenses?q=FINDABLE-LICENSE', tok)).json();
    expect(byEmailCi.some((l: { id: string }) => l.id === issued.id)).toBe(true);

    const byPlan = await (await get('/admin/licenses?q=FindableLicensePlan', tok)).json();
    expect(byPlan.some((l: { id: string }) => l.id === issued.id)).toBe(true);

    const noMatch = await (await get('/admin/licenses?q=zzz-nonexistent-zzz', tok)).json();
    expect(noMatch).toEqual([]);

    // status=active filters by the EFFECTIVE (time-aware) status, not the raw
    // stored column — every fresh license here should qualify.
    const activeOnes = await (await get('/admin/licenses?status=active', tok)).json();
    expect(activeOnes.some((l: { id: string }) => l.id === issued.id)).toBe(true);
    for (const l of activeOnes) expect(l.effectiveStatus).toBe('active');

    // Revoke it, then confirm status=revoked picks it up and status=active no longer does.
    await post(`/admin/licenses/${issued.id}/revoke`, undefined, tok);
    const revokedOnes = await (await get('/admin/licenses?status=revoked', tok)).json();
    expect(revokedOnes.some((l: { id: string }) => l.id === issued.id)).toBe(true);
    const activeAfterRevoke = await (await get('/admin/licenses?status=active', tok)).json();
    expect(activeAfterRevoke.some((l: { id: string }) => l.id === issued.id)).toBe(false);
  });

  it('POST /admin/licenses/:id/regenerate revokes the old license and returns a new one, verifiable by the real editor verifier', async () => {
    const tok = await freshAdminToken();
    const pkgRes = await post('/admin/packages', {
      name: 'RegenApiPlan', priceCents: 100, currency: 'USD', billingInterval: 'once', featureIds: ['export.pdf'], domainBound: true,
    }, tok);
    const pkg = await pkgRes.json();
    const cust = await (await post('/admin/customers', { name: 'Regen Buyer', email: 'regen-api@x.com', domains: ['regen-api.com'] }, tok)).json();
    const original = await (await post('/admin/licenses', { customerId: cust.id, packageId: pkg.id }, tok)).json();

    const regenRes = await post(`/admin/licenses/${original.id}/regenerate`, undefined, tok);
    expect(regenRes.status).toBe(201);
    const fresh = await regenRes.json();

    expect(fresh.id).not.toBe(original.id);
    expect(fresh.token).toBeTruthy();
    const verified = await verifyLicense(fresh.token, { keyring, hostname: 'regen-api.com' });
    expect(verified.valid).toBe(true);
    expect(verified.payload.features).toEqual(['export.pdf']);

    // The OLD license now shows revoked in the list.
    const list = await (await get('/admin/licenses', tok)).json();
    const oldRow = list.find((l: { id: string }) => l.id === original.id);
    expect(oldRow.effectiveStatus).toBe('revoked');
  });

  it('I6 — updating/deleting an unknown customer returns 404 (not silent success)', async () => {
    const tok = await freshAdminToken();
    const fakeId = '00000000-0000-0000-0000-000000000000';
    expect((await fetch(`${base}/admin/customers/${fakeId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ name: 'x' }),
    })).status).toBe(404);
    expect((await fetch(`${base}/admin/customers/${fakeId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${tok}` },
    })).status).toBe(404);
  });

  it('forbidNonWhitelisted — an unexpected field is rejected (400), not silently stripped', async () => {
    const tok = await freshAdminToken();
    const r = await post('/admin/packages', {
      name: 'Extra', priceCents: 100, currency: 'USD', billingInterval: 'once', featureIds: ['export.pdf'],
      system: true, tokenVersion: 99, // <- not in the DTO
    }, tok);
    expect(r.status).toBe(400);
  });
});

describe('RBAC: a limited role is denied a privileged action', () => {
  it('a user with only feature.read cannot create packages (403)', async () => {
    // create a limited role + user directly, then log in as them
    const auth = app.get(AuthService);
    const users = app.get<import('typeorm').Repository<UserEntity>>(getRepositoryToken(UserEntity));
    const roles = app.get<import('typeorm').Repository<RoleEntity>>(getRepositoryToken(RoleEntity));
    const permRepo = app.get<import('typeorm').Repository<import('../src/auth/entities/permission.entity').PermissionEntity>>(getRepositoryToken((await import('../src/auth/entities/permission.entity')).PermissionEntity));
    const readOnly = await permRepo.findOne({ where: { key: 'feature.read' } });
    const role = await roles.save(roles.create({ name: 'viewer', description: 'read only', system: false, permissions: readOnly ? [readOnly] : [] }));
    const hash = await auth.hashPassword('viewer-pw-123');
    await users.save(users.create({ email: 'viewer@test.com', name: 'Viewer', passwordHash: hash, active: true, roles: [role] }));

    const login = await post('/auth/login', { email: 'viewer@test.com', password: 'viewer-pw-123' });
    const token = (await login.json()).accessToken;

    // allowed: reading features
    expect((await get('/admin/features', token)).status).toBe(200);
    // denied: creating a package (needs package.create)
    const denied = await post('/admin/packages', {
      name: 'X', priceCents: 100, currency: 'USD', billingInterval: 'once', featureIds: ['export.pdf'],
    }, token);
    expect(denied.status).toBe(403);
  });
});
