/**
 * email.service.ts — delivers the license key to the buyer after payment.
 *
 * Three transports, tried in order of what's configured:
 *   • SMTP (e.g. Gmail): if SMTP_HOST is set, send via nodemailer. Preferred.
 *   • WEBHOOK: else if EMAIL_WEBHOOK_URL is set, POST the message as JSON to it
 *     (Resend/SES/Postmark or a relay).
 *   • DEV (default): log metadata only (never the key — it's a bearer
 *     credential) so the whole flow runs with no email config.
 * Sending must NEVER throw the fulfillment path over: on failure we log and
 * return false; the license is still issued and shown once on the success page.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { BILLING_CONFIG, BillingConfig } from '../config/billing.config';

export interface LicenseEmailInput {
  to: string;
  customerName: string;
  planName: string;
  licenseKey: string;
}

export interface PortalLinkEmailInput {
  to: string;
  customerName: string;
  /** The one-time magic-link URL the customer clicks to sign in. */
  link: string;
}

export interface KeyRotatedEmailInput {
  to: string;
  customerName: string;
  planName: string;
  /** The freshly-minted license key to paste (the old one no longer works). */
  licenseKey: string;
  /** The new domain(s) the key is now bound to (shown for confirmation). */
  domains: string[];
}

export interface ExpiryReminderEmailInput {
  to: string;
  customerName: string;
  planName: string;
  /** Whole days remaining until access ends (renewUntil), for the message copy. */
  daysLeft: number;
  /** Where to re-purchase (the storefront). NEVER contains the license key —
   *  this is a nudge, not a key delivery; the customer re-buys to extend access. */
  rebuyUrl: string;
}

// Bound so a hung provider can't wedge fulfillment.
const EMAIL_TIMEOUT_MS = 15_000;

@Injectable()
export class EmailService {
  private readonly log = new Logger('EmailService');
  private transporter: Transporter | null = null;

  constructor(@Inject(BILLING_CONFIG) private readonly cfg: BillingConfig) {}

  /**
   * Send the license email. Returns true if sent/dev-logged, false if a real
   * transport failed — callers must NOT abort fulfillment on false.
   */
  async sendLicenseEmail(input: LicenseEmailInput): Promise<boolean> {
    if (this.cfg.smtp.host) return this.sendViaSmtp(input);
    if (this.cfg.emailWebhookUrl) return this.sendViaWebhook(input);
    // DEV transport: metadata only — the license key never lands in logs.
    this.log.log(
      `[dev-email] To: ${input.to} | From: ${this.cfg.emailFrom} | `
      + `Subject: ${this.subject(input)} (${input.licenseKey.length}-char key delivered)`,
    );
    return true;
  }

  /**
   * Send the self-serve portal magic-link (Phase 4). Same transport chain +
   * never-throw contract as the license email. The link is a bearer credential
   * (one-time login), so — like the license key — it is NEVER written to logs;
   * the dev transport logs metadata only.
   */
  async sendPortalLink(input: PortalLinkEmailInput): Promise<boolean> {
    const subject = 'Sign in to your Open Editor licenses';
    const text =
      `Hi ${input.customerName || 'there'},\n\n`
      + `Click the link below to sign in and manage your license keys. `
      + `It expires shortly and can be used once:\n\n`
      + `${input.link}\n\n`
      + `If you didn't request this, you can ignore this email.\n\n`
      + `— The Open Editor team\n`;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    const html =
      `<p>Hi ${esc(input.customerName || 'there')},</p>`
      + `<p>Click below to sign in and manage your license keys. It expires shortly and can be used once:</p>`
      + `<p><a href="${esc(input.link)}">Sign in to your licenses</a></p>`
      + `<p>If you didn't request this, you can ignore this email.</p>`
      + `<p>— The Open Editor team</p>`;

    if (this.cfg.smtp.host) return this.sendRaw(input.to, subject, text, html);
    if (this.cfg.emailWebhookUrl) return this.sendRawWebhook(input.to, subject, text, html);
    // DEV transport: metadata only — never log the link (it's a login credential).
    this.log.log(`[dev-email] To: ${input.to} | Subject: ${subject} (magic-link delivered)`);
    return true;
  }

