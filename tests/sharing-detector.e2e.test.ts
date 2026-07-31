/**
 * sharing-detector.e2e.test.ts — Phase 5c anti-sharing detection.
 *
 * Proves: many distinct origins/IPs for ONE key within the window → SOFT flag
 * (license KEEPS status=active, keeps working); a single-origin key is NEVER
 * flagged; only SUCCESSFUL refreshes count; the window is respected; and an admin
 * can dismiss the flag. No auto-revoke — flagging is a soft signal.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { LicenseService } from '../src/licensing/license.service';
import { SharingDetectorService } from '../src/portal/sharing-detector.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CustomerEntity } from '../src/licensing/entities/customer.entity';
import { LicenseEntity } from '../src/licensing/entities/license.entity';
import { RefreshEventEntity } from '../src/portal/entities/refresh-event.entity';
import type { Repository } from 'typeorm';

let app: INestApplication;
let events: Repository<RefreshEventEntity>;
let licenses: Repository<LicenseEntity>;
let detector: SharingDetectorService;
let licId: string;
let licRowId: string;

beforeAll(async () => {
  process.env.DB_ENABLED = 'true';
  process.env.DB_DRIVER ||= 'sqljs';
  const { generateKeyPair } = await import('../src/licensing/license-signer.service');
  const kp = generateKeyPair();
  process.env.LICENSE_PRIVATE_KEY = kp.privateKeyPem;
  process.env.LICENSE_KID = 'oe-share-test';
  process.env.AUTH_ACCESS_SECRET = 'test-access-secret';
  process.env.AUTH_REFRESH_SECRET = 'test-refresh-secret';
  process.env.SEED_ADMIN_EMAIL = 'admin@share.test';
  process.env.SEED_ADMIN_PASSWORD = 'sup3r-secret-pw';

  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot()] }).compile();
  app = mod.createNestApplication({ logger: false });
  await app.init();

  events = app.get<Repository<RefreshEventEntity>>(getRepositoryToken(RefreshEventEntity));
  licenses = app.get<Repository<LicenseEntity>>(getRepositoryToken(LicenseEntity));
  detector = app.get(SharingDetectorService);
  const licenseSvc = app.get(LicenseService);
  const customers = app.get<Repository<CustomerEntity>>(getRepositoryToken(CustomerEntity));
  const c = await customers.save(customers.create({ name: 'Ada', email: 'ada@buyer.com', domains: ['ada.com'] }));
  const lic = await licenseSvc.issueFromSnapshot({
    customerId: c.id, features: ['export.pdf'], domains: ['ada.com'], planName: 'Pro', domainBound: true,
  });
  licId = lic.licId; licRowId = lic.id;
});

afterAll(async () => {
  await app?.close();
  delete process.env.DB_ENABLED; delete process.env.DB_DRIVER;
});

beforeEach(async () => {
  // Clean slate: no events, unflag the license.
  await events.clear();
  await licenses.update({ id: licRowId }, { flaggedAt: 0, flagReason: '' });
});

/** Seed `n` refreshed events for the license, each with a distinct origin. */
async function seedOrigins(n: number, outcome = 'refreshed') {
  for (let i = 0; i < n; i += 1) {
    await events.save(events.create({ licId, ip: '1.1.1.1', origin: `https://site${i}.com`, outcome }));
  }
}

