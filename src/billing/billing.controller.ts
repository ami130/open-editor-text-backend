/**
 * billing.controller.ts — the public billing surface (Stripe, one-time).
 *
 *   POST /billing/checkout            (@Public) create a Checkout Session
 *   POST /billing/webhook             (@Public, RAW body) fulfill on payment
 *   GET  /billing/orders/:sid/license (@Public) success-page key retrieval
 *
 * These are @Public (no admin JWT). The webhook is authenticated by the Stripe
 * SIGNATURE instead — only Stripe can produce a valid one. Checkout + success
 * are same-origin-guarded at the BFF layer (open-editor-web) and rate-limitable
 * (Phase G). The price is ALWAYS taken server-side from the DB package.
 */
import {
  Controller, Post, Get, Body, Param, Req, Headers,
  BadRequestException, Inject, Logger, ServiceUnavailableException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators';
import { OrderService } from './order.service';
import { STRIPE_CLIENT, StripeClient } from './stripe.service';
import { BILLING_CONFIG, BillingConfig } from '../config/billing.config';
import { CreateCheckoutDto } from './dto/checkout.dto';
import { loadThrottleConfig } from '../config/throttle.config';

const T = loadThrottleConfig();

@Controller('billing')
export class BillingController {
  private readonly log = new Logger('BillingController');

  constructor(
    @Inject(OrderService) private readonly orders: OrderService,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
    @Inject(BILLING_CONFIG) private readonly cfg: BillingConfig,
  ) {}

  // Strict limit: each checkout creates a Stripe session + a DB row, so it's a
  // cheap-to-fire, costly-to-serve public endpoint — cap it tightly per IP.
  @Throttle({ default: { ttl: T.checkoutTtlMs, limit: T.checkoutLimit } })
  @Public()
  @Post('checkout')
  async checkout(@Body() dto: CreateCheckoutDto) {
    if (!this.stripe.enabled) {
      throw new ServiceUnavailableException('billing is not configured');
    }
    // Validate + snapshot the authoritative price into a pending order.
    const { order } = await this.orders.prepareOrder({
      packageId: dto.packageId, email: dto.email, name: dto.name, domains: dto.domains,
    });
    // Create the Stripe EMBEDDED session, then bind its id to our order.
    const session = await this.stripe.createCheckoutSession({
      orderId: order.id,
      packageName: order.packageName,
      amountCents: order.amountCents,
      currency: order.currency,
      customerEmail: order.customerEmail,
      returnUrl: this.cfg.returnUrl,
    });
    await this.orders.attachSession(order.id, session.id);
    // clientSecret drives the on-site embedded form; sessionId lets the
    // success page poll for the minted license after payment.
    return { clientSecret: session.clientSecret, sessionId: session.id };
  }

  // NOT rate-limited: Stripe delivers from its own IPs and RETRIES on non-2xx;
  // throttling could drop legitimate retries and lose a fulfillment. The
  // signature check is the real gate here, not a rate limit.
  @SkipThrottle()
  @Public()
  @Post('webhook')
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string) {
    const raw = req.rawBody;
    if (!raw) {
      // Raw body missing = misconfiguration (rawBody not enabled). Fail loud.
      throw new BadRequestException('missing raw body for signature verification');
    }
    if (!signature) throw new BadRequestException('missing stripe-signature header');

    let event;
    try {
      event = this.stripe.constructEvent(raw, signature);
    } catch (e) {
      // Bad/forged signature → 400, and nothing is minted.
      this.log.warn(`webhook signature verification failed: ${(e as Error).message}`);
      throw new BadRequestException('invalid signature');
    }

    // We only act on a completed checkout whose payment is actually settled.
    // Note: payment_status 'no_payment_required' (a 100%-off session) is
    // intentionally NOT treated as paid — only 'paid' proceeds, and the
    // amount is then re-checked in the service against the order.
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as {
        id: string; payment_status?: string; amount_total?: number | null; currency?: string | null;
        metadata?: { orderId?: string }; client_reference_id?: string;
      };
      if (session.payment_status === 'paid') {
        const result = await this.orders.fulfillFromEvent({
          eventId: event.id,
          eventType: event.type,
          orderId: session.metadata?.orderId || session.client_reference_id || undefined,
          sessionId: session.id,
          amountPaidCents: session.amount_total,
          currencyPaid: session.currency,
        });
        // If our order isn't visible yet (webhook beat attachSession), ask
        // Stripe to retry by returning a non-2xx — do NOT swallow it as 200.
        if (result.retry) {
          throw new ServiceUnavailableException('order not ready — retry');
        }
      } else {
        this.log.log(`checkout.session.completed but payment_status=${session.payment_status} — ignored`);
      }
    }

    // 200 for a validly-signed, handled event so Stripe stops retrying.
    return { received: true };
  }

  @Public()
  @Get('orders/:sessionId/license')
  async orderLicense(@Param('sessionId') sessionId: string) {
    // SINGLE-USE: the signed key is returned only on the first fulfilled read
    // for this session. A replayed/leaked success URL gets {delivered:true} and
    // no token — the buyer is told to use the emailed copy. (The admin license
    // list never exposes tokens either; this is the buyer's one-time retrieval.)
    return this.orders.retrieveLicenseOnce(sessionId);
  }
}
