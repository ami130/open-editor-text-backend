/**
 * license-flow.test.ts — the FULL commercial flow, DB-backed (in-memory sqljs),
 * end-to-end and verified against the editor's REAL verifier:
 *
 *   sync feature catalog → admin composes a package (hand-picked features + price)
 *   → create a customer → ISSUE a license → the editor VERIFIES it and grants
 *   exactly the package's features → RENEW (re-mint) → REVOKE.
 *
 * Uses TypeORM's pure-JS `sqljs` driver so no native build / no MySQL is needed;
 * the same entities run on MySQL in production.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { LICENSE_CONFIG, loadLicenseConfig, SAFE_MAX_TTL } from '../src/config/license.config';
import { LicenseSignerService, generateKeyPair } from '../src/licensing/license-signer.service';
import { LicenseService } from '../src/licensing/license.service';
import { INFINITE_TERM } from '../src/licensing/duration-policy';
import { FeatureCatalogService } from '../src/licensing/feature-catalog.service';
import { FeatureEntity } from '../src/licensing/entities/feature.entity';
import { PackageEntity } from '../src/licensing/entities/package.entity';
import { CustomerEntity } from '../src/licensing/entities/customer.entity';
import { LicenseEntity } from '../src/licensing/entities/license.entity';

// @ts-expect-error — JS module, no types (dev/test import into the sibling monorepo)
import { verifyLicense, importEs256PublicKey, REASON } from '../../open-editor/packages/entitlements/src/index.js';

const ENTITIES = [FeatureEntity, PackageEntity, CustomerEntity, LicenseEntity];
const KID = 'oe-flow-key';

let licenseService: LicenseService;
let catalog: FeatureCatalogService;
let packages: Repository<PackageEntity>;
let customers: Repository<CustomerEntity>;
let licenses: Repository<LicenseEntity>;
let keyring: Array<{ kid: string; alg: string; key: unknown }>;

beforeAll(async () => {
  const kp = generateKeyPair();
  const licCfg = loadLicenseConfig({ LICENSE_PRIVATE_KEY: kp.privateKeyPem, LICENSE_KID: KID } as NodeJS.ProcessEnv);

  const mod = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({ type: 'sqljs', autoSave: false, entities: ENTITIES, synchronize: true }),
      TypeOrmModule.forFeature(ENTITIES),
    ],
    providers: [
      { provide: LICENSE_CONFIG, useValue: licCfg },
      LicenseSignerService,
      LicenseService,
      FeatureCatalogService,
    ],
  }).compile();

  licenseService = mod.get(LicenseService);
  catalog = mod.get(FeatureCatalogService);
  packages = mod.get(getRepositoryToken(PackageEntity));
  customers = mod.get(getRepositoryToken(CustomerEntity));
  licenses = mod.get(getRepositoryToken(LicenseEntity));

  await catalog.sync(); // seed the feature table

  const signer = mod.get(LicenseSignerService);
  const key = await importEs256PublicKey(signer.publicJwk());
  keyring = [{ kid: KID, alg: 'ES256', key }];
});

afterAll(() => { /* in-memory sqljs — nothing to tear down */ });

// helper: admin composes a package by picking feature rows
async function makePackage(name: string, featureIds: string[], opts: Partial<PackageEntity> = {}) {
  const feats = await catalog.sellable();
  const chosen = feats.filter((f) => featureIds.includes(f.id));
  return packages.save(packages.create({
    name, description: '', priceCents: 4900, currency: 'USD',
    billingInterval: 'once', domainBound: true, licenseTtlSeconds: 365 * 24 * 3600,
    active: true, features: chosen, ...opts,
  }));
}

const verify = (token: string, hostname = 'acme.com', now?: number) =>
  verifyLicense(token, { keyring, hostname, now });

