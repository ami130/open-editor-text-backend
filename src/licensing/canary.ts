/**
 * canary.ts — sticky percentage bucketing for gradual releases (§2.7).
 *
 * ─── WHY GRADUAL RELEASE MATTERS MORE THAN ROLLBACK ─────────────────────────
 * Rollback (§2.8) is reactive: by the time it runs, something has already
 * broken for every customer simultaneously. A canary converts a potential
 * incident into a contained one — a bad build reaches 5% of sessions and is
 * halted before most customers ever load it.
 *
 * ─── STICKINESS IS THE WHOLE DESIGN ─────────────────────────────────────────
 * The bucket MUST be a pure function of the caller's identity, never of time or
 * randomness. If a browser could flip between versions on alternate page loads
 * it would be worse than no canary at all:
 *
 *   • the editor would re-download a different bundle on every reload,
 *     destroying the immutable cache the whole architecture depends on
 *   • a customer would see a feature appear and disappear, and bug reports
 *     would become unreproducible
 *   • per-licence watermarked bundles (§2.5) would be regenerated constantly
 *
 * So bucketing is `HMAC(salt, identity) mod 100`. Deterministic, uniform, and
 * stable for as long as the identity and salt are unchanged.
 *
 * ─── WHY THE SALT IS THE VERSION ────────────────────────────────────────────
 * Salting with the CANARY VERSION means each release re-shuffles who is in the
 * early group. Without that, the same unlucky 5% would be the guinea pig for
 * every single release forever — they would absorb every bad build while the
 * other 95% never saw one. Re-shuffling spreads that exposure fairly.
 */
import { createHmac } from 'node:crypto';

/**
 * Which 0–99 bucket does this identity fall into for this release?
 *
 * `identity` should be the most stable thing available — a licence id for a
 * customer, an install id for an anonymous browser. An empty identity returns
 * null: an unidentifiable caller must NEVER be silently placed in a canary,
 * because it could not be kept there consistently.
 */
export function bucketOf(identity: string | null | undefined, salt: string): number | null {
  const id = (identity || '').trim();
  if (!id) return null;
  const digest = createHmac('sha256', `canary:${salt}`).update(id).digest();
  // First 4 bytes are ample: we need 100 buckets, not cryptographic spread.
  return digest.readUInt32BE(0) % 100;
}

/**
 * Should this caller receive the canary version?
 *
 * `percent` is clamped to 0–100 so a bad value can never mean "everyone":
 * a typo of 1000 in an admin form must not become a full rollout.
 */
export function inCanary(
  identity: string | null | undefined,
  canaryVersion: string,
  percent: number,
): boolean {
  const pct = Math.max(0, Math.min(100, Math.floor(Number(percent) || 0)));
  if (pct <= 0 || !canaryVersion) return false;
  if (pct >= 100) return true;

  const bucket = bucketOf(identity, canaryVersion);
  // Unidentifiable caller → never in the canary. Deliberately conservative:
  // the alternative is a caller who flips in and out of the early group.
  if (bucket === null) return false;
  return bucket < pct;
}
