/**
 * order-admin.controller.ts — the admin's read-only view of purchase orders.
 * Guarded (needs order.read); surfaces fulfilled AND failed orders so a
 * "paid but not issued" case is never silently lost. Tokens are never returned.
 */
import {
  Controller, Get, Post, Body, Param, Query, Inject, BadRequestException, Logger,
} from '@nestjs/common';
import { IsArray, ArrayNotEmpty, IsString } from 'class-validator';
import { RequirePermissions } from '../auth/decorators';
import { OrderService } from './order.service';
import { STRIPE_CLIENT, StripeClient } from './stripe.service';

/** Body for the Phase-5d domain rebind: the license's NEW domain list. */
export class RebindDomainsDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  domains!: string[];
}

@Controller('admin/orders')
export class OrderAdminController {
  private readonly log = new Logger('OrderAdminController');

  constructor(
    @Inject(OrderService) private readonly orders: OrderService,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
  ) {}

  /** `?q=` filters by customer email/name; `?status=` filters to an exact status. */
  @Get() @RequirePermissions('order.read')
  list(@Query('q') q?: string, @Query('status') status?: string) {
    return this.orders.listOrders(q, status);
  }

  /**
   * ADMIN force-fulfill a "paid but not fulfilled" order (audit — the webhook
   * never arrived / Stripe exhausted retries, so the buyer paid and got nothing).
   * We RETRIEVE the session fresh from Stripe (source of truth), confirm it's
   * actually PAID, then delegate to the SAME idempotent `fulfillFromEvent` the
   * webhook uses — so the amount is re-verified against the order and a double
   * mint is impossible (already-fulfilled → returns the existing license, mints
   * nothing). Gated by `license.issue` (fulfilling mints a bearer credential).
   */
  @Post(':id/force-fulfill') @RequirePermissions('license.issue')
  async forceFulfill(@Param('id') id: string) {
    if (!this.stripe.enabled) throw new BadRequestException('billing is not configured');
    const order = await this.orders.getOrderById(id);
    if (!order) throw new BadRequestException('order not found');
    if (order.status === 'fulfilled') {
      return { fulfilled: true, alreadyFulfilled: true, licenseId: order.license?.id ?? null };
    }
    if (!order.stripeSessionId) {
      throw new BadRequestException('order has no Stripe session — cannot fulfill (was checkout ever started?)');
    }
    const session = await this.stripe.retrieveSession(order.stripeSessionId);
    if (session.paymentStatus !== 'paid') {
      throw new BadRequestException(`Stripe reports this session is not paid (payment_status=${session.paymentStatus ?? 'unknown'}) — nothing to fulfill`);
    }
    // Deterministic synthetic eventId so re-clicking is idempotent via the
    // processed-events ledger (same key → dedup, never a second mint).
    const result = await this.orders.fulfillFromEvent({
      eventId: `admin-force:${order.stripeSessionId}`,
      eventType: 'admin.force_fulfill',
      orderId: order.id,
      sessionId: order.stripeSessionId,
      amountPaidCents: session.amountTotal,
      currencyPaid: session.currency,
    });
    if (!result.order || result.order.status !== 'fulfilled') {
      throw new BadRequestException('fulfillment did not complete (amount mismatch or a transient error) — check the order status and server logs');
    }
    this.log.log(`admin force-fulfilled order ${order.id} → license ${result.order.license?.id}`);
    return { fulfilled: true, alreadyFulfilled: false, licenseId: result.order.license?.id ?? null };
  }
}

/**
 * Lives in the billing module because re-sending the license email needs both
 * the LicenseService (the token) AND the EmailService (the transport), and
 * EmailService is provided here — not in the licensing/admin modules. Gated by
 * `license.issue`: re-delivering a bearer token is as sensitive as issuing one.
 */
@Controller('admin/licenses')
export class LicenseEmailAdminController {
  constructor(@Inject(OrderService) private readonly orders: OrderService) {}

  /** Re-send a minted license's key to its customer (SMTP-failure recovery). */
  @Post(':id/resend-email') @RequirePermissions('license.issue')
  resend(@Param('id') id: string) {
    return this.orders.resendLicenseEmail(id);
  }

  /**
   * Phase 5d — rebind a license to NEW domains + email the customer the new key
   * to re-paste. Mints a new credential (old one revoked) so it needs BOTH
   * license.revoke + license.issue, like regenerate.
   */
  @Post(':id/rebind-domains') @RequirePermissions('license.revoke', 'license.issue')
  rebind(@Param('id') id: string, @Body() dto: RebindDomainsDto) {
    return this.orders.rebindLicenseDomains(id, dto.domains);
  }
}
