/**
 * watermark.ts — per-licence bundle watermarking (§2.5 anti-leak).
 *
 * ─── WHAT THIS DOES AND DOES NOT ACHIEVE ────────────────────────────────────
 * It does NOT stop a determined person from extracting a premium bundle they
 * are legitimately entitled to. That is not achievable in a browser and no
 * competitor achieves it either. The actual revenue protection is server-side
 * entitlement (§1.3): no request ever returns premium code to an unentitled
 * caller.
 *
 * What this adds is ATTRIBUTION. A premium bundle found somewhere it should not
 * be can be traced to the licence it was issued to. That is what deters the
 * customers capable of causing real damage — a reseller cannot leak
 * anonymously — and it is what makes a revocation decision defensible rather
 * than a guess.
 *
 * A determined attacker CAN strip the marker. That is fine and expected: the
 * goal is attribution of casual and semi-deliberate leaks, not DRM.
 *
 * ─── WHY AN HMAC TOKEN AND NOT THE LICENCE ID ───────────────────────────────
 * The obvious implementation embeds the licId or the customer's name. Both are
 * wrong here:
 *
 *   • the bundle is CLIENT-SIDE CODE — anyone who opens devtools on their own
 *     editor reads it. Embedding a customer identifier would publish who your
 *     customers are, to every one of their end-users.
 *   • it invites tampering into someone else's identity.
 *
 * So we embed `HMAC-SHA256(secret, licId)` truncated to 16 hex chars. It is
 * opaque to everyone without the secret, and tracing is a cheap scan: compute
 * the token for each known licence until one matches (see `matchWatermark`).
 * No extra table, no state, and the mapping cannot be reversed by whoever holds
 * the bundle.
 *
 * ─── WHY IT IS APPENDED, NOT INJECTED ───────────────────────────────────────
 * The marker is a trailing comment plus a re-exported constant. It never
 * rewrites the bundle's own code, so a watermarked bundle is byte-identical to
 * the original up to the marker: the engine cannot behave differently for one
 * customer, which would be a far worse bug than the leak it guards against.
 */
import { createHmac, createHash } from 'node:crypto';

/** Marker fence. Deliberately greppable — support needs to find it by eye. */
const BEGIN = '/*! oe-wm:';
const END = ' */';

/** Truncated HMAC length. 16 hex = 64 bits: collision-free at any real customer count. */
const TOKEN_LEN = 16;

/**
 * The token embedded for a licence. Deterministic: the same licence always
 * produces the same bundle bytes, so it is generated once and cached forever
 * (content-addressed storage makes that automatic).
 */
export function watermarkToken(secret: string, licId: string): string {
  return createHmac('sha256', secret).update(`wm:${licId}`).digest('hex').slice(0, TOKEN_LEN);
}

/**
 * Append the marker to a bundle.
 *
 * The trailing newline matters: if the original bundle ends inside a `//`
 * comment, appending on the same line would comment out the marker.
 */
export function applyWatermark(bytes: Buffer, secret: string, licId: string): Buffer {
  const token = watermarkToken(secret, licId);
  // A JS comment AND a runtime-readable constant. The comment survives casual
  // copying; the constant survives a minifier that strips comments, which is
  // exactly what a re-publisher would run.
  const marker = `\n${BEGIN}${token}${END}\nexport const __oeWm=${JSON.stringify(token)};\n`;
  return Buffer.concat([bytes, Buffer.from(marker, 'utf8')]);
}

/** Read the token out of a (possibly leaked) bundle. Null when unmarked. */
export function readWatermark(bytes: Buffer | string): string | null {
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8');
  const m = text.match(new RegExp(`${BEGIN.replace(/[*/!]/g, '\\$&')}([0-9a-f]{${TOKEN_LEN}})`));
  if (m) return m[1];
  // Fall back to the constant, for a bundle whose comments were stripped.
  const c = text.match(/__oeWm\s*=\s*["']([0-9a-f]{16})["']/);
  return c ? c[1] : null;
}

/**
 * Which of these licences produced this bundle?
 *
 * The trace direction is deliberately one-way: given the bundle you cannot
 * derive the licence, but given your own licence list you can identify it.
 */
export function matchWatermark(
  bytes: Buffer | string,
  secret: string,
  licIds: string[],
): string | null {
  const token = readWatermark(bytes);
  if (!token) return null;
  for (const licId of licIds) {
    if (watermarkToken(secret, licId) === token) return licId;
  }
  return null;
}

/** SHA-256 of the watermarked bytes — the digest the loader will verify. */
export function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
