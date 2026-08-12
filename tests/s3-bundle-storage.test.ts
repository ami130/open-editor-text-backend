/**
 * s3-bundle-storage.test.ts — the S3 driver against a REAL S3-compatible server
 * (execution plan §2.0, decision T21).
 *
 * ─── WHY A REAL SERVER, NOT A MOCK ──────────────────────────────────────────
 * The whole reason this driver exists is that local disk is per-instance. A
 * mocked S3 client would prove only that we call the SDK — not that the bytes
 * survive a round trip, that a 650 KB binary payload is not corrupted, or that
 * the request is signed correctly. MinIO is S3-compatible and runs locally, so
 * the real driver is exercised.
 *
 * ⚠️ SKIPS LOUDLY without a server. A silent skip would let this file report
 * success while proving nothing — the same blind spot the migration-SQL tests
 * exist to close.
 *
 *   brew install minio
 *   MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
 *     minio server /tmp/minio-data --address ":9100" --console-address ":9101"
 *
 * Override the endpoint with TEST_S3_ENDPOINT to run against any other
 * S3-compatible store.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll } from 'vitest';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { S3BundleStorage } from '../src/delivery/s3-bundle-storage';
import { createHash } from 'node:crypto';

const ENDPOINT = process.env.TEST_S3_ENDPOINT || 'http://127.0.0.1:9100';

const OPTS = {
  bucket: 'oe-bundles-test',
  region: 'us-east-1',
  endpoint: ENDPOINT,
  accessKeyId: process.env.TEST_S3_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.TEST_S3_SECRET_KEY || 'minioadmin',
  // MinIO needs path-style; virtual-host style would require wildcard DNS.
  forcePathStyle: true,
  prefix: 'engine',
};

/** Is a server actually listening? Decides run-vs-skip, and says so. */
async function serverUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    await fetch(`${ENDPOINT}/minio/health/live`, { signal: ctrl.signal }).catch(() => {
      throw new Error('down');
    });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

const up = await serverUp();
if (!up) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n  ⚠️  SKIPPING S3 storage tests — no S3 server at ${ENDPOINT}.\n`
    + '     The object-storage driver is UNVERIFIED in this run.\n'
    + '     Start one:  minio server /tmp/minio-data --address ":9100"\n',
  );
}

beforeAll(async () => {
  const c = new S3Client({
    region: OPTS.region, endpoint: OPTS.endpoint, forcePathStyle: true,
    credentials: { accessKeyId: OPTS.accessKeyId, secretAccessKey: OPTS.secretAccessKey },
  });
  await c.send(new CreateBucketCommand({ Bucket: OPTS.bucket })).catch(() => {});
}, 30000);

(up ? describe : describe.skip)('S3BundleStorage against a real S3 server', () => {
  const store = new S3BundleStorage(OPTS);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  it('round-trips bytes under their own digest', async () => {
    const bytes = Buffer.from('export const engine = "s3";');
    const digest = await store.put(bytes);
    expect(digest).toBe(sha(bytes));
    const got = await store.get(digest);
    expect(got?.bytes.equals(bytes)).toBe(true);
  }, 30000);

  it('round-trips a REAL-SIZED bundle without corruption', async () => {
    const bytes = Buffer.alloc(650_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;   // binary-ish
    const digest = await store.put(bytes);
    const got = await store.get(digest);
    expect(got!.bytes.length).toBe(650_000);
    expect(sha(got!.bytes)).toBe(digest);
  }, 60000);

  it('is idempotent — re-publishing identical bytes is a no-op', async () => {
    const bytes = Buffer.from('same bytes');
    expect(await store.put(bytes)).toBe(await store.put(bytes));
  }, 30000);

  it('has() is true only after a put', async () => {
    // Unique per run: the store is CONTENT-ADDRESSED and persistent, so a fixed
    // payload would already exist from a previous run and the "before" assertion
    // would fail — a flaw in the test, not the driver.
    const bytes = Buffer.from(`presence check ${Math.random()}`);
    expect(await store.has(sha(bytes))).toBe(false);
    await store.put(bytes);
    expect(await store.has(sha(bytes))).toBe(true);
  }, 30000);

  it('a miss is null, never a throw', async () => {
    expect(await store.get('a'.repeat(64))).toBeNull();
  }, 30000);

  it('refuses a non-digest key (prefix escape)', async () => {
    for (const bad of ['../../secret', 'a'.repeat(63), 'G'.repeat(64), '']) {
      expect(await store.get(bad)).toBeNull();
      expect(await store.has(bad)).toBe(false);
    }
  }, 30000);
});
