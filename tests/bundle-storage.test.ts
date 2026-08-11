/**
 * bundle-storage.test.ts — the local BundleStorage driver (§1.4a).
 *
 * These bytes ARE the product. If storage silently corrupts, truncates, or
 * mixes up a bundle, the failure surfaces in a customer's browser as an
 * integrity mismatch or broken editor — a long way from its cause. So the
 * driver's guarantees are pinned here rather than assumed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalBundleStorage } from '../src/delivery/local-bundle-storage';
import { digestOf, isValidDigest } from '../src/delivery/bundle-storage';

let root: string;
let store: LocalBundleStorage;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'oe-bundles-'));
  store = new LocalBundleStorage(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('put / get — content-addressed round trip', () => {
  it('stores bytes under their own digest and returns them unchanged', async () => {
    const bytes = Buffer.from('export const editor = 1;');
    const digest = await store.put(bytes);

    expect(digest).toBe(sha(bytes));
    const got = await store.get(digest);
    expect(got?.bytes.equals(bytes)).toBe(true);
  });

  it('round-trips BINARY content without corruption', async () => {
    // A real bundle is UTF-8 JS, but nothing in the driver should assume text —
    // an encoding assumption here would corrupt bytes in a way that only shows
    // up as an integrity mismatch in the browser.
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x1f, 0x80, 0x00, 0x7f]);
    const digest = await store.put(bytes);
    const got = await store.get(digest);
    expect(got?.bytes.equals(bytes)).toBe(true);
  });

  it('handles a realistically large bundle', async () => {
    const bytes = Buffer.alloc(700_000, 'x');
    const digest = await store.put(bytes);
    const got = await store.get(digest);
    expect(got?.bytes.length).toBe(700_000);
    expect(sha(got!.bytes)).toBe(digest);
  });

  it('keeps distinct bundles distinct', async () => {
    const free = Buffer.from('FREE BUNDLE');
    const premium = Buffer.from('PREMIUM BUNDLE');
    const a = await store.put(free);
    const b = await store.put(premium);

    expect(a).not.toBe(b);
    expect((await store.get(a))!.bytes.toString()).toBe('FREE BUNDLE');
    expect((await store.get(b))!.bytes.toString()).toBe('PREMIUM BUNDLE');
  });
});

describe('idempotence — republishing identical bytes is not a conflict', () => {
  it('storing the same bytes twice yields one file and the same digest', async () => {
    const bytes = Buffer.from('same');
    const first = await store.put(bytes);
    const second = await store.put(bytes);

    expect(second).toBe(first);
    const files = (await readdir(root)).filter((f) => f.endsWith('.bundle'));
    expect(files).toHaveLength(1);
  });

  it('concurrent writes of the same bytes do not corrupt each other', async () => {
    // Content-addressing makes this safe by construction — every writer is
    // writing byte-identical data — but the atomic-rename path must hold up.
    const bytes = Buffer.alloc(50_000, 'z');
    const digests = await Promise.all(
      Array.from({ length: 8 }, () => store.put(bytes)),
    );
    expect(new Set(digests).size).toBe(1);
    const got = await store.get(digests[0]);
    expect(got!.bytes.equals(bytes)).toBe(true);
  });
});

describe('misses are misses, never errors', () => {
  it('get() resolves null for an absent bundle', async () => {
    expect(await store.get('a'.repeat(64))).toBeNull();
  });

  it('has() is false for an absent bundle, true once stored', async () => {
    const bytes = Buffer.from('present');
    expect(await store.has(sha(bytes))).toBe(false);
    await store.put(bytes);
    expect(await store.has(sha(bytes))).toBe(true);
  });
});

describe('path traversal — the digest becomes a FILENAME', () => {
  // get()/has() are reachable from a URL parameter, so a digest that is not a
  // digest must never be turned into a path. These are treated as misses rather
  // than errors so the endpoint answers 404 uniformly and reveals nothing.
  const attacks = [
    '../../../../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    'a/../../secret',
    '/etc/passwd',
    'a'.repeat(63),          // too short
    'a'.repeat(65),          // too long
    'A'.repeat(64),          // uppercase is not our canonical form
    'g'.repeat(64),          // not hex
    '',
  ];

  it.each(attacks)('refuses %j', async (bad) => {
    expect(isValidDigest(bad)).toBe(false);
    expect(await store.get(bad)).toBeNull();
    expect(await store.has(bad)).toBe(false);
  });

  it('cannot read a file that exists outside the store', async () => {
    const outside = join(root, '..', `oe-secret-${process.pid}.txt`);
    await writeFile(outside, 'top secret');
    try {
      expect(await store.get(`../oe-secret-${process.pid}.txt`)).toBeNull();
    } finally {
      await rm(outside, { force: true });
    }
  });
});

describe('atomicity — a reader never sees a partial bundle', () => {
  it('leaves no temp files behind after a successful write', async () => {
    await store.put(Buffer.from('clean'));
    const stray = (await readdir(root)).filter((f) => f.startsWith('.tmp-'));
    expect(stray).toEqual([]);
  });

  it('only ever exposes complete files, because writes are renamed into place', async () => {
    // Every file visible under a .bundle name must hash to its own name. A
    // non-atomic write could expose a truncated file under the final name,
    // which is exactly the corruption this guarantees against.
    const bytes = Buffer.alloc(200_000, 'q');
    await store.put(bytes);
    const files = (await readdir(root)).filter((f) => f.endsWith('.bundle'));
    for (const f of files) {
      const digest = f.replace('.bundle', '');
      const got = await store.get(digest);
      expect(sha(got!.bytes)).toBe(digest);
    }
  });
});

describe('digestOf — the canonical identity', () => {
  it('is lowercase hex SHA-256, matching what the build manifest emits', () => {
    const d = digestOf(Buffer.from('hello'));
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d).toBe(sha(Buffer.from('hello')));
  });
});
