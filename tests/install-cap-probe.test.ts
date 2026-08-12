/**
 * Probe: is the §2.4 seat cap ACTUALLY wired, and does it ACTUALLY persist?
 *
 * Written because an @Optional() dependency that silently resolves to
 * `undefined` is precisely how the anti-sharing detector sat inert for an
 * entire phase while looking correct in every review. A behavioural test can
 * pass for the wrong reason; this asserts the wiring itself.
 */
import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: any;
let bundleDir: string;

beforeAll(async () => {
  // Without these, DeliveryModule.forRoot() returns an EMPTY module and every
  // provider lookup below fails — which is what a first run of this probe did.
  process.env.DB_ENABLED = 'true';
  process.env.DB_DRIVER ||= 'sqljs';
  bundleDir = await mkdtemp(join(tmpdir(), 'oe-probe-'));
  process.env.DELIVERY_BUNDLE_DIR = bundleDir;
  process.env.DELIVERY_URL_SECRET = 'probe-url-secret';
  const { generateKeyPair } = await import('../src/licensing/license-signer.service');
  const kp = generateKeyPair();
  process.env.LICENSE_PRIVATE_KEY = kp.privateKeyPem;
  process.env.LICENSE_KID = 'oe-probe';
  process.env.AUTH_ACCESS_SECRET = 'probe-access';
  process.env.AUTH_REFRESH_SECRET = 'probe-refresh';
  process.env.SEED_ADMIN_EMAIL = 'admin@test.com';
  process.env.SEED_ADMIN_PASSWORD = 'sup3r-secret-pw';

  const { AppModule } = await import('../src/app.module');
  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot()] }).compile();
  app = mod.createNestApplication({ logger: false });
  await app.init();
}, 60_000);

afterAll(async () => {
  await app?.close();
  if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
});

describe('§2.4 wiring probe', () => {
  it('LicenseInstallService is really injected — not silently undefined', async () => {
    const { DeliverySessionService } = await import('../src/delivery/session.service');
    const { LicenseInstallService } = await import('../src/delivery/license-install.service');
    const svc: any = app.get(DeliverySessionService, { strict: false });
    expect(svc.installs).toBeDefined();
    expect(svc.installs).toBeInstanceOf(LicenseInstallService);
  });

  it('the cap WRITES seat rows — the table is real, not a no-op', async () => {
    const { LicenseInstallService } = await import('../src/delivery/license-install.service');
    const installs: any = app.get(LicenseInstallService, { strict: false });

    const before = (await installs.listForLicence('probe-lic')).length;
    const r1 = await installs.check('probe-lic', 'oe_' + 'a'.repeat(32), 'https://x.test', 2);
    const r2 = await installs.check('probe-lic', 'oe_' + 'b'.repeat(32), 'https://x.test', 2);
    const r3 = await installs.check('probe-lic', 'oe_' + 'c'.repeat(32), 'https://x.test', 2);
    const after = (await installs.listForLicence('probe-lic')).length;

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false);          // over cap
    expect(after).toBeGreaterThan(before);   // genuinely persisted
    // eslint-disable-next-line no-console
    console.log(`  PROBE seats: ${before} -> ${after}; third refused=${!r3.allowed}`);
  });

  it('a released seat frees capacity — the support recovery path works', async () => {
    const { LicenseInstallService } = await import('../src/delivery/license-install.service');
    const installs: any = app.get(LicenseInstallService, { strict: false });
    const A = 'oe_' + '1'.repeat(32);

    await installs.check('rel-lic', A, null, 1);
    expect((await installs.check('rel-lic', 'oe_' + '2'.repeat(32), null, 1)).allowed).toBe(false);

    expect(await installs.release('rel-lic', A)).toBe(true);
    // Seat freed → a new machine can now activate ("I replaced my laptop").
    expect((await installs.check('rel-lic', 'oe_' + '3'.repeat(32), null, 1)).allowed).toBe(true);
  });

  it('the ADMIN controller really sees the seat service (cross-module visibility)', async () => {
    // AdminModule and DeliveryModule are siblings; a sibling does NOT see
    // another's exports without importing it. This exact gap left the
    // anti-sharing detector injected-as-undefined for a whole phase, so the
    // support endpoints get an explicit wiring assertion rather than trust.
    const { LicenseAdminController } = await import('../src/admin/admin.controller');
    const ctrl: any = app.get(LicenseAdminController, { strict: false });
    expect(ctrl.installsSvc).toBeDefined();
  });

  it('ACTIVATION is single-use: a replayed install id yields NOTHING', async () => {
    // THE SECURITY PROPERTY. installId is written to the server logs on every
    // session (delivery/usage-log.ts). If a claim could be replayed, anyone who
    // could read a log line would have permanent free premium — a worse hole
    // than the localhost sharing this phase set out to close.
    const { LicenseActivationService } = await import('../src/delivery/license-activation.service');
    const acts: any = app.get(LicenseActivationService, { strict: false });
    const install = 'oe_' + '7'.repeat(32);

    expect(await acts.create(install, 'lic-abc')).toBe(true);
    expect(await acts.claim(install, 'https://buyer.test')).toBe('lic-abc');
    // Every subsequent attempt — the replay a log reader would make.
    expect(await acts.claim(install, 'https://attacker.test')).toBeNull();
    expect(await acts.claim(install, 'https://attacker.test')).toBeNull();
  });

  it('ACTIVATION expires: a stale claim is refused', async () => {
    const { LicenseActivationService } = await import('../src/delivery/license-activation.service');
    const acts: any = app.get(LicenseActivationService, { strict: false });
    const install = 'oe_' + '8'.repeat(32);

    await acts.create(install, 'lic-old');
    // Redeem well past the TTL window.
    const later = new Date(Date.now() + 1000 * 3600 * 24 * 30);
    expect(await acts.claim(install, null, later)).toBeNull();
  });

  it('ACTIVATION fails CLOSED on a broken repository — never gives premium away', async () => {
    // Opposite posture to the seat cap, deliberately. There, failing open
    // protects a payer; here, failing open would hand out a licence we could
    // not verify.
    const { LicenseActivationService } = await import('../src/delivery/license-activation.service');
    const broken = new LicenseActivationService({
      findOne: async () => { throw new Error('db down'); },
    } as any);
    expect(await broken.claim('oe_' + '9'.repeat(32), null)).toBeNull();
  });

  it('the SESSION CONTROLLER and ORDER SERVICE really see the activation service', async () => {
    // Both are siblings of DeliveryModule and neither sees its exports without
    // importing it. BillingModule did not, and would have armed no activation
    // at all while every purchase test still passed.
    const { DeliverySessionController } = await import('../src/delivery/session.controller');
    const { OrderService } = await import('../src/billing/order.service');
    expect(app.get(DeliverySessionController, { strict: false }).activations).toBeDefined();
    expect(app.get(OrderService, { strict: false }).activations).toBeDefined();
  });

  it('fails OPEN: a broken repository must never downgrade a paying customer', async () => {
    const { LicenseInstallService } = await import('../src/delivery/license-install.service');
    const broken = new LicenseInstallService({
      findOne: async () => { throw new Error('db down'); },
      count: async () => { throw new Error('db down'); },
    } as any);
    const res = await broken.check('lic', 'oe_' + 'f'.repeat(32), null, 1);
    expect(res.allowed).toBe(true);
  });
});