describe('Phase 5c — anti-sharing detector', () => {
  it('flags a key seen from MANY distinct origins (soft — status stays active)', async () => {
    await seedOrigins(6); // default threshold is > 5 origins
    const signal = await detector.evaluateAndFlag(licId);
    expect(signal.anomalous).toBe(true);
    expect(signal.distinctOrigins).toBe(6);
    const row = await licenses.findOne({ where: { id: licRowId } });
    expect(row!.flaggedAt).toBeGreaterThan(0);            // soft-flagged
    expect(row!.flagReason).toContain('distinct origins');
    expect(row!.status).toBe('active');                    // KEEPS WORKING (not revoked)
    expect(row!.effectiveStatus()).toBe('active');
  });

  it('does NOT flag a normal key (few origins — prod+staging+www)', async () => {
    await seedOrigins(3);
    const signal = await detector.evaluateAndFlag(licId);
    expect(signal.anomalous).toBe(false);
    const row = await licenses.findOne({ where: { id: licRowId } });
    expect(row!.flaggedAt).toBe(0);
  });

  it('only NOISE (refused/garbage) is excluded — random refused hits do not implicate the customer', async () => {
    await seedOrigins(8, 'refused'); // 8 distinct origins, but all refused/unknown
    const signal = await detector.evaluateAndFlag(licId);
    expect(signal.anomalous).toBe(false);   // refused rows are excluded
    expect(signal.distinctOrigins).toBe(0);
  });

  it('C3: ORIGIN-BLOCKED events COUNT — a domain-bound key hammering unauthorized origins is the strongest signal', async () => {
    // The key resolved to THIS license but was presented from 6 domains it isn't
    // bound to → origin-blocked. Pre-fix these were excluded, making domain-bound
    // keys unflaggable; now they count.
    await seedOrigins(6, 'origin-blocked');
    const signal = await detector.evaluateAndFlag(licId);
    expect(signal.anomalous).toBe(true);
    expect(signal.distinctOrigins).toBe(6);
    const row = await licenses.findOne({ where: { id: licRowId } });
    expect(row!.flaggedAt).toBeGreaterThan(0);
    expect(row!.status).toBe('active'); // still soft — keeps working
  });

  it('C3: a MIX of refreshed + origin-blocked origins is counted together', async () => {
    for (let i = 0; i < 3; i += 1) await events.save(events.create({ licId, ip: '1.1.1.1', origin: `https://ok${i}.com`, outcome: 'refreshed' }));
    for (let i = 0; i < 4; i += 1) await events.save(events.create({ licId, ip: '1.1.1.1', origin: `https://blocked${i}.com`, outcome: 'origin-blocked' }));
    const signal = await detector.evaluate(licId);
    expect(signal.distinctOrigins).toBe(7); // 3 + 4 combined
    expect(signal.anomalous).toBe(true);    // > 5
  });

  it('respects the WINDOW — origins older than the window are ignored', async () => {
    // 6 old events (well before the 24h window) + 2 fresh → only 2 in-window.
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    for (let i = 0; i < 6; i += 1) {
      await events.save(events.create({ licId, ip: '1.1.1.1', origin: `https://old${i}.com`, outcome: 'refreshed', createdAt: old }));
    }
    await seedOrigins(2);
    const signal = await detector.evaluate(licId);
    expect(signal.distinctOrigins).toBe(2); // old ones excluded
    expect(signal.anomalous).toBe(false);
  });

  it('flag carries a FIRST-seen time that is stable across re-evaluation', async () => {
    await seedOrigins(6);
    const first = await detector.evaluateAndFlag(licId);
    expect(first.anomalous).toBe(true);
    const t1 = (await licenses.findOne({ where: { id: licRowId } }))!.flaggedAt;
    await seedOrigins(1); // one more origin
    await detector.evaluateAndFlag(licId);
    const t2 = (await licenses.findOne({ where: { id: licRowId } }))!.flaggedAt;
    expect(t2).toBe(t1); // first-seen preserved
  });

  it('admin dismissFlag clears the flag without touching status', async () => {
    await seedOrigins(6);
    await detector.evaluateAndFlag(licId);
    const licenseSvc = app.get(LicenseService);
    await licenseSvc.dismissFlag(licRowId);
    const row = await licenses.findOne({ where: { id: licRowId } });
    expect(row!.flaggedAt).toBe(0);
    expect(row!.flagReason).toBe('');
    expect(row!.status).toBe('active');
  });
});