  /**
   * Notify a customer that their license was rebound to new domains and deliver
   * the NEW key to re-paste (Phase 5d). Same transport chain + never-throw + the
   * key is NEVER logged (dev transport logs metadata only) as the license email.
   */
  async sendKeyRotatedEmail(input: KeyRotatedEmailInput): Promise<boolean> {
    const subject = `Your ${input.planName} license key was updated`;
    const domains = input.domains.join(', ');
    const text =
      `Hi ${input.customerName || 'there'},\n\n`
      + `Your ${input.planName} license was updated for these domain(s): ${domains}.\n`
      + `Your PREVIOUS key no longer works. Here is your new key — paste it into your editor config:\n\n`
      + `${input.licenseKey}\n\n`
      + `— The Open Editor team\n`;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    const html =
      `<p>Hi ${esc(input.customerName || 'there')},</p>`
      + `<p>Your <strong>${esc(input.planName)}</strong> license was updated for these domain(s): <strong>${esc(domains)}</strong>.</p>`
      + `<p>Your PREVIOUS key no longer works. Here is your new key — paste it into your editor config as <code>licenseKey</code>:</p>`
      + `<pre style="padding:12px;background:#f4f4f5;border-radius:8px;white-space:pre-wrap;word-break:break-all;font-size:12px">${esc(input.licenseKey)}</pre>`
      + `<p>— The Open Editor team</p>`;

    if (this.cfg.smtp.host) return this.sendRaw(input.to, subject, text, html);
    if (this.cfg.emailWebhookUrl) return this.sendRawWebhook(input.to, subject, text, html);
    this.log.log(`[dev-email] To: ${input.to} | Subject: ${subject} (rotated key delivered)`);
    return true;
  }

  /**
   * Expiry-reminder email (audit B2): a one-time-per-term nudge sent inline on
   * refresh when a FINITE-term license nears renewUntil. Billing is one-time for a
   * fixed access window (NOT a subscription), so without this the access lapses
   * SILENTLY — the surprise that drives refunds/chargebacks. Never carries the
   * license key (nudge, not delivery); links to the storefront to re-purchase.
   * Same transport chain + never-throw contract as the other emails.
   */
  async sendExpiryReminderEmail(input: ExpiryReminderEmailInput): Promise<boolean> {
    const when = input.daysLeft <= 0
      ? 'today'
      : input.daysLeft === 1 ? 'in 1 day' : `in ${input.daysLeft} days`;
    const subject = `Your ${input.planName} access ends ${when}`;
    const text =
      `Hi ${input.customerName || 'there'},\n\n`
      + `Your ${input.planName} access ends ${when}. This was a one-time purchase for a fixed period `
      + `— it does NOT auto-renew, so premium features will stop working when it lapses.\n\n`
      + `To keep your premium features, re-purchase here:\n${input.rebuyUrl}\n\n`
      + `— The Open Editor team\n`;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    const html =
      `<p>Hi ${esc(input.customerName || 'there')},</p>`
      + `<p>Your <strong>${esc(input.planName)}</strong> access ends <strong>${esc(when)}</strong>. `
      + `This was a one-time purchase for a fixed period — it does <strong>not</strong> auto-renew, `
      + `so premium features will stop working when it lapses.</p>`
      + `<p>To keep your premium features, <a href="${esc(input.rebuyUrl)}">re-purchase here</a>.</p>`
      + `<p>— The Open Editor team</p>`;

    if (this.cfg.smtp.host) return this.sendRaw(input.to, subject, text, html);
    if (this.cfg.emailWebhookUrl) return this.sendRawWebhook(input.to, subject, text, html);
    this.log.log(`[dev-email] To: ${input.to} | Subject: ${subject} (expiry reminder)`);
    return true;
  }

