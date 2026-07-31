/**
 * public.controller.ts — the UNauthenticated storefront read surface. Exposes
 * ONLY the packages an admin has opted into the public pricing page, and only
 * the fields safe to show a prospective buyer (never internal flags, never the
 * full feature entity — just id + human title).
 */
import { Controller, Get, Inject } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Public } from '../auth/decorators';
import { PackageEntity } from '../licensing/entities/package.entity';
import { BILLING_CONFIG, BillingConfig } from '../config/billing.config';

@Controller('public')
export class PublicController {
  constructor(
    @InjectRepository(PackageEntity) private readonly packages: Repository<PackageEntity>,
    @Inject(BILLING_CONFIG) private readonly cfg: BillingConfig,
  ) {}

  /** Packages shown on /pricing: active + publiclyListed only, safe fields. */
  @Public()
  @Get('packages')
  async listPublicPackages() {
    const rows = await this.packages.find({
      where: { active: true, publiclyListed: true },
      relations: ['features'],
      order: { priceCents: 'ASC' },
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      priceCents: p.priceCents,
      currency: p.currency,
      billingInterval: p.billingInterval,
      domainBound: p.domainBound,
      features: (p.features || []).map((f) => ({ id: f.id, title: f.title })),
    }));
  }

  /** Whether self-serve checkout is available (Stripe configured), plus the
   *  PUBLISHABLE key the storefront needs to mount the embedded Stripe form.
   *  The publishable key is safe to expose to the browser (that's its purpose);
   *  the secret key never leaves the server. Lets the storefront show a
   *  friendly "coming soon" instead of a broken buy button when unconfigured. */
  @Public()
  @Get('billing-status')
  billingStatus() {
    return { enabled: this.cfg.enabled, publishableKey: this.cfg.publishableKey };
  }
}
