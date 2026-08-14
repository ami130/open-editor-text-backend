/**
 * admin.controller.ts — the guarded admin REST API the panel calls. Every route
 * requires a valid admin JWT (global guard) AND the declared permission(s).
 * Split by resource: features (read), packages (CRUD), customers (CRUD),
 * licenses (issue/renew/revoke/list).
 */
import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Inject, Optional, NotFoundException,
  BadRequestException, Logger,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { RequirePermissions, CurrentUser } from '../auth/decorators';
import type { AccessClaims } from '../auth/auth.service';
import { FeatureEntity } from '../licensing/entities/feature.entity';
import { CustomerEntity } from '../licensing/entities/customer.entity';
import { PackageAdminService } from './package-admin.service';
import { LicenseService } from '../licensing/license.service';
import { normalizeDomains, assertDomainsAcceptable } from '../licensing/domain-policy';
import { RbacService } from './rbac.service';
import { CreatePackageDto, UpdatePackageDto } from './dto/package.dto';
import { CreateCustomerDto, UpdateCustomerDto } from './dto/customer.dto';
import { IssueLicenseDto, RenewLicenseDto } from './dto/license.dto';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { LicenseInstallService } from '../delivery/license-install.service';
import { EntitlementEventsService } from '../delivery/entitlement-events.service';
import { TraceBundleDto } from './dto/trace-bundle.dto';
import { WatermarkService } from '../delivery/watermark.service';
import { readWatermark, matchWatermark } from '../delivery/watermark';
import { DefaultPackageService } from '../licensing/default-package.service';
import { SetDefaultPackageDto } from './dto/default-package.dto';

@Controller('admin/features')
export class FeatureAdminController {
  constructor(@InjectRepository(FeatureEntity) private readonly features: Repository<FeatureEntity>) {}

  /** The catalog the admin picks from when composing packages. */
  @Get()
  @RequirePermissions('feature.read')
  list() {
    return this.features.find({ order: { id: 'ASC' } });
  }

  @Get('sellable')
  @RequirePermissions('feature.read')
  sellable() {
    return this.features.find({ where: { sellable: true }, order: { id: 'ASC' } });
  }
}

@Controller('admin/packages')
export class PackageAdminController {
  private readonly log = new Logger(PackageAdminController.name);

  constructor(
    @Inject(PackageAdminService) private readonly svc: PackageAdminService,
    @Optional() @Inject(DefaultPackageService)
    private readonly defaultPackage?: DefaultPackageService,
  ) {}

  @Get() @RequirePermissions('package.read') list() { return this.svc.list(); }
  @Get(':id') @RequirePermissions('package.read') get(@Param('id') id: string) { return this.svc.get(id); }
  @Post() @RequirePermissions('package.create') create(@Body() dto: CreatePackageDto) { return this.svc.create(dto); }
  @Patch(':id') @RequirePermissions('package.update') update(@Param('id') id: string, @Body() dto: UpdatePackageDto) { return this.svc.update(id, dto); }
  @Delete(':id') @RequirePermissions('package.delete') async remove(@Param('id') id: string) { await this.svc.remove(id); return { ok: true }; }

  /**
   * Stage 2a — which package UNLICENSED visitors receive.
   *
   * This is the single most consequential setting in the admin panel: it
   * decides what every anonymous editor on the internet can do. Reading it is
   * package.read; CHANGING it requires package.update.
   */
  @Get('default/current') @RequirePermissions('package.read')
  currentDefault() {
    return this.defaultPackage ? this.defaultPackage.current() : null;
  }

  @Post('default') @RequirePermissions('package.update')
  async setDefault(@Body() dto: SetDefaultPackageDto, @CurrentUser() user: AccessClaims) {
    if (!this.defaultPackage) throw new NotFoundException('default-package storage is not configured');
    const res = await this.defaultPackage.designate(dto.packageId, {
      actor: user?.sub ?? '', reason: dto.reason ?? '',
    });
    // WARN, not LOG: this changes what every unlicensed visitor receives, so it
    // should stand out in whatever aggregates these lines.
    this.log?.warn?.(
      `DEFAULT PACKAGE CHANGED -> ${res.packageId} (${res.features} features) by ${user?.sub ?? 'unknown'}`,
    );
    return res;
  }
}

@Controller('admin/customers')
export class CustomerAdminController {
  constructor(@InjectRepository(CustomerEntity) private readonly customers: Repository<CustomerEntity>) {}

