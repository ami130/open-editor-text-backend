/**
 * order.service.ts — the purchase lifecycle: start a checkout (pending order)
 * and fulfill it (idempotently) when Stripe confirms payment.
 *
 * SECURITY / CORRECTNESS invariants:
 *   • Price is taken from OUR DB package, never the client. `startCheckout`
 *     validates the package is active + publicly listed and (if domain-bound)
 *     has ≥1 domain, then snapshots the amount onto the order.
 *   • Fulfillment is IDEMPOTENT twice over: (1) a processed-events ledger keyed
 *     by the Stripe event id, and (2) an early return if the order already has a
 *     license. Either guarantees exactly one license per paid checkout, however
 *     many times Stripe re-delivers the event.
 *   • Fulfillment reuses LicenseService.issue() verbatim — a paid purchase mints
 *     the same signed token an admin-issued one would.
 *   • A self-serve buyer becomes a real CustomerEntity (upsert by email), so the
 *     admin sees them like any other customer.
 */
import {
  Injectable, Inject, Optional, BadRequestException, NotFoundException, Logger,
} from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { OrderEntity } from './entities/order.entity';
import { ProcessedStripeEventEntity } from './entities/processed-stripe-event.entity';
import { PackageEntity } from '../licensing/entities/package.entity';
import { CustomerEntity } from '../licensing/entities/customer.entity';
import { LicenseService } from '../licensing/license.service';
import { effectiveTtlSeconds } from '../licensing/duration-policy';
import { normalizeDomains, assertDomainsAcceptable } from '../licensing/domain-policy';
import { EmailService } from './email.service';
import { LicenseActivationService } from '../delivery/license-activation.service';

export interface StartCheckoutInput {
  packageId: string;
  email: string;
  /** Buyer's editor install id (§2.4 activation). Optional. */
  installId?: string;
  name?: string;
  domains?: string[];
}

