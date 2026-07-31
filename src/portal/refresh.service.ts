/**
 * refresh.service.ts — the public "silent auto-refresh" core (Phase 4c). Makes
 * "paste once, forever" real: given a current (near-expiry) token, mint a fresh
 * one for the SAME license, IN PLACE (same license row + licId — only the signed
 * token + exp roll forward), honoring the snapshot.
 *
 * SECURITY (threat model, §5) — an unauthenticated key→token endpoint is a
 * key-oracle / enumeration / token-farm surface, so:
 *   • UNIFORM OUTCOME: the caller only ever learns "here's a token" or a generic
 *     refusal — never WHY (bad token vs revoked vs unknown all look identical).
 *     The controller maps every non-success to one generic response.
 *   • DELIVERY-TIME REVOCATION: a revoked license never refreshes (the one perk
 *     of being online at refresh time).
 *   • ORIGIN/DOMAIN MATCH: for a domain-bound license, the request Origin must
 *     match a bound domain.
 *   • PER-KEY LIMIT: RefreshRateLimiter caps refreshes per license (per-IP is the
 *     global throttler). Together: no farm, no DoS.
 *   • HONOR-SNAPSHOT: re-mint exactly what was sold; a since-withdrawn feature
 *     does not strip a paying customer (decision B). Unknown ids still rejected.
 *   • PAID-TERM BOUNDARY (audit C1): re-mint ONLY while now < renewUntil. Billing
 *     is one-time-per-term, so a monthly license is a 30-day term — past it, the
 *     token lapses within one TTL and refresh refuses (no renew-forever). The
 *     term is FIXED at issue; refresh rolls the token but never extends the term.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { LicenseEntity } from '../licensing/entities/license.entity';
import { LicenseSignerService } from '../licensing/license-signer.service';
import { effectiveTtlSeconds, effectiveRenewUntil, clampTtlToTerm } from '../licensing/duration-policy';
import { hostAllowed } from '../licensing/domain-policy';
import { RefreshRateLimiter } from './refresh-rate-limiter';
import { EmailService } from '../billing/email.service';
import { BILLING_CONFIG, BillingConfig } from '../config/billing.config';

/**
 * Expiry-reminder window (audit B2): when a FINITE-term license comes within this
 * many seconds of renewUntil, the next refresh sends a one-time "access ending
 * soon" email. 7 days gives the customer time to re-purchase before the silent
 * lapse. Lifetime licenses (renewUntil = INFINITE_TERM → +∞ boundary) never enter
 * this window, so they never trigger a reminder.
 */
const EXPIRY_REMINDER_WINDOW_SECONDS = 7 * 24 * 3600;

export type RefreshResult =
  | { ok: true; token: string; expiresAt: number; licId: string }
  | { ok: false; reason: 'refused' | 'rate-limited' | 'origin-blocked' | 'term-ended'; licId: string | null };

/** Internal-only: the expiry-reminder email payload carried out of the refresh txn
 *  for fire-and-forget dispatch after commit. NEVER part of the public result. */
type RemindPayload = { to: string; customerName: string; planName: string; daysLeft: number };