  /**
   * `?q=` does a case-insensitive substring match on name OR email. Built with
   * the query builder (not TypeORM's `find({ where: [...] })` + `Raw`, which
   * mis-places the `ESCAPE` clause when the same Raw expression is repeated
   * across multiple OR branches — confirmed live against real MySQL). Not
   * `ILike` either — it isn't portable across the two drivers this app runs
   * on (MySQL vs. sqljs/SQLite in tests); `LOWER()` + `LIKE` is identical SQL
   * on both. Escape char is `!` (not backslash) — a backslash literal, once
   * round-tripped through TypeScript source, the SQL string literal, AND the
   * MySQL/SQLite grammars, becomes ambiguous ("ESCAPE expression must be a
   * single character" on sqljs); `!` needs no such escaping and is rare
   * enough in real names/emails that literal occurrences are cheaply escaped
   * too.
   */
  @Get() @RequirePermissions('customer.read')
  list(@Query('q') q?: string) {
    const term = q?.trim();
    if (!term) return this.customers.find({ order: { createdAt: 'DESC' } });
    const pattern = `%${term.toLowerCase().replace(/[%_!]/g, (c) => `!${c}`)}%`;
    return this.customers
      .createQueryBuilder('c')
      .where("LOWER(c.name) LIKE :pattern ESCAPE '!'", { pattern })
      .orWhere("LOWER(c.email) LIKE :pattern ESCAPE '!'", { pattern })
      .orderBy('c.createdAt', 'DESC')
      .getMany();
  }

  @Post() @RequirePermissions('customer.create')
  create(@Body() dto: CreateCustomerDto) {
    const domains = this.cleanDomains(dto.domains);
    return this.customers.save(this.customers.create({
      name: dto.name, email: dto.email.toLowerCase().trim(), domains,
    }));
  }

  @Patch(':id') @RequirePermissions('customer.update')
  async update(@Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    const c = await this.customers.findOne({ where: { id } });
    if (!c) throw new NotFoundException('customer not found'); // consistent 404 (I6)
    if (dto.name !== undefined) c.name = dto.name;
    if (dto.email !== undefined) c.email = dto.email.toLowerCase().trim();
    if (dto.domains !== undefined) c.domains = this.cleanDomains(dto.domains);
    return this.customers.save(c);
  }

  /** Normalize (+apex/www pair) AND reject over-broad bindings at customer-save
   *  time (audit A4), not just later at license mint — so a bad domain fails
   *  fast here. Empty is allowed (a customer may have no domains yet). */
  private cleanDomains(input?: string[]): string[] {
    const domains = normalizeDomains(input ?? []);
    if (domains.length) assertDomainsAcceptable(domains, (msg) => { throw new BadRequestException(msg); });
    return domains;
  }

  @Delete(':id') @RequirePermissions('customer.delete')
  async remove(@Param('id') id: string) {
    const res = await this.customers.delete(id);
    if (!res.affected) throw new NotFoundException('customer not found'); // 404, not silent success (I6)
    return { ok: true };
  }
}

@Controller('admin/licenses')
export class LicenseAdminController {
  constructor(
    @Inject(LicenseService) private readonly licenses: LicenseService,
    // @Optional: a deployment without the delivery module still serves every
    // other licence route; the seat endpoints simply report nothing.
    @Optional() @Inject(LicenseInstallService) private readonly installsSvc?: LicenseInstallService,
    // §2.3 instant push on revoke/regenerate.
    @Optional() @Inject(EntitlementEventsService) private readonly events?: EntitlementEventsService,
    // §2.5 — leaked-bundle attribution.
    @Optional() @Inject(WatermarkService) private readonly watermarks?: WatermarkService,
  ) {}

