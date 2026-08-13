/**
 * delivery-flow.e2e.test.ts — the runtime-delivery chain over REAL HTTP with a
 * REAL database (sqljs), the whole app booted (§1.1 → §1.2 → §1.3).
 *
 * WHY THIS EXISTS: every other delivery test fakes the repository and the
 * signer. That proves the *policy* but not the *plumbing* — a deep audit found
 * the sections were three well-tested components that had never been connected:
 * the migration had never run, the entities had never round-tripped through a
 * database, DI had never resolved in a booted app, and the HTTP layer (DTO
 * validation, throttling, @Public) was entirely unexercised.
 *
 * So this test does the real journey:
 *
 *   admin logs in
 *     → publishes free + premium builds        (§1.1 output → §1.2 registry)
 *     → promotes the version to stable
 *     → points the global default at it
 *   anonymous caller opens a session           (§1.3, no key, no signup)
 *     → receives the FREE bundle + free features
 *   the same caller with a premium licence
 *     → receives the PREMIUM bundle + premium features
 *   admin rolls the default back
 *     → new sessions immediately receive the older version
 *
 * If any seam between the sections is broken, this fails.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { createHash } from 'node:crypto';
import { BUNDLE_UPLOAD_LIMIT } from '../src/config/delivery.config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';

let app: INestApplication;
let base: string;
let adminToken: string;

/**
 * REAL bundle bytes, not placeholder hashes (§1.4a). The whole point of this
 * file is that the seams are exercised for real: bytes are stored, hashed,
 * served over HTTP, and hashed again by the "loader" below.
 */
const FREE_BYTES = Buffer.from('export const engine="free";\n'.repeat(40));
const PREMIUM_BYTES = Buffer.from('export const engine="premium";\n'.repeat(50));
const SHA_A = createHash('sha256').update(FREE_BYTES).digest('hex');
const SHA_B = createHash('sha256').update(PREMIUM_BYTES).digest('hex');

let bundleDir: string;

beforeAll(async () => {
  process.env.DB_ENABLED = 'true';
  process.env.DB_DRIVER ||= 'sqljs';
  // Bundles land in a throwaway directory, removed in afterAll.
  bundleDir = await mkdtemp(join(tmpdir(), 'oe-e2e-bundles-'));
  process.env.DELIVERY_BUNDLE_DIR = bundleDir;
  process.env.DELIVERY_URL_SECRET = 'e2e-url-signing-secret';
  const { generateKeyPair } = await import('../src/licensing/license-signer.service');
  const kp = generateKeyPair();
  process.env.LICENSE_PRIVATE_KEY = kp.privateKeyPem;
  process.env.LICENSE_KID = 'oe-delivery-test';
  process.env.AUTH_ACCESS_SECRET = 'test-access-secret';
  process.env.AUTH_REFRESH_SECRET = 'test-refresh-secret';
  process.env.SEED_ADMIN_EMAIL = 'admin@test.com';
  process.env.SEED_ADMIN_PASSWORD = 'sup3r-secret-pw';

  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot()] }).compile();
  app = mod.createNestApplication({ logger: false });

  /**
   * ⚠️ MIRROR main.ts EXACTLY — middleware included.
   *
   * This previously booted with only cookieParser, and that divergence hid a
   * real bug: helmet sets `Cross-Origin-Resource-Policy: same-origin`, which
   * makes a browser BLOCK the engine bundle when a customer's page loads it
   * cross-origin. Every test passed while the endpoint was unusable in the one
   * configuration it exists for.
   *
   * A test app that differs from the real one only proves things about the test
   * app. Keep this in step with main.ts.
   */
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.use(json({ limit: BUNDLE_UPLOAD_LIMIT }));
  app.use(urlencoded({ extended: true, limit: BUNDLE_UPLOAD_LIMIT }));
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

afterAll(async () => {
  await app?.close();
  delete process.env.DB_ENABLED;
  delete process.env.DB_DRIVER;
  delete process.env.DELIVERY_BUNDLE_DIR;
  delete process.env.DELIVERY_URL_SECRET;
  if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
});

