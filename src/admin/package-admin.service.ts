/**
 * package-admin.service.ts — package CRUD for the admin API. Resolves feature
 * ids to entities, and re-validates on the SERVER that every chosen feature is
 * known + sellable (the DTO checks shape; this checks business rules — a client
 * can't slip in an internal/deprecated feature).
 */
import {
  Injectable, Inject, BadRequestException, NotFoundException, Optional,
} from '@nestjs/common';
import { Repository, In } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { PackageEntity } from '../licensing/entities/package.entity';
import { FeatureEntity } from '../licensing/entities/feature.entity';
import { isSellableFeature } from '../licensing/feature-catalog';
import { durationPolicy, asBillingInterval } from '../licensing/duration-policy';
import { CreatePackageDto, UpdatePackageDto } from './dto/package.dto';
import { DefaultPackageService } from '../licensing/default-package.service';

@Injectable()
export class PackageAdminService {
  constructor(
    @InjectRepository(PackageEntity) private readonly packages: Repository<PackageEntity>,
    @InjectRepository(FeatureEntity) private readonly features: Repository<FeatureEntity>,
    // Stage 2a — R2 guardrail: refuse to delete the package unlicensed
    // visitors resolve to.
    @Optional() @Inject(DefaultPackageService)
    private readonly defaultPackage?: DefaultPackageService,
  ) {}

  list(): Promise<PackageEntity[]> {
    return this.packages.find({ order: { createdAt: 'DESC' } });
  }

  async get(id: string): Promise<PackageEntity> {
    const pkg = await this.packages.findOne({ where: { id } });
    if (!pkg) throw new NotFoundException('package not found');
    return pkg;
  }

  async create(dto: CreatePackageDto): Promise<PackageEntity> {
    const features = await this.resolveFeatures(dto.featureIds);
    const pkg = this.packages.create({
      name: dto.name,
      description: dto.description || '',
      priceCents: dto.priceCents,
      currency: 'USD', // USD-only product — never read a client-supplied currency
      billingInterval: dto.billingInterval,
      isFree: dto.isFree ?? false,
      domainBound: dto.domainBound ?? true,
      // 0 = unlimited, so an omitted value keeps existing behaviour (§2 security).
      maxDomains: dto.maxDomains ?? 0,
      maxInstalls: dto.maxInstalls ?? 0,
      // licenseTtlSeconds is retired from the write path (inert on issue — the TTL
      // is derived from the interval, or from ttlOverrideSeconds). The DB column
      // keeps its NOT-NULL default; nothing reads it. See duration-policy.ts.
      ttlOverrideSeconds: dto.ttlOverrideSeconds ?? null,
      active: dto.active ?? true,
      publiclyListed: dto.publiclyListed ?? false,
      features,
    });
    this.applyCoherence(pkg);
    return this.packages.save(pkg);
  }

  async update(id: string, dto: UpdatePackageDto): Promise<PackageEntity> {
    const pkg = await this.get(id);
    if (dto.name !== undefined) pkg.name = dto.name;
    if (dto.description !== undefined) pkg.description = dto.description;
    if (dto.priceCents !== undefined) pkg.priceCents = dto.priceCents;
    pkg.currency = 'USD'; // USD-only product — normalize on every update
    if (dto.billingInterval !== undefined) pkg.billingInterval = dto.billingInterval;
    if (dto.isFree !== undefined) pkg.isFree = dto.isFree;
    if (dto.domainBound !== undefined) pkg.domainBound = dto.domainBound;
    if (dto.maxDomains !== undefined) pkg.maxDomains = dto.maxDomains;
    if (dto.maxInstalls !== undefined) pkg.maxInstalls = dto.maxInstalls;
    if (dto.ttlOverrideSeconds !== undefined) pkg.ttlOverrideSeconds = dto.ttlOverrideSeconds;
    if (dto.active !== undefined) pkg.active = dto.active;
    if (dto.publiclyListed !== undefined) pkg.publiclyListed = dto.publiclyListed;
    if (dto.featureIds !== undefined) pkg.features = await this.resolveFeatures(dto.featureIds);

    /**
     * The designated package may be EDITED freely — that is the whole point of
     * Stage 2a — but it may not be emptied.
     *
     * `designate()` already refuses a package with no features, but that guards
     * only the moment of designation.
     *
     * ⚠️ HONEST NOTE ON THIS GUARD'S VALUE. I added it believing an admin could
     * empty an already-designated package through update(). Checking properly:
     * `UpdatePackageDto` carries `@ArrayNotEmpty()`, so an empty `featureIds`
     * is already rejected at the DTO boundary and this branch is UNREACHABLE
     * through the HTTP API. Disabling it left the whole suite green, which is
     * how I found out.
     *
     * It is kept deliberately, as defence in depth rather than a live fix:
     * this service is also called directly (seeds, future admin tooling, tests)
     * where no DTO validation runs, and the failure it prevents is silent — an
     * empty designated package does not error, it quietly drops every visitor
     * to seven hardcoded features. A guard whose cost is one comparison and
     * whose failure mode is invisible is worth keeping even when a second layer
     * currently covers it.
     */
    if (
      dto.featureIds !== undefined
      && pkg.features.length === 0
      && this.defaultPackage
      && await this.defaultPackage.isDesignated(id)
    ) {
      throw new BadRequestException(
        `"${pkg.name}" is the package served to unlicensed visitors, so it must grant `
        + 'at least one feature. Designate a different package first, or keep one feature.',
      );
    }

    this.applyCoherence(pkg);
    const saved = await this.packages.save(pkg);

    // An edit to the designated package must take effect NOW, not after the
    // cache TTL — an admin who removes a feature and sees it still granted
    // would reasonably conclude the change failed.
    if (this.defaultPackage && await this.defaultPackage.isDesignated(id)) {
      await this.defaultPackage.warm().catch(() => undefined);
    }
    return saved;
  }