@Injectable()
export class RefreshService {
  private readonly log = new Logger('RefreshService');

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(LicenseSignerService) private readonly signer: LicenseSignerService,
    private readonly limiter: RefreshRateLimiter,
    private readonly email: EmailService,
    @Inject(BILLING_CONFIG) private readonly billing: BillingConfig,
  ) {}

  /**
   * Attempt a refresh. `origin` is the request Origin header (may be null).
   * Returns a discriminated result — the controller collapses every failure to
   * ONE uniform response so nothing leaks.
   */
  async refresh(token: string, origin: string | null, nowSeconds?: number): Promise<RefreshResult> {
    const now = typeof nowSeconds === 'number' ? nowSeconds : Math.floor(Date.now() / 1000);

    // 1) Verify it's one of OUR tokens (signature + shape). Garbage → refused.
    //    Accepts current AND retired kids (H1 fix) so refresh survives rotation.
    const claims = this.signer.verifyOwnToken(token);
    if (!claims) return { ok: false, reason: 'refused', licId: null };

    const result = await this.doRefresh(token, origin, now, claims);

    // Dispatch the expiry reminder AFTER the txn commits (email I/O must never sit
    // inside the transaction) and FIRE-AND-FORGET (a reminder-send failure must not
    // fail the refresh — the customer still got their token). reminderSentAt was
    // already marked in-txn, so a transient send failure just means one missed
    // nudge, never a duplicate. (audit B2)
    if (result.ok && result.remind) {
      const r = result.remind;
      this.email
        .sendExpiryReminderEmail({
          to: r.to,
          customerName: r.customerName,
          planName: r.planName,
          daysLeft: r.daysLeft,
          rebuyUrl: `${this.billing.webOrigin}/pricing`,
        })
        .catch((e) => this.log.warn(`expiry reminder send failed: ${(e as Error).message}`));
    }

    // Strip the internal `remind` field so the public result stays uniform.
    if (result.ok) return { ok: true, token: result.token, expiresAt: result.expiresAt, licId: result.licId };
    return result;
  }

  private async doRefresh(
    token: string,
    origin: string | null,
    now: number,
    claims: NonNullable<ReturnType<LicenseSignerService['verifyOwnToken']>>,
  ): Promise<RefreshResult & { remind?: RemindPayload | null }> {
    // The read-check-remint runs in ONE transaction for an atomic save. The M3
    // orphaning race is primarily fixed by PRESERVING licId (step 7): since the
    // row's licId no longer changes across a refresh, two concurrent refreshes of
    // the same token both keep the same licId — neither orphans the other's token
    // (both resolve on the next refresh). No pessimistic lock needed (and it isn't
    // portable to the sqljs test driver anyway); licId-stability removes the harm.
    return this.dataSource.transaction(async (mgr) => {
      const licenses = mgr.getRepository(LicenseEntity);

      // 2) Resolve the row. Source of truth for status / term / snapshot.
      const lic = await licenses.findOne({
        where: { licId: claims.lic }, relations: ['package', 'customer'],
      });
      if (!lic) return { ok: false, reason: 'refused', licId: null };

      // 3) Delivery-time revocation: a revoked license never refreshes.
      if (lic.status === 'revoked') return { ok: false, reason: 'refused', licId: lic.licId };

      // 4) PAID-TERM BOUNDARY (C1): re-mint only while now < renewUntil. Uses the
      //    SHARED effectiveRenewUntil (same helper the rebind path uses, E1) — a
      //    legacy renewUntil=0 row derives its bound from createdAt+interval so old
      //    rows are bounded too (never ∞), consistently across refresh + rebind.
      const boundary = effectiveRenewUntil({
        renewUntil: lic.renewUntil,
        createdAt: lic.createdAt,
        issuedAt: lic.issuedAt,
        intervalForTerm: lic.package ? lic.package.billingInterval : 'once',
      });
      if (now >= boundary) return { ok: false, reason: 'term-ended', licId: lic.licId };

      // 5) Origin/domain match — TRULY defense-in-depth (audit F1). Only reject
      //    when an Origin is PRESENT and does NOT match a bound domain (a browser
      //    on the wrong site). A MISSING Origin does NOT block: the editor's
      //    refresh client can't set Origin (it's a browser-forbidden header the
      //    browser attaches automatically), so a non-browser host (SSR, a webview
      //    that strips Origin, a server-side integration) would otherwise be
      //    stranded despite a valid, in-term, unrevoked license. The real gates
      //    (term boundary above, revocation, per-key rate limit) carry enforcement;
      //    Origin can only ever be a secondary signal, never the sole denier.
      if (lic.domains.length > 0 && origin && !this.originMatches(origin, lic.domains)) {
        return { ok: false, reason: 'origin-blocked', licId: lic.licId };
      }

      // 6) Per-key rate limit. Key on the STABLE license row id — NOT licId
      //    (preserved now, but id is the durable identity regardless).
      if (!this.limiter.allow(lic.id)) {
        return { ok: false, reason: 'rate-limited', licId: lic.licId };
      }

      // 7) Re-mint honoring the snapshot. PRESERVE licId (M3): the row identity
      //    and the token's `lic` claim stay stable across refreshes, so a token
      //    handed back always resolves on the next refresh — no orphaning.
      //    CLAMP the ttl to the term boundary (audit #3) so the LAST refresh near
      //    renewUntil can't mint a token that lives a full TTL past the paid term.
      const baseTtl = lic.package ? effectiveTtlSeconds(lic.package) : undefined;
      const ttl = clampTtlToTerm(baseTtl, boundary, now);
      const signed = this.signer.sign({
        lic: lic.licId, // keep the SAME license id across the re-mint
        features: lic.features,
        domains: lic.domains,
        customer: lic.customer ? lic.customer.id : claims.customer,
        plan: lic.planName || 'custom',
        ttlSeconds: ttl,
        iat: now, // pin iat to the SAME clock the clamp used, so exp = now+ttl <= boundary holds
      });
      lic.token = signed.token;
      lic.kid = signed.kid;
      lic.issuedAt = signed.iat;
      lic.expiresAt = signed.exp;
      // renewUntil is NOT extended — the paid term is fixed; only the token rolls.
      lic.status = 'active';

      // 8) EXPIRY REMINDER (audit B2): a FINITE-term license within the reminder
      //    window that hasn't already been reminded THIS term earns a one-time
      //    "access ending soon" nudge. Billing is one-time-per-term (no auto-renew),
      //    so without this the access lapses silently — the chargeback trigger.
      //    We MARK reminderSentAt inside this txn (atomic with the refresh, so it
      //    can't double-send across concurrent refreshes) and hand the send back to
      //    the caller to dispatch AFTER commit (email I/O must not sit in the txn).
      //    isFinite(boundary) excludes lifetime (+∞) automatically.
      let remind: RemindPayload | null = null;
      const withinWindow = Number.isFinite(boundary) && boundary - now <= EXPIRY_REMINDER_WINDOW_SECONDS;
      if (withinWindow && !(lic.reminderSentAt > 0) && lic.customer?.email) {
        lic.reminderSentAt = now;
        remind = {
          to: lic.customer.email,
          customerName: lic.customer.name || '',
          planName: lic.planName || (lic.package ? lic.package.name : 'your'),
          daysLeft: Math.max(0, Math.ceil((boundary - now) / (24 * 3600))),
        };
      }

      await licenses.save(lic);

      return { ok: true, token: signed.token, expiresAt: signed.exp, licId: lic.licId, remind };
    });
  }

  /** True if `origin`'s host matches one of the license's bound domains. Uses the
   *  SHARED matcher (Phase 5) so the refresh gate agrees EXACTLY with the editor's
   *  offline verifier — same `*.base`-includes-apex, same single-sub-level rule
   *  (the old local copy over-matched `a.b.base` and disagreed on apex). */
  private originMatches(origin: string | null, domains: string[]): boolean {
    if (!origin) return false;
    let bareHost: string;
    try { bareHost = new URL(origin).host.toLowerCase().split(':')[0]; } catch { return false; }
    return hostAllowed(bareHost, domains);
  }
}
