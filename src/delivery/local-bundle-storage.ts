/**
 * local-bundle-storage.ts — the Phase 1 BundleStorage driver: bundles on local
 * disk (execution plan §1.4a).
 *
 * Phase 2 replaces this with an S3-compatible driver behind a CDN (T21). Local
 * disk is deliberately enough to prove the whole chain end to end — the seam is
 * the BundleStorage interface, so only this file is swapped.
 *
 * ⚠️ NOT suitable for multi-instance production: two app servers would each
 * hold half the bundles. That is exactly why Phase 2 moves to object storage,
 * and why the interface exists rather than filesystem calls inline.
 */
import { Injectable, Logger } from '@nestjs/common';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  mkdir, writeFile, readFile, rename, stat, unlink,
} from 'node:fs/promises';
import {
  BundleStorage, StoredBundle, digestOf, isValidDigest,
} from './bundle-storage';

@Injectable()
export class LocalBundleStorage implements BundleStorage {
  private readonly log = new Logger(LocalBundleStorage.name);
  private ready: Promise<void> | null = null;

  constructor(private readonly root: string) {}

  /**
   * Create the storage directory once, lazily. Cached as a promise so
   * concurrent callers share a single mkdir rather than racing.
   */
  private ensureRoot(): Promise<void> {
    if (!this.ready) {
      this.ready = mkdir(this.root, { recursive: true }).then(() => undefined);
    }
    return this.ready;
  }

  private pathFor(sha256: string): string {
    // Callers inside the app pass digests we computed ourselves, but get()/has()
    // are reachable from a URL parameter — so the guard is enforced here too,
    // at the point where a string would become a filesystem path.
    if (!isValidDigest(sha256)) {
      throw new Error('refusing to build a bundle path from a non-digest value');
    }
    return join(this.root, `${sha256}.bundle`);
  }

  /**
   * Store bytes under their own digest.
   *
   * WRITTEN ATOMICALLY: bytes go to a unique temp file and are then renamed
   * into place. Within a filesystem, rename is atomic — so a reader either sees
   * no file or sees a COMPLETE one. A plain write would leave a window where a
   * concurrent read returns a truncated bundle whose hash silently mismatches,
   * which is a genuinely miserable bug to trace.
   */
  async put(bytes: Buffer): Promise<string> {
    await this.ensureRoot();
    const sha256 = digestOf(bytes);
    const finalPath = this.pathFor(sha256);

    // Content-addressed: identical bytes are already stored. Idempotent by
    // construction, so re-publishing the same build is a no-op, not a clash.
    if (await this.has(sha256)) return sha256;

    const tmpPath = join(this.root, `.tmp-${randomUUID()}`);
    try {
      await writeFile(tmpPath, bytes);
      await rename(tmpPath, finalPath);
    } catch (err) {
      // Never leave a temp file behind on failure; the cleanup itself must not
      // mask the original error.
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
    this.log.log(`stored bundle ${sha256.slice(0, 12)}… (${bytes.length} bytes)`);
    return sha256;
  }

  async get(sha256: string): Promise<StoredBundle | null> {
    if (!isValidDigest(sha256)) return null; // a malformed digest is a miss, not an error
    try {
      const bytes = await readFile(this.pathFor(sha256));
      return { bytes, sha256 };
    } catch {
      return null;
    }
  }

  async has(sha256: string): Promise<boolean> {
    if (!isValidDigest(sha256)) return false;
    try {
      await stat(this.pathFor(sha256));
      return true;
    } catch {
      return false;
    }
  }
}