  /** Compose the email subject/body once (shared by every transport). */
  private subject(input: LicenseEmailInput): string {
    return `Your ${input.planName} license key`;
  }

  private textBody(input: LicenseEmailInput): string {
    return (
      `Hi ${input.customerName || 'there'},\n\n`
      + `Thank you for purchasing ${input.planName}. Here is your license key:\n\n`
      + `${input.licenseKey}\n\n`
      + `To activate it, paste the key into your editor config:\n\n`
      + `  const editor = new OpenEditor("#editor", {\n`
      + `    licenseKey: "${input.licenseKey.slice(0, 16)}…",\n`
      + `  });\n\n`
      + `Keep this key safe — it unlocks your premium features on your domain.\n\n`
      + `— The Open Editor team\n`
    );
  }

  private htmlBody(input: LicenseEmailInput): string {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    return (
      `<p>Hi ${esc(input.customerName || 'there')},</p>`
      + `<p>Thank you for purchasing <strong>${esc(input.planName)}</strong>. Here is your license key:</p>`
      + `<pre style="padding:12px;background:#f4f4f5;border-radius:8px;white-space:pre-wrap;word-break:break-all;font-size:12px">${esc(input.licenseKey)}</pre>`
      + `<p>To activate it, paste the key into your editor config as <code>licenseKey</code>.</p>`
      + `<p>Keep this key safe — it unlocks your premium features on your domain.</p>`
      + `<p>— The Open Editor team</p>`
    );
  }

  /** SMTP (nodemailer). Transporter is created once and reused. */
  private sendViaSmtp(input: LicenseEmailInput): Promise<boolean> {
    return this.sendRaw(input.to, this.subject(input), this.textBody(input), this.htmlBody(input));
  }

  private sendViaWebhook(input: LicenseEmailInput): Promise<boolean> {
    return this.sendRawWebhook(input.to, this.subject(input), this.textBody(input), this.htmlBody(input));
  }

  /** Generic SMTP send (shared by license + portal emails). Never throws. */
  private async sendRaw(to: string, subject: string, text: string, html: string): Promise<boolean> {
    try {
      if (!this.transporter) {
        this.transporter = nodemailer.createTransport({
          host: this.cfg.smtp.host,
          port: this.cfg.smtp.port,
          secure: this.cfg.smtp.secure,
          auth: this.cfg.smtp.user ? { user: this.cfg.smtp.user, pass: this.cfg.smtp.pass } : undefined,
          connectionTimeout: EMAIL_TIMEOUT_MS,
          greetingTimeout: EMAIL_TIMEOUT_MS,
          socketTimeout: EMAIL_TIMEOUT_MS,
        });
      }
      await this.transporter.sendMail({ from: this.cfg.emailFrom, to, subject, text, html });
      this.log.log(`email sent via SMTP to ${to}`);
      return true;
    } catch (e) {
      this.log.warn(`email SMTP send failed for ${to}: ${(e as Error).message}`);
      return false;
    }
  }

  /** Generic webhook send (shared by license + portal emails). Never throws. */
  private async sendRawWebhook(to: string, subject: string, text: string, html: string): Promise<boolean> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.cfg.emailWebhookToken) headers.Authorization = `Bearer ${this.cfg.emailWebhookToken}`;
      const res = await fetch(this.cfg.emailWebhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ from: this.cfg.emailFrom, to, subject, text, html }),
        signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.log.warn(`email webhook returned ${res.status} for ${to}`);
        return false;
      }
      this.log.log(`email delivered via webhook to ${to}`);
      return true;
    } catch (e) {
      this.log.warn(`email webhook failed for ${to}: ${(e as Error).message}`);
      return false;
    }
  }
}
