/**
 * s3-delivery-e2e.test.ts — the WHOLE delivery chain on object storage (§2.0).
 *
 * The driver's own tests prove put/get/has. This proves the thing that actually
 * matters: that publishing, resolving, serving and the health check all behave
 * identically when the bytes live in S3 instead of on local disk.
 *
 * If §2.0 only swapped the driver but broke publish or the engine endpoint, the
 * unit tests would still pass. This is the seam.
 *
 * Skips loudly without a server — see s3-bundle-storage.test.ts.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { createHash } from 'node:crypto';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { BUNDLE_UPLOAD_LIMIT } from '../src/config/delivery.config';

const ENDPOINT = process.env.TEST_S3_ENDPOINT || 'http://127.0.0.1:9100';
const BUCKET = 'oe-e2e-bundles';

async function serverUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(`${ENDPOINT}/minio/health/live`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}
const up = await serverUp();
if (!up) {
  // eslint-disable-next-line no-console
  console.warn(`\n  ⚠️  SKIPPING S3 delivery e2e — no S3 server at ${ENDPOINT}.\n`);
}

let app: INestApplication;
let base: string;
let adminToken: string;

const FREE = Buffer.from('export const engine="free-s3";\n'.repeat(40));
const PREM = Buffer.from('export const engine="premium-s3";\n'.repeat(50));
const SHA_F = createHash('sha256').update(FREE).digest('hex');
const SHA_P = createHash('sha256').update(PREM).digest('hex');

const post = (p: string, b?: unknown, t?: string) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  body: b ? JSON.stringify(b) : undefined,
});
const patch = (p: string, b: unknown, t: string) => fetch(`${base}${p}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
  body: JSON.stringify(b),
});
const get = (p: string, t?: string) =>
  fetch(`${base}${p}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });

(up ? describe : describe.skip)('delivery chain on OBJECT STORAGE (§2.0)', () => {
  beforeAll(async () => {
    const c = new S3Client({
      region: 'us-east-1', endpoint: ENDPOINT, forcePathStyle: true,
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    });
    await c.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => {});

    process.env.DB_ENABLED = 'true';
    process.env.DB_DRIVER ||= 'sqljs';
    // THE POINT OF THIS FILE: s3, not local.
    process.env.DELIVERY_STORAGE = 's3';
    process.env.DELIVERY_S3_ENDPOINT = ENDPOINT;
    process.env.DELIVERY_S3_BUCKET = BUCKET;
    process.env.DELIVERY_S3_ACCESS_KEY_ID = 'minioadmin';
    process.env.DELIVERY_S3_SECRET_ACCESS_KEY = 'minioadmin';
    process.env.DELIVERY_S3_PREFIX = 'engine';
    process.env.DELIVERY_URL_SECRET = 's3-e2e-secret';
    const { generateKeyPair } = await import('../src/licensing/license-signer.service');
    process.env.LICENSE_PRIVATE_KEY = generateKeyPair().privateKeyPem;
    process.env.LICENSE_KID = 'oe-s3-e2e';
    process.env.AUTH_ACCESS_SECRET = 'a';
    process.env.AUTH_REFRESH_SECRET = 'b';
    process.env.SEED_ADMIN_EMAIL = 'admin@test.com';
    process.env.SEED_ADMIN_PASSWORD = 'sup3r-secret-pw';

    const { AppModule } = await import('../src/app.module');
    const mod = await Test.createTestingModule({ imports: [AppModule.forRoot()] }).compile();
    app = mod.createNestApplication({ logger: false });
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(cookieParser());
    app.use(json({ limit: BUNDLE_UPLOAD_LIMIT }));
    app.use(urlencoded({ extended: true, limit: BUNDLE_UPLOAD_LIMIT }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

    adminToken = (await (await post('/auth/login', {
      email: 'admin@test.com', password: 'sup3r-secret-pw',
    })).json()).accessToken;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    for (const k of ['DELIVERY_STORAGE', 'DELIVERY_S3_ENDPOINT', 'DELIVERY_S3_BUCKET',
      'DELIVERY_S3_ACCESS_KEY_ID', 'DELIVERY_S3_SECRET_ACCESS_KEY', 'DELIVERY_S3_PREFIX',
      'DB_ENABLED', 'DB_DRIVER']) delete process.env[k];
  });

  it('publishes both plans — bytes land in S3, not on disk', async () => {
    for (const [plan, bytes, sha] of [['free', FREE, SHA_F], ['premium', PREM, SHA_P]] as const) {
      const r = await post('/admin/engine/versions', {
        version: '5.0.0', plan,
        supportedFeatures: plan === 'premium' ? ['text.bold', 'export.pdf'] : ['text.bold'],
        bundleKey: `engine/5.0.0/${plan}.js`,
        bundleSha256: sha, bundleBytes: bytes.length,
        bundleBase64: bytes.toString('base64'),
      }, adminToken);
      expect(r.status, `${plan} publish`).toBe(201);
    }
    await patch('/admin/engine/versions/5.0.0/channel', { channel: 'stable' }, adminToken);
    await post('/admin/engine/defaults', { scope: 'global', version: '5.0.0' }, adminToken);
  }, 120_000);

  it('isComplete() sees the bytes IN S3 — promote/default would fail otherwise', async () => {
    const s = await (await get('/admin/engine/versions/5.0.0/status', adminToken)).json();
    expect(s).toEqual({ complete: true, missingPlans: [] });
  }, 60_000);

  it('a session downloads REAL bytes from S3, hash-verified', async () => {
    const s = await (await post('/delivery/session', {})).json();
    expect(s.version).toBe('5.0.0');

    const r = await fetch(`${base}${s.engine.url}`);
    expect(r.status).toBe(200);
    const bytes = Buffer.from(await r.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(s.engine.sha256);
    expect(bytes.equals(FREE)).toBe(true);
    // The §1.4 headers must survive the driver swap.
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(r.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  }, 60_000);

  it('premium is STILL refused without a signature (R44 holds on S3)', async () => {
    expect((await fetch(`${base}/engine/5.0.0/premium/${SHA_P}.js`)).status).toBe(403);
  }, 60_000);

  it('/health reports delivery UP when bytes live in S3', async () => {
    const h = await (await get('/health')).json();
    expect(h.checks.delivery.status).toBe('up');
    expect(h.checks.delivery.version).toBe('5.0.0');
  }, 60_000);

  it('restore re-uploads to S3, and still refuses foreign bytes', async () => {
    const wrong = await post('/admin/engine/versions/5.0.0/free/restore', {
      bundleBase64: Buffer.from('NOT THE ORIGINAL').toString('base64'),
    }, adminToken);
    expect(wrong.status).toBe(400);

    const right = await post('/admin/engine/versions/5.0.0/free/restore', {
      bundleBase64: FREE.toString('base64'),
    }, adminToken);
    expect(right.status).toBe(201);
  }, 60_000);
});