describe('feature catalog sync', () => {
  it('syncs the vendored catalog and exposes only SELLABLE features', async () => {
    const sellable = await catalog.sellable();
    const ids = sellable.map((f) => f.id);
    expect(ids).toContain('export.pdf');
    expect(ids).toContain('export.docx');
    expect(ids).not.toContain('dev.smoke');     // internal, not sellable
    expect(ids).not.toContain('footnotes');     // deprecated
    // AI + SEO are deprecated + non-sellable (no-AI / no-SEO decision) — never offered.
    expect(ids).not.toContain('ai.translate');
    expect(ids).not.toContain('ai.panel');
    expect(ids).not.toContain('ai.review');
    expect(ids).not.toContain('ai.quickActions');
    expect(ids).not.toContain('seo');
  });
});

describe('full purchase → license → editor-verify flow', () => {
  it('issues a license granting EXACTLY the package features, verified by the editor', async () => {
    const pkg = await makePackage('Pro', ['export.pdf', 'export.docx']);
    const customer = await customers.save(customers.create({
      name: 'Acme Inc', email: 'acme@example.com', domains: ['acme.com'],
    }));

    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id });
    expect(lic.status).toBe('active');
    expect(lic.features.sort()).toEqual(['export.docx', 'export.pdf']);

    const res = await verify(lic.token);
    expect(res.valid).toBe(true);
    expect(res.payload.features.sort()).toEqual(['export.docx', 'export.pdf']);
  });

  it('the license unlocks ONLY its features — a non-package feature is absent', async () => {
    const pkg = await makePackage('SEO-only', ['export.pdf']);
    const customer = await customers.save(customers.create({ name: 'C2', email: 'c2@x.com', domains: ['c2.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id });
    const res = await verify(lic.token, 'c2.com');
    expect(res.payload.features).toEqual(['export.pdf']);
    expect(res.payload.features).not.toContain('export.docx');
  });

  it('domain-bound: the license fails on a domain the customer did not register', async () => {
    const pkg = await makePackage('Bound', ['export.pdf']);
    const customer = await customers.save(customers.create({ name: 'C3', email: 'c3@x.com', domains: ['c3.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id });
    expect((await verify(lic.token, 'c3.com')).valid).toBe(true);
    const bad = await verify(lic.token, 'someone-else.com');
    expect(bad.valid).toBe(false);
    expect(bad.reason).toBe(REASON.DOMAIN);
  });

  it('Phase 3 — a LIFETIME package issues a token at the max safe TTL (perpetual), overriding the raw licenseTtlSeconds column', async () => {
    // makePackage hardcodes licenseTtlSeconds=365d, but with duration-driven TTL a
    // lifetime package has NO ttlOverrideSeconds → effectiveTtl derives SAFE_MAX_TTL.
    const pkg = await makePackage('Perpetual', ['export.pdf'], { billingInterval: 'lifetime', refreshPolicy: 'auto' });
    const customer = await customers.save(customers.create({ name: 'CL', email: 'cl@x.com', domains: ['cl.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id });
    const life = lic.expiresAt - lic.issuedAt;
    expect(life).toBe(SAFE_MAX_TTL);              // derived from the interval, not the 365d column
    expect((await verify(lic.token, 'cl.com')).valid).toBe(true); // still under the verifier ceiling
  });

  it('Phase 3 — ttlOverrideSeconds wins over the interval-derived TTL (admin escape hatch)', async () => {
    const pkg = await makePackage('Overridden', ['export.pdf'], { billingInterval: 'lifetime', ttlOverrideSeconds: 7 * 24 * 3600 });
    const customer = await customers.save(customers.create({ name: 'CO', email: 'co@x.com', domains: ['co.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id });
    expect(lic.expiresAt - lic.issuedAt).toBe(7 * 24 * 3600); // the override, NOT SAFE_MAX_TTL
  });

  it('RENEW re-mints a fresh token (new lic id + later expiry), still verifying', async () => {
    const pkg = await makePackage('Renewable', ['export.pdf']);
    const customer = await customers.save(customers.create({ name: 'C4', email: 'c4@x.com', domains: ['c4.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id });
    const firstLicId = lic.licId;
    const firstExp = lic.expiresAt;
    // renew with a small forced iat difference by using a longer ttl
    const renewed = await licenseService.renew(lic.id, 2 * 365 * 24 * 3600);
    expect(renewed.licId).not.toBe(firstLicId);
    expect(renewed.expiresAt).toBeGreaterThanOrEqual(firstExp);
    expect((await verify(renewed.token, 'c4.com')).valid).toBe(true);
  });

  it('5d REBIND: regenerateWithDomains mints NEW domains, revokes old, and CARRIES the same renewUntil', async () => {
    const pkg = await makePackage('Rebindable', ['export.pdf'], { billingInterval: 'yearly' });
    const customer = await customers.save(customers.create({ name: 'CR', email: 'cr@x.com', domains: ['old.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id, domains: ['old.com'] });
    const originalRenewUntil = lic.renewUntil;
    expect(originalRenewUntil).toBeGreaterThan(0);

    const rebound = await licenseService.regenerateWithDomains(lic.id, ['new.com', 'www.new.com']);
    // New license: distinct id, new domains (apex↔www auto-paired stays as given).
    expect(rebound.id).not.toBe(lic.id);
    expect(rebound.domains).toContain('new.com');
    expect(rebound.domains).toContain('www.new.com');
    expect(rebound.domains).not.toContain('old.com');
    // The paid TERM is CARRIED OVER — a domain change never extends it (plan §9).
    expect(rebound.renewUntil).toBe(originalRenewUntil);
    // Old license is revoked; new one verifies on the new domain, not the old.
    const old = await licenseService.get(lic.id);
    expect(old!.status).toBe('revoked');
    expect((await verify(rebound.token, 'new.com')).valid).toBe(true);
    expect((await verify(rebound.token, 'old.com')).valid).toBe(false);
  });

  it('#1 REGENERATE: carries the paid term (a lifetime stays lifetime, monthly keeps its boundary) + carries the flag', async () => {
    const pkg = await makePackage('RegenTerm', ['export.pdf'], { billingInterval: 'lifetime' });
    const customer = await customers.save(customers.create({ name: 'CReg', email: 'creg1@x.com', domains: ['rg1.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id, domains: ['rg1.com'] });
    const originalRenewUntil = lic.renewUntil;
    // A lifetime license is TRULY perpetual (audit B1): renewUntil is the
    // INFINITE_TERM sentinel (-1), NOT a finite ~3y wall. This is the whole B1 fix —
    // a lifetime buyer's license never term-ends.
    expect(originalRenewUntil).toBe(INFINITE_TERM);
    // Simulate a pre-existing sharing flag on the old license.
    await licenses.update({ id: lic.id }, { flaggedAt: 12345, flagReason: 'test flag' });

    const regen = await licenseService.regenerate(lic.id);
    expect(regen.id).not.toBe(lic.id);
    // Term CARRIED (audit #1 + B1) — a lifetime stays perpetual across a regenerate,
    // NOT collapsed to a fresh 30d 'once' term and NOT re-imposed as a finite wall.
    expect(regen.renewUntil).toBe(originalRenewUntil);
    expect(regen.renewUntil).toBe(INFINITE_TERM);
    // Flag CARRIED (audit #6) — regenerate doesn't launder the sharing flag.
    expect(regen.flaggedAt).toBe(12345);
    expect(regen.flagReason).toBe('test flag');
    // Old is revoked.
    expect((await licenseService.get(lic.id))!.status).toBe('revoked');
  });

  it('#4 RENEW: advances renewUntil for a term interval (monthly) so silent refresh keeps working', async () => {
    const pkg = await makePackage('RenewTerm', ['export.pdf'], { billingInterval: 'monthly' });
    const customer = await customers.save(customers.create({ name: 'CRen', email: 'cren1@x.com', domains: ['rn1.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id, domains: ['rn1.com'] });
    const before = lic.renewUntil;
    const renewed = await licenseService.renew(lic.id);
    // renewUntil advanced (a deliberate admin term extension, audit #4) — same row id.
    expect(renewed.id).toBe(lic.id);
    expect(renewed.renewUntil).toBeGreaterThanOrEqual(before);
    // And the token exp is clamped to the (new) term (audit #3).
    expect(renewed.expiresAt).toBeLessThanOrEqual(renewed.renewUntil);
  });

  it('R1 REGENERATE: refuses to resurrect a TERM-ENDED license (no fresh full token past a dead term)', async () => {
    const pkg = await makePackage('R1Regen', ['export.pdf'], { billingInterval: 'monthly' });
    const customer = await customers.save(customers.create({ name: 'CR1', email: 'cr1-r1@x.com', domains: ['r1.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id, domains: ['r1.com'] });
    // Force the paid term to have ended (renewUntil in the past); status stays 'active'.
    await licenses.update({ id: lic.id }, { renewUntil: Math.floor(Date.now() / 1000) - 24 * 3600 });
    await expect(licenseService.regenerate(lic.id)).rejects.toThrow(/paid term has ended/i);
    // The old license is NOT revoked (the refusal happened before the atomic swap).
    expect((await licenseService.get(lic.id))!.status).toBe('active');
  });

  it('R1 REBIND: refuses to resurrect a TERM-ENDED license', async () => {
    const pkg = await makePackage('R1Rebind', ['export.pdf'], { billingInterval: 'monthly' });
    const customer = await customers.save(customers.create({ name: 'CR1b', email: 'cr1b-r1@x.com', domains: ['r1b.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id, domains: ['r1b.com'] });
    await licenses.update({ id: lic.id }, { renewUntil: Math.floor(Date.now() / 1000) - 24 * 3600 });
    await expect(licenseService.regenerateWithDomains(lic.id, ['r1b-new.com'])).rejects.toThrow(/paid term has ended/i);
  });

  it('R2 RENEW: a once license\'s exp never exceeds renewUntil (invariant holds for once too)', async () => {
    const pkg = await makePackage('R2Once', ['export.pdf'], { billingInterval: 'once' });
    const customer = await customers.save(customers.create({ name: 'CR2', email: 'cr2-r2@x.com', domains: ['r2.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id, domains: ['r2.com'] });
    // Age the license so its original 'once' term is already past.
    await licenses.update({ id: lic.id, }, { renewUntil: Math.floor(Date.now() / 1000) - 24 * 3600 });
    const renewed = await licenseService.renew(lic.id);
    // exp <= renewUntil MUST hold — renew advances renewUntil to the minted exp (R2).
    expect(renewed.expiresAt).toBeLessThanOrEqual(renewed.renewUntil);
    expect(renewed.renewUntil).toBe(renewed.expiresAt); // uniform: renewUntil == exp
    expect(renewed.renewUntil).toBeGreaterThan(Math.floor(Date.now() / 1000)); // extended to the future
  });

  it('E1 REBIND: a LEGACY renewUntil=0 license does NOT get its term extended — derives from createdAt, not now', async () => {
    const pkg = await makePackage('LegacyRebind', ['export.pdf'], { billingInterval: 'monthly' });
    const customer = await customers.save(customers.create({ name: 'CLeg', email: 'cleg-e1@x.com', domains: ['leg.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id, domains: ['leg.com'] });
    // Simulate a pre-Phase-4c row: no term boundary stored, issued ~20 days ago.
    const createdSec = Math.floor(Date.now() / 1000) - 20 * 24 * 3600;
    await licenses.update({ id: lic.id }, { renewUntil: 0, createdAt: new Date(createdSec * 1000) });

    const rebound = await licenseService.regenerateWithDomains(lic.id, ['leg-new.com']);
    const DAY = 24 * 3600;
    // The carried boundary = createdAt + 30d term (monthly), NOT now + 30d.
    // So it should be ~10 days out (30 - 20), NOT ~30 days out.
    const secondsOut = rebound.renewUntil - Math.floor(Date.now() / 1000);
    expect(secondsOut).toBeLessThan(15 * DAY);       // NOT extended to a full fresh term
    expect(secondsOut).toBeGreaterThan(5 * DAY);     // ~10 days of the original term remain
    // And crucially, NOT ~30 days (which is what the old `|| undefined` bug produced).
    expect(rebound.renewUntil).toBeLessThan(createdSec + 30 * DAY + 60);
  });

  it('5d REBIND: rejects an empty / over-broad domain list', async () => {
    const pkg = await makePackage('RebindGuard', ['export.pdf']);
    const customer = await customers.save(customers.create({ name: 'CG', email: 'cg@x.com', domains: ['g.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id, domains: ['g.com'] });
    await expect(licenseService.regenerateWithDomains(lic.id, [])).rejects.toThrow(/at least one domain/i);
    await expect(licenseService.regenerateWithDomains(lic.id, ['*.com'])).rejects.toThrow(/too broad/i);
  });

  it('REVOKE flips status; a revoked license cannot be renewed', async () => {
    const pkg = await makePackage('Revocable', ['export.pdf']);
    const customer = await customers.save(customers.create({ name: 'C5', email: 'c5@x.com', domains: ['c5.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id });
    const revoked = await licenseService.revoke(lic.id);
    expect(revoked.status).toBe('revoked');
    await expect(licenseService.renew(lic.id)).rejects.toThrow(/revoked/i);
  });

  it('REGENERATE revokes the OLD license and mints a genuinely NEW one (distinct id, both verifiable/checkable independently)', async () => {
    const pkg = await makePackage('Regenerable', ['export.pdf']);
    const customer = await customers.save(customers.create({ name: 'C20', email: 'c20@x.com', domains: ['c20.com'] }));
    const original = await licenseService.issue({ customerId: customer.id, packageId: pkg.id });
    const originalId = original.id;
    const originalToken = original.token;

    const fresh = await licenseService.regenerate(original.id);

    // A genuinely NEW row — not the same id (unlike renew, which reuses the row).
    expect(fresh.id).not.toBe(originalId);
    expect(fresh.customer.id).toBe(customer.id);
    expect(fresh.features).toEqual(original.features);
    expect(fresh.domains).toEqual(original.domains);
    expect(fresh.planName).toBe(original.planName);

    // The OLD license record is now revoked — permanently dead, even though
    // its token string is untouched, because verification also depends on
    // signature/expiry, and a real client would use the license id from the
    // admin API, not a cached raw token.
    const oldReloaded = await licenseService.get(originalId);
    expect(oldReloaded!.status).toBe('revoked');

    // The NEW token verifies correctly.
    expect((await verify(fresh.token, 'c20.com')).valid).toBe(true);
    // The OLD token is untouched (still cryptographically well-formed) but
    // its DB row is what admin tooling / a future revocation-check would see
    // as revoked — confirmed by re-fetching the old row above, not by
    // re-verifying the raw token (offline verification can't see revocation
    // by design, per the documented latency — see ROADMAP.md).
    expect(originalToken).not.toBe(fresh.token);
  });

  it('REGENERATE is rejected when the package has been deactivated (same guard as renew)', async () => {
    const pkg = await makePackage('RegenSunset', ['export.pdf']);
    const customer = await customers.save(customers.create({ name: 'C21', email: 'c21@x.com', domains: ['c21.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id });
    pkg.active = false;
    await packages.save(pkg);
    await expect(licenseService.regenerate(lic.id)).rejects.toThrow(/no longer active/i);
  });

  it('REGENERATE still works from the snapshot after the package is DELETED (SET NULL)', async () => {
    const pkg = await makePackage('RegenDeluxe', ['export.pdf'], { priceCents: 4200, currency: 'GBP' });
    const customer = await customers.save(customers.create({ name: 'C22', email: 'c22@x.com', domains: ['c22.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id });
    await packages.delete(pkg.id);

    const fresh = await licenseService.regenerate(lic.id);
    expect(fresh.planName).toBe('RegenDeluxe');
    expect(fresh.planPriceCents).toBe(4200);
    expect((await verify(fresh.token, 'c22.com')).valid).toBe(true);
  });

  it('rejects issuing a package that contains a non-sellable feature', async () => {
    // force a package with dev.smoke directly at the repo level (bypassing the
    // admin pick-list) to prove the service still guards it.
    const featRepo = packages.manager.getRepository(FeatureEntity);
    const smoke = await featRepo.findOne({ where: { id: 'dev.smoke' } });
    const pkg = await packages.save(packages.create({
      name: 'Bad', description: '', priceCents: 0, currency: 'USD', billingInterval: 'once',
      domainBound: true, licenseTtlSeconds: 3600, active: true, features: smoke ? [smoke] : [],
    }));
    const customer = await customers.save(customers.create({ name: 'C6', email: 'c6@x.com', domains: ['c6.com'] }));
    await expect(licenseService.issue({ customerId: customer.id, packageId: pkg.id }))
      .rejects.toThrow(/not sellable/i);
  });

  it('#I5 — the license snapshots plan name/price and survives package DELETION', async () => {
    const pkg = await makePackage('Deluxe', ['export.pdf'], { priceCents: 9900, currency: 'EUR' });
    const customer = await customers.save(customers.create({ name: 'C7', email: 'c7@x.com', domains: ['c7.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id });
    expect(lic.planName).toBe('Deluxe');
    expect(lic.planPriceCents).toBe(9900);
    expect(lic.planCurrency).toBe('EUR');
    // delete the package → relation nulls (SET NULL), but the snapshot remains
    await packages.delete(pkg.id);
    const reloaded = await licenseService.get(lic.id);
    expect(reloaded!.package).toBeNull();
    expect(reloaded!.planName).toBe('Deluxe');
    expect(reloaded!.planPriceCents).toBe(9900);
    // and it can still renew from the snapshot (package gone → plan 'Deluxe')
    const renewed = await licenseService.renew(lic.id);
    expect(renewed.planName).toBe('Deluxe');
    expect((await verify(renewed.token, 'c7.com')).valid).toBe(true);
  });

  it('#3 — renew is REJECTED when the package has been deactivated', async () => {
    const pkg = await makePackage('Sunset', ['export.pdf']);
    const customer = await customers.save(customers.create({ name: 'C8', email: 'c8@x.com', domains: ['c8.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id });
    pkg.active = false;
    await packages.save(pkg);
    await expect(licenseService.renew(lic.id)).rejects.toThrow(/no longer active/i);
  });

  it('#6 — effectiveStatus reflects EXPIRY on read (status column never stores "expired")', async () => {
    const pkg = await makePackage('Shortlived', ['export.pdf']);
    const customer = await customers.save(customers.create({ name: 'C9', email: 'c9@x.com', domains: ['c9.com'] }));
    const lic = await licenseService.issue({ customerId: customer.id, packageId: pkg.id });
    expect(lic.status).toBe('active');                 // stored state
    expect(lic.effectiveStatus(lic.issuedAt)).toBe('active');
    // a time past exp → effective 'expired', even though the column still says active
    expect(lic.effectiveStatus(lic.expiresAt + 1)).toBe('expired');
    expect(lic.status).toBe('active');
    // revoked always wins over expiry
    lic.status = 'revoked';
    expect(lic.effectiveStatus(lic.expiresAt + 1)).toBe('revoked');
  });

  it('domain-bound package with a customer that has NO domains is rejected at issue', async () => {
    const pkg = await makePackage('NeedsDomain', ['export.pdf'], { domainBound: true });
    const customer = await customers.save(customers.create({ name: 'C10', email: 'c10@x.com', domains: [] }));
    await expect(licenseService.issue({ customerId: customer.id, packageId: pkg.id }))
      .rejects.toThrow(/domain-bound/i);
  });

  it('#8 — the sellable flag is PERSISTED on feature rows (not only in-memory)', async () => {
    const featRepo = packages.manager.getRepository(FeatureEntity);
    const seo = await featRepo.findOne({ where: { id: 'export.pdf' } });
    const smoke = await featRepo.findOne({ where: { id: 'dev.smoke' } });
    expect(seo!.sellable).toBe(true);
    expect(smoke!.sellable).toBe(false);   // internal → not sellable, stored
  });
});
