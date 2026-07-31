/**
 * portal-license.controller.ts — authenticated self-serve license routes
 * (Phase 4b). All @Public() to the GLOBAL admin guard, then gated by
 * CustomerAuthGuard, and every action is scoped to the authenticated customer
 * (the service re-checks ownership — the :id in the URL is untrusted).
 *
 *   GET  /portal/licenses               → my licenses (safe fields, NO token)
 *   GET  /portal/licenses/:id/key       → reveal the CURRENT token (mine, active)
 *   POST /portal/licenses/:id/regenerate→ new key, old one revoked (honor-snapshot)
 */
import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators';
import { loadThrottleConfig } from '../config/throttle.config';
import { CustomerAuthGuard } from './customer-auth.guard';
import { CurrentCustomer, CustomerClaims } from './current-customer.decorator';
import { PortalLicenseService } from './portal-license.service';

const T = loadThrottleConfig();

@Public()
@UseGuards(CustomerAuthGuard)
@Controller('portal/licenses')
export class PortalLicenseController {
  constructor(private readonly svc: PortalLicenseService) {}

  @Get()
  list(@CurrentCustomer() c: CustomerClaims) {
    return this.svc.listForCustomer(c.sub);
  }

  @Get(':id/key')
  reveal(@CurrentCustomer() c: CustomerClaims, @Param('id') id: string) {
    return this.svc.revealToken(c.sub, id);
  }

  // Regenerate mints a fresh signed token → tighter throttle (it's a write that
  // invalidates the old key). Reuse the strict `auth` bucket.
  @Throttle({ default: { ttl: T.authTtlMs, limit: T.authLimit } })
  @Post(':id/regenerate')
  regenerate(@CurrentCustomer() c: CustomerClaims, @Param('id') id: string) {
    return this.svc.regenerateForCustomer(c.sub, id);
  }
}
