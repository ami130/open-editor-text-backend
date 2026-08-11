/**
 * usage-log.ts — one structured line per delivery session (decision S1, gap G3).
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * S1's reasoning was explicit: *record usage from day one, because retrofitting
 * it after every customer is live means changing the very endpoint they all
 * call.* The install id (T18) was built, sent by the loader, and validated by
 * the DTO — and then dropped on the floor. We were paying the cost of the
 * identifier without collecting the benefit.
 *
 * ─── WHY A LOG LINE AND NOT A TABLE ─────────────────────────────────────────
 * /session is the most exposed surface in the architecture (T20) and is
 * deliberately STATELESS (T17): a database write per anonymous end-user per
 * page load is exactly the traffic shape this design exists to avoid. A
 * structured line costs nothing per request, is already collected by the
 * platform's log pipeline (LOG_FORMAT=json), and can be aggregated offline into
 * whatever seat/domain/volume model S1 eventually chooses.
 *
 * If usage-based BILLING is ever adopted, this becomes the input to a batch
 * roll-up — not a hot-path write.
 *
 * ─── WHAT IS DELIBERATELY NOT LOGGED ────────────────────────────────────────
 * No licence key, no token, no IP, no user agent. The install id identifies an
 * INSTALL, not a person (see install-id.js), and the origin is a customer's
 * domain — which is what we actually sell against (T11).
 */

/** One session, reduced to what usage analysis needs. */
export interface SessionUsage {
  installId: string | null;
  origin: string | null;
  plan: string;
  version: string;
  /** Did the caller present a licence key at all? Not WHICH key. */
  licensed: boolean;
  /**
   * Why a licence was refused, if it was. Logged server-side only — surfacing
   * it in the response would turn /session into a key-validation oracle.
   */
  refusal: string | null;
}

/**
 * Emit the usage line.
 *
 * Never throws: a logging failure must not turn a working session into a failed
 * one. Written to stdout as JSON so it joins the existing access-log stream
 * (see observability/logging.interceptor.ts) rather than inventing a second
 * transport.
 */
export function recordSessionUsage(usage: SessionUsage): void {
  try {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      evt: 'delivery.session',
      installId: usage.installId,
      origin: usage.origin,
      plan: usage.plan,
      version: usage.version,
      licensed: usage.licensed,
      // Omitted entirely when there was no refusal, so the common line stays small.
      ...(usage.refusal ? { refusal: usage.refusal } : {}),
      time: new Date().toISOString(),
    }));
  } catch {
    /* usage recording is best-effort by design */
  }
}
