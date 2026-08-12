/**
 * package-admin.service.ts — package CRUD for the admin API. Resolves feature
 * ids to entities, and re-validates on the SERVER that every chosen feature is
 * known + sellable (the DTO checks shape; this checks business rules — a client
 * can't slip in an internal/deprecated feature).
 */
import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository, In } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { PackageEntity } from '../licensing/entities/package.entity';
import { FeatureEntity } from '../licensing/entities/feature.entity';
import { isSellableFeature } from '../licensing/feature-catalog';
import { durationPolicy, asBillingInterval } from '../licensing/duration-policy';
import { CreatePackageDto, UpdatePackageDto } from './dto/package.dto';

@Injectable()
export class PackageAdminService {
  constructor(
    @InjectRepository(PackageEntity) private readonly packages: Repository<PackageEntity>,
    @InjectRepository(FeatureEntity) private readonly features: Repository<FeatureEntity>,
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
    if (dto.ttlOverrideSeconds !== undefined) pkg.ttlOverrideSeconds = dto.ttlOverrideSeconds;
    if (dto.active !== undefined) pkg.active = dto.active;
    if (dto.publiclyListed !== undefined) pkg.publiclyListed = dto.publiclyListed;
    if (dto.featureIds !== undefined) pkg.features = await this.resolveFeatures(dto.featureIds);
    this.applyCoherence(pkg);
    return this.packages.save(pkg);
  }

  /**
   * Enforce the Phase-3 invariants before every save, so neither a create nor an
   * update (nor the quick row-toggle, which also PATCHes) can persist an
   * incoherent package (the DTO checks shape only):
   *   1. isFree ⇒ priceCents=0 AND billingInterval='once' (a paid "free" package
   *      is a contradiction; coerce rather than reject so the admin UI stays simple).
   *   2. isFree ⇒ publiclyListed=false. Self-serve checkout requires priceCents>0
   *      (order.service rejects a $0 buy), so a free+listed package would render on
   *      /pricing with a dead "Buy" button. There is no self-serve free-claim flow,
   *      so a free package simply cannot be on the public storefront. Coerce it off.
   *   3. refreshPolicy is DERIVED from the final billing interval — never trusted
   *      from the client — so it always matches the interval actually stored.
   */
  private applyCoherence(pkg: PackageEntity): void {
    if (pkg.isFree) {
      pkg.priceCents = 0;
      pkg.billingInterval = 'once';
      pkg.publiclyListed = false;
    }
    const interval = asBillingInterval(pkg.billingInterval) ?? 'once';
    pkg.billingInterval = interval;
    pkg.refreshPolicy = durationPolicy(interval).refreshPolicy;
  }

  async remove(id: string): Promise<void> {
    const pkg = await this.get(id);
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