  /**
   * `?q=` matches customer name/email or plan name (pushed into the DB
   * query). `?status=` filters by the EFFECTIVE (time-aware) status —
   * 'active'/'revoked'/'expired' — applied AFTER `effectiveStatus()` runs,
   * not pushed into the DB query: the stored `status` column alone can't
   * distinguish "active" from "expired" (both are stored as 'active' until
   * the token's exp passes), so filtering on the raw column would wrongly
   * include expired licenses under an "Active" filter.
   */
  @Get() @RequirePermissions('license.read')
  async list(@Query('q') q?: string, @Query('status') status?: string) {
    const list = await this.licenses.list(q);
    // EXPLICIT allowlist projection (audit #9) — never spread the raw entity, so a
    // future sensitive column can't silently leak to a license.read-only role. The
    // signed `token` is a bearer credential and is NEVER in a bulk list (I2); it's
    // returned only on issue/renew/regenerate to that one customer. Customer
    // identity (name/email/domains) IS included — the admin licenses UI needs it,
    // and `license.read` is understood to imply seeing the license's owner.
    const shaped = list.map((l) => ({
      id: l.id,
      licId: l.licId,
      /**
       * WHICH key signed this licence (Phase 4b).
       *
       * A licence issued by one environment cannot verify against a bundle
       * carrying another's keyring — it silently resolves to the free tier.
       * That has already happened here (an `oe-dev-1` key pasted into a
       * production demo). Surfacing the kid in the list makes a
       * wrong-environment licence visible without decoding the token.
       *
       * Public key ID only; never key material.
       */
      kid: l.kid,
      planName: l.planName,
      planPriceCents: l.planPriceCents,
      planCurrency: l.planCurrency,
      features: l.features,
      domains: l.domains,
      status: l.status,
      effectiveStatus: l.effectiveStatus(),
      // §1.8 — so the UI can mark a sandbox licence and reporting can exclude
      // it. Included in the allowlist deliberately: an unmarked test licence
      // is indistinguishable from a real sale, which is the whole problem.
      isTest: l.isTest,
      issuedAt: l.issuedAt,
      expiresAt: l.expiresAt,
      renewUntil: l.renewUntil,
      flaggedAt: l.flaggedAt,
      flagReason: l.flagReason,
      createdAt: l.createdAt,
      customer: l.customer
        ? { id: l.customer.id, name: l.customer.name, email: l.customer.email, domains: l.customer.domains }
        : null,
    }));
    const VALID = new Set(['active', 'revoked', 'expired']);
    return status && VALID.has(status)
      ? shaped.filter((l) => l.effectiveStatus === status)
      : shaped;
  }

  @Post() @RequirePermissions('license.issue')
  issue(@Body() dto: IssueLicenseDto) {
    return this.licenses.issue({
      customerId: dto.customerId,
      packageId: dto.packageId,
      domains: dto.domains,
      ttlSeconds: dto.ttlSeconds,
      // §1.8 — a sandbox licence: real entitlements, never revenue.
      isTest: dto.isTest,
    });
  }

  @Post(':id/renew') @RequirePermissions('license.renew')
  renew(@Param('id') id: string, @Body() dto: RenewLicenseDto) {
    return this.licenses.renew(id, dto.ttlSeconds);
  }

  /**
   * Revoke, then §2.3-push so an open editor drops premium in ~2s instead of
   * keeping it until its refresh timer fires (up to 15 min).
   *
   * Published from the CONTROLLER, not LicenseService, on purpose: delivery
   * already imports licensing (session.service reads licences), so injecting a
   * delivery service INTO licensing would close a dependency cycle. The
   * controller is the natural seam — it may depend on both.
   */
  @Post(':id/revoke') @RequirePermissions('license.revoke')
  async revoke(@Param('id') id: string) {
    const lic = await this.licenses.revoke(id);
    this.pushEntitlementChange(lic?.licId, 'revoked');
    return lic;
  }

  /** Dismiss the anti-sharing soft flag (Phase 5c) — admin reviewed + deemed it
   *  legitimate. Uses license.revoke permission (same reviewer authority). */
  @Post(':id/dismiss-flag') @RequirePermissions('license.revoke')
  dismissFlag(@Param('id') id: string) { return this.licenses.dismissFlag(id); }

  /**
   * Regenerate needs BOTH license.revoke (kills the old one) and
   * license.issue (mints the new one) — an admin who can only revoke, or
   * only issue, cannot do this composite action.
   */
  @Post(':id/regenerate') @RequirePermissions('license.revoke', 'license.issue')
  async regenerate(@Param('id') id: string) {
    const lic = await this.licenses.regenerate(id);
    // The OLD key is dead the moment this returns. Nudge the open editor so it
    // fetches the new one rather than failing refreshes until its timer catches
    // up — a regenerate is exactly when a customer is watching.
    this.pushEntitlementChange(lic?.licId, 'changed');
    return lic;
  }

