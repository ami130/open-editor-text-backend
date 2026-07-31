/**
 * rbac-admin.e2e.test.ts — the role & admin-user management surface over real
 * HTTP with DB ON (sqljs), auth + RBAC wired. Proves both the happy path AND
 * the security invariants that make this safe to expose in the admin panel:
 *
 *   • admin creates a role from catalog permissions → creates a staff user with
 *     that role → that user can log in and do exactly what the role allows.
 *   • the wildcard '*' can NEVER be assigned to a role via the API (no minting a
 *     new super-admin).
 *   • system roles (seeded "admin") are immutable + undeletable.
 *   • changing a user's roles invalidates their existing token immediately.
 *   • the last active admin can't be deactivated/deleted (no lockout).
 *   • a non-privileged user is denied role/user management (403).
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';

let app: INestApplication;
let base: string;

beforeAll(async () => {
  process.env.DB_ENABLED = 'true';
  process.env.DB_DRIVER ||= 'sqljs';
  const { generateKeyPair } = await import('../src/licensing/license-signer.service');
  const kp = generateKeyPair();
  process.env.LICENSE_PRIVATE_KEY = kp.privateKeyPem;
  process.env.LICENSE_KID = 'oe-rbac-test';
  process.env.AUTH_ACCESS_SECRET = 'test-access-secret';
  process.env.AUTH_REFRESH_SECRET = 'test-refresh-secret';
  process.env.SEED_ADMIN_EMAIL = 'root@test.com';
  process.env.SEED_ADMIN_PASSWORD = 'sup3r-secret-pw';

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
});

const post = (path: string, body?: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const patch = (path: string, body: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const del = (path: string, token?: string) =>
  fetch(`${base}${path}`, { method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {} });
const get = (path: string, token?: string) =>
  fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

async function rootToken(): Promise<string> {
  const r = await post('/auth/login', { email: 'root@test.com', password: 'sup3r-secret-pw' });
  return (await r.json()).accessToken;
}

describe('RBAC management: roles, permissions, admin users', () => {
  it('the permission catalog is readable and EXCLUDES the wildcard', async () => {
    const tok = await rootToken();
    const r = await get('/admin/permissions', tok);
    expect(r.status).toBe(200);
    const perms = await r.json();
    expect(perms.some((p: { key: string }) => p.key === 'package.create')).toBe(true);
    expect(perms.some((p: { key: string }) => p.key === '*')).toBe(false);
  });

  it('FULL FLOW: create a role → create a user with it → the user can act within the role', async () => {
    const tok = await rootToken();

    // A "support" role that can only read + issue licenses.
    const roleRes = await post('/admin/roles', {
      name: 'support', description: 'issue licenses', permissions: ['license.read', 'license.issue', 'customer.read', 'package.read', 'feature.read'],
    }, tok);
    expect(roleRes.status).toBe(201);
    const role = await roleRes.json();
    expect(role.permissions.map((p: { key: string }) => p.key).sort()).toEqual(
      ['customer.read', 'feature.read', 'license.issue', 'license.read', 'package.read'],
    );

    // A staff user holding that role.
    const userRes = await post('/admin/users', {
      email: 'support@test.com', name: 'Support', password: 'support-pw-123', roleIds: [role.id],
    }, tok);
    expect(userRes.status).toBe(201);
    const user = await userRes.json();
    expect(user.passwordHash).toBeUndefined();          // never leaked
    expect(user.permissions.sort()).toContain('license.issue');

    // The support user logs in and can read licenses, but NOT manage roles.
    const login = await post('/auth/login', { email: 'support@test.com', password: 'support-pw-123' });
    const supportTok = (await login.json()).accessToken;
    expect((await get('/admin/licenses', supportTok)).status).toBe(200);
    expect((await post('/admin/roles', { name: 'evil', permissions: [] }, supportTok)).status).toBe(403);
  });

  it('the wildcard permission CANNOT be assigned to a role (privilege-escalation guard)', async () => {
    const tok = await rootToken();
    const r = await post('/admin/roles', { name: 'sneaky-super', permissions: ['*'] }, tok);
    expect(r.status).toBe(400);
  });

  it('unknown permission keys are rejected (400)', async () => {
    const tok = await rootToken();
    const r = await post('/admin/roles', { name: 'bogus', permissions: ['package.create', 'not.a.real.perm'] }, tok);
    expect(r.status).toBe(400);
  });

  it('duplicate role names are rejected (409)', async () => {
    const tok = await rootToken();
    await post('/admin/roles', { name: 'dupe-role', permissions: [] }, tok);
    const again = await post('/admin/roles', { name: 'dupe-role', permissions: [] }, tok);
    expect(again.status).toBe(409);
  });

  it('the seeded system "admin" role is immutable and undeletable', async () => {
    const tok = await rootToken();
    const roles = await (await get('/admin/roles', tok)).json();
    const adminRole = roles.find((r: { name: string }) => r.name === 'admin');
    expect(adminRole.system).toBe(true);
    expect((await patch(`/admin/roles/${adminRole.id}`, { description: 'hacked' }, tok)).status).toBe(400);
    expect((await del(`/admin/roles/${adminRole.id}`, tok)).status).toBe(400);
  });

  it('changing a user\'s roles invalidates their existing access token immediately', async () => {
    const tok = await rootToken();
    // a role that can read licenses
    const role = await (await post('/admin/roles', { name: 'reader', permissions: ['license.read'] }, tok)).json();
    const user = await (await post('/admin/users', { email: 'reader@test.com', password: 'reader-pw-123', roleIds: [role.id] }, tok)).json();

    const login = await post('/auth/login', { email: 'reader@test.com', password: 'reader-pw-123' });
    const readerTok = (await login.json()).accessToken;
    expect((await get('/admin/licenses', readerTok)).status).toBe(200);

    // strip the role → the OLD token must stop working on the next request
    await patch(`/admin/users/${user.id}`, { roleIds: [] }, tok);
    expect((await get('/admin/licenses', readerTok)).status).toBe(401);
  });

  it('the last active admin cannot be deactivated or deleted (no lockout)', async () => {
    const tok = await rootToken();
    const users = await (await get('/admin/users', tok)).json();
    const root = users.find((u: { email: string }) => u.email === 'root@test.com');
    // (root is the only wildcard admin in this DB)
    expect((await patch(`/admin/users/${root.id}`, { active: false }, tok)).status).toBe(400);
    expect((await del(`/admin/users/${root.id}`, tok)).status).toBe(400);
  });

  it('a role still assigned to a user cannot be deleted (409)', async () => {
    const tok = await rootToken();
    const role = await (await post('/admin/roles', { name: 'attached', permissions: ['license.read'] }, tok)).json();
    await post('/admin/users', { email: 'holder@test.com', password: 'holder-pw-123', roleIds: [role.id] }, tok);
    expect((await del(`/admin/roles/${role.id}`, tok)).status).toBe(409);
  });

  it('duplicate user email is rejected (409)', async () => {
    const tok = await rootToken();
    await post('/admin/users', { email: 'twice@test.com', password: 'pw-123456' }, tok);
    expect((await post('/admin/users', { email: 'twice@test.com', password: 'pw-123456' }, tok)).status).toBe(409);
  });

  it('a short password is rejected by DTO validation (400)', async () => {
    const tok = await rootToken();
    expect((await post('/admin/users', { email: 'short@test.com', password: 'x' }, tok)).status).toBe(400);
  });
});

describe('H3 — RBAC privilege ceiling (no escalation beyond the actor)', () => {
  // Build a limited "user-admin" who can manage roles+users but holds NO other
  // permissions, then prove they cannot bootstrap themselves broader authority.
  let userAdminTok = '';
  let userAdminId = '';

  it('setup: create a limited user-admin (role.manage + user.manage only)', async () => {
    const tok = await rootToken();
    const role = await (await post('/admin/roles', {
      name: 'user-admin', permissions: ['role.read', 'role.manage', 'user.read', 'user.manage'],
    }, tok)).json();
    const u = await (await post('/admin/users', {
      email: 'useradmin@test.com', password: 'useradmin-pw-1', roleIds: [role.id],
    }, tok)).json();
    userAdminId = u.id;
    const login = await post('/auth/login', { email: 'useradmin@test.com', password: 'useradmin-pw-1' });
    userAdminTok = (await login.json()).accessToken;
    expect(userAdminTok).toBeTruthy();
  });

  it('cannot create a role granting permissions they do NOT hold (400)', async () => {
    // They hold only role/user manage — not license.issue/package.delete.
    const r = await post('/admin/roles', {
      name: 'escalation', permissions: ['license.issue', 'package.delete'],
    }, userAdminTok);
    expect(r.status).toBe(400);
  });

  it('CAN create a role within their own authority (subset) (201)', async () => {
    const r = await post('/admin/roles', {
      name: 'subset-ok', permissions: ['user.read', 'role.read'],
    }, userAdminTok);
    expect(r.status).toBe(201);
  });

  it('cannot assign an existing broad role to a new user (400)', async () => {
    const tok = await rootToken();
    // root makes a powerful role
    const powerful = await (await post('/admin/roles', {
      name: 'powerful', permissions: ['license.issue', 'license.revoke'],
    }, tok)).json();
    // the limited user-admin tries to assign it to a fresh user
    const r = await post('/admin/users', {
      email: 'victim@test.com', password: 'victim-pw-1', roleIds: [powerful.id],
    }, userAdminTok);
    expect(r.status).toBe(400);
  });

  it('cannot change their OWN roles (self-escalation) (400)', async () => {
    const tok = await rootToken();
    const powerful = await (await post('/admin/roles', {
      name: 'powerful2', permissions: ['package.delete'],
    }, tok)).json();
    const r = await patch(`/admin/users/${userAdminId}`, { roleIds: [powerful.id] }, userAdminTok);
    expect(r.status).toBe(400);
  });

  it('a super-admin (root, *) is exempt and CAN grant anything', async () => {
    const tok = await rootToken();
    const r = await post('/admin/roles', {
      name: 'root-made-broad', permissions: ['license.issue', 'package.delete', 'user.manage'],
    }, tok);
    expect(r.status).toBe(201);
  });
});
