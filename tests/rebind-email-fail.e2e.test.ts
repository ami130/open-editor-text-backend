/**
 * rebind-email-fail.e2e.test.ts — Phase 5d / audit F1: when the domain-rebind
 * notification email FAILS, the customer's old key is already dead, so the new
 * token MUST be surfaced to the (admin) caller for out-of-band recovery. On
 * success the token is never returned. Drives OrderService.rebindLicenseDomains
 * directly with a faked EmailService whose sendKeyRotatedEmail returns false.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { EmailService } from '../src/billing/email.service';
import { OrderService } from '../src/billing/order.service';
import { LicenseService } from '../src/licensing/license.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CustomerEntity } from '../src/licensing/entities/customer.entity';
import type { Repository } from 'typeorm';

let app: INestApplication;
let orders: OrderService;
let licenseId: string;

// Fake email: sendKeyRotatedEmail FAILS (transport down); others succeed.
const fakeEmail = {
  async sendKeyRotatedEmail() { return false; },
  async sendLicenseEmail() { return true; },
  async sendPortalLink() { return true; },
};

beforeAll(async () => {
  process.env.DB_ENABLED = 'true';
  process.env.DB_DRIVER ||= 'sqljs';
  const { generateKeyPair } = await import('../src/licensing/license-signer.service');
  const kp = generateKeyPair();
  process.env.LICENSE_PRIVATE_KEY = kp.privateKeyPem;
  process.env.LICENSE_KID = 'oe-rebindfail-test';
  process.env.AUTH_ACCESS_SECRET = 'test-access-secret';
  process.env.AUTH_REFRESH_SECRET = 'test-refresh-secret';
  process.env.SEED_ADMIN_EMAIL = 'admin@rf.test';
  process.env.SEED_ADMIN_PASSWORD = 'sup3r-secret-pw';

  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot()] })
    .overrideProvider(EmailService).useValue(fakeEmail)
    .compile();
  app = mod.createNestApplication({ logger: false });
  await app.init();

  orders = app.get(OrderService);
  const licenseSvc = app.get(LicenseService);
  const customers = app.get<Repository<CustomerEntity>>(getRepositoryToken(CustomerEntity));
  const c = await customers.save(customers.create({ name: 'Rf', email: 'rf@buyer.com', domains: ['rf-old.com'] }));
  const lic = await licenseSvc.issueFromSnapshot({
    customerId: c.id, features: ['export.pdf'], domains: ['rf-old.com'], planName: 'Pro', domainBound: true, billingInterval: 'yearly',
  });
  licenseId = lic.id;
});

afterAll(async () => {
  await app?.close();
  delete process.env.DB_ENABLED; delete process.env.DB_DRIVER;
});

describe('Phase 5d / F1 — rebind email-failure recovery', () => {
  it('when the notify email FAILS, the new key IS returned so the admin can recover the customer', async () => {
    const res = await orders.rebindLicenseDomains(licenseId, ['rf-new.com']);
    expect(res.delivered).toBe(false);           // transport failed
    expect(res.licenseKey).toBeTruthy();          // ...so the key is surfaced
    expect(typeof res.licenseKey).toBe('string');
    expect(res.licenseId).not.toBe(licenseId);    // a genuinely new license
  });
});
