/**
 * default-package.seed.ts — create the free package on first boot (Stage 2a).
 *
 * ─── WHY SEED AT ALL ────────────────────────────────────────────────────────
 * The anonymous path now resolves an admin-designated package. On a fresh
 * install nothing is designated, so without a seed every unlicensed visitor
 * would fall back to the minimal built-in set — a worse editor than before the
 * change, on day one, for everyone.
 *
 * ─── THE SEED MUST NOT CHANGE EXISTING BEHAVIOUR ────────────────────────────
 * It grants exactly the features a free user receives TODAY: every catalog
 * entry that is sellable and not premium (53 at time of writing). So upgrading
 * to Stage 2a is a no-op from a visitor's point of view — the difference is
 * that an admin can now EDIT it.
 *
 * A seed that quietly changed the free tier would be the worst kind of
 * migration: invisible, global, and attributed to nothing.
 *
 * ─── IDEMPOTENT, AND NEVER OVERWRITES AN ADMIN ──────────────────────────────
 * Runs on every boot but does nothing when a designation already exists. An
 * admin who removes a feature must not have it restored by the next deploy —
 * that would make their change look like it silently reverted itself.
 */
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PackageEntity } from './entities/package.entity';
import { FeatureEntity } from './entities/feature.entity';
import { DefaultPackageEntity, DEFAULT_PACKAGE_ID } from './entities/default-package.entity';
import { FEATURE_CATALOG } from './feature-catalog';
import { DefaultPackageService } from './default-package.service';

/** The name given to the seeded package. Editable by an admin afterwards. */
export const SEED_PACKAGE_NAME = 'Free';

@Injectable()
export class DefaultPackageSeed implements OnModuleInit {
  private readonly log = new Logger(DefaultPackageSeed.name);

  constructor(
    @Optional() @InjectRepository(PackageEntity)
    private readonly packages?: Repository<PackageEntity>,
    @Optional() @InjectRepository(FeatureEntity)
    private readonly features?: Repository<FeatureEntity>,
    @Optional() @InjectRepository(DefaultPackageEntity)
    private readonly defaults?: Repository<DefaultPackageEntity>,
    @Optional() private readonly resolver?: DefaultPackageService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seed();
      // Warm the cache so the very first anonymous request is served from
      // memory rather than triggering a lookup.
      await this.resolver?.warm();
    } catch (err) {
      // Never block boot. A missing designation degrades to the minimal set and
      // is logged loudly by the resolver on every refresh.
      this.log.error(`default-package seed failed (continuing): ${String(err)}`);
    }
  }

  private async seed(): Promise<void> {
    if (!this.packages || !this.features || !this.defaults) return;

    const existing = await this.defaults.findOne({ where: { id: DEFAULT_PACKAGE_ID } });
    if (existing?.packageId) return; // already designated — never overwrite

    // Exactly what a free user gets today: sellable, non-premium.
    const wanted = FEATURE_CATALOG
      .filter((f) => f.sellable !== false && f.kind !== 'premium')
      .map((f) => f.id);

    // Intersect with what is actually IN the features table, so a catalog entry
    // that failed to sync cannot produce a package referencing a missing row.
    const rows = await this.features.findBy(
      wanted.map((id) => ({ id })) as Array<{ id: string }>,
    );
    if (!rows.length) {
      this.log.warn('feature table is empty — skipping default-package seed this boot');
      return;
    }

    let pkg = await this.packages.findOne({
      where: { name: SEED_PACKAGE_NAME }, relations: ['features'],
    });
    if (!pkg) {
      pkg = this.packages.create({
        name: SEED_PACKAGE_NAME,
        priceCents: 0,
        currency: 'USD',
        billingInterval: 'once',
        isFree: true,
        active: true,
        // Not on the storefront: this is what people get WITHOUT buying, so
        // listing it for "purchase" would be nonsense.
        publiclyListed: false,
        domainBound: false,
        features: rows,
      });
      pkg = await this.packages.save(pkg);
      this.log.log(`seeded "${SEED_PACKAGE_NAME}" package with ${rows.length} features`);
    }

    await this.defaults.save(this.defaults.create({
      id: DEFAULT_PACKAGE_ID,
      packageId: pkg.id,
      actor: 'system:seed',
      reason: 'initial default for unlicensed visitors',
    }));
    this.log.log(`designated "${pkg.name}" as the package for unlicensed visitors`);
  }
}