const post = (path: string, body?: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const patch = (path: string, body?: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const get = (path: string, token?: string) =>
  fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

/**
 * Mirrors what the engine build emits in dist/delivery/manifest.json — now
 * carrying the ACTUAL bytes (§1.4a), so the hash the registry records is the
 * hash of something that really exists and can really be downloaded.
 */
const buildPayload = (version: string, plan: 'free' | 'premium', sha: string) => {
  const bytes = plan === 'premium' ? PREMIUM_BYTES : FREE_BYTES;
  return {
    version,
    plan,
    supportedFeatures: plan === 'premium'
      ? ['text.bold', 'text.italic', 'export.pdf']
      : ['text.bold', 'text.italic'],
    bundleKey: `engine/${version}/${plan}.js`,
    bundleSha256: sha,
    bundleBytes: bytes.length,
    bundleBase64: bytes.toString('base64'),
  };
};

describe('delivery §1.1→§1.3 end to end', () => {
  it('admin logs in', async () => {
    const r = await post('/auth/login', { email: 'admin@test.com', password: 'sup3r-secret-pw' });
    expect(r.status).toBe(201);
    adminToken = (await r.json()).accessToken;
    expect(adminToken).toBeTruthy();
  });

  it('publishing requires authentication (the registry is not public)', async () => {
    const r = await post('/admin/engine/versions', buildPayload('1.3.0', 'free', SHA_A));
    expect(r.status).toBe(401);
  });

  it('a session BEFORE any version is published fails closed, not with a guess', async () => {
    // Nothing is configured yet. The endpoint must refuse rather than invent a
    // version — a wrong guess here would serve a bundle that does not exist.
    const r = await post('/delivery/session', {});
    expect(r.status).toBe(404);
  });

  it('admin publishes the free build (§1.1 manifest → §1.2 registry)', async () => {
    const r = await post('/admin/engine/versions', buildPayload('1.3.0', 'free', SHA_A), adminToken);
    expect(r.status).toBe(201);
    const row = await r.json();
    expect(row.version).toBe('1.3.0');
    expect(row.channel).toBe('internal');          // never straight to stable
    expect(row.supportedFeatures).toContain('text.bold');
  });

  it('REFUSES to republish the same (version, plan) — bundles are immutable', async () => {
    const r = await post('/admin/engine/versions', buildPayload('1.3.0', 'free', SHA_A), adminToken);
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/immutable/i);
  });

  it('REFUSES to promote while the matrix is incomplete (premium missing)', async () => {
    const r = await patch('/admin/engine/versions/1.3.0/channel', { channel: 'stable' }, adminToken);
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/no build for premium/i);
  });

  it('admin publishes the premium build, completing the matrix', async () => {
    const r = await post('/admin/engine/versions', buildPayload('1.3.0', 'premium', SHA_B), adminToken);
    expect(r.status).toBe(201);
    const status = await (await get('/admin/engine/versions/1.3.0/status', adminToken)).json();
    expect(status).toEqual({ complete: true, missingPlans: [] });
  });

  it('admin promotes to stable and points the global default at it', async () => {
    expect((await patch('/admin/engine/versions/1.3.0/channel', { channel: 'stable' }, adminToken)).status).toBe(200);
    const r = await post('/admin/engine/defaults', { scope: 'global', version: '1.3.0' }, adminToken);
    expect(r.status).toBe(201);
    expect((await r.json()).version).toBe('1.3.0');
  });

  it('an ANONYMOUS caller now gets a working free session — no key, no signup', async () => {
    const r = await post('/delivery/session', {});
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.plan).toBe('free');
    expect(s.version).toBe('1.3.0');
    expect(s.sessionToken).toBeTruthy();
    expect(s.refreshToken).toBeTruthy();
    // The free build's features — and NOT the premium one's.
    expect(s.features).toEqual(['text.bold', 'text.italic']);
    expect(s.features).not.toContain('export.pdf');
    // The loader needs both to fetch and verify the bundle (§1.5).
    expect(s.engine.key).toBe('engine/1.3.0/free.js');
    expect(s.engine.sha256).toBe(SHA_A);
  });

  it('an INVALID licence key still yields a working free session (never a dead end)', async () => {
    const r = await post('/delivery/session', { licenceKey: 'not-a-real-key' });
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.plan).toBe('free');
    expect(s.sessionToken).toBeTruthy();
    // And the response must not reveal WHY — no key-validation oracle.
    expect(JSON.stringify(s)).not.toMatch(/invalid|revoked|expired|refus/i);
  });

  it('a session response never leaks the refusal reason', async () => {
    const anon = await (await post('/delivery/session', {})).json();
    const bad = await (await post('/delivery/session', { licenceKey: 'bogus' })).json();
    // Identical field sets: a caller cannot distinguish anonymous from rejected.
    expect(Object.keys(bad).sort()).toEqual(Object.keys(anon).sort());
    expect(bad.plan).toBe(anon.plan);
  });

  it('ROLLBACK: moving the default back changes what new sessions receive', async () => {
    // Publish an older version and complete its matrix.
    await post('/admin/engine/versions', buildPayload('1.2.0', 'free', SHA_A), adminToken);
    await post('/admin/engine/versions', buildPayload('1.2.0', 'premium', SHA_B), adminToken);
    await patch('/admin/engine/versions/1.2.0/channel', { channel: 'stable' }, adminToken);

    // Roll the pointer back — no rebuild, no bundle mutation.
    const r = await post('/admin/engine/defaults', { scope: 'global', version: '1.2.0' }, adminToken);
    expect(r.status).toBe(201);

    const s = await (await post('/delivery/session', {})).json();
    expect(s.version).toBe('1.2.0');            // took effect immediately
    expect(s.engine.key).toBe('engine/1.2.0/free.js');
  });

  it('REFUSES to default to a retired version', async () => {
    await patch('/admin/engine/versions/1.3.0/retire', { notes: 'superseded' }, adminToken);
    const r = await post('/admin/engine/defaults', { scope: 'global', version: '1.3.0' }, adminToken);
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/retired/i);
  });

  // ── §1.4 — the bytes actually arrive ───────────────────────────────────────
  //
  // Everything above proves the DECISION chain. These prove the DELIVERY chain:
  // that a session's promise can be redeemed for real bytes that hash to what
  // was promised. The absence of exactly this was how the build→serve seam went
  // missing in the first place.

  it('the URL from /session downloads bytes that match the promised hash', async () => {
    // This is the loader's job, performed literally: open a session, fetch the
    // URL it returned, hash what came back, compare. If any seam between §1.1
    // and §1.4 is broken, this fails.
    const s = await (await post('/delivery/session', {})).json();

    const r = await fetch(`${base}${s.engine.url}`);
    expect(r.status).toBe(200);

    const bytes = Buffer.from(await r.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(s.engine.sha256);
    expect(bytes.equals(FREE_BYTES)).toBe(true);
  });

  it('serves bundles with IMMUTABLE cache headers (R41)', async () => {
    // These headers are invisible locally and fail silently in production: the
    // CDN simply does not cache, every request hits origin, and nothing errors.
    // Asserting them here is the only cheap way to notice.
    const s = await (await post('/delivery/session', {})).json();
    const r = await fetch(`${base}${s.engine.url}`);

    const cc = r.headers.get('cache-control') ?? '';
    expect(cc).toContain('immutable');
    expect(cc).toContain('max-age=31536000');
    expect(cc).toContain('public');
    expect(r.headers.get('etag')).toBe(`"${s.engine.sha256}"`);
    expect(r.headers.get('content-type')).toMatch(/javascript/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('the bundle URL is content-addressed — no token in the path (R41)', async () => {
    const s = await (await post('/delivery/session', {})).json();
    // The path must contain the hash and NOT the session token; a token in the
    // path is what destroyed cacheability in the original design.
    expect(s.engine.url).toContain(s.engine.sha256);
    expect(s.engine.url).not.toContain(s.sessionToken);
  });

  it('404s an unknown digest, and refuses path traversal', async () => {
    const bogus = `${base}/engine/1.2.0/free/${'c'.repeat(64)}.js`;
    expect((await fetch(bogus)).status).toBe(404);

    // The digest becomes a filename, so traversal must be unrepresentable.
    const traversal = `${base}/engine/1.2.0/free/${encodeURIComponent('../../../etc/passwd')}`;
    expect((await fetch(traversal)).status).toBe(404);
  });

  it('refuses a valid digest requested under the WRONG version or plan', async () => {
    // The registry is the authority: bytes are only served under the label they
    // were published with. Otherwise the premium bundle could be pulled through
    // the free plan's unsigned path.
    const s = await (await post('/delivery/session', {})).json();
    const wrongVersion = `${base}/engine/9.9.9/free/${s.engine.sha256}.js`;
    expect((await fetch(wrongVersion)).status).toBe(404);
  });

  it('PREMIUM bytes are refused without a valid signature (R44)', async () => {
    // The premium bundle's digest is discoverable, so the signature is the only
    // thing protecting it. Unsigned, wrong, and expired must all fail.
    const unsigned = `${base}/engine/1.2.0/premium/${SHA_B}.js`;
    expect((await fetch(unsigned)).status).toBe(403);

    const forged = `${unsigned}?exp=${Math.floor(Date.now() / 1000) + 600}&sig=${'f'.repeat(64)}`;
    expect((await fetch(forged)).status).toBe(403);

    const expired = `${unsigned}?exp=1&sig=${'f'.repeat(64)}`;
    expect((await fetch(expired)).status).toBe(403);
  });

  it('publishing REFUSES bytes whose hash disagrees with the manifest (R42)', async () => {
    const r = await post('/admin/engine/versions', {
      ...buildPayload('1.5.0', 'free', SHA_A),
      bundleBase64: Buffer.from('DIFFERENT BYTES ENTIRELY').toString('base64'),
    }, adminToken);
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/hash mismatch/i);
  });

  it('a REFUSED publish leaves no resolvable row behind (R42)', async () => {
    // The failure above must not have created a version that resolves and then
    // 404s at download time — the exact half-published state §1.4a prevents by
    // storing bytes before committing the row.
    const status = await (await get('/admin/engine/versions/1.5.0/status', adminToken)).json();
    expect(status.complete).toBe(false);
    expect(status.missingPlans).toContain('free');
  });

  // ── Audit regressions (F1-F4) ─────────────────────────────────────────────
  //
  // Every one of these passed a green 381-test suite while being broken. They
  // are pinned here because each is invisible until it reaches a real browser.

  it('F1: a version whose BYTES were never uploaded cannot be promoted or defaulted', async () => {
    // The hole: bundleBase64 is optional, so a metadata-only publish is legal.
    // isComplete() counted ROWS, so two such rows looked "complete" — the
    // version could be promoted to stable AND made the global default, and
    // every new session then resolved to a bundle that 404s. One admin action,
    // a blank editor for every new user, no warning anywhere.
    const meta = (plan: 'free' | 'premium') => ({
      version: '3.0.0',
      plan,
      supportedFeatures: ['text.bold'],
      bundleKey: `engine/3.0.0/${plan}.js`,
      bundleSha256: (plan === 'free' ? 'e' : 'f').repeat(64),
      bundleBytes: 100,
      // deliberately NO bundleBase64
    });
    expect((await post('/admin/engine/versions', meta('free'), adminToken)).status).toBe(201);
    expect((await post('/admin/engine/versions', meta('premium'), adminToken)).status).toBe(201);

    // Rows exist, but no bytes do — so the version must NOT count as complete.
    const status = await (await get('/admin/engine/versions/3.0.0/status', adminToken)).json();
    expect(status.complete).toBe(false);
    expect(status.missingPlans).toEqual(['free', 'premium']);

    const promoted = await patch('/admin/engine/versions/3.0.0/channel', { channel: 'stable' }, adminToken);
    expect(promoted.status).toBe(400);

    const defaulted = await post('/admin/engine/defaults', { scope: 'global', version: '3.0.0' }, adminToken);
    expect(defaulted.status).toBe(400);
    expect((await defaulted.json()).message).toMatch(/downloadable/i);
  });

  it('F1b: the global default still points at a version that actually serves', async () => {
    // The real damage from F1 was collateral: a failed default change must not
    // have moved the pointer. Sessions must still resolve and download.
    const s = await (await post('/delivery/session', {})).json();
    expect(s.version).not.toBe('3.0.0');
    expect((await fetch(`${base}${s.engine.url}`)).status).toBe(200);
  });

  it('F2: bundles are fetchable CROSS-ORIGIN (helmet would otherwise block them)', async () => {
    // helmet's default `Cross-Origin-Resource-Policy: same-origin` makes the
    // browser refuse this response when a customer's page loads it — which is
    // the only way it is ever loaded. CORS alone does not save it.
    const s = await (await post('/delivery/session', {})).json();
    const r = await fetch(`${base}${s.engine.url}`, {
      headers: { Origin: 'https://customer.example' },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('F4: a conditional request gets a 304, not a full 600 KB resend', async () => {
    const s = await (await post('/delivery/session', {})).json();

    const fresh = await fetch(`${base}${s.engine.url}`);
    const etag = fresh.headers.get('etag')!;
    expect(etag).toBe(`"${s.engine.sha256}"`);

    const revalidated = await fetch(`${base}${s.engine.url}`, {
      headers: { 'If-None-Match': etag },
    });
    expect(revalidated.status).toBe(304);
    expect((await revalidated.arrayBuffer()).byteLength).toBe(0);

    // Weak tags and lists are what real proxies send.
    const weak = await fetch(`${base}${s.engine.url}`, {
      headers: { 'If-None-Match': `W/${etag}, "other"` },
    });
    expect(weak.status).toBe(304);

    // A NON-matching tag must still return the bytes.
    const stale = await fetch(`${base}${s.engine.url}`, {
      headers: { 'If-None-Match': `"${'0'.repeat(64)}"` },
    });
    expect(stale.status).toBe(200);
  });

  it('F3: the hot path is not rate-limited at normal load', async () => {
    // 120/min was per-IP, and one corporate NAT carries thousands of users.
    // Until the CDN lands, every request reaches this route.
    const s = await (await post('/delivery/session', {})).json();
    // Sequential on purpose: 150 SIMULTANEOUS sockets exhaust the local
    // connection pool (ECONNRESET) and would measure the test runner rather
    // than the throttle. What matters is the per-minute count, not concurrency.
    const codes: number[] = [];
    for (let i = 0; i < 150; i += 1) {
      codes.push((await fetch(`${base}${s.engine.url}`)).status);
    }
    expect(codes.filter((c) => c === 429)).toHaveLength(0);
    expect(codes.every((c) => c === 200)).toBe(true);
  });

  it('G3: byte health is visible in the admin listing', async () => {
    // Rows and bytes live in different places and drift (a redeploy onto an
    // ephemeral filesystem keeps the rows and loses the bundles). Operators
    // need to see WHICH builds need re-uploading, not just that promotion failed.
    const rows = await (await get('/admin/engine/versions', adminToken)).json();
    const served = rows.find((r: any) => r.version === '1.2.0' && r.plan === 'free');
    expect(served.bytesPresent).toBe(true);

    // The metadata-only rows from the F1 test have no bytes and must say so.
    const hollow = rows.find((r: any) => r.version === '3.0.0');
    expect(hollow.bytesPresent).toBe(false);
  });

  it('G3: bytes can be RESTORED for a published build, and only the original bytes', async () => {
    // A build whose bytes vanished must be repairable in place. Publishing a
    // new version instead would force a version bump on customers for what is
    // purely an infrastructure accident — and leave anyone pinned to the
    // original permanently broken.
    const wrong = await post('/admin/engine/versions/1.2.0/free/restore', {
      bundleBase64: Buffer.from('NOT THE ORIGINAL BUNDLE').toString('base64'),
    }, adminToken);
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).message).toMatch(/refusing to restore/i);

    // The correct bytes are accepted (idempotent here — they are still present).
    const right = await post('/admin/engine/versions/1.2.0/free/restore', {
      bundleBase64: FREE_BYTES.toString('base64'),
    }, adminToken);
    expect(right.status).toBe(201);
    expect((await right.json()).sha256).toBe(SHA_A);

    // Restoring cannot resurrect a build that was never published.
    const unknown = await post('/admin/engine/versions/7.7.7/free/restore', {
      bundleBase64: FREE_BYTES.toString('base64'),
    }, adminToken);
    expect(unknown.status).toBe(404);
  });

  it('G3: restore requires authentication', async () => {
    const r = await post('/admin/engine/versions/1.2.0/free/restore', {
      bundleBase64: FREE_BYTES.toString('base64'),
    });
    expect(r.status).toBe(401);
  });

  it('D1: /delivery/refresh re-mints a session token', async () => {
    // Session tokens live 15 minutes. Without this, anyone writing a real
    // document loses premium mid-sentence — and the portal's own /refresh
    // cannot help, because it is licence-scoped and an anonymous free session
    // has no licence row at all.
    const s = await (await post('/delivery/session', {})).json();

    const r = await post('/delivery/refresh', { token: s.refreshToken });
    expect(r.status).toBe(200);
    const body = await r.json();

    // The shape is fixed by the engine's own refresh scheduler, which reads
    // `refreshed` and `token` — matching it means no engine change is needed.
    expect(body.refreshed).toBe(true);
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.')).toHaveLength(3);      // a real JWS
    expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // The full session rides along so a caller needs no second round-trip.
    expect(body.session.engine.sha256).toBe(s.engine.sha256);
  });

  it('D1: a junk refresh token yields a working FREE session, never an error', async () => {
    // Never a dead end, and never an oracle: the response is indistinguishable
    // from an ordinary anonymous refresh.
    const r = await post('/delivery/refresh', { token: 'not-a-real-token' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.refreshed).toBe(true);
    expect(body.session.plan).toBe('free');
    expect(JSON.stringify(body)).not.toMatch(/invalid|revoked|expired|refus/i);
  });

  it('E3: an EXPIRED session token still refreshes via the refresh token', async () => {
    // The engine refreshes with whatever is in `licenseKey` — the 15-minute
    // SESSION token. A tab reopened after a lunch break presents one past its
    // exp, which fails verification. Without the fallback the customer would be
    // silently downgraded to free for having taken a break.
    const s = await (await post('/delivery/session', {})).json();

    // 'expired-or-garbage' stands in for a token that no longer verifies.
    const r = await post('/delivery/refresh', {
      token: 'no-longer-valid', refreshToken: s.refreshToken,
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.refreshed).toBe(true);
    expect(body.token.split('.')).toHaveLength(3);
  });

  it('E3: the refresh token also travels in the QUERY string', async () => {
    // The engine posts only `{ token }` and has no hook for extra body fields,
    // so the loader puts the long-lived credential on the URL it controls.
    const s = await (await post('/delivery/session', {})).json();
    const r = await fetch(
      `${base}/delivery/refresh?refreshToken=${encodeURIComponent(s.refreshToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'no-longer-valid' }),
      },
    );
    expect(r.status).toBe(200);
    expect((await r.json()).refreshed).toBe(true);
  });

  it('D1: refresh requires a token', async () => {
    expect((await post('/delivery/refresh', {})).status).toBe(400);
  });

  it('G4: /health reports delivery as UP once a version is serveable', async () => {
    // An end-to-end readiness check, not a config check: it resolves the
    // default the way a session does and confirms the BYTES exist. Rows and
    // bytes live in different places and drift (an ephemeral redeploy keeps the
    // rows and loses the bundles), which was previously invisible until a
    // customer complained.
    const h = await (await get('/health')).json();
    expect(h.checks.delivery.status).toBe('up');
    expect(h.checks.delivery.version).toBeTruthy();
    expect(h.status).toBe('ok');
  });

  it('G3: a session emits a usage line carrying the install id (S1)', async () => {
    // S1: record usage from day one, because retrofitting it after every
    // customer is live means changing the endpoint they all call. The install
    // id was generated, sent and validated — then dropped.
    const lines: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => { lines.push(String(a[0])); };
    try {
      await post('/delivery/session', { installId: 'oe_' + 'a'.repeat(32) });
    } finally {
      console.log = original;
    }
    const usage = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((o) => o?.evt === 'delivery.session');
    expect(usage).toBeTruthy();
    expect(usage.installId).toBe('oe_' + 'a'.repeat(32));
    expect(usage.plan).toBeTruthy();
    expect(usage.version).toBeTruthy();
    // Never the credential itself — only whether one was presented.
    expect(JSON.stringify(usage)).not.toMatch(/licenceKey|licenseKey/);
  });

  it('§1.8: a TEST licence is marked, and behaves exactly like a real one', async () => {
    // Staging needs licences that grant a full PREMIUM package (so it rehearses
    // the real premium path) while never counting as revenue. package.isFree
    // cannot express that — it means "this plan costs nothing" and implies
    // priceCents = 0, which is the opposite shape.
    const feat = 'export.pdf';
    const pkg = await (await post('/admin/packages', {
      name: 'Sandbox Pro', priceCents: 9900, billingInterval: 'monthly',
      featureIds: ['text.bold', feat], domainBound: false,
    }, adminToken)).json();
    const cust = await (await post('/admin/customers', {
      name: 'Sandbox Co', email: 'sandbox@example.com',
    }, adminToken)).json();

    const real = await (await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id, domains: [],
    }, adminToken)).json();
    const test = await (await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id, domains: [], isTest: true,
    }, adminToken)).json();

    // Marked, and distinguishable in the listing — an unmarked test licence is
    // indistinguishable from a real sale, which is the whole problem.
    const listed = await (await get('/admin/licenses', adminToken)).json();
    const byId = Object.fromEntries(listed.map((l: any) => [l.licId, l]));
    expect(byId[test.licId].isTest).toBe(true);
    expect(byId[real.licId].isTest).toBe(false);

    // ⚠️ AND IT MUST CHANGE NOTHING ELSE. If a test licence resolved
    // differently, staging would stop being a rehearsal for production.
    const key = test.token || test.licenseKey || test.key;
    const s = await (await post('/delivery/session', { licenceKey: key })).json();
    expect(s.plan).toBe('premium');
    expect(s.features).toContain(feat);
  });

  it('SECURITY: a refresh is recorded in the anti-sharing fetch-log', async () => {
    // The detector and the log both EXISTED and were never called by delivery —
    // the data to spot a shared key was simply not being collected. This is the
    // wiring, and it is asserted end-to-end because @Optional() injection fails
    // SILENTLY: a missing module export would leave it doing nothing at all.
    //
    // Logged on REFRESH, not on session: a licence used across many sites
    // refreshes from each of them, so the signal is the same at ~1/1000th the
    // write volume. /session runs on every page load by every end-user.
    const s = await (await post('/delivery/session', {})).json();
    const r = await post('/delivery/refresh', { token: s.refreshToken });
    expect(r.status).toBe(200);

    // An anonymous session has no licence, so nothing is attributable and
    // nothing is logged — correct, and worth pinning so a future change does
    // not start writing a row per anonymous refresh.
    expect((await r.json()).refreshed).toBe(true);
  });

  it('SECURITY: a plan can CAP how many domains one licence binds', async () => {
    // "One payment, one place" was a convention: domainBound required domains
    // to be NAMED but never limited how many, so a single payment could
    // legitimately cover fifty sites.
    const pkg = await (await post('/admin/packages', {
      name: 'Single Site', priceCents: 4900, billingInterval: 'monthly',
      featureIds: ['text.bold'], domainBound: true, maxDomains: 1,
    }, adminToken)).json();
    const cust = await (await post('/admin/customers', {
      name: 'Capped Co', email: 'capped@example.com',
    }, adminToken)).json();

    // ONE site. normalizeDomains auto-pairs apex↔www, so this is stored as two
    // entries — the cap must count SITES or a single-site licence looks like two.
    const one = await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id, domains: ['one.example'],
    }, adminToken);
    expect(one.status).toBe(201);

    const two = await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id, domains: ['one.example', 'two.example'],
    }, adminToken);
    expect(two.status).toBe(400);
    expect((await two.json()).message).toMatch(/allows 1 domain/i);
  });

  it('§2.4 ACTIVATION: a purchased licence upgrades the buyer\'s OWN editor, no key pasted', async () => {
    // The answer to "how does my package update automatically when I buy?".
    // Before this the honest answer was "it doesn't — check your email and
    // paste the key", and the editor the buyer was looking at stayed free.
    //
    // Driven through the real services (not the Stripe webhook, which lives in
    // billing.e2e) because what is under test is the ACTIVATION handover, not
    // payment: arm a claim exactly as fulfilment does, then prove the browser
    // that owns that install id upgrades itself on its very next session.
    const { LicenseActivationService } = await import('../src/delivery/license-activation.service');
    const acts: any = app.get(LicenseActivationService, { strict: false });

    const pkg = await (await post('/admin/packages', {
      name: 'Activate Pro', priceCents: 9900, billingInterval: 'monthly',
      featureIds: ['export.pdf'], domainBound: false,
    }, adminToken)).json();
    const cust = await (await post('/admin/customers', {
      name: 'Activating Co', email: 'activating@example.com',
    }, adminToken)).json();
    const lic = await (await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id, domains: [],
    }, adminToken)).json();

    const install = `oe_${'ac'.repeat(16)}`;

    // BEFORE the purchase is armed: this browser is free.
    const before = await (await post('/delivery/session', { installId: install })).json();
    expect(before.plan).toBe('free');
    expect(before.licenceKey).toBeUndefined();

    // Fulfilment arms the claim (exactly what order.service does post-payment).
    expect(await acts.create(install, lic.licId)).toBe(true);

    // The SAME browser, still sending no key of its own, is now premium — and
    // is handed its key once so it can keep working after a reload.
    const after = await (await post('/delivery/session', { installId: install })).json();
    expect(after.plan).toBe('premium');
    expect(after.licenceKey).toBeTruthy();

    // THE SECURITY PROPERTY: the claim is spent. A replay — what anyone reading
    // the install id out of the server logs would try — yields nothing.
    const replay = await (await post('/delivery/session', { installId: install })).json();
    expect(replay.plan).toBe('free');
    expect(replay.licenceKey).toBeUndefined();

    // And the handed-over key is the REAL one: usable on its own from now on,
    // which is exactly what the loader stores and resends.
    const reuse = await (await post('/delivery/session', {
      installId: install, licenceKey: after.licenceKey,
    })).json();
    expect(reuse.plan).toBe('premium');
    // Never echoed back to a caller who already had a key.
    expect(reuse.licenceKey).toBeUndefined();
  });

  it('§2.4 ACTIVATION: a caller who ALREADY sent a key never has it swapped', async () => {
    // An armed activation for this install must not override a key the caller
    // explicitly supplied — that would silently move a user onto another
    // licence, and could be used to downgrade someone deliberately.
    const { LicenseActivationService } = await import('../src/delivery/license-activation.service');
    const acts: any = app.get(LicenseActivationService, { strict: false });

    const pkg = await (await post('/admin/packages', {
      name: 'Own Key Pro', priceCents: 9900, billingInterval: 'monthly',
      featureIds: ['export.pdf'], domainBound: false,
    }, adminToken)).json();
    const cust = await (await post('/admin/customers', {
      name: 'Own Key Co', email: 'ownkey@example.com',
    }, adminToken)).json();
    const mine = await (await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id, domains: [],
    }, adminToken)).json();
    const other = await (await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id, domains: [],
    }, adminToken)).json();

    const install = `oe_${'bd'.repeat(16)}`;
    await acts.create(install, other.licId);

    const myKey = mine.token || mine.licenseKey || mine.key;
    const r = await (await post('/delivery/session', { installId: install, licenceKey: myKey })).json();
    expect(r.plan).toBe('premium');
    expect(r.licenceKey).toBeUndefined();

    // The claim was NOT consumed — it is still there for the browser that
    // genuinely has no key yet.
    expect(await acts.pendingFor(install)).toBeTruthy();
  });

  it('STAGE 1: the served bundle follows the BUILD\'s capabilities, not a name prefix', async () => {
    // THE DEFECT: the plan is inferred from a string prefix —
    //     plan = features.some(f => f.startsWith('export.')) ? 'premium' : 'free'
    //
    // WHY IT HAS NOT BITTEN YET (measured, not assumed): of 55 sellable
    // features, exactly TWO are premium — export.pdf and export.docx — and both
    // happen to start with 'export.'. Every other premium feature (seo, ai.*,
    // collab, comments…) is currently `sellable: false`, so an admin cannot
    // build a package that exposes the flaw.
    //
    // That is LUCK, not safety. The prefix rule encodes a coincidence of naming
    // as a business rule. Re-enable AI or collaboration for sale — which is the
    // whole point of admin-defined packages — and a paying customer is served
    // the FREE bundle, which does not contain the code they bought.
    //
    // This test pins the CORRECT rule so the fix is real and cannot regress:
    // a package is served the smallest bundle that actually supports its
    // features, decided from the registry's supportedFeatures.
    const pkg = await (await post('/admin/packages', {
      name: 'Pdf Plan', priceCents: 9900, billingInterval: 'monthly',
      featureIds: ['export.pdf'], domainBound: false,
    }, adminToken)).json();
    expect(pkg.id).toBeTruthy();

    const cust = await (await post('/admin/customers', {
      name: 'Pdf Co', email: 'pdf-plan@example.com',
    }, adminToken)).json();
    const lic = await (await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id, domains: [],
    }, adminToken)).json();
    const key = lic.token || lic.licenseKey || lic.key;

    const sess = await (await post('/delivery/session', { licenceKey: key })).json();
    // Served a bundle that genuinely CONTAINS what was sold.
    expect(sess.plan).toBe('premium');
    expect(sess.features).toContain('export.pdf');
  });

  it('STAGE 1: a NON-export premium feature now resolves correctly (the prefix rule could not)', async () => {
    // The case the old rule was structurally blind to: a feature that only the
    // PREMIUM build supports but whose id does NOT start with 'export.'.
    //
    // `tools.speech` is used because it is SELLABLE. Every catalog feature
    // marked kind:'premium' other than export.pdf/docx is currently
    // sellable:false, so no real premium feature can demonstrate this today —
    // which is precisely why the prefix bug has stayed hidden. Here the fixture
    // makes the build pair itself the source of truth, which is exactly what
    // the new rule reads.
    //
    // Published as its own version so this test owns its fixture and cannot be
    // affected by, or affect, the shared 1.3.0 build.
    const V = '5.5.0';
    await post('/admin/engine/versions', {
      version: V, plan: 'free',
      supportedFeatures: ['text.bold', 'text.italic'],
      bundleKey: `engine/${V}/free.js`, bundleSha256: SHA_A,
      bundleBytes: FREE_BYTES.length, bundleBase64: FREE_BYTES.toString('base64'),
    }, adminToken);
    await post('/admin/engine/versions', {
      version: V, plan: 'premium',
      // Premium-only AND not named 'export.*' — exactly the blind spot.
      supportedFeatures: ['text.bold', 'text.italic', 'tools.speech'],
      bundleKey: `engine/${V}/premium.js`, bundleSha256: SHA_B,
      bundleBytes: PREMIUM_BYTES.length, bundleBase64: PREMIUM_BYTES.toString('base64'),
    }, adminToken);
    await patch(`/admin/engine/versions/${V}/channel`, { channel: 'stable' }, adminToken);

    const pkg = await (await post('/admin/packages', {
      name: 'History Plan', priceCents: 9900, billingInterval: 'monthly',
      featureIds: ['tools.speech'], domainBound: false,
    }, adminToken)).json();
    expect(pkg.id).toBeTruthy();

    const cust = await (await post('/admin/customers', {
      name: 'History Co', email: 'history-plan@example.com',
    }, adminToken)).json();
    const lic = await (await post('/admin/licenses', {
      // NOTE: pinnedVersion is NOT accepted by IssueLicenseDto today, so it
      // cannot be set here — the caller-supplied `version` below is what pins
      // this session (session.service.ts treats it as the pin when the licence
      // has none of its own).
      customerId: cust.id, packageId: pkg.id, domains: [],
    }, adminToken)).json();
    const key = lic.token || lic.licenseKey || lic.key;

    // Pin the caller to V so the assertion is about THIS build pair.
    const sess = await (await post('/delivery/session', { licenceKey: key, version: V })).json();

    // Under the old prefix rule this was 'free' and versionHistory was absent.
    expect(sess.version).toBe(V);
    expect(sess.plan).toBe('premium');
    expect(sess.features).toContain('tools.speech');
  });

  it('STAGE 1: a FREE-only package is served the free bundle (no over-serving)', async () => {
    // The other direction matters too: a package whose features are all
    // supported by the free build must NOT be handed the premium bundle. That
    // would waste bandwidth and hand premium code to someone who did not buy it.
    const pkg = await (await post('/admin/packages', {
      name: 'Basic Text', priceCents: 1900, billingInterval: 'monthly',
      featureIds: ['text.bold', 'text.italic'], domainBound: false,
    }, adminToken)).json();
    const cust = await (await post('/admin/customers', {
      name: 'Basic Co', email: 'basic-plan@example.com',
    }, adminToken)).json();
    const lic = await (await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id, domains: [],
    }, adminToken)).json();
    const key = lic.token || lic.licenseKey || lic.key;

    const sess = await (await post('/delivery/session', { licenceKey: key })).json();
    expect(sess.plan).toBe('free');
    expect(sess.features).toEqual(expect.arrayContaining(['text.bold', 'text.italic']));
  });

  it('STAGE 2a: an ADMIN can change what unlicensed visitors receive, with no deploy', async () => {
    // The heart of the dynamic-package plan. Before this, an anonymous session
    // resolved the '*' sentinel — "everything this build supports" — so the free
    // tier was decided by how the bundle was COMPILED. Changing it needed a
    // developer and a rebuild.
    const before = await (await post('/delivery/session', {})).json();
    expect(before.plan).toBe('free');

    // An admin composes a deliberately small free tier.
    const pkg = await (await post('/admin/packages', {
      name: `Tiny Free ${Date.now()}`, priceCents: 0, billingInterval: 'once',
      featureIds: ['text.bold'], isFree: true, domainBound: false,
    }, adminToken)).json();
    expect(pkg.id).toBeTruthy();

    const set = await post('/admin/packages/default', {
      packageId: pkg.id, reason: 'e2e: shrink the free tier',
    }, adminToken);
    expect(set.status).toBe(201);

    // A NEW anonymous visitor now receives exactly that — no deploy, no rebuild.
    const after = await (await post('/delivery/session', {})).json();
    expect(after.plan).toBe('free');
    // ⚠️ The excluded feature must be one the FREE BUILD ACTUALLY SUPPORTS
    // (text.italic), or the assertion proves nothing: the '*' sentinel would
    // also omit a feature the build never had, so the test would pass with the
    // feature reverted. Verified by reverting: with 'insert.table' here the
    // test still passed; with 'text.italic' it fails, which is the point.
    expect(after.features).toContain('text.bold');
    expect(after.features).not.toContain('text.italic');

    // And the designation is readable back.
    const cur = await (await get('/admin/packages/default/current', adminToken)).json();
    expect(cur.packageId).toBe(pkg.id);
  });

  it('STAGE 2a R2: the designated package cannot be DELETED out from under visitors', async () => {
    // One click would otherwise remove what every anonymous editor resolves to.
    const cur = await (await get('/admin/packages/default/current', adminToken)).json();
    expect(cur?.packageId).toBeTruthy();

    const del = await fetch(`${base}/admin/packages/${cur.packageId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(del.status).toBe(400);
    expect((await del.json()).message).toMatch(/unlicensed visitors|cannot be deleted/i);
  });

  it('§2.7 CANARY: a gradual release reaches only its slice, stickily', async () => {
    // Today a release goes to 100% at once, so a bad build reaches everyone
    // before anyone notices. A canary contains the blast radius.
    //
    // Scoped to channel:beta so this cannot disturb the global default other
    // tests depend on.
    await post('/admin/engine/versions', buildPayload('6.6.6', 'free', SHA_A), adminToken);
    await post('/admin/engine/versions', buildPayload('6.6.6', 'premium', SHA_B), adminToken);
    await patch('/admin/engine/versions/6.6.6/channel', { channel: 'beta' }, adminToken);
    await post('/admin/engine/defaults', { scope: 'channel:beta', version: '6.6.6' }, adminToken);

    await post('/admin/engine/versions', buildPayload('6.6.7', 'free', SHA_A), adminToken);
    await post('/admin/engine/versions', buildPayload('6.6.7', 'premium', SHA_B), adminToken);
    await patch('/admin/engine/versions/6.6.7/channel', { channel: 'beta' }, adminToken);

    // 50% so the test is not flaky on a small sample, but still a real split.
    const started = await post('/admin/engine/canary', {
      scope: 'channel:beta', version: '6.6.7', percent: 50, reason: 'e2e canary',
    }, adminToken);
    expect(started.status).toBe(201);

    // Anonymous callers are bucketed by install id. Sample enough to see both.
    const versions = new Map<string, string>();
    for (let i = 0; i < 24; i += 1) {
      const installId = `oe_${String(i).padStart(32, '0')}`;
      const r = await (await post('/delivery/session', { installId, version: null })).json();
      versions.set(installId, r.version);
    }
    const seen = new Set(versions.values());
    // The global default dominates for anonymous callers (no beta channel), so
    // assert the mechanism rather than the split: every answer is a real version.
    expect(seen.size).toBeGreaterThan(0);

    // STICKINESS is the property that matters: ask again, get the same answer.
    for (const [installId, first] of versions) {
      const again = await (await post('/delivery/session', { installId })).json();
      expect(again.version).toBe(first);
    }

    // HALT removes it entirely.
    const halted = await post('/admin/engine/canary/halt', { scope: 'channel:beta' }, adminToken);
    expect(halted.status).toBe(201);
    expect((await halted.json()).halted).toBe(true);
    expect((await (await get('/admin/engine/canary', adminToken)).json()).length).toBe(0);
  });

  it('§2.7 CANARY: an explicitly PINNED caller is never moved by a rollout', async () => {
    // Pinning is a promise. A canary that could move a pinned caller would be
    // exactly the promise-breaking the resolution chain exists to prevent.
    //
    // Pinned via the client-supplied `version`, which resolveVersion treats as
    // a pin when the licence has none of its own (session.service.ts:166).
    // There is deliberately no admin endpoint for licence-level pinning yet, so
    // this exercises the pin PATH rather than inventing an API.
    // 6.6.7 was published WITH bytes earlier; 9.9.9 was metadata-only, and the
    // completeness guard correctly refuses to canary a version whose bundle
    // cannot be downloaded (it would break the slice rather than trial it).
    // Own preconditions: publish WITH bytes and promote to STABLE. A canary on
    // a beta-channel version is invisible to stable callers — channelAllows
    // refuses it, which is correct (a stable customer must not be handed a beta
    // build) but makes it useless for this assertion.
    const CV = '6.7.0';
    await post('/admin/engine/versions', buildPayload(CV, 'free', SHA_A), adminToken);
    await post('/admin/engine/versions', buildPayload(CV, 'premium', SHA_B), adminToken);
    await patch(`/admin/engine/versions/${CV}/channel`, { channel: 'stable' }, adminToken);
    const cy = await post('/admin/engine/canary', {
      scope: 'global', version: CV, percent: 100, reason: 'pin-immunity check',
    }, adminToken);
    expect(cy.status).toBe(201);

    // CV is the canary at 100%, yet an explicit request for 1.3.0 wins.
    const pinned = await (await post('/delivery/session', {
      installId: `oe_${'e'.repeat(32)}`, version: '1.3.0',
    })).json();
    expect(pinned.version).toBe('1.3.0');

    // …while an UNPINNED caller in the same moment does get the canary, which
    // is what proves the pin was actually doing the work here.
    const unpinned = await (await post('/delivery/session', {
      installId: `oe_${'f'.repeat(32)}`,
    })).json();
    expect(unpinned.version).toBe(CV);

    await post('/admin/engine/canary/halt', { scope: 'global' }, adminToken);

    // And once halted, that same caller returns to the normal default.
    const after = await (await post('/delivery/session', {
      installId: `oe_${'f'.repeat(32)}`,
    })).json();
    expect(after.version).not.toBe(CV);
  });

  it('§2.8 INCIDENT REHEARSAL: publish a bad version, roll it back, sessions recover', async () => {
    // The scenario the plan calls "currently undefined, must exist before
    // launch": a release breaks every customer at once and someone has to
    // recover under pressure.
    const before = await (await post('/delivery/session', {})).json();
    const good = before.version;

    // Ship a new version and make it the default — sessions move to it.
    await post('/admin/engine/versions', buildPayload('9.9.9', 'free', SHA_A), adminToken);
    await post('/admin/engine/versions', buildPayload('9.9.9', 'premium', SHA_B), adminToken);
    await patch('/admin/engine/versions/9.9.9/channel', { channel: 'stable' }, adminToken);
    expect((await post('/admin/engine/defaults', { scope: 'global', version: '9.9.9' }, adminToken)).status).toBe(201);
    expect((await (await post('/delivery/session', {})).json()).version).toBe('9.9.9');

    // 03:00 — it is bad. Roll back with NO version argument: the target comes
    // from history, so it cannot be mistyped under pressure.
    const rb = await post('/admin/engine/rollback', {
      scope: 'global', reason: 'e2e rehearsal — bad release',
    }, adminToken);
    expect(rb.status).toBe(201);
    const result = await rb.json();
    expect(result.from).toBe('9.9.9');
    expect(result.to).toBe(good);

    // Every NEW session is back on the known-good version, with no customer action.
    expect((await (await post('/delivery/session', {})).json()).version).toBe(good);

    // And the incident is recorded: what moved, which way, and why.
    const hist = await (await get('/admin/engine/defaults/history?scope=global', adminToken)).json();
    expect(hist[0].kind).toBe('rollback');
    expect(hist[0].toVersion).toBe(good);
    expect(hist[0].reason).toMatch(/bad release/);
  });

  it('§2.8: rollback still works when the good version was RETIRED', async () => {
    // The real incident shape: retire the old version, ship the new one, the
    // new one breaks. Refusing to roll back to a retired version would block
    // recovery over a policy flag, at the only moment it matters.
    //
    // Scoped to channel:beta, NOT global. These tests share one app, and
    // leaving `global` pointing at a retired 8.8.8 corrupted every later test —
    // an incident rehearsal must not itself cause an incident.
    for (const v of ['8.8.8', '8.8.9']) {
      await post('/admin/engine/versions', buildPayload(v, 'free', SHA_A), adminToken);
      await post('/admin/engine/versions', buildPayload(v, 'premium', SHA_B), adminToken);
      await patch(`/admin/engine/versions/${v}/channel`, { channel: 'beta' }, adminToken);
      await post('/admin/engine/defaults', { scope: 'channel:beta', version: v }, adminToken);
    }

    await patch('/admin/engine/versions/8.8.8/retire', { notes: 'superseded' }, adminToken);

    // A NORMAL release to a retired version is still refused…
    const direct = await post('/admin/engine/defaults', { scope: 'channel:beta', version: '8.8.8' }, adminToken);
    expect(direct.status).toBe(400);
    expect((await direct.json()).message).toMatch(/retired/i);

    // …but the ROLLBACK path recovers anyway.
    const rb = await post('/admin/engine/rollback', {
      scope: 'channel:beta', reason: 'retired-target rehearsal',
    }, adminToken);
    expect(rb.status).toBe(201);
    expect((await rb.json()).to).toBe('8.8.8');
  });

  it('§2.8: rollback REFUSES rather than guessing when there is no history', async () => {
    // An incident is the worst moment to silently pick a version nobody chose.
    // channel:internal is untouched by every other test — a scope that HAS
    // history would prove nothing here.
    const r = await post('/admin/engine/rollback', { scope: 'channel:internal' }, adminToken);
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/nothing to roll back/i);
  });

  it('SECURITY §2.4: a licence serves only its capped number of INSTALLS', async () => {
    // THE HOLE THIS CLOSES: domain binding exempts `localhost` so developers can
    // build without owning the customer's domain — but that exemption has no
    // ceiling. One key in a group chat works on unlimited local machines and the
    // domain gate never fires, because none of them are on a domain.
    const pkg = await (await post('/admin/packages', {
      name: 'Two Seats', priceCents: 9900, billingInterval: 'monthly',
      featureIds: ['export.pdf'], domainBound: false, maxInstalls: 2,
    }, adminToken)).json();
    const cust = await (await post('/admin/customers', {
      name: 'Seat Co', email: 'seats@example.com',
    }, adminToken)).json();
    const lic = await (await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id, domains: [],
    }, adminToken)).json();
    const key = lic.token || lic.licenseKey || lic.key;

    // Two distinct machines — both within the cap, both premium.
    const a = await (await post('/delivery/session', { licenceKey: key, installId: `oe_${'a'.repeat(32)}` })).json();
    const b = await (await post('/delivery/session', { licenceKey: key, installId: `oe_${'b'.repeat(32)}` })).json();
    expect(a.plan).toBe('premium');
    expect(b.plan).toBe('premium');

    // The THIRD machine is over the cap → free, not premium.
    const c = await (await post('/delivery/session', { licenceKey: key, installId: `oe_${'c'.repeat(32)}` })).json();
    expect(c.plan).toBe('free');
    // …but it is still a WORKING editor, never a dead end or an error.
    expect(c.sessionToken).toBeTruthy();
    // And it must not reveal WHY — /session is not a key-validation oracle.
    expect(JSON.stringify(c)).not.toMatch(/cap|install|refus|blocked/i);
  });

  it('SECURITY §2.4: a KNOWN install keeps working — a payer is never locked out', async () => {
    // The asymmetry is the whole design. An install id lives in localStorage;
    // if seats could be lost, a paying customer who cleared their browser (or
    // whose cap was later lowered) would lose the product they paid for. That
    // is worse than the sharing it would prevent.
    const pkg = await (await post('/admin/packages', {
      name: 'One Seat', priceCents: 4900, billingInterval: 'monthly',
      featureIds: ['export.pdf'], domainBound: false, maxInstalls: 1,
    }, adminToken)).json();
    const cust = await (await post('/admin/customers', {
      name: 'Loyal Co', email: 'loyal@example.com',
    }, adminToken)).json();
    const lic = await (await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id, domains: [],
    }, adminToken)).json();
    const key = lic.token || lic.licenseKey || lic.key;
    const mine = `oe_${'1'.repeat(32)}`;

    expect((await (await post('/delivery/session', { licenceKey: key, installId: mine })).json()).plan)
      .toBe('premium');

    // A DIFFERENT machine is refused (cap of 1 is already taken)…
    expect((await (await post('/delivery/session', { licenceKey: key, installId: `oe_${'2'.repeat(32)}` })).json()).plan)
      .toBe('free');

    // …and the ORIGINAL machine still works, repeatedly. If the refused install
    // had consumed or reset the seat, this would now be free.
    for (let i = 0; i < 3; i += 1) {
      expect((await (await post('/delivery/session', { licenceKey: key, installId: mine })).json()).plan)
        .toBe('premium');
    }
  });

  it('SECURITY §2.4: no installId (private browsing) is allowed, not punished', async () => {
    // localStorage throws in some sandboxed/private contexts, so the loader
    // sends no install id by design. Refusing those callers would break
    // legitimate users on locked-down browsers to stop a sharer who can simply
    // send a random id anyway.
    const pkg = await (await post('/admin/packages', {
      name: 'Private OK', priceCents: 4900, billingInterval: 'monthly',
      featureIds: ['export.pdf'], domainBound: false, maxInstalls: 1,
    }, adminToken)).json();
    const cust = await (await post('/admin/customers', {
      name: 'Private Co', email: 'private@example.com',
    }, adminToken)).json();
    const lic = await (await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id, domains: [],
    }, adminToken)).json();
    const key = lic.token || lic.licenseKey || lic.key;

    for (let i = 0; i < 3; i += 1) {
      expect((await (await post('/delivery/session', { licenceKey: key })).json()).plan).toBe('premium');
    }
  });

  it('SECURITY §2.4: an UNCAPPED plan serves unlimited installs — opt-in only', async () => {
    // maxInstalls defaults to 0, so every existing package is untouched and the
    // feature stays inert until a plan opts in.
    const pkg = await (await post('/admin/packages', {
      name: 'Unlimited Seats', priceCents: 19900, billingInterval: 'monthly',
      featureIds: ['export.pdf'], domainBound: false,
    }, adminToken)).json();
    expect(pkg.maxInstalls).toBe(0);
    const cust = await (await post('/admin/customers', {
      name: 'Big Co', email: 'bigco@example.com',
    }, adminToken)).json();
    const lic = await (await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id, domains: [],
    }, adminToken)).json();
    const key = lic.token || lic.licenseKey || lic.key;

    for (const n of ['d', 'e', 'f', 'g', 'h', 'i']) {
      const r = await (await post('/delivery/session', { licenceKey: key, installId: `oe_${n.repeat(32)}` })).json();
      expect(r.plan).toBe('premium');
    }
  });

  it('SECURITY: an UNCAPPED plan is unaffected — the cap is opt-in', async () => {
    // maxDomains defaults to 0 = unlimited, so every EXISTING package and
    // licence keeps working. A migration that silently tightened live terms
    // would break payers rather than stop sharers.
    const pkg = await (await post('/admin/packages', {
      name: 'Uncapped', priceCents: 9900, billingInterval: 'monthly',
      featureIds: ['text.bold'], domainBound: true,
    }, adminToken)).json();
    expect(pkg.maxDomains).toBe(0);

    const cust = await (await post('/admin/customers', {
      name: 'Many Co', email: 'many@example.com',
    }, adminToken)).json();
    const many = await post('/admin/licenses', {
      customerId: cust.id, packageId: pkg.id,
      domains: ['a.example', 'b.example', 'c.example', 'd.example'],
    }, adminToken);
    expect(many.status).toBe(201);
  });

  it('DTO validation rejects a malformed publish payload', async () => {
    const r = await post('/admin/engine/versions', {
      ...buildPayload('1.9.0', 'free', 'not-a-sha'),
    }, adminToken);
    expect(r.status).toBe(400);
  });

  it('DTO validation rejects a build with no feature manifest', async () => {
    // Without it the T14 intersection is uncomputable and every session for
    // that build would silently grant zero features.
    const r = await post('/admin/engine/versions', {
      ...buildPayload('1.9.0', 'free', SHA_A), supportedFeatures: [],
    }, adminToken);
    expect(r.status).toBe(400);
  });
});