@Injectable()
export class OrderService {
  private readonly log = new Logger('OrderService');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(OrderEntity) private readonly orders: Repository<OrderEntity>,
    @InjectRepository(ProcessedStripeEventEntity) private readonly processed: Repository<ProcessedStripeEventEntity>,
    @InjectRepository(PackageEntity) private readonly packages: Repository<PackageEntity>,
    @InjectRepository(CustomerEntity) private readonly customers: Repository<CustomerEntity>,
    @Inject(LicenseService) private readonly licenses: LicenseService,
    @Inject(EmailService) private readonly email: EmailService,
    // @Optional so billing still works where the delivery module is absent —
    // activation is then simply not offered. Wiring is asserted by a probe test,
    // not trusted: an @Optional() that silently resolves to undefined is how the
    // anti-sharing detector stayed inert for an entire phase.
    @Optional() @Inject(LicenseActivationService)
    private readonly activations?: LicenseActivationService,
  ) {}

  /**
   * Validate a public purchase request and create a PENDING order with the
   * server-authoritative amount snapshotted. Returns the order + the package so
   * the controller can create the Stripe session. Does NOT touch Stripe itself.
   */
  async prepareOrder(input: StartCheckoutInput): Promise<{ order: OrderEntity; pkg: PackageEntity }> {
    const email = String(input.email || '').toLowerCase().trim();
    if (!email) throw new BadRequestException('email is required');

    const pkg = await this.packages.findOne({ where: { id: input.packageId }, relations: ['features'] });
    if (!pkg) throw new NotFoundException('package not found');
    // Only ACTIVE + PUBLICLY LISTED packages can be bought self-serve.
    if (!pkg.active || !pkg.publiclyListed) {
      throw new BadRequestException('this package is not available for purchase');
    }
    if (pkg.priceCents <= 0) {
      throw new BadRequestException('this package has no purchasable price');
    }

    const domains = normalizeDomains(input.domains);
    if (pkg.domainBound && domains.length === 0) {
      throw new BadRequestException('this package is domain-bound — enter at least one domain');
    }
    // Reject over-broad bindings at CHECKOUT (audit A4) — a clean pre-payment 400
    // instead of a post-payment 'failed' order surfaced only at fulfillment.
    if (domains.length) assertDomainsAcceptable(domains, (msg) => { throw new BadRequestException(msg); });

    const order = this.orders.create({
      // A placeholder session id until the controller sets the real one; the
      // unique index means we set it before save (controller flow below).
      stripeSessionId: `pending-${randomUUID()}`,
      package: pkg,
      packageName: pkg.name,
      amountCents: pkg.priceCents,      // authoritative — from the DB
      currency: pkg.currency,
      // Snapshot terms so the sale is honoured even if the package changes.
      featureIds: (pkg.features || []).map((f) => f.id),
      domainBound: pkg.domainBound,
      // Snapshot the DURATION-derived TTL (lifetime→max), not the raw column, so
      // fulfillment mints the sold term. Plus the interval + refresh policy for
      // the Phase-4 refresh endpoint. (Phase 3)
      licenseTtlSeconds: effectiveTtlSeconds(pkg),
      billingInterval: pkg.billingInterval,
      refreshPolicy: pkg.refreshPolicy,
      customerEmail: email,
      customerName: (input.name || '').trim(),
      // §2.4 — lets the buyer's own editor activate itself after payment.
      installId: (input.installId || '').trim().slice(0, 128),
      domains,
      status: 'pending',
      license: null,
    });
    const saved = await this.orders.save(order);
    return { order: saved, pkg };
  }

  /** Attach the real Stripe session id to a pending order. */
  async attachSession(orderId: string, sessionId: string): Promise<void> {
    await this.orders.update({ id: orderId }, { stripeSessionId: sessionId });
  }

  /**
   * Idempotently fulfill a PAID checkout. Safe to call repeatedly with the same
   * event — mints exactly once. Ordering matters:
   *
   *   1. Find the order FIRST (by orderId, else sessionId). If it's missing —
   *      e.g. the webhook beat `attachSession` — we DO NOT record the event, so
   *      Stripe's retry can succeed once the session id is attached (fixes the
   *      lost-license race). We signal "retry me" to the caller.
   *   2. Then the ledger dedup + a per-order license guard both prevent a
   *      double-mint under retries / concurrent delivery.
   *   3. Verify the AMOUNT ACTUALLY PAID matches the order (defends against a
   *      100%-off coupon / tampered session minting a paid license for free).
   *   4. Mint from the SNAPSHOT (survives a package edited/deleted mid-flight).
   */
  async fulfillFromEvent(params: {
    eventId: string;
    eventType: string;
    orderId?: string;
    sessionId: string;
    /** What Stripe says was actually paid (amount_total + currency). */
    amountPaidCents?: number | null;
    currencyPaid?: string | null;
  }): Promise<{ order: OrderEntity | null; retry: boolean }> {
    // (1) Find the order BEFORE recording the event. If absent, do not burn the
    // ledger — let Stripe retry (attachSession may not have committed yet).
    const order = params.orderId
      ? await this.orders.findOne({ where: { id: params.orderId }, relations: ['package'] })
      : await this.orders.findOne({ where: { stripeSessionId: params.sessionId }, relations: ['package'] });
    if (!order) {
      this.log.warn(`fulfill: no order yet for session ${params.sessionId} / order ${params.orderId} — asking Stripe to retry`);
      return { order: null, retry: true };
    }

    // (2a) Per-order guard: already fulfilled → return it, mint nothing.
    if (order.status === 'fulfilled' && order.license) return { order, retry: false };

    // (2b) Fast pre-check: already processed → skip (mint nothing).
    const already = await this.processed.findOne({ where: { eventId: params.eventId } });
    if (already) {
      this.log.log(`stripe event ${params.eventId} already processed — skipping`);
      return { order: await this.findBySession(order.stripeSessionId), retry: false };
    }

    // (3) Amount authority: what Stripe collected MUST equal what we charged.
    // A mismatch (coupon to $0, tampered session, wrong currency) → refuse to
    // mint and mark the order failed. amountPaidCents may be undefined for
    // events that don't carry it — then we can't verify, so we refuse.
    const paid = params.amountPaidCents;
    const paidCurrency = (params.currencyPaid || '').toLowerCase();
    if (paid == null || paid !== order.amountCents
        || (paidCurrency && paidCurrency !== order.currency.toLowerCase())) {
      order.status = 'failed';
      order.stripeEventId = params.eventId;
      await this.orders.save(order);
      this.log.warn(
        `fulfill: amount mismatch on order ${order.id} — expected ${order.amountCents} ${order.currency}, `
        + `paid ${paid} ${paidCurrency || '?'} — NOT minting`,
      );
      return { order, retry: false };
    }

    // (4) ATOMIC mint (H2). Ledger insert + license mint + order save all run in
    // ONE transaction, so if the mint throws, the ledger row is NOT persisted →
    // Stripe's retry can try again (no "paid-but-lost" from a burned ledger).
    // The ledger's unique PK is also the concurrency guard: a second concurrent
    // delivery's insert conflicts and rolls back, so exactly one mint wins.
    const customer = await this.upsertCustomer(order.customerEmail, order.customerName, order.domains);
    let licenseToken: string | null = null;
    try {
      await this.dataSource.transaction(async (mgr) => {
        // Concurrency + idempotency guard, INSIDE the txn: a duplicate/concurrent
        // event's insert throws the unique-PK conflict and aborts this txn.
        await mgr.getRepository(ProcessedStripeEventEntity)
          .insert({ eventId: params.eventId, type: params.eventType });

        const license = await this.licenses.issueFromSnapshot({
          customerId: customer.id,
          features: order.featureIds,
          domains: order.domains.length ? order.domains : undefined,
          planName: order.packageName,
          planPriceCents: order.amountCents,
          planCurrency: order.currency,
          domainBound: order.domainBound,
          ttlSeconds: order.licenseTtlSeconds || undefined,
          billingInterval: order.billingInterval, // sets the paid-term boundary (C1)
          packageId: order.package ? order.package.id : null,
        }, mgr);

        order.license = license;
        order.status = 'fulfilled';
        order.stripeEventId = params.eventId;
        await mgr.getRepository(OrderEntity).save(order);
        licenseToken = license.token;
      });
    } catch (e) {
      // A PERMANENT mint failure (e.g. a feature retired between checkout and
      // payment, or a domain-rule violation → BadRequestException) must NOT loop
      // Stripe forever. Mark the order `failed` (a COMMITTED write, separate from
      // the rolled-back txn) so it's visible in the admin Orders view, and stop
      // retrying. Any OTHER error is treated as transient: rethrow so the ledger
      // stays unwritten and Stripe retries.
      if (e instanceof BadRequestException || e instanceof NotFoundException) {
        order.status = 'failed';
        order.stripeEventId = params.eventId;
        await this.orders.save(order);
        this.log.warn(`fulfill: permanent mint failure on order ${order.id}: ${(e as Error).message} — marked failed`);
        return { order, retry: false };
      }
      // Concurrent-duplicate: the ledger insert lost the race → someone else
      // minted. Not an error; return the (soon-to-be) fulfilled order.
      const msg = (e as Error).message || '';
      if (/duplicate|unique|ER_DUP_ENTRY|constraint/i.test(msg)) {
        this.log.log(`stripe event ${params.eventId} raced — another worker handled it`);
        return { order: await this.findBySession(order.stripeSessionId), retry: false };
      }
      // Transient (DB hiccup, etc.) — ledger rolled back, let Stripe retry.
      this.log.error(`fulfill: transient error on order ${order.id}: ${msg} — will retry`);
      throw e;
    }

    // §2.4 — arm the activation so the buyer's OWN editor can upgrade itself
    // without pasting anything. Best-effort and deliberately AFTER the commit:
    // the purchase is already complete and the key is already being emailed, so
    // a failure here costs a convenience, never the sale.
    if (order.installId && order.license?.licId && this.activations) {
      await this.activations
        .create(order.installId, order.license.licId)
        .catch(() => undefined);
    }

    // Best-effort delivery — never fail fulfillment on a mail error (committed).
    if (licenseToken) {
      await this.email.sendLicenseEmail({
        to: order.customerEmail,
        customerName: order.customerName,
        planName: order.packageName,
        licenseKey: licenseToken,
      });
    }

    this.log.log(`fulfilled order ${order.id} → license ${order.license?.id} for ${order.customerEmail}`);
    return { order, retry: false };
  }

  /** Fetch a single order by id WITH its license + package (for admin actions
   *  like force-fulfill). Token-bearing — callers must be admin-guarded. */
  async getOrderById(id: string): Promise<OrderEntity | null> {
    return this.orders.findOne({ where: { id }, relations: ['license', 'package'] });
  }

  /** For the success page: the fulfilled order (with license) for a session. */
  async findBySession(sessionId: string): Promise<OrderEntity | null> {
    return this.orders.findOne({ where: { stripeSessionId: sessionId }, relations: ['license'] });
  }

  /**
   * Admin recovery action: RE-SEND a license's key to the customer by email.
   * Closes the money-path gap where the fulfillment email failed to deliver
   * (SMTP down) AND the buyer never opened the one-time success page — the
   * license was minted and stored, but the customer never received it.
   *
   * Reuses the license's OWN snapshot (customer email/name, plan name) and its
   * currently-valid signed token — never a bulk-listed value (the token is
   * deliberately stripped from the licenses list). Refuses to re-send a
   * revoked/expired credential (nothing useful to deliver). Returns the send
   * outcome so the admin sees whether the transport actually accepted it.
   */
  async resendLicenseEmail(licenseId: string): Promise<{ delivered: boolean; to: string }> {
    const lic = await this.licenses.get(licenseId, ['customer']);
    if (!lic) throw new NotFoundException('license not found');
    if (lic.effectiveStatus() !== 'active') {
      throw new BadRequestException('cannot resend a revoked or expired license — regenerate it first');
    }
    const to = lic.customer?.email;
    if (!to) throw new BadRequestException('license has no customer email on file');

    const delivered = await this.email.sendLicenseEmail({
      to,
      customerName: lic.customer?.name || '',
      planName: lic.planName || 'your',
      licenseKey: lic.token,
    });
    this.log.log(`resend license ${lic.id} to ${to}: delivered=${delivered}`);
    return { delivered, to };
  }

  /**
   * Phase 5d — rebind a license to NEW domains and NOTIFY the customer. Revokes
   * the old license + mints a new one for the new domains (same paid term), then
   * emails the new key to re-paste. Reuses LicenseService.regenerateWithDomains
   * (atomic) + EmailService here (where both are available, like resend).
   *
   * LOCKOUT SAFETY (audit F1): the old key is dead the moment we rebind, so if the
   * email FAILS the customer would be stranded. In that ONLY case we return the new
   * token in the response so the admin has an out-of-band copy to hand over (this
   * is an admin-only route — same trust level as regenerate, which also returns a
   * token). On success the token is NOT returned (email is the delivery). */
  async rebindLicenseDomains(licenseId: string, domains: string[]): Promise<{ licenseId: string; delivered: boolean; to: string; licenseKey?: string }> {
    const fresh = await this.licenses.regenerateWithDomains(licenseId, domains);
    const to = fresh.customer?.email || '';
    let delivered = false;
    if (to) {
      delivered = await this.email.sendKeyRotatedEmail({
        to,
        customerName: fresh.customer?.name || '',
        planName: fresh.planName || 'your',
        licenseKey: fresh.token,
        domains: fresh.domains,
      });
    }
    this.log.log(`rebind license ${fresh.id} → [${fresh.domains.join(', ')}]; emailed ${to || '(no email)'} delivered=${delivered}`);
    // Surface the key ONLY when delivery failed (or there was no email) so the
    // admin can recover the customer out-of-band; never on the happy path.
    return delivered
      ? { licenseId: fresh.id, delivered, to }
      : { licenseId: fresh.id, delivered, to, licenseKey: fresh.token };
  }

  /**
   * Admin orders list (newest first), token-free. Surfaces failed orders so a
   * "paid but not fulfilled" case (e.g. amount mismatch, package deleted) is
   * visible instead of silently lost. Never returns the license token.
   */
  /**
   * An order stuck `pending` this long almost certainly means the webhook
   * never arrived (e.g. `stripe listen`/the production webhook endpoint was
   * down when the buyer paid) — Stripe's own retry schedule gives up well
   * before this. Surfacing it in `listOrders()` turns a silent buyer-facing
   * stall (the success page just times out to a vague "almost there") into
   * something an admin can actually see and act on (check Stripe's dashboard
   * for the event, or manually fulfill).
   */
  private static readonly STALE_PENDING_MS = 30 * 60 * 1000; // 30 minutes

  /**
   * True if `createdAt` is old enough (or unreadable) to call this pending
   * order stale. `@CreateDateColumn` always populates a real Date in normal
   * operation, so a malformed/missing value here would itself be a data
   * problem — this fails toward SURFACING that (stale=true), not silently
   * reporting "fine" the way a bare `NaN > threshold` comparison would
   * (`NaN` is never `>` anything, so that comparison alone always resolves
   * to false and would hide the very problem this flag exists to catch).
   */
  private static isStalePending(status: string, createdAt: unknown, now: number): boolean {
    if (status !== 'pending') return false;
    const ms = new Date(createdAt as string | number | Date).getTime();
    if (Number.isNaN(ms)) return true; // unreadable createdAt — flag, don't hide
    return now - ms > OrderService.STALE_PENDING_MS;
  }

  /**
   * `q` matches customer email/name (case-insensitive substring — same
   * portable `LOWER()+LIKE...ESCAPE '!'` approach as customer search; see
   * admin.controller.ts for why `!` and not `ILike`/backslash). `status`
   * filters to an exact OrderStatus. Both optional; combining them ANDs.
   */
  async listOrders(q?: string, status?: string): Promise<Array<Record<string, unknown>>> {
    const qb = this.orders.createQueryBuilder('o')
      .leftJoinAndSelect('o.license', 'license')
      .orderBy('o.createdAt', 'DESC');

    const term = q?.trim();
    if (term) {
      const pattern = `%${term.toLowerCase().replace(/[%_!]/g, (c) => `!${c}`)}%`;
      qb.andWhere(
        "(LOWER(o.customerEmail) LIKE :pattern ESCAPE '!' OR LOWER(o.customerName) LIKE :pattern ESCAPE '!')",
        { pattern },
      );
    }
    const VALID_STATUSES = new Set(['pending', 'fulfilled', 'failed', 'expired']);
    if (status && VALID_STATUSES.has(status)) {
      qb.andWhere('o.status = :status', { status });
    }

    const rows = await qb.getMany();
    const now = Date.now();
    return rows.map((o) => ({
      id: o.id,
      status: o.status,
      packageName: o.packageName,
      amountCents: o.amountCents,
      currency: o.currency,
      customerEmail: o.customerEmail,
      customerName: o.customerName,
      domains: o.domains,
      licenseId: o.license ? o.license.id : null,
      licenseDelivered: o.licenseDelivered,
      createdAt: o.createdAt,
      stalePending: OrderService.isStalePending(o.status, o.createdAt, now),
    }));
  }

  /**
   * SINGLE-USE license retrieval for the success page. Returns the signed key
   * only on the FIRST fulfilled read for a session; marks it delivered so a
   * later read of the same (potentially leaked) session-id URL cannot re-fetch
   * the bearer token. The mark is done with a conditional UPDATE so two racing
   * reads can't both win. Non-fulfilled orders just report their status.
   */
  async retrieveLicenseOnce(sessionId: string): Promise<
    | { status: 'unknown' }
    | { status: 'pending' | 'failed' | 'expired' }
    | { status: 'fulfilled'; delivered: false; planName: string; licenseKey: string; features: string[]; domains: string[] }
    | { status: 'fulfilled'; delivered: true }
  > {
    const order = await this.orders.findOne({ where: { stripeSessionId: sessionId }, relations: ['license'] });
    if (!order) return { status: 'unknown' };
    if (order.status !== 'fulfilled' || !order.license) {
      return { status: order.status as 'pending' | 'failed' | 'expired' };
    }
    // Atomically claim the one-time delivery: flip false→true; only the winner
    // gets the key. If already delivered, tell the client to check email.
    const claim = await this.orders.update(
      { id: order.id, licenseDelivered: false },
      { licenseDelivered: true },
    );
    if (!claim.affected) {
      return { status: 'fulfilled', delivered: true };
    }
    return {
      status: 'fulfilled',
      delivered: false,
      planName: order.packageName,
      licenseKey: order.license.token,
      features: order.license.features,
      domains: order.license.domains,
    };
  }

  /**
   * Find the customer by email, or create one. Deliberately does NOT mutate an
   * EXISTING customer's domain list: the purchased domains are bound to the
   * LICENSE (its own snapshot), which is where enforcement happens. Merging into
   * a shared customer record would let one buyer's domains pollute another's
   * (same-email collision). We only set domains when creating a NEW customer.
   */
  private async upsertCustomer(email: string, name: string, domains: string[]): Promise<CustomerEntity> {
    const existing = await this.customers.findOne({ where: { email } });
    if (existing) return existing;
    return this.customers.save(this.customers.create({
      name: name || email, email, domains,
    }));
  }
}

