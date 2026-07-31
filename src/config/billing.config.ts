/**
 * billing.config.ts — typed configuration for Stripe billing (Phase F).
 *
 * Like the AI proxy, the secret keys are read from the server environment and
 * NEVER reach the browser. Billing is OPTIONAL: if STRIPE_SECRET_KEY is unset,
 * `enabled` is false and the billing endpoints 503 cleanly (the app still boots
 * and everything else works). The webhook additionally needs the signing secret
 * to verify events — without it, webhooks are rejected.
 */

export interface BillingConfig {
  /** Stripe secret key (sk_test_… / sk_live_…). Server-only. */
  secretKey: string;
  /**
   * Stripe PUBLISHABLE key (pk_test_… / pk_live_…). SAFE to expose to the
   * browser — it's required by Stripe.js for the EMBEDDED checkout form that
   * renders on our own site. Exposed to the client via /public/billing-status.
   */
  publishableKey: string;
  /** Webhook signing secret (whsec_…) — verifies incoming events. */
  webhookSecret: string;
  /** Whether billing is usable at all (a secret key is present). */
  enabled: boolean;
  /**
   * Embedded Checkout return URL — where Stripe sends the buyer AFTER payment
   * completes ON our page (embedded has no cancel URL; the buyer just closes
   * the form). Carries {CHECKOUT_SESSION_ID} so the success page can poll for
   * the minted license.
   */
  returnUrl: string;
  /** (Legacy hosted-mode redirect URL — retained but unused in embedded mode.) */
  successUrl: string;
  /** The web app origin (no trailing slash) — used to build customer-facing links
   *  like the expiry-reminder re-purchase URL (audit B2). */
  webOrigin: string;
  /** From-address for the license-delivery email (dev logs when unset). */
  emailFrom: string;
  /**
   * Optional outbound email webhook. When set, license emails are POSTed as
   * JSON to this URL (point it at your provider — Resend/SES/Postmark/etc. — or
   * a small relay). When unset, emails are dev-logged (metadata only). Keeps the
   * backend vendor-neutral: no provider SDK baked in.
   */
  emailWebhookUrl: string;
  /** Optional bearer token sent as Authorization on the email webhook. */
  emailWebhookToken: string;
  /**
   * Optional SMTP transport for license emails (e.g. Gmail). When SMTP_HOST is
   * set, the email service sends via SMTP (preferred over the webhook). All
   * server-only; never shipped to the browser.
   */
  smtp: {
    host: string;
    port: number;
    secure: boolean;   // true for port 465 (implicit TLS); false uses STARTTLS
    user: string;
    pass: string;
  };
}

/** Read + normalize billing config from the environment. Pure; no side effects. */
export function loadBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const secretKey = (env.STRIPE_SECRET_KEY || '').trim();
  const publishableKey = (env.STRIPE_PUBLISHABLE_KEY || '').trim();
  const webhookSecret = (env.STRIPE_WEBHOOK_SECRET || '').trim();
  // Default the redirect URLs to the admin/web app origin; overridable per env.
  const webOrigin = (env.WEB_APP_ORIGIN || 'http://localhost:3000').replace(/\/+$/, '');
  const successUrl = (env.CHECKOUT_SUCCESS_URL
    || `${webOrigin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`).trim();
  // Embedded return URL = the success page (reuses successUrl's value/env).
  const returnUrl = successUrl;
  return {
    secretKey,
    publishableKey,
    webhookSecret,
    enabled: secretKey.length > 0,
    returnUrl,
    successUrl,
    webOrigin,
    emailFrom: (env.EMAIL_FROM || 'licenses@open-editor.local').trim(),
    emailWebhookUrl: (env.EMAIL_WEBHOOK_URL || '').trim(),
    emailWebhookToken: (env.EMAIL_WEBHOOK_TOKEN || '').trim(),
    smtp: {
      host: (env.SMTP_HOST || '').trim(),
      port: parseInt(env.SMTP_PORT || '587', 10) || 587,
      // Port 465 = implicit TLS (secure:true); 587/others = STARTTLS (secure:false).
      secure: (env.SMTP_SECURE || (env.SMTP_PORT === '465' ? 'true' : 'false')).toLowerCase() === 'true',
      user: (env.SMTP_USER || '').trim(),
      pass: (env.SMTP_PASS || '').trim(),
    },
  };
}

export const BILLING_CONFIG = 'BILLING_CONFIG';
