/**
 * version-resolution.ts — pure resolution logic for the delivery service
 * (execution plan §1.2). No database, no NestJS: everything here is a plain
 * function over plain data, so the whole matrix is unit-testable.
 *
 * Two questions are answered here, and both fail SILENTLY if wrong — a customer
 * receives the wrong build, or is promised features their build cannot deliver,
 * with nothing in the logs to explain it. Hence pure functions with exhaustive
 * tests rather than logic buried in a service method.
 *
 *   1. resolveVersion()  — WHICH build does this caller get?
 *   2. resolveFeatures() — WHAT may they use in it?
 */

/** Promotion stage. Path: internal → beta → stable. */
export type EngineChannel = 'internal' | 'beta' | 'stable';

/**
 * Sentinel in a package's feature list meaning "everything this build supports".
 * The free tier uses it because it has no package to intersect against — see
 * resolveFeatures and ALL_BUILD_FEATURES in delivery/session.service.ts.
 */
export const ALL_FEATURES = '*';

/** Everything about the caller that can influence which version they receive. */
export interface VersionResolutionInput {
  /** Version the customer explicitly pinned, if any. ABSOLUTE — overrides everything. */
  pinnedVersion?: string | null;
  /** Admin override for this specific licence ("switch one customer"). */
  overrideVersion?: string | null;
  /** Channel the customer opted into. Defaults to 'stable'. */
  channel?: EngineChannel | null;
  /** Default version for the customer's channel. */
  channelDefault?: string | null;
  /** Global fallback default. */
  globalDefault?: string | null;
}

export type VersionSource = 'pin' | 'override' | 'channel' | 'global';

export interface VersionResolution {
  version: string | null;
  /** Why this version was chosen — surfaced in logs and admin views. */
  source: VersionSource | 'none';
}

/**
 * Resolve which engine version a caller receives. FIRST MATCH WINS:
 *
 *   1. Customer pinned a version   → use it        (absolute)
 *   2. Admin override for them     → use it
 *   3. Their channel's default     → use it
 *   4. Global default              → fallback
 *
 * PINNING IS A PROMISE. A pinned customer is unaffected by a new default, a
 * channel promotion, a canary rollout, OR a rollback. Breaking a pin even once
 * destroys the credibility of pinning permanently — which is why the pin is
 * checked before the admin override, not after.
 */
export function resolveVersion(input: VersionResolutionInput): VersionResolution {
  if (input.pinnedVersion) return { version: input.pinnedVersion, source: 'pin' };
  if (input.overrideVersion) return { version: input.overrideVersion, source: 'override' };
  if (input.channelDefault) return { version: input.channelDefault, source: 'channel' };
  if (input.globalDefault) return { version: input.globalDefault, source: 'global' };
  return { version: null, source: 'none' };
}

/**
 * Resolve the features a caller may actually use.
 *
 *     granted = packageFeatures ∩ supportedFeatures
 *
 * WHY THE INTERSECTION (T14 / R25 — the silent failure):
 *
 * A licence stores its features as a SNAPSHOT taken at purchase time, while the
 * feature catalog is regenerated whenever the engine changes. Using either side
 * alone breaks in one direction:
 *
 *   • Snapshot alone → v1.4.0 adds "table.merge"; a Pro licence snapshotted in
 *     January never receives it. A paying customer silently missing what their
 *     plan includes, forever, unless someone notices by hand.
 *
 *   • Package alone → a customer pinned to v1.2.0 whose plan grants
 *     "table.merge" gets a token promising a feature their build does not have.
 *     The editor gates on the token, so the feature appears "granted" and then
 *     does nothing.
 *
 * The intersection fixes both: the PACKAGE is the source of truth for
 * entitlement (so plan changes reach existing customers), bounded by what the
 * SERVED BUILD can actually do (so a token never over-promises).
 *
 * The licence's own `features` snapshot is retained as an AUDIT RECORD — what
 * was sold, and when — and deliberately not used as the live gate.
 */
export function resolveFeatures(
  packageFeatures: readonly string[],
  supportedFeatures: readonly string[],
): string[] {
  // '*' means "everything this build supports" — used by the free tier, which
  // has no package to intersect against. Without it, an anonymous caller's
  // empty feature list intersects to nothing and they receive a working free
  // bundle with every feature disabled.
  if (packageFeatures.includes(ALL_FEATURES)) return [...supportedFeatures].sort();
  const supported = new Set(supportedFeatures);
  return packageFeatures.filter((f) => supported.has(f)).sort();
}

/**
 * Features the customer's plan grants but the served build cannot provide.
 *
 * Never sent to the client — it exists for observability. A non-empty result on
 * a NON-pinned customer means they are on an old default and are quietly losing
 * paid features: exactly the silent failure T14 exists to prevent, so it should
 * be logged and alerted on rather than discovered by a support ticket.
 */
export function missingFromBuild(
  packageFeatures: readonly string[],
  supportedFeatures: readonly string[],
): string[] {
  // '*' asks for whatever the build has, so by definition nothing is missing.
  if (packageFeatures.includes(ALL_FEATURES)) return [];
  const supported = new Set(supportedFeatures);
  return packageFeatures.filter((f) => !supported.has(f)).sort();
}

/**
 * Is this build eligible to be SERVED to a caller on the given channel?
 *
 * Channel ordering is a ladder, not a set: a customer on `beta` may receive
 * `stable` builds too (stable is more conservative than what they opted into),
 * but a `stable` customer must never receive `beta` or `internal` code.
 *
 * A RETIRED build stays serveable — customers pinned to it keep working. It is
 * only excluded from being chosen as a default (see eligibleAsDefault).
 */
const CHANNEL_RANK: Record<EngineChannel, number> = {
  stable: 0,
  beta: 1,
  internal: 2,
};

export function channelAllows(
  callerChannel: EngineChannel,
  buildChannel: EngineChannel,
): boolean {
  return CHANNEL_RANK[buildChannel] <= CHANNEL_RANK[callerChannel];
}

/**
 * May this build be chosen as a channel/global DEFAULT?
 *
 * Retired builds may still be served (to pins) but must never become the answer
 * for a caller who has not asked for them specifically.
 */
export function eligibleAsDefault(status: string): boolean {
  return status === 'published';
}
