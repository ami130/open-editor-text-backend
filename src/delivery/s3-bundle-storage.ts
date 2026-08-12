/**
 * s3-bundle-storage.ts — the Phase 2 BundleStorage driver: bundles in
 * S3-compatible object storage (execution plan §2.0, decision T21).
 *
 * ─── WHAT THIS FIXES ────────────────────────────────────────────────────────
 * The local-disk driver is per-instance, which imposes two real limits today:
 *
 *   • SINGLE INSTANCE ONLY. Publishing writes bytes to whichever server handled
 *     the request, so with N app servers roughly (N-1)/N of engine downloads
 *     404 at random. main.ts refuses to start when DELIVERY_INSTANCES > 1
 *     rather than serve that lottery.
 *   • A REDEPLOY ON AN EPHEMERAL FILESYSTEM WIPES EVERY BUNDLE. Registry rows
 *     survive in MySQL; the bytes do not.
 *
 * Object storage removes both, and becomes the origin a CDN fronts in §2.1.
 * Bundle bytes never flow through the app server once a CDN is in place — which
 * is the entire point of T21.
 *
 * ─── WHY THE OFFICIAL SDK ───────────────────────────────────────────────────
 * S3 requires AWS SigV4 request signing. A hand-rolled signer is ~60 lines and
 * tends to work against MinIO while failing against real S3, because MinIO is
 * lenient about canonical-request edge cases that AWS rejects. That failure
 * would surface in production and never locally — the worst possible place, and
 * exactly what testing locally is meant to prevent.
 *
 * ─── CONTENT-ADDRESSED, UNCHANGED ───────────────────────────────────────────
 * Objects are keyed by their own SHA-256, exactly as on local disk. That keeps
 * the store immutable by construction (a key can only ever hold one byte
 * sequence), makes re-publishing idempotent rather than a conflict, and is what
 * lets §1.4's URLs be cached forever.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { BundleStorage, StoredBundle, digestOf, isValidDigest } from './bundle-storage';

/** Options for the S3 driver. `endpoint` is what makes MinIO/R2 work. */
export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Custom endpoint for MinIO / Cloudflare R2 / any S3-compatible store. */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * MinIO and most self-hosted stores need path-style addressing
   * (`host/bucket/key`) because virtual-host style needs wildcard DNS.
   */
  forcePathStyle?: boolean;
  /** Key prefix, so one bucket can hold more than just engine bundles. */
  prefix?: string;
}

@Injectable()
export class S3BundleStorage implements BundleStorage {
  private readonly log = new Logger(S3BundleStorage.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3StorageOptions) {
    if (!opts.bucket) throw new Error('S3 bundle storage needs a bucket name');
    this.bucket = opts.bucket;
    this.prefix = (opts.prefix || '').replace(/^\/+|\/+$/g, '');

    this.client = new S3Client({
      region: opts.region || 'us-east-1',
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle ?? !!opts.endpoint,
      ...(opts.accessKeyId && opts.secretAccessKey
        ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
        : {}),
    });
  }

  /**
   * Object key for a digest.
   *
   * The digest is validated even though callers inside the app pass digests we
   * computed ourselves: `get`/`has` are reachable from a URL parameter, and a
   * key built from unvalidated input could escape the prefix. Rejecting
   * anything but 64 hex characters makes that unrepresentable rather than
   * merely filtered — the same guard the local driver applies to filenames.
   */
  private keyFor(sha256: string): string {
    if (!isValidDigest(sha256)) {
      throw new Error('refusing to build an object key from a non-digest value');
    }
    return this.prefix ? `${this.prefix}/${sha256}` : sha256;
  }

  /**
   * Store bytes under their own digest.
   *
   * Idempotent by construction: the key IS the hash of the content, so two
   * writers racing on the same bundle are writing identical data. A pre-check
   * skips the upload when it already exists, which matters because a bundle is
   * ~640 KB and re-publishing an unchanged build is a normal operation.
   */
  async put(bytes: Buffer): Promise<string> {
    const sha256 = digestOf(bytes);
    if (await this.has(sha256)) return sha256;

    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.keyFor(sha256),
      Body: bytes,
      ContentType: 'application/javascript; charset=utf-8',
      // The object is immutable by construction, so it is safe to declare so —
      // this also carries through to a CDN fronting the bucket (§2.1).
      CacheControl: 'public, max-age=31536000, immutable',
      // S3 verifies this against the body it received and rejects a mismatch,
      // so a corrupted upload fails at the boundary instead of being stored
      // under a key that claims a hash it does not have. The header wants the
      // raw digest base64-encoded, not the hex string.
      ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
    }));

    this.log.log(`stored bundle ${sha256.slice(0, 12)}… (${bytes.length} bytes)`);
    return sha256;
  }

  /**
   * Read a bundle by digest.
   *
   * Resolves null for anything missing or malformed — never throws for a miss,
   * matching the local driver so `readBundle` can 404 uniformly and this route
   * cannot be used to probe what exists.
   */
  async get(sha256: string): Promise<StoredBundle | null> {
    if (!isValidDigest(sha256)) return null;
    try {
      const res = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(sha256),
      }));
      if (!res.Body) return null;
      // transformToByteArray() buffers the whole object. That is correct here —
      // integrity is verified over the complete bytes before anything executes,
      // so a streamed partial would have to be reassembled anyway.
      const bytes = Buffer.from(await res.Body.transformToByteArray());
      return { bytes, sha256 };
    } catch {
      return null;
    }
  }

  /** Does this digest exist? HEAD only — never transfers the object. */
  async has(sha256: string): Promise<boolean> {
    if (!isValidDigest(sha256)) return false;
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(sha256),
      }));
      return true;
    } catch {
      return false;
    }
  }
}