  /**
   * §2.5 — TRACE A LEAKED BUNDLE back to the licence it was issued to.
   *
   * Paste the suspect bundle (or just its `oe-wm:` marker) and this reports
   * which customer it came from. That is the entire point of watermarking: it
   * turns "someone is redistributing our engine" into a specific, actionable,
   * defensible answer rather than a guess.
   *
   * POST (not GET) because the body is a whole bundle, and because a leaked
   * artefact should not end up in access logs or browser history as a URL.
   *
   * Requires license.read: it reveals which customer an artefact belongs to.
   */
  @Post('trace-bundle') @RequirePermissions('license.read')
  async traceBundle(@Body() dto: TraceBundleDto) {
    const token = readWatermark(dto.content);
    if (!token) {
      // No marker: either an unmarked (free/legacy) bundle, or one that was
      // stripped. Say which, rather than implying nobody is responsible.
      return {
        matched: false,
        token: null,
        reason: 'no watermark found — a free/legacy bundle, or the marker was removed',
      };
    }
    if (!this.watermarks?.enabled) {
      return { matched: false, token, reason: 'watermarking is not configured on this server' };
    }

    // Scanning every licence is fine HERE: this is a rare, human-initiated
    // admin action, not the hot path. (The serve endpoint deliberately does
    // not scan — see WatermarkService.isKnownWatermark.)
    const all = await this.licenses.list();
    const licIds = all.map((l) => l.licId).filter(Boolean);
    const licId = matchWatermark(dto.content, this.watermarks.traceSecret(), licIds);
    if (!licId) {
      return { matched: false, token, reason: 'watermark did not match any current licence' };
    }
    const licence = all.find((l) => l.licId === licId);
    return {
      matched: true,
      token,
      licId,
      customer: licence?.customer ? { id: licence.customer.id, name: licence.customer.name, email: licence.customer.email } : null,
      status: licence?.status ?? null,
      plan: licence?.planName ?? null,
    };
  }

  /** Best-effort §2.3 push. Never throws: an admin action must not fail
   *  because nobody happened to be listening, or because push is unavailable. */
  private pushEntitlementChange(licId: string | undefined, reason: 'changed' | 'revoked'): void {
    if (!licId || !this.events) return;
    try { this.events.publish(licId, reason); } catch { /* optimisation only */ }
  }

  /**
   * Seats (§2.4) — which browser installs have used this licence.
   *
   * This is the support view behind the install cap. Without it the cap is
   * unarguable: a customer says "I only use two machines", and there is no way
   * to check. `blocked: true` rows are the ones that were turned away, so a
   * genuine multi-machine customer is visible and can be upgraded rather than
   * argued with.
   */
  @Get(':id/installs') @RequirePermissions('license.read')
  installs(@Param('id') id: string) {
    if (!this.installsSvc) return [];
    return this.installsSvc.listForLicence(id);
  }

  /**
   * Release a seat — the recovery path for "I cleared my browser" or "I
   * replaced my laptop". Without this, an install id lost to cleared storage
   * would consume a seat forever and the cap would slowly strangle a paying
   * customer. Deleting rather than flagging keeps the count honest.
   *
   * Requires license.update: it changes what the customer may do, so it is a
   * mutation, not a read.
   */
  @Delete(':id/installs/:installId') @RequirePermissions('license.update')
  async releaseInstall(@Param('id') id: string, @Param('installId') installId: string) {
    if (!this.installsSvc) return { ok: false, released: false };
    const released = await this.installsSvc.release(id, installId);
    return { ok: true, released };
  }
}

@Controller('admin/permissions')
export class PermissionAdminController {
  constructor(@Inject(RbacService) private readonly rbac: RbacService) {}

  /** The assignable permission catalog (wildcard excluded) for role checkboxes. */
  @Get() @RequirePermissions('role.read')
  list() { return this.rbac.listPermissions(); }
}

@Controller('admin/roles')
export class RoleAdminController {
  constructor(@Inject(RbacService) private readonly rbac: RbacService) {}

  @Get() @RequirePermissions('role.read')
  list() { return this.rbac.listRoles(); }

  @Post() @RequirePermissions('role.manage')
  create(@Body() dto: CreateRoleDto, @CurrentUser() actor: AccessClaims) {
    return this.rbac.createRole(dto.name, dto.description || '', dto.permissions || [], actor.perms);
  }

  @Patch(':id') @RequirePermissions('role.manage')
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentUser() actor: AccessClaims) {
    return this.rbac.updateRole(id, dto, actor.perms);
  }

  @Delete(':id') @RequirePermissions('role.manage')
  async remove(@Param('id') id: string) { await this.rbac.deleteRole(id); return { ok: true }; }
}

@Controller('admin/users')
export class UserAdminController {
  constructor(@Inject(RbacService) private readonly rbac: RbacService) {}

  @Get() @RequirePermissions('user.read')
  list() { return this.rbac.listUsers(); }

  @Post() @RequirePermissions('user.manage')
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: AccessClaims) {
    return this.rbac.createUser({ email: dto.email, name: dto.name, password: dto.password, roleIds: dto.roleIds }, actor);
  }

  @Patch(':id') @RequirePermissions('user.manage')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AccessClaims) {
    return this.rbac.updateUser(id, dto, actor);
  }

  @Delete(':id') @RequirePermissions('user.manage')
  async remove(@Param('id') id: string) { await this.rbac.deleteUser(id); return { ok: true }; }
}

