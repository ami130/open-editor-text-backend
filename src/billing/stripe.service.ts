/**
 * stripe.service.ts — a thin, mockable wrapper around the Stripe SDK.
 *
 * The controller depends on the STRIPE_CLIENT token (this interface), so tests
 * inject a fake with the same shape — no network, no keys. The real service
 * constructs a Stripe client from the server-only secret key and:
 *   • creates a one-time (mode:'payment') Checkout Session with the price taken
 *     from OUR database package (never the client), and
 *   • verifies inbound webhook signatures against the webhook secret.
 *
 * If no secret key is configured the service is DISABLED and any attempt to use
 * it throws a 503-mapped error (mirrors the AI proxy's "no key" behaviour).
 */
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import { BILLING_CONFIG, BillingConfig } from '../config/billing.config';

/** DI token so the controller/service can depend on the interface, not the class. */
export const STRIPE_CLIENT = 'STRIPE_CLIENT';

export interface CheckoutSessionInput {
  /** Our order id — echoed back in the event metadata for fulfillment. */
  orderId: string;
  packageName: string;
  amountCents: number;
  currency: string;
  customerEmail: string;
  /**
   * Where Stripe sends the buyer after payment completes ON our embedded page.
   * Embedded mode has NO cancel URL (the buyer stays on our page). Should
   * carry {CHECKOUT_SESSION_ID} so the success page can poll for the license.
   */
  returnUrl: string;
}

export interface CheckoutSessionResult {
  id: string;
  /**
   * The Embedded Checkout client secret — handed to Stripe.js in the browser
   * to mount the on-site payment form. (Embedded mode returns this instead of
   * a hosted `url`.)
   */
  clientSecret: string;
}

/** A retrieved Checkout Session — the minimal fields fulfillment needs. */
export interface RetrievedSession {
  id: string;
  paymentStatus: string | null;
  amountTotal: number | null;
  currency: string | null;
  orderId: string | null;
}

/** The minimal surface the billing code needs from Stripe (real or fake). */
export interface StripeClient {
  readonly enabled: boolean;
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult>;
  /** Verify + parse a webhook payload. Throws if the signature is invalid. */
  constructEvent(rawBody: Buffer | string, signature: string): Stripe.Event;
  /** Retrieve a Checkout Session fresh from Stripe — the source of truth for an
   *  ADMIN force-fulfill of a stuck order (no webhook event in hand). Returns the
   *  real paid amount/currency so the existing idempotent fulfill re-verifies it. */
  retrieveSession(sessionId: string): Promise<RetrievedSession>;
}

@Injectable()
export class StripeService implements StripeClient {
  private readonly stripe: Stripe | null;

  constructor(@Inject(BILLING_CONFIG) private readonly cfg: BillingConfig) {
    this.stripe = cfg.enabled ? new Stripe(cfg.secretKey) : null;
  }

  get enabled(): boolean {
    return this.stripe !== null;
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const stripe = this.require();
    const session = await stripe.checkout.sessions.create({
      // EMBEDDED: the payment form renders on OUR /checkout page (no redirect
      // to checkout.stripe.com). Stripe.js in the browser consumes the
      // returned client_secret to mount it. NOTE: this pinned Stripe API
      // version names the value 'embedded_page' (older versions used
      // 'embedded'); the client library's EmbeddedCheckout maps to it.
      ui_mode: 'embedded_page',
      mode: 'payment',
      // CARD ONLY. Explicitly pinning payment_method_types stops Stripe's
      // "automatic payment methods" behaviour (which, when this field is
      // OMITTED, shows whatever is enabled in the Stripe Dashboard — Amazon
      // Pay, Klarna, Cash App, Link, etc.). We only want cards. (Apple/Google
      // Pay still appear as card wallets in a supporting browser — that IS the
      // 'card' method, not a separate provider, and can't be split out here.)
      payment_method_types: ['card'],
      // USD DISPLAY ONLY. Stripe "Adaptive Pricing" (on by default in the
      // Dashboard) shows the buyer a CONVERTED local-currency price (e.g. BDT
      // for a Bangladesh visitor) even though we charge USD. Disable it so the
      // buyer always sees USD $ — matching the single-currency product.
      adaptive_pricing: { enabled: false },
      // Price is built from OUR package data — the client never sends an amount.
      // Currency is FORCED to USD (the only currency this product sells in),
      // not read from the package, so even a legacy/mis-entered non-USD package
      // can never reach Stripe in another currency.
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: input.amountCents,
          product_data: { name: input.packageName },
        },
      }],
      customer_email: input.customerEmail,
      // Embedded uses a single return_url (no cancel_url — buyer stays on our
      // page). {CHECKOUT_SESSION_ID} is substituted by Stripe on return.
      return_url: input.returnUrl,
      // Echoed back on the completed event so the webhook can find our order.
      metadata: { orderId: input.orderId },
      client_reference_id: input.orderId,
    });
    if (!session.client_secret) throw new ServiceUnavailableException('Stripe did not return a checkout client secret');
    return { id: session.id, clientSecret: session.client_secret };
  }

  constructEvent(rawBody: Buffer | string, signature: string): Stripe.Event {
    const stripe = this.require();
    if (!this.cfg.webhookSecret) {
      throw new ServiceUnavailableException('webhook secret not configured');
    }
    // Throws on a bad/forged signature — the controller maps that to 400.
    return stripe.webhooks.constructEvent(rawBody, signature, this.cfg.webhookSecret);
  }

  async retrieveSession(sessionId: string): Promise<RetrievedSession> {
    const stripe = this.require();
    const s = await stripe.checkout.sessions.retrieve(sessionId);
    return {
      id: s.id,
      paymentStatus: s.payment_status ?? null,
      amountTotal: s.amount_total ?? null,
      currency: s.currency ?? null,
      orderId: (s.metadata && s.metadata.orderId) || null,
    };
  }

  private require(): Stripe {
    if (!this.stripe) {
      throw new ServiceUnavailableException('billing is not configured (no STRIPE_SECRET_KEY)');
    }
    return this.stripe;
  }
}
