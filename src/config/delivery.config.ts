/**
 * delivery.config.ts — runtime engine delivery (execution plan §1.4/§1.4a).
 *
 * Covers where bundles are stored and how PREMIUM bundle URLs are signed.
 *
 * ─── WHY PREMIUM URLS ARE SIGNED (R44) ──────────────────────────────────────
 * Today premium code is protected simply by not existing in the free npm
 * package. Under runtime delivery it becomes a URL, and the editor's
 * `allowDevHost: true` default grants premium on any localhost — so an
 * unprotected premium bundle URL could be fetched and replayed locally for full
 * premium access.
 *
 * The free bundle being publicly fetchable is an accepted position (B2); the
 * premium bundle being publicly fetchable is not, and nothing else in the
 * architecture compensates for it.
 *
 * The signature is an HMAC over (digest, expiry) — cheap to verify, no database
 * lookup, and in Phase 2 the same scheme is what a CDN validates at the edge.
 */

export interface DeliveryConfig {
  /**
   * Which BundleStorage driver to use (§2.0 / T21).
   *
   * Defaults to 'local' so an existing deployment keeps its current behaviour
   * exactly — switching to object storage must be a deliberate act, never a
   * side effect of upgrading.
   */
  storageDriver: 'local' | 's3';
  /** Directory holding bundle bytes with the 'local' driver. */
  bundleDir: string;
  /**
   * S3-compatible object storage (§2.0). Set `endpoint` for MinIO or R2; leave
   * it unset for real AWS S3.
   *
   * WHY THIS MATTERS: local disk is per-instance, so the app refuses to start
   * with DELIVERY_INSTANCES > 1, and a redeploy on an ephemeral filesystem
   * wipes every bundle. Object storage removes both limits and becomes the
   * origin a CDN fronts in §2.1.
   */
  s3: {
    bucket: string;
    region: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    prefix: string;
  };
  /**
   * HMAC secret for premium bundle URLs. Server-only: anyone holding it can
   * mint premium download links.
   */
  urlSigningSecret: string;
  /** True when a signing secret is configured. */
  signingEnabled: boolean;
  /**
   * How long a premium bundle URL stays valid.
   *
   * Long enough to survive a slow connection and a retry; short enough that a
   * leaked URL is worthless quickly. It only needs to outlive one download,
   * because the loader gets a fresh URL with every session.
   */
  urlTtlSeconds: number;
  /**
   * Force unlicensed visitors onto the FREE bundle, whatever the admin's
   * default package contains.
   *
   * The anonymous plan is normally DERIVED from that package (the same
   * `planForFeatures` the licensed path uses), so designating a package that
   * grants `export.pdf` ships the premium bundle — with the export code in it —
   * to every anonymous visitor. That is the admin's call to make, and the
   * confirm step names it.
   *
   * This exists so the call is REVERSIBLE without a redeploy: if giving that
   * code away turns out to be commercially wrong, set
   * `DELIVERY_ANONYMOUS_FREE_BUNDLE_ONLY=true` and every anonymous session is
   * back on the free bundle within one process restart. Features the free build
   * cannot serve then drop out through the existing T14 intersection, exactly
   * as they did before this was configurable.
   */
  anonymousFreeBundleOnly: boolean;
  /**
   * Public origin (or CDN base) the loader should fetch bundles from, e.g.
   * `https://delivery.openeditor.com`. No trailing slash.
   *
   * WHY THIS MATTERS (B4): `/session` returns the bundle URL, and the loader
   * runs on the CUSTOMER'S domain. A relative path like `/engine/…` would
   * resolve against *their* server and 404. Only an absolute URL reaches us.
   *
   * Empty → URLs stay relative, which is correct for local development and for
   * same-origin deployments where the API and the page share a host.
   *
   * In Phase 2 this becomes the CDN hostname, so moving to a CDN is a config
   * change rather than a code change.
   */
  publicBaseUrl: string;
}

export const DELIVERY_CONFIG = 'DELIVERY_CONFIG';

/**
 * Number of app instances sharing this deployment (G2).
 *
 * ⚠️ LOCAL-DISK BUNDLE STORAGE IS SINGLE-INSTANCE ONLY. Publishing writes the
 * bytes to whichever instance handled the request, so with two app servers each
 * holds roughly half the bundles and about half of all engine downloads 404 —
 * at random, per server, with nothing in the logs to explain it.
 *
 * That was previously documented only in a source comment, which no deployment
 * reads. Set `DELIVERY_INSTANCES` above 1 and the app refuses to start rather
 * than serving a lottery. Phase 2's object-storage driver removes the limit.
 */
export function deliveryInstanceCount(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DELIVERY_INSTANCES);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Request-body ceiling, sized for publishing a bundle (§1.4a).
 *
 * The largest artifact today is ~640 KB, which is ~854 KB once base64-encoded.
 * 4 MB leaves substantial headroom for the engine to grow without becoming a
 * useful amplification target. Express defaults to 100 KB, which would reject a
 * publish with an opaque 413.
 */
export const BUNDLE_UPLOAD_LIMIT = '4mb';

/** Default premium URL lifetime — see urlTtlSeconds. */
const DEFAULT_URL_TTL = 10 * 60;

export function loadDeliveryConfig(env: NodeJS.ProcessEnv = process.env): DeliveryConfig {
  const secret = (env.DELIVERY_URL_SECRET || '').trim();
  const ttl = Number(env.DELIVERY_URL_TTL_SECONDS);

  const driver = (env.DELIVERY_STORAGE || '').trim().toLowerCase() === 's3' ? 's3' : 'local';

  return {
    storageDriver: driver as 'local' | 's3',
    bundleDir: (env.DELIVERY_BUNDLE_DIR || '').trim() || 'storage/bundles',
    s3: {
      bucket: (env.DELIVERY_S3_BUCKET || '').trim(),
      region: (env.DELIVERY_S3_REGION || '').trim() || 'us-east-1',
      // Any non-AWS S3 store (MinIO, R2, Backblaze) needs an explicit endpoint.
      endpoint: (env.DELIVERY_S3_ENDPOINT || '').trim(),
      accessKeyId: (env.DELIVERY_S3_ACCESS_KEY_ID || '').trim(),
      secretAccessKey: (env.DELIVERY_S3_SECRET_ACCESS_KEY || '').trim(),
      // Path-style is required by MinIO and most self-hosted stores, because
      // virtual-host style needs wildcard DNS. Default it on whenever a custom
      // endpoint is set, since that is the case where it is nearly always right.
      forcePathStyle: (env.DELIVERY_S3_FORCE_PATH_STYLE || '').trim() === 'false'
        ? false
        : !!(env.DELIVERY_S3_ENDPOINT || '').trim(),
      prefix: (env.DELIVERY_S3_PREFIX || '').trim(),
    },
    urlSigningSecret: secret,
    signingEnabled: secret.length > 0,
    urlTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_URL_TTL,
    // Opt-IN kill switch: absent or anything other than 'true' keeps the
    // derived behaviour, so an unset variable never silently pins the free
    // bundle and makes an admin's chosen default look broken.
    anonymousFreeBundleOnly:
      (env.DELIVERY_ANONYMOUS_FREE_BUNDLE_ONLY || '').trim().toLowerCase() === 'true',
    // Trailing slashes are stripped so joining is unambiguous — otherwise a
    // value with one produces `https://cdn//engine/…`, which some CDNs treat
    // as a different (and uncached) path.
    publicBaseUrl: (env.DELIVERY_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
  };
}
