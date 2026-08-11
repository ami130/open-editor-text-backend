/**
 * bundle-storage.ts — where the engine BYTES live (execution plan §1.4a).
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * §1.1 builds `free.js` / `premium.js`. §1.2 registers their METADATA — note
 * that `bundleKey` on the registry row is a *string*, not a file. §1.4 serves
 * bytes to the loader.
 *
 * Nothing connected the first to the third: the built bundles existed only on
 * the build machine, so a session could resolve a version perfectly and then
 * have nothing to download. This module is that missing link.
 *
 * ─── THE INTERFACE IS THE POINT (T21) ───────────────────────────────────────
 * Phase 1 stores bundles on local disk; Phase 2 moves them to S3-compatible
 * object storage behind a CDN. Without a seam here that move is a rewrite of
 * every call site. With one, it is a new driver and a config change.
 *
 * Deliberately NOT database blobs: that would route every bundle download
 * through the app server and the connection pool — precisely the traffic shape
 * this architecture exists to avoid.
 *
 * ─── CONTENT-ADDRESSED, NOT NAME-ADDRESSED ──────────────────────────────────
 * Bundles are stored under their SHA-256, not under `version/plan`. That makes
 * the store immutable by construction: a given key can only ever hold one byte
 * sequence, because the key IS the hash of those bytes. Republishing identical
 * bytes is idempotent rather than a conflict, and a corrupted write can never
 * masquerade as a valid bundle under the right name.
 *
 * It also makes §1.4's cache story work: the URL contains the hash, so it can
 * be cached forever without risking a stale bundle.
 *
 * ─── ⚠️ DEDUPLICATION IS LOAD-BEARING: NEVER DELETE BY VERSION ──────────────
 * Because the key is the content hash, two versions with identical bytes share
 * ONE stored object. That is desirable — republishing an unchanged bundle costs
 * nothing — but it makes naive cleanup dangerous:
 *
 *   Deleting "v1.3.0's bundle" can delete the bytes v1.4.0 is still serving.
 *
 * Observed in practice: publishing three bundles produced two files on disk.
 *
 * So any future retention or cleanup work (Phase 2) MUST delete only bytes that
 * NO published row still references — a reference count across engine_versions,
 * never a per-version delete. Note also that retirement deliberately keeps
 * serving pinned customers, so a retired row is still a live reference.
 */
import { createHash } from 'node:crypto';

/** A stored bundle's bytes plus what is needed to serve them. */
export interface StoredBundle {
  bytes: Buffer;
  sha256: string;
}

/**
 * Where engine bundles are stored. Implementations must be safe to call
 * concurrently — publishing is rare, but reads are the hot path.
 */
export interface BundleStorage {
  /**
   * Store bytes under their own SHA-256 and return that digest.
   *
   * MUST be idempotent: storing identical bytes twice is a no-op, not an error.
   * Because the key is derived from the content, two writers racing on the same
   * bundle cannot corrupt each other — they are writing identical data.
   */
  put(bytes: Buffer): Promise<string>;

  /** Read a bundle by digest. Resolves null when absent — never throws for a miss. */
  get(sha256: string): Promise<StoredBundle | null>;

  /** Does this digest exist? Cheaper than get() where only presence matters. */
  has(sha256: string): Promise<boolean>;
}

export const BUNDLE_STORAGE = 'BUNDLE_STORAGE';

/** SHA-256 hex digest of a buffer — the canonical bundle identity. */
export function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A 64-char lowercase hex digest, and nothing else. */
const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * Validate a digest that arrived from OUTSIDE (a URL, a request body).
 *
 * This is a security boundary, not a formatting nicety. The digest becomes a
 * FILENAME in the local driver, so anything containing `..` or `/` would let a
 * crafted request read arbitrary files. Accepting only 64 hex characters makes
 * path traversal unrepresentable rather than merely filtered.
 */
export function isValidDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}