  /**
   * Enforce the Phase-3 invariants before every save, so neither a create nor an
   * update (nor the quick row-toggle, which also PATCHes) can persist an
   * incoherent package (the DTO checks shape only):
   *   1. isFree ⇒ priceCents=0 AND billingInterval='once' (a paid "free" package
   *      is a contradiction; coerce rather than reject so the admin UI stays simple).
   *   2. (REMOVED) isFree ⇒ publiclyListed=false. This used to be coerced off
   *      because /pricing gave every package a "Buy" button and order.service
   *      rejects a $0 buy, so a free+listed package showed a dead button. The
   *      storefront now renders free as "Get started" with no checkout path, so
   *      the free tier can finally be listed — and hiding it meant visitors had
   *      no way to see a free tier existed. order.service's zero-price refusal
   *      is untouched and remains the real guard.
   *   3. refreshPolicy is DERIVED from the final billing interval — never trusted
   *      from the client — so it always matches the interval actually stored.
   */
  private applyCoherence(pkg: PackageEntity): void {
    if (pkg.isFree) {
      pkg.priceCents = 0;
      pkg.billingInterval = 'once';
      // NOTE: `publiclyListed` is deliberately NOT forced off here any more.
      // It used to be, because /pricing rendered every package with a "Buy"
      // button and order.service rejects a $0 checkout — so a free+listed
      // package showed a button that could only ever 400.
      //
      // The storefront now renders a free package as "Free / Get started"
      // linking to the docs, with no checkout path, and guards the dialog on
      // `priceCents > 0`. The dead-button reason is gone, and hiding the free
      // tier from the pricing page had a real cost: visitors could not see
      // that a free tier exists at all.
      //
      // The actual protection is unchanged and lives where it belongs —
      // order.service still refuses any zero-price checkout, so even a crafted
      // request cannot buy a free package.
    }
    const interval = asBillingInterval(pkg.billingInterval) ?? 'once';
    pkg.billingInterval = interval;
    pkg.refreshPolicy = durationPolicy(interval).refreshPolicy;
  }

  async remove(id: string): Promise<void> {
    const pkg = await this.get(id);
    /**
     * R2 — the package serving every UNLICENSED visitor cannot be deleted.
     *
     * Without this, one click removes what every anonymous editor on the
     * internet resolves to. The database enforces it too (ON DELETE RESTRICT),
     * but that surfaces as an opaque FK error; this explains what to do instead.
     */
    if (this.defaultPackage && await this.defaultPackage.isDesignated(id)) {
      throw new BadRequestException(
        `"${pkg.name}" is the package served to unlicensed visitors and cannot be deleted. `
        + 'Designate a different package first, then delete this one.',
      );
    }
    await this.packages.remove(pkg);
  }

  /** Resolve ids → entities, rejecting unknown or non-sellable features. */
  private async resolveFeatures(ids: string[]): Promise<FeatureEntity[]> {
    const unique = [...new Set(ids)];
    const notSellable = unique.filter((id) => !isSellableFeature(id));
    if (notSellable.length) {
      throw new BadRequestException(`features not sellable: ${notSellable.join(', ')}`);
    }
    const rows = await this.features.find({ where: { id: In(unique) } });
    if (rows.length !== unique.length) {
      const found = new Set(rows.map((r) => r.id));
      throw new BadRequestException(`unknown features: ${unique.filter((i) => !found.has(i)).join(', ')}`);
    }
    return rows;
  }
}
