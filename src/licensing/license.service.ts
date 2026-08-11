/**
 * license.service.ts — the DB-backed license engine: issue, renew, revoke, list.
 *
 * Flow: validate features (must be known + sellable) → sign a token with
 * LicenseSignerService → persist a LicenseEntity record (snapshotting the
 * granted features/domains) → return the record + token. "Perpetual" licenses
 * are renewed by RE-MINTING (tokens are bounded ≤~3y by the verifier). Revoke
 * flips the record status; the current token then just expires and is never
 * renewed.
 */
import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository, EntityManager, DataSource } from 'typeorm';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { LicenseEntity } from './entities/license.entity';
import { CustomerEntity } from './entities/customer.entity';
import { PackageEntity } from './entities/package.entity';
import { LicenseSignerService } from './license-signer.service';
import { isKnownFeature, isSellableFeature } from './feature-catalog';
import {
  effectiveTtlSeconds, termSeconds, asBillingInterval, clampTtlToTerm, isTermActive,
  stampedRenewUntil, isInfiniteTerm, INFINITE_TERM, carriedRenewUntilFor,
} from './duration-policy';
import {
  normalizeDomains, assertDomainsAcceptable as assertDomainsAcceptableShared,
} from './domain-policy';

export interface IssueInput {
  customerId: string;
  packageId: string;
  /** Domains to bind (defaults to the customer's registered domains). */
  domains?: string[];
  /** Override the package's default token TTL (seconds). */
  ttlSeconds?: number;
  /**
   * Mark this as a SANDBOX licence (§1.8): real entitlements, no commercial
   * meaning. Deliberately does NOT alter what is granted — staging must
   * rehearse the real premium path exactly, or it stops being a rehearsal.
   */
  isTest?: boolean;
}

export interface IssueFromSnapshotInput {
  customerId: string;
  /** Feature ids captured at purchase time (survives package edit/delete). */
  features: string[];
  domains?: string[];
  /** Plan name to stamp on the license/token. */
  planName: string;
  planPriceCents?: number;
  planCurrency?: string;
  domainBound?: boolean;
  ttlSeconds?: number;
  /** Optional live package to link (may be null if it was deleted). */
  packageId?: string | null;
  /**
   * The sold billing interval (once/monthly/yearly/lifetime), snapshotted at
   * checkout. Determines the paid-TERM boundary (renewUntil) stamped on the
   * license. Absent → 'once' (single-term, conservative). (audit C1)
   */
  billingInterval?: string;
  /**
   * Explicit paid-term boundary to CARRY OVER (Phase 5d domain rebind): when set,
   * the new license keeps this exact `renewUntil` instead of recomputing term
   * from the interval — so changing a license's domains never silently EXTENDS
   * the paid term. Absent → derived from billingInterval (the normal issue path).
   */
  renewUntil?: number;
  /**
   * Honor-the-snapshot mode (Phase 4b, customer self-serve re-mint). When true,
   * a feature that has become NON-SELLABLE since purchase is still re-granted —
   * a paying customer must not lose what they bought because the catalog
   * changed. UNKNOWN (not-in-catalog) ids are STILL rejected (that would be a
   * corrupt grant). Default false → the strict admin/billing behavior is
   * unchanged (both known AND sellable required).
   */
  honorSnapshot?: boolean;
  /**
   * Carry-over anti-sharing SOFT FLAG (audit #6): a regenerate/rebind mints a new
   * license row, and without carrying these the sharing flag would be laundered
   * (reset to unflagged). Preserve them so a flagged key stays flagged across a
   * credential swap. Absent → defaults (0 / '' = unflagged), the normal issue path.
   */
  flaggedAt?: number;
  flagReason?: string;
}

