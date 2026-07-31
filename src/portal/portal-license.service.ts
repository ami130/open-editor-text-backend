/**
 * portal-license.service.ts — the customer-facing license operations behind the
 * self-serve portal (Phase 4b): list my licenses, reveal my current key,
 * regenerate a compromised key.
 *
 * Every method is scoped to the AUTHENTICATED customer id and re-checks
 * OWNERSHIP against the license record — a customer can only ever see/act on
 * their own licenses (the license id in the URL is untrusted). This is the core
 * authorization boundary of the portal.
 *
 * REGENERATE honors the SNAPSHOT (locked decision B): unlike the admin
 * `regenerate()`, it does NOT re-validate sellability — a paying customer must
 * never be blocked from re-obtaining what they bought because the catalog
 * changed. Revocation remains the deliberate kill switch.
 */
import { Injectable, Inject, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { LicenseEntity } from '../licensing/entities/license.entity';
import { LicenseService } from '../licensing/license.service';
import { carriedRenewUntilFor, isTermActive } from '../licensing/duration-policy';

/** Safe, non-secret projection of a license for the portal list. Never the token. */
export interface PortalLicenseView {
  id: string;
  licId: string;
  planName: string;
  features: string[];
  domains: string[];
  issuedAt: number;
  expiresAt: number;
  effectiveStatus: 'active' | 'revoked' | 'expired';
}

@Injectable()
export class PortalLicenseService {
  constructor(
    @InjectRepository(LicenseEntity) private readonly licenses: Repository<LicenseEntity>,
    @Inject(LicenseService) private readonly licenseSvc: LicenseService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** All of a customer's licenses (newest first), safe fields only — no token. */
  async listForCustomer(customerId: string): Promise<PortalLicenseView[]> {
    const rows = await this.licenses.find({
      where: { customer: { id: customerId } },
      relations: ['customer'],
      order: { createdAt: 'DESC' },
    });
    return rows.map((l) => this.toView(l));
  }

  /**
   * Reveal the CURRENT signed token for one of the customer's licenses.
   * Ownership-checked. A revoked/expired license does NOT reveal a token (a dead
   * credential is useless and could mislead) — the caller should regenerate.
   */
  async revealToken(customerId: string, licenseId: string): Promise<{ view: PortalLicenseView; token: string }> {
    const lic = await this.ownedOrThrow(customerId, licenseId);
    if (lic.effectiveStatus() !== 'active') {
      throw new BadRequestException('this license is not active — regenerate to get a new key');
    }
    return { view: this.toView(lic), token: lic.token };
  }

  /**
   * Regenerate a customer's license (old key stops working, brand-new key
   * minted) — ownership-checked, honoring the snapshot. Mirrors the admin
   * atomic revoke-then-mint but WITHOUT the sellability re-check (decision B),
   * so a legitimate customer is never blocked by a later catalog change.
   */
  async regenerateForCustomer(customerId: string, licenseId: string): Promise<{ view: PortalLicenseView; token: string }> {
    // Ownership check first (outside the txn — a cheap early reject).
    await this.ownedOrThrow(customerId, licenseId);

    const fresh = await this.dataSource.transaction(async (mgr) => {
      const repo = mgr.getRepository(LicenseEntity);
      const old = await repo.findOne({ where: { id: licenseId }, relations: ['customer', 'package'] });
      if (!old) throw new NotFoundException('license not found');
      // Re-check ownership INSIDE the txn against the fresh row (defense in depth).
      if (!old.customer || old.customer.id !== customerId) throw new ForbiddenException('not your license');

      // Term gate (audit R1): SELF-SERVE regenerate must NOT resurrect a term-ended
      // license — otherwise a lapsed monthly customer could click "Regenerate" for a
      // fresh full-TTL token, repeatedly, defeating the paid-term boundary. Refuse a
      // dead term; the customer must re-purchase (an admin can extend via renew).
      if (!isTermActive({
        renewUntil: old.renewUntil, createdAt: old.createdAt, issuedAt: old.issuedAt,
        intervalForTerm: old.package ? old.package.billingInterval : 'once',
      })) {
        throw new BadRequestException('this license’s paid term has ended — please renew or re-purchase');
      }

      // Carry the EXACT paid-term boundary (audit #1): a customer clicking
      // "Regenerate" must NOT reset a lifetime to 30 days nor extend a monthly.
      // carriedRenewUntilFor keeps a perpetual (lifetime) term as the storable
      // INFINITE_TERM sentinel, not +∞ (audit B1).
      const carriedRenewUntil = carriedRenewUntilFor({
        renewUntil: old.renewUntil,
        createdAt: old.createdAt,
        issuedAt: old.issuedAt,
        intervalForTerm: old.package ? old.package.billingInterval : 'once',
      });

      old.status = 'revoked';
      await repo.save(old);

      // honorSnapshot: re-grant exactly what was sold — a since-withdrawn feature
      // must not block a paying customer's re-mint (decision B). Unknown ids are
      // still rejected inside issueFromSnapshot.
      return this.licenseSvc.issueFromSnapshot({
        customerId: old.customer.id,
        features: old.features,
        domains: old.domains,
        planName: old.planName || (old.package ? old.package.name : 'custom'),
        planPriceCents: old.planPriceCents,
        planCurrency: old.planCurrency,
        domainBound: old.domains.length > 0,
        packageId: old.package ? old.package.id : null,
        honorSnapshot: true,
        renewUntil: carriedRenewUntil,   // preserve the paid term (audit #1)
        flaggedAt: old.flaggedAt,        // don't launder the sharing flag (audit #6)
        flagReason: old.flagReason,
      }, mgr);
    });
    return { view: this.toView(fresh), token: fresh.token };
  }

  /** Load a license and assert it belongs to this customer, else 404/403. */
  private async ownedOrThrow(customerId: string, licenseId: string): Promise<LicenseEntity> {
    const lic = await this.licenses.findOne({ where: { id: licenseId }, relations: ['customer', 'package'] });
    // Uniform 404 for both "missing" and "not yours" so the portal can't be used
    // to probe which license ids exist (no id-enumeration oracle).
    if (!lic || !lic.customer || lic.customer.id !== customerId) {
      throw new NotFoundException('license not found');
    }
    return lic;
  }

  private toView(l: LicenseEntity): PortalLicenseView {
    return {
      id: l.id,
      licId: l.licId,
      planName: l.planName,
      features: l.features,
      domains: l.domains,
      issuedAt: l.issuedAt,
      expiresAt: l.expiresAt,
      effectiveStatus: l.effectiveStatus(),
    };
  }
}