@Injectable()
export class LicenseService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(LicenseEntity) private readonly licenses: Repository<LicenseEntity>,
    @InjectRepository(CustomerEntity) private readonly customers: Repository<CustomerEntity>,
    @InjectRepository(PackageEntity) private readonly packages: Repository<PackageEntity>,
    @Inject(LicenseSignerService) private readonly signer: LicenseSignerService,
  ) {}

  /** Issue a NEW license for a customer + package. */
  async issue(input: IssueInput): Promise<LicenseEntity> {
    const customer = await this.customers.findOne({ where: { id: input.customerId } });
    if (!customer) throw new NotFoundException('customer not found');
    const pkg = await this.packages.findOne({ where: { id: input.packageId }, relations: ['features'] });
    if (!pkg) throw new NotFoundException('package not found');
    if (!pkg.active) throw new BadRequestException('package is not active');

    const features = (pkg.features || []).map((f) => f.id);
    this.assertFeaturesSellable(features);

    const domains = normalizeDomains(input.domains && input.domains.length ? input.domains : customer.domains);
    if (pkg.domainBound && domains.length === 0) {
      throw new BadRequestException('domain-bound package requires at least one domain');
    }
    assertDomainsAcceptable(domains); // (M3) no over-broad / public-suffix bindings

    const nowSec = Math.floor(Date.now() / 1000);
    // Paid-term boundary (audit C1): refresh may re-mint only until here. For a
    // `lifetime` package this is the INFINITE_TERM sentinel (audit B1) so the term
    // never ends and silent refresh re-mints forever.
    const renewUntil = stampedRenewUntil(asBillingInterval(pkg.billingInterval) ?? 'once', nowSec);
    // TTL derives from the package duration (or an admin override), then is CLAMPED
    // so exp never outlives the term (audit #3) — matters if an override exceeds it.
    // (lifetime → clamp is a no-op vs the infinite term; the signer's SAFE_MAX_TTL
    //  ceiling still bounds each individual token.)
    const ttl = clampTtlToTerm(input.ttlSeconds || effectiveTtlSeconds(pkg), renewUntil, nowSec);

    const signed = this.signer.sign({
      features,
      domains,
      customer: customer.id,
      plan: pkg.name,
      ttlSeconds: ttl,
    });

    const record = this.licenses.create({
      licId: signed.lic,
      customer,
      package: pkg,
      // Snapshot the plan terms so the sale survives package rename/delete (I5).
      planName: pkg.name,
      planPriceCents: pkg.priceCents,
      planCurrency: pkg.currency,
      features,
      domains,
      status: 'active',
      token: signed.token,
      kid: signed.kid,
      issuedAt: signed.iat,
      expiresAt: signed.exp,
      renewUntil,
      isTest: input.isTest === true,
    });
    return this.licenses.save(record);
  }

  /**
   * Issue a license from a SNAPSHOT of terms (features/domains/plan), rather
   * than reading a live package. Used by billing fulfillment so a paid order is
   * honoured even if the package was edited or deleted between checkout and
   * payment. Still re-validates that every snapshotted feature is currently
   * known + sellable (we never mint a feature that has since been retired).
   */
  async issueFromSnapshot(input: IssueFromSnapshotInput, manager?: EntityManager): Promise<LicenseEntity> {
    // When a transaction EntityManager is passed (billing fulfillment), ALL
    // reads/writes go through it so the mint is atomic with the caller's other
    // writes (ledger + order). Otherwise use the injected repositories.
    const customers = manager ? manager.getRepository(CustomerEntity) : this.customers;
    const packages = manager ? manager.getRepository(PackageEntity) : this.packages;
    const licenses = manager ? manager.getRepository(LicenseEntity) : this.licenses;

    const customer = await customers.findOne({ where: { id: input.customerId } });
    if (!customer) throw new NotFoundException('customer not found');

    const features = [...new Set(input.features || [])];
    // honorSnapshot (customer self-serve): re-grant known-but-withdrawn features,
    // but never an unknown id. Otherwise (admin/billing): strict known+sellable.
    if (input.honorSnapshot) this.assertFeaturesKnown(features);
    else this.assertFeaturesSellable(features);

    // (L4) For a NON-domain-bound plan, do NOT bind buyer-typed domains — an
    // unbound license must not be silently self-restricted to a host the buyer
    // happened to enter. Only bind when the plan is domain-bound.
    const requestedDomains = input.domainBound
      ? (input.domains && input.domains.length ? input.domains : customer.domains)
      : [];
    const domains = normalizeDomains(requestedDomains);
    if (input.domainBound && domains.length === 0) {
      throw new BadRequestException('domain-bound license requires at least one domain');
    }
    assertDomainsAcceptable(domains); // (M3)

    // Link the live package if it still exists (nice-to-have; not required).
    const pkg = input.packageId
      ? await packages.findOne({ where: { id: input.packageId } })
      : null;

    const nowSec = Math.floor(Date.now() / 1000);
    // Paid-term boundary (audit C1): a carried-over value (rebind/regenerate, #1/#5d)
    // wins so a credential swap never extends the term; else derive from interval.
    // A carried INFINITE_TERM (-1) is a VALID perpetual sentinel (audit B1) and must
    // pass through — the old `> 0` guard would reject -1 and silently re-derive a
    // ~3y wall for a lifetime rebind, resurrecting the bug. Accept -1 explicitly.
    const carried =
      typeof input.renewUntil === 'number' &&
      (input.renewUntil > 0 || isInfiniteTerm(input.renewUntil));
    const renewUntil = carried
      ? (input.renewUntil as number)
      : stampedRenewUntil(asBillingInterval(input.billingInterval) ?? 'once', nowSec);
    // Clamp the token TTL so exp never OUTLIVES the paid term (audit #3). Without
    // this, a token minted just before renewUntil would live a full extra TTL past
    // it. `clampTtlToTerm` keeps exp <= renewUntil (signer still applies SAFE_MAX_TTL).
    const ttl = clampTtlToTerm(input.ttlSeconds, renewUntil, nowSec);

    const signed = this.signer.sign({
      features,
      domains,
      customer: customer.id,
      plan: input.planName,
      ttlSeconds: ttl,
    });

    const record = licenses.create({
      licId: signed.lic,
      customer,
      package: pkg,
      planName: input.planName,
      planPriceCents: input.planPriceCents ?? 0,
      planCurrency: input.planCurrency ?? 'USD',
      features,
      domains,
      status: 'active',
      token: signed.token,
      kid: signed.kid,
      issuedAt: signed.iat,
      expiresAt: signed.exp,
      renewUntil,
      // Carry over the anti-sharing soft flag across the credential swap (audit #6).
      flaggedAt: typeof input.flaggedAt === 'number' ? input.flaggedAt : 0,
      flagReason: input.flagReason || '',
    });
    return licenses.save(record);
  }

  /**
   * Renew a license — re-mint a fresh token (new exp) for the SAME snapshot of
   * features/domains. This is how "perpetual" works given bounded tokens.
   *
   * Re-validates before re-minting (#3): a feature that has since become
   * deprecated/unsellable, or a package that has been deactivated, must NOT be
   * silently re-granted for another full term. If the package is gone
   * (onDelete SET NULL) we still renew from the snapshot (the sale stands), but
   * we never re-grant a feature that is no longer sellable.
   */
  async renew(licenseId: string, ttlSeconds?: number): Promise<LicenseEntity> {
    const lic = await this.getOrThrow(licenseId, ['customer', 'package']);
    if (lic.status === 'revoked') throw new BadRequestException('cannot renew a revoked license');
    if (lic.package && !lic.package.active) {
      throw new BadRequestException('cannot renew: the package is no longer active');
    }
    // Honor the snapshot (audit #7): re-grant known features even if a package
    // feature has since become unsellable — consistent with refresh/rebind, so an
    // admin renew doesn't hard-fail on a license the customer is still using. An
    // UNKNOWN (catalog-removed) id is still rejected.
    this.assertFeaturesKnown(lic.features);
    const nowSec = Math.floor(Date.now() / 1000);
    // ADMIN renew is a deliberate term EXTENSION: advance renewUntil by a fresh
    // interval term from now (audit #4) — otherwise the re-minted token would still
    // stop silent-refreshing at the OLD boundary. Lifetime stays effectively
    // perpetual. For 'once' there's no renewal loop, but renew still EXTENDS the
    // term to the new token's life so the exp <= renewUntil invariant holds (audit
    // R2 — previously 'once' kept its old/past boundary, leaving exp > renewUntil).
    const interval = asBillingInterval(lic.package ? lic.package.billingInterval : 'once') ?? 'once';
    // Lifetime is perpetual (audit B1): its term boundary is the INFINITE_TERM
    // sentinel, so clamp is a no-op and renewUntil below stays perpetual — a renew
    // just rolls the token, it can't turn a lifetime into a finite term.
    const termBoundary = interval === 'lifetime'
      ? INFINITE_TERM
      : interval === 'once'
        ? nowSec + (lic.package ? effectiveTtlSeconds(lic.package) : (ttlSeconds || 0))
        : nowSec + termSeconds(interval);
    const baseTtl = ttlSeconds || (lic.package ? effectiveTtlSeconds(lic.package) : undefined);
    const ttl = clampTtlToTerm(baseTtl, termBoundary, nowSec);
    const signed = this.signer.sign({
      features: lic.features,
      domains: lic.domains,
      customer: lic.customer.id,
      plan: lic.planName || (lic.package ? lic.package.name : 'custom'),
      ttlSeconds: ttl,
      iat: nowSec, // pin iat to the clamp basis so exp <= termBoundary holds exactly (R2)
    });
    lic.licId = signed.lic;
    lic.token = signed.token;
    lic.kid = signed.kid;
    lic.issuedAt = signed.iat;
    lic.expiresAt = signed.exp;
    // renewUntil = the minted exp — a uniform, always-coherent invariant across
    // every FINITE interval (exp <= renewUntil always). (audit #4 + R2) Lifetime
    // keeps the perpetual sentinel (audit B1): setting it to signed.exp here would
    // re-impose a ~3y wall — the exact bug. exp <= renewUntil still holds (∞).
    lic.renewUntil = interval === 'lifetime' ? INFINITE_TERM : signed.exp;
    // A renew starts a FRESH term, so it earns a fresh expiry reminder (audit B2) —
    // reset the once-per-term idempotency flag.
    lic.reminderSentAt = 0;
    lic.status = 'active';
    return this.licenses.save(lic);
  }

  /** Revoke a license — mark it revoked; its token is not renewed and expires. */
  async revoke(licenseId: string): Promise<LicenseEntity> {
    const lic = await this.getOrThrow(licenseId);
    lic.status = 'revoked';
    return this.licenses.save(lic);
  }

  /** Clear the anti-sharing SOFT FLAG (Phase 5c) — an admin reviewed it and
   *  decided it's legitimate (e.g. a real multi-PoP/CDN customer). Does NOT touch
   *  `status`; a later refresh CAN re-flag if the anomaly persists (by design —
   *  the flag reflects live spread). Audit #11 note: a detector pass already
   *  in-flight at dismiss time may re-set the flag moments later; that's a benign
   *  timing artifact (soft flag, self-heals on the admin's next view) and a genuine
   *  still-sharing key SHOULD re-flag — so we accept it rather than add a
   *  dismissed-window column. Uses a targeted 2-column write to avoid clobbering a
   *  concurrent refresh's token (same reasoning as the detector's update). */
  async dismissFlag(licenseId: string): Promise<LicenseEntity> {
    const lic = await this.getOrThrow(licenseId);
    await this.licenses.update({ id: lic.id }, { flaggedAt: 0, flagReason: '' });
    lic.flaggedAt = 0;
    lic.flagReason = '';
    return lic;
  }

  /**
   * Regenerate: revoke the OLD license and mint a brand-new one (new id,
   * new `licId`, new signed token) for the SAME customer/features/domains.
   * Unlike `renew()` (which re-signs the SAME row in place — same id, only
   * the token/expiry change), this creates a genuinely distinct license
   * record. Use this for "the old key leaked / was compromised — the old one
   * must never work again and the customer needs a wholly new credential,"
   * as opposed to a routine expiry extension.
   *
   * Re-validates before minting (same guard as `renew`): a package that's
   * gone inactive, or a feature no longer sellable, blocks regeneration —
   * an already-revoked/expired license is not a backdoor to re-grant a
   * withdrawn feature.
   */
  async regenerate(licenseId: string): Promise<LicenseEntity> {
    // ATOMIC: revoke-the-old + mint-the-new run in ONE transaction. If the mint
    // fails, the revoke rolls back — a regenerate never leaves the customer with
    // a revoked license and no replacement. All reads/writes (incl. the mint)
    // go through the transaction manager so nothing escapes the unit of work.
    return this.dataSource.transaction(async (mgr) => {
      const licenses = mgr.getRepository(LicenseEntity);
      const old = await licenses.findOne({ where: { id: licenseId }, relations: ['customer', 'package'] });
      if (!old) throw new NotFoundException('license not found');
      if (old.package && !old.package.active) {
        throw new BadRequestException('cannot regenerate: the package is no longer active');
      }
      // Term gate (audit R1): a regenerate carries the (fixed) paid-term boundary,
      // so re-minting a TERM-ENDED license would resurrect it for a full fresh TTL
      // (clampTtlToTerm's headroom<=0 path returns the token unclamped). Refuse it —
      // the customer must re-purchase (admin extends via `renew`, not `regenerate`).
      if (!isTermActive({
        renewUntil: old.renewUntil, createdAt: old.createdAt, issuedAt: old.issuedAt,
        intervalForTerm: old.package ? old.package.billingInterval : 'once',
      })) {
        throw new BadRequestException('cannot regenerate: the paid term has ended — renew or re-purchase');
      }
      // Honor the snapshot (audit #7) — a leaked-key recovery must not strip a
      // paying customer of a since-withdrawn feature; unknown ids still rejected.
      this.assertFeaturesKnown(old.features);

      // Carry over the EXACT paid-term boundary (audit #1) — a regenerate replaces
      // the credential but must NOT reset/extend the term. Without this a lifetime
      // license collapses to a fresh 30-day 'once' term and a monthly gets extended.
      // Uses carriedRenewUntilFor so a perpetual (lifetime) term carries the storable
      // INFINITE_TERM sentinel, not +∞ (audit B1).
      const carriedRenewUntil = carriedRenewUntilFor({
        renewUntil: old.renewUntil,
        createdAt: old.createdAt,
        issuedAt: old.issuedAt,
        intervalForTerm: old.package ? old.package.billingInterval : 'once',
      });

      old.status = 'revoked';
      await licenses.save(old);

      return this.issueFromSnapshot({
        customerId: old.customer.id,
        features: old.features,
        domains: old.domains,
        planName: old.planName || (old.package ? old.package.name : 'custom'),
        planPriceCents: old.planPriceCents,
        planCurrency: old.planCurrency,
        domainBound: old.domains.length > 0,
        packageId: old.package ? old.package.id : null,
        honorSnapshot: true,                  // don't strip a withdrawn feature (audit #7)
        renewUntil: carriedRenewUntil,        // preserve the paid term (audit #1)
        flaggedAt: old.flaggedAt,             // carry the sharing flag (audit #6)
        flagReason: old.flagReason,
      }, mgr);
    });
  }

  /**
   * Rebind a license to NEW domains (Phase 5d). Like regenerate — atomically
   * revoke the old + mint a genuinely new license — but with a DIFFERENT domain
   * list, and CARRYING OVER the original `renewUntil` so a domain change never
   * silently extends the paid term (plan §9). Honors the snapshot (known, not
   * strictly sellable) so a legitimate rebind isn't blocked by a catalog change.
   * The customer must re-paste the returned new key (there is no in-place rebind).
   */
  async regenerateWithDomains(licenseId: string, newDomains: string[]): Promise<LicenseEntity> {
    const domains = normalizeDomains(newDomains);
    if (domains.length === 0) throw new BadRequestException('at least one domain is required');
    assertDomainsAcceptableShared(domains, (msg) => { throw new BadRequestException(msg); });

    return this.dataSource.transaction(async (mgr) => {
      const licenses = mgr.getRepository(LicenseEntity);
      const old = await licenses.findOne({ where: { id: licenseId }, relations: ['customer', 'package'] });
      if (!old) throw new NotFoundException('license not found');
      if (old.status === 'revoked') throw new BadRequestException('cannot rebind a revoked license');
      if (old.package && !old.package.active) {
        throw new BadRequestException('cannot rebind: the package is no longer active');
      }
      // Term gate (audit R1) — rebinding a term-ended license would resurrect it.
      if (!isTermActive({
        renewUntil: old.renewUntil, createdAt: old.createdAt, issuedAt: old.issuedAt,
        intervalForTerm: old.package ? old.package.billingInterval : 'once',
      })) {
        throw new BadRequestException('cannot rebind: the paid term has ended — renew or re-purchase');
      }
      this.assertFeaturesKnown(old.features);

      // Carry over the EXACT paid-term boundary so a rebind never extends the term
      // (audit E1). For a legacy renewUntil=0 row this DERIVES from createdAt+interval
      // (carriedRenewUntilFor) — NOT undefined, which would re-derive a fresh term
      // from now and silently extend it. A perpetual (lifetime) term carries the
      // INFINITE_TERM sentinel, not +∞ (audit B1).
      const carriedRenewUntil = carriedRenewUntilFor({
        renewUntil: old.renewUntil,
        createdAt: old.createdAt,
        issuedAt: old.issuedAt,
        intervalForTerm: old.package ? old.package.billingInterval : 'once',
      });

      old.status = 'revoked';
      await licenses.save(old);

      return this.issueFromSnapshot({
        customerId: old.customer.id,
        features: old.features,
        domains,                              // the NEW domains
        planName: old.planName || (old.package ? old.package.name : 'custom'),
        planPriceCents: old.planPriceCents,
        planCurrency: old.planCurrency,
        domainBound: true,                    // rebind always yields a domain-bound license
        packageId: old.package ? old.package.id : null,
        honorSnapshot: true,                  // don't strip a paying customer on a catalog change
        renewUntil: carriedRenewUntil,        // CARRY OVER the term (no extension), legacy-safe
        flaggedAt: old.flaggedAt,             // don't launder the sharing flag (audit #6)
        flagReason: old.flagReason,
      }, mgr);
    });
  }

  /**
   * List licenses (newest first). Loads customer + package explicitly — no
   * eager cartesian joins (#7). `q` matches customer name/email OR the plan
   * name (case-insensitive substring — same portable `LOWER()+LIKE...ESCAPE
   * '!'` approach as customers/orders search). Status filtering is NOT done
   * here — see the controller, which filters on the time-aware
   * `effectiveStatus()` instead of the raw stored column.
   */
  async list(q?: string): Promise<LicenseEntity[]> {
    const qb = this.licenses.createQueryBuilder('l')
      .leftJoinAndSelect('l.customer', 'customer')
      .leftJoinAndSelect('l.package', 'package')
      .orderBy('l.createdAt', 'DESC');

    const term = q?.trim();
    if (term) {
      const pattern = `%${term.toLowerCase().replace(/[%_!]/g, (c) => `!${c}`)}%`;
      qb.andWhere(
        "(LOWER(customer.name) LIKE :pattern ESCAPE '!' OR LOWER(customer.email) LIKE :pattern ESCAPE '!' OR LOWER(l.planName) LIKE :pattern ESCAPE '!')",
        { pattern },
      );
    }

    return qb.getMany();
  }

  async get(licenseId: string, relations: string[] = ['customer', 'package']): Promise<LicenseEntity | null> {
    return this.licenses.findOne({ where: { id: licenseId }, relations });
  }

  private async getOrThrow(licenseId: string, relations?: string[]): Promise<LicenseEntity> {
    const lic = await this.get(licenseId, relations);
    if (!lic) throw new NotFoundException('license not found');
    return lic;
  }

  private assertFeaturesSellable(features: string[]): void {
    this.assertFeaturesKnown(features);
    const notSellable = features.filter((f) => !isSellableFeature(f));
    if (notSellable.length) throw new BadRequestException(`features not sellable: ${notSellable.join(', ')}`);
  }

  /** Weaker check: features must be non-empty and all KNOWN (in the catalog),
   *  but MAY be non-sellable. Used by honor-snapshot customer re-mint. */
  private assertFeaturesKnown(features: string[]): void {
    if (!features.length) throw new BadRequestException('package has no features');
    const unknown = features.filter((f) => !isKnownFeature(f));
    if (unknown.length) throw new BadRequestException(`unknown features: ${unknown.join(', ')}`);
  }
}

/**
 * Domain normalization + acceptability now live in the SHARED domain-policy
 * module (Phase 5) so checkout/admin/issue all use ONE rule (+ apex↔www pairing).
 * This thin wrapper keeps the framework-throw here and preserves the existing
 * one-arg call sites / export.
 */
export function assertDomainsAcceptable(domains: string[]): void {
  assertDomainsAcceptableShared(domains, (msg) => { throw new BadRequestException(msg); });
}
