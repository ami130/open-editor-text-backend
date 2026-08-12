/**
 * billing.e2e.test.ts — Phase F over real HTTP with DB ON (sqljs) and a FAKE
 * Stripe injected (no network, no keys). Proves the money flow AND its security
 * invariants:
 *
 *   • checkout uses the DB package's price, never the client's;
 *   • non-public / inactive / domain-bound-without-domain checkouts are rejected;
 *   • a signature-verified `checkout.session.completed` (paid) mints a license
 *     that VERIFIES in the real @openeditors/entitlements verifier;
 *   • the SAME event delivered twice mints exactly ONE license (idempotency);
 *   • a bad signature → 400, nothing minted;
 *   • the success endpoint returns the key once for a fulfilled order.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { STRIPE_CLIENT, type StripeClient, type CheckoutSessionInput } from '../src/billing/stripe.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LicenseEntity } from '../src/licensing/entities/license.entity';
import { OrderEntity } from '../src/billing/entities/order.entity';
import { LicenseSignerService } from '../src/licensing/license-signer.service';
import { SAFE_MAX_TTL } from '../src/config/license.config';

// @ts-expect-error — JS module (dev/test import into the sibling monorepo)
import { verifyLicense, importEs256PublicKey } from '../../open-editor/packages/entitlements/src/index.js';

let app: INestApplication;
let base: string;
let adminToken: string;
let keyring: Array<{ kid: string; alg: string; key: unknown }>;

// A controllable fake Stripe: records the last checkout input, hands back a
// canned session, and "verifies" a signature by requiring sig === 'good-sig'
// and parsing the body as the event (so we can craft events in tests).
const stripeState = {
  lastCheckout: null as CheckoutSessionInput | null,
  nextSessionId: 'cs_test_1',
  // Sessions the fake will return from retrieveSession (admin force-fulfill path).
  sessions: new Map<string, { paymentStatus: string; amountTotal: number | null; currency: string | null; orderId: string | null }>(),
};
const fakeStripe: StripeClient = {
  enabled: true,
  async createCheckoutSession(input) {
    stripeState.lastCheckout = input;
    // Embedded mode returns a client_secret (not a hosted url).
    return { id: stripeState.nextSessionId, clientSecret: `${stripeState.nextSessionId}_secret_fake` };
  },
  constructEvent(rawBody, signature) {
    if (signature !== 'good-sig') throw new Error('bad signature');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JSON.parse(rawBody.toString()) as any;
  },
  async retrieveSession(sessionId) {
    const s = stripeState.sessions.get(sessionId);
    return {
      id: sessionId,
      paymentStatus: s ? s.paymentStatus : 'unpaid',
      amountTotal: s ? s.amountTotal : null,
      currency: s ? s.currency : null,
      orderId: s ? s.orderId : null,
    };
  },
};

beforeAll(async () => {
  process.env.DB_ENABLED = 'true';
  process.env.DB_DRIVER ||= 'sqljs';
  const { generateKeyPair } = await import('../src/licensing/license-signer.service');
  const kp = generateKeyPair();
  process.env.LICENSE_PRIVATE_KEY = kp.privateKeyPem;
  process.env.LICENSE_KID = 'oe-billing-test';
  process.env.AUTH_ACCESS_SECRET = 'test-access-secret';
  process.env.AUTH_REFRESH_SECRET = 'test-refresh-secret';
  process.env.SEED_ADMIN_EMAIL = 'admin@bill.test';
  process.env.SEED_ADMIN_PASSWORD = 'sup3r-secret-pw';
  // Make billing "enabled" so BillingController doesn't 503 (the fake ignores it).
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';

  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot()] })
    .overrideProvider(STRIPE_CLIENT).useValue(fakeStripe)
    .compile();
  // rawBody:true so the webhook can read req.rawBody (mirrors production main.ts).
  app = mod.createNestApplication({ logger: false, rawBody: true });
  app.use(cookieParser());
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  const signer = app.get(LicenseSignerService);
  keyring = [{ kid: 'oe-billing-test', alg: 'ES256', key: await importEs256PublicKey(signer.publicJwk()) }];

  const login = await post('/auth/login', { email: 'admin@bill.test', password: 'sup3r-secret-pw' });
  adminToken = (await login.json()).accessToken;
});

afterAll(async () => {
  await app?.close();
  delete process.env.DB_ENABLED;
  delete process.env.DB_DRIVER;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

const post = (path: string, body?: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const get = (path: string, token?: string) =>
  fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

/** Create a public+active package via the admin API; returns its id. */
async function makePackage(over: Record<string, unknown> = {}): Promise<{ id: string; priceCents: number }> {
  const body = {
    name: 'Pro', priceCents: 4900, currency: 'USD', billingInterval: 'once',
    featureIds: ['export.pdf', 'export.docx'], domainBound: true, active: true, publiclyListed: true,
    ...over,
  };
  const res = await post('/admin/packages', body, adminToken);
  const pkg = await res.json();
  return { id: pkg.id, priceCents: pkg.priceCents };
}

/** POST a raw (unparsed) JSON webhook body with a signature header. */
const postWebhook = (event: unknown, signature = 'good-sig') =>
  fetch(`${base}/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: JSON.stringify(event),
  });

function completedEvent(eventId: string, sessionId: string, orderId: string, amountCents = 4900, currency = 'usd') {
  return {
    id: eventId,
    type: 'checkout.session.completed',
    data: { object: { id: sessionId, payment_status: 'paid', amount_total: amountCents, currency, metadata: { orderId } } },
  };
}

describe('Phase F — self-serve billing', () => {
  it('lists only public+active packages on /public/packages (safe fields, no token/flags)', async () => {
    await makePackage({ name: 'PublicPro' });
    await makePackage({ name: 'HiddenPro', publiclyListed: false });
    const res = await get('/public/packages');
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list.some((p: { name: string }) => p.name === 'PublicPro')).toBe(true);
    expect(list.some((p: { name: string }) => p.name === 'HiddenPro')).toBe(false);
    // safe shape: features are {id,title}, no `active`/`publiclyListed` leaked
    const pro = list.find((p: { name: string }) => p.name === 'PublicPro');
    expect(pro.features[0]).toHaveProperty('title');
    expect(pro).not.toHaveProperty('publiclyListed');
  });

  it('checkout uses the SERVER price, not the client (no amount field accepted)', async () => {
    const { id, priceCents } = await makePackage({ name: 'PriceTest' });
    stripeState.nextSessionId = 'cs_price';
    const res = await post('/billing/checkout', {
      packageId: id, email: 'buyer@x.com', domains: ['buyer.com'],
      priceCents: 1, // <- attempt to override; DTO whitelist rejects unknown fields
    });
    // forbidNonWhitelisted → the stray field makes this a 400 (defense in depth).
    expect(res.status).toBe(400);

    // Clean request → session created with the DB price; embedded returns a
    // clientSecret (not a hosted url) + the sessionId for the success page.
    const ok = await post('/billing/checkout', { packageId: id, email: 'buyer@x.com', domains: ['buyer.com'] });
    expect(ok.status).toBe(201);
    expect(stripeState.lastCheckout?.amountCents).toBe(priceCents);
    const okBody = await ok.json();
    expect(okBody.clientSecret).toContain('cs_price');
    expect(okBody.sessionId).toBe('cs_price');
    expect(okBody.url).toBeUndefined(); // no hosted redirect url in embedded mode
  });

  it('Phase 3 — checkout snapshots the lifetime term + refreshPolicy onto the order (for Phase-4 refresh)', async () => {
    const { id } = await makePackage({ name: 'LifetimeSnap', billingInterval: 'lifetime' });
    stripeState.nextSessionId = 'cs_lifesnap';
    const ok = await post('/billing/checkout', { packageId: id, email: 'buyer@x.com', domains: ['buyer.com'] });
    expect(ok.status).toBe(201);

    const orders = app.get<import('typeorm').Repository<OrderEntity>>(getRepositoryToken(OrderEntity));
    const ord = await orders.findOne({ where: { stripeSessionId: 'cs_lifesnap' } });
    expect(ord).toBeTruthy();
    expect(ord!.billingInterval).toBe('lifetime');          // snapshotted, not defaulted
    expect(ord!.refreshPolicy).toBe('auto');                // lifetime ⇒ auto
    expect(ord!.licenseTtlSeconds).toBe(SAFE_MAX_TTL);      // the DERIVED term, not a raw column
  });

  it('USD-only: a package created with a non-USD currency is rejected (400), and USD is forced regardless', async () => {
    // A non-USD currency must be rejected by the DTO.
    const eurRes = await post('/admin/packages', {
      name: 'EurPlan', priceCents: 4900, currency: 'EUR', billingInterval: 'once',
      featureIds: ['export.pdf'], active: true, publiclyListed: true,
    }, adminToken);
    expect(eurRes.status).toBe(400);

    // Currency may be OMITTED entirely — the server defaults it to USD.
    const noCurrencyRes = await post('/admin/packages', {
      name: 'NoCurrencyPlan', priceCents: 4900, billingInterval: 'once',
      featureIds: ['export.pdf'], active: true, publiclyListed: true,
    }, adminToken);
    expect(noCurrencyRes.status).toBe(201);
    const noCurrencyPkg = await noCurrencyRes.json();
    expect(noCurrencyPkg.currency).toBe('USD');
  });

  it('rejects checkout for a non-public / inactive package (400)', async () => {
    const hidden = await makePackage({ name: 'Hidden2', publiclyListed: false });
    expect((await post('/billing/checkout', { packageId: hidden.id, email: 'b@x.com', domains: ['b.com'] })).status).toBe(400);
    const inactive = await makePackage({ name: 'Inactive2', active: false });
    expect((await post('/billing/checkout', { packageId: inactive.id, email: 'b@x.com', domains: ['b.com'] })).status).toBe(400);
  });

  it('rejects a domain-bound checkout with no domain (400)', async () => {
    const { id } = await makePackage({ name: 'BoundReq', domainBound: true });
    expect((await post('/billing/checkout', { packageId: id, email: 'b@x.com' })).status).toBe(400);
  });

  it('§2.4: a checkout with NO installId still works — activation is optional', async () => {
    // Buying from a pricing page has no editor to read an install id from. That
    // path must be completely unchanged.
    const { id, priceCents } = await makePackage({ name: 'NoInstall', featureIds: ['export.pdf'], domainBound: false });
    stripeState.nextSessionId = 'cs_noinstall';
    const checkout = await post('/billing/checkout', { packageId: id, email: 'plain@buyer.com' });
    expect(checkout.status).toBe(201);
    const { sessionId } = await checkout.json();
    expect((await postWebhook(completedEvent('evt_noinst_1', sessionId, '', priceCents, 'usd'))).status).toBe(201);
    const fulfilled = await (await get(`/billing/orders/${sessionId}/license`)).json();
    expect(fulfilled.status).toBe('fulfilled');
    expect(fulfilled.licenseKey).toBeTruthy();
  });

  it('FULL FLOW: checkout → paid webhook → license minted & verifies in the real verifier', async () => {
    const { id, priceCents } = await makePackage({ name: 'FlowPro', featureIds: ['export.pdf', 'export.docx'], domainBound: true });
    stripeState.nextSessionId = 'cs_flow';
    const checkout = await post('/billing/checkout', { packageId: id, email: 'flow@buyer.com', name: 'Flow', domains: ['flow.com'] });
    const { sessionId } = await checkout.json();
    expect(sessionId).toBe('cs_flow');

    const pending = await (await get(`/billing/orders/${sessionId}/license`)).json();
    expect(pending.status).toBe('pending');

    // Webhook keyed by sessionId (controller falls back when orderId absent).
    // amount_total/currency MUST match the order or minting is refused.
    const evt = completedEvent('evt_flow_1', sessionId, '', priceCents, 'usd');
    expect((await postWebhook(evt)).status).toBe(201);

    // Single-use retrieval: FIRST read returns the key.
    const fulfilled = await (await get(`/billing/orders/${sessionId}/license`)).json();
    expect(fulfilled.status).toBe('fulfilled');
    expect(fulfilled.delivered).toBe(false);
    expect(fulfilled.licenseKey).toBeTruthy();

    const verified = await verifyLicense(fulfilled.licenseKey, { keyring, hostname: 'flow.com' });
    expect(verified.valid).toBe(true);
    expect(verified.payload.features.sort()).toEqual(['export.docx', 'export.pdf']);

    // SECOND read does NOT re-expose the key (leaked-URL protection).
    const second = await (await get(`/billing/orders/${sessionId}/license`)).json();
    expect(second.status).toBe('fulfilled');
    expect(second.delivered).toBe(true);
    expect(second.licenseKey).toBeUndefined();
  });

  it('ADMIN force-fulfill: recovers a paid-but-webhook-never-arrived order, idempotently', async () => {
    const { id, priceCents } = await makePackage({ name: 'ForcePro', featureIds: ['export.pdf'], domainBound: true });
    stripeState.nextSessionId = 'cs_force';
    // Checkout creates a PENDING order — but NO webhook ever arrives (the bug).
    await post('/billing/checkout', { packageId: id, email: 'force@buyer.com', name: 'Force', domains: ['force.com'] });

    // Find the stuck pending order via the admin orders list.
    const orders = await (await get('/admin/orders?q=force@buyer.com', adminToken)).json();
    const stuck = orders[0];
    expect(stuck.status).toBe('pending');

    // Stripe (retrieved fresh) reports the session IS paid for the right amount.
    stripeState.sessions.set('cs_force', {
      paymentStatus: 'paid', amountTotal: priceCents, currency: 'usd', orderId: stuck.id,
    });

    // Admin force-fulfills → license minted.
    const r1 = await post(`/admin/orders/${stuck.id}/force-fulfill`, {}, adminToken);
    expect(r1.status).toBe(201);
    const b1 = await r1.json();
    expect(b1.fulfilled).toBe(true);
    expect(b1.alreadyFulfilled).toBe(false);
    expect(b1.licenseId).toBeTruthy();

    // IDEMPOTENT: clicking again mints nothing new, returns the same license.
    const r2 = await post(`/admin/orders/${stuck.id}/force-fulfill`, {}, adminToken);
    expect(r2.status).toBe(201);
    const b2 = await r2.json();
    expect(b2.fulfilled).toBe(true);
    expect(b2.alreadyFulfilled).toBe(true);
    expect(b2.licenseId).toBe(b1.licenseId);
  });

  it('ADMIN force-fulfill: REFUSES when Stripe says the session is not paid (no free license)', async () => {
    const { id } = await makePackage({ name: 'UnpaidForce', featureIds: ['export.pdf'], domainBound: true });
    stripeState.nextSessionId = 'cs_unpaid_force';
    await post('/billing/checkout', { packageId: id, email: 'unpaid@buyer.com', name: 'Unp', domains: ['unp.com'] });
    const orders = await (await get('/admin/orders?q=unpaid@buyer.com', adminToken)).json();
    const stuck = orders[0];
    // Stripe reports NOT paid → force-fulfill must refuse (no license without payment).
    stripeState.sessions.set('cs_unpaid_force', {
      paymentStatus: 'unpaid', amountTotal: null, currency: null, orderId: stuck.id,
    });
    const r = await post(`/admin/orders/${stuck.id}/force-fulfill`, {}, adminToken);
    expect(r.status).toBe(400);
  });

  it('ADMIN force-fulfill: requires admin auth (no token → rejected)', async () => {
    const r = await post('/admin/orders/some-id/force-fulfill', {});
    expect([401, 403]).toContain(r.status);
  });

  it('5d REBIND route: admin rebinds a license to new domains → new key verifies there, old revoked', async () => {
    // Fulfill a license to rebind.
    const { id, priceCents } = await makePackage({ name: 'RebindPro', featureIds: ['export.pdf'], domainBound: true });
    stripeState.nextSessionId = 'cs_rebind';
    await post('/billing/checkout', { packageId: id, email: 'rebind@buyer.com', name: 'Reb', domains: ['old-site.com'] });
    expect((await postWebhook(completedEvent('evt_rebind_1', 'cs_rebind', '', priceCents, 'usd'))).status).toBe(201);

    // Find the admin license id (bulk list is token-free).
    const list = await (await get('/admin/licenses?q=rebind@buyer.com', adminToken)).json();
    const licId = list[0].id;

    // Rebind to a new domain via the admin route.
    const r = await post(`/admin/licenses/${licId}/rebind-domains`, { domains: ['new-site.com'] }, adminToken);
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.licenseId).toBeTruthy();
    expect(body.licenseId).not.toBe(licId);   // a genuinely new license row
    // F1 happy path: email delivered (dev-log transport) → token NOT leaked in the response.
    expect(body.delivered).toBe(true);
    expect(body.licenseKey).toBeUndefined();

    // The NEW license (fetch its key via resend? no — assert via admin list state):
    // the old id is now revoked, and a fresh active one exists on the new domain.
    const after = await (await get('/admin/licenses?q=rebind@buyer.com', adminToken)).json();
    const oldRow = after.find((l: { id: string }) => l.id === licId);
    const newRow = after.find((l: { id: string }) => l.id === body.licenseId);
    expect(oldRow.effectiveStatus).toBe('revoked');
    expect(newRow.effectiveStatus).toBe('active');
    expect(newRow.domains).toContain('new-site.com');
    expect(newRow.domains).not.toContain('old-site.com');
  });

  it('5d REBIND route: an over-broad domain is rejected (400)', async () => {
    const { id, priceCents } = await makePackage({ name: 'RebindGuardPro', featureIds: ['export.pdf'], domainBound: true });
    stripeState.nextSessionId = 'cs_rebindguard';
    await post('/billing/checkout', { packageId: id, email: 'rg@buyer.com', name: 'RG', domains: ['rg-old.com'] });
    expect((await postWebhook(completedEvent('evt_rg_1', 'cs_rebindguard', '', priceCents, 'usd'))).status).toBe(201);
    const list = await (await get('/admin/licenses?q=rg@buyer.com', adminToken)).json();
    const r = await post(`/admin/licenses/${list[0].id}/rebind-domains`, { domains: ['*.com'] }, adminToken);
    expect(r.status).toBe(400);
  });

  it('AMOUNT MISMATCH: a paid session for less than the order does NOT mint (coupon/$0 guard)', async () => {
    const { id } = await makePackage({ name: 'CouponPro', priceCents: 4900, featureIds: ['export.pdf'], domainBound: true });
    stripeState.nextSessionId = 'cs_coupon';
    await post('/billing/checkout', { packageId: id, email: 'coupon@buyer.com', domains: ['coupon.com'] });

    // Stripe reports amount_total: 0 (100%-off coupon). Must be refused.
    const evt = completedEvent('evt_coupon_1', 'cs_coupon', '', 0, 'usd');
    expect((await postWebhook(evt)).status).toBe(201); // acked, but…
    const after = await (await get('/billing/orders/cs_coupon/license')).json();
    expect(after.status).toBe('failed');       // …marked failed, no license
    expect(after.licenseKey).toBeUndefined();
  });

  it('CURRENCY MISMATCH: a paid session in the wrong currency does NOT mint', async () => {
    const { id, priceCents } = await makePackage({ name: 'CurPro', featureIds: ['export.pdf'], domainBound: true });
    stripeState.nextSessionId = 'cs_cur';
    await post('/billing/checkout', { packageId: id, email: 'cur@buyer.com', domains: ['cur.com'] });
    const evt = completedEvent('evt_cur_1', 'cs_cur', '', priceCents, 'eur'); // order is USD
    expect((await postWebhook(evt)).status).toBe(201);
    const after = await (await get('/billing/orders/cs_cur/license')).json();
    expect(after.status).toBe('failed');
  });

  it('IDEMPOTENCY: the same event twice mints exactly ONE license', async () => {
    const { id, priceCents } = await makePackage({ name: 'IdemPro', featureIds: ['export.pdf'], domainBound: true });
    stripeState.nextSessionId = 'cs_idem';
    await post('/billing/checkout', { packageId: id, email: 'idem@buyer.com', domains: ['idem.com'] });

    const evt = completedEvent('evt_idem_1', 'cs_idem', '', priceCents, 'usd');
    expect((await postWebhook(evt)).status).toBe(201);
    expect((await postWebhook(evt)).status).toBe(201); // replay

    const licenses = app.get<import('typeorm').Repository<LicenseEntity>>(getRepositoryToken(LicenseEntity));
    const all = await licenses.find({ relations: ['customer'] });
    const forBuyer = all.filter((l) => l.customer?.email === 'idem@buyer.com');
    expect(forBuyer.length).toBe(1); // exactly one, despite two events
  });

  it('CONCURRENT duplicate delivery mints exactly ONE license (H2 atomic guard)', async () => {
    const { id, priceCents } = await makePackage({ name: 'ConcPro', featureIds: ['export.pdf'], domainBound: true });
    stripeState.nextSessionId = 'cs_conc';
    await post('/billing/checkout', { packageId: id, email: 'conc@buyer.com', domains: ['conc.com'] });

    const evt = completedEvent('evt_conc_1', 'cs_conc', '', priceCents, 'usd');
    // Fire the SAME event twice truly concurrently — the in-txn ledger insert is
    // the guard; one wins, the other rolls back. Neither should error the caller.
    const [a, b] = await Promise.all([postWebhook(evt), postWebhook(evt)]);
    expect([a.status, b.status].every((s) => s === 201 || s === 503)).toBe(true);

    const licenses = app.get<import('typeorm').Repository<LicenseEntity>>(getRepositoryToken(LicenseEntity));
    const forBuyer = (await licenses.find({ relations: ['customer'] }))
      .filter((l) => l.customer?.email === 'conc@buyer.com');
    expect(forBuyer.length).toBe(1); // exactly one despite concurrent delivery
    const after = await (await get('/billing/orders/cs_conc/license')).json();
    expect(after.status).toBe('fulfilled');
  });

  it('MINT FAILURE does not burn the ledger: order → failed, and a corrected retry still fulfills (H2)', async () => {
    const { id, priceCents } = await makePackage({ name: 'FailPro', featureIds: ['export.pdf'], domainBound: true });
    stripeState.nextSessionId = 'cs_fail';
    await post('/billing/checkout', { packageId: id, email: 'fail@buyer.com', domains: ['fail.com'] });

    // Corrupt the order's feature snapshot to an UNKNOWN feature so the mint
    // (issueFromSnapshot → assertFeaturesSellable) throws BadRequestException.
    const orders = app.get<import('typeorm').Repository<import('../src/billing/entities/order.entity').OrderEntity>>(
      getRepositoryToken((await import('../src/billing/entities/order.entity')).OrderEntity));
    const ord = await orders.findOne({ where: { stripeSessionId: 'cs_fail' } });
    ord!.featureIds = ['this.feature.does.not.exist'];
    await orders.save(ord!);

    const evt = completedEvent('evt_fail_1', 'cs_fail', '', priceCents, 'usd');
    expect((await postWebhook(evt)).status).toBe(201); // acked (permanent failure)
    let after = await (await get('/billing/orders/cs_fail/license')).json();
    expect(after.status).toBe('failed');          // surfaced, not stuck pending
    expect(after.licenseKey).toBeUndefined();

    // The ledger was NOT burned (rolled back with the failed txn): fix the
    // snapshot and re-deliver the SAME event → it now fulfills. Proves no
    // "paid-but-lost".
    const fixed = await orders.findOne({ where: { stripeSessionId: 'cs_fail' } });
    fixed!.featureIds = ['export.pdf']; fixed!.status = 'pending';
    await orders.save(fixed!);
    expect((await postWebhook(evt)).status).toBe(201);
    after = await (await get('/billing/orders/cs_fail/license')).json();
    expect(after.status).toBe('fulfilled');
    expect(after.licenseKey).toBeTruthy();
  });

  it('RACE: a webhook arriving before the order is known asks Stripe to retry, then succeeds', async () => {
    // Simulate: an event for a session id that no order has yet (attachSession
    // not committed). The webhook must NOT burn the idempotency ledger, so a
    // later retry (once the order exists) can still fulfill.
    const evtEarly = completedEvent('evt_race_1', 'cs_race', '', 4900, 'usd');
    const early = await postWebhook(evtEarly);
    expect(early.status).toBe(503); // "retry me", non-2xx

    // Now the order appears (checkout completes / attachSession commits).
    const { id, priceCents } = await makePackage({ name: 'RacePro', featureIds: ['export.pdf'], domainBound: true });
    stripeState.nextSessionId = 'cs_race';
    await post('/billing/checkout', { packageId: id, email: 'race@buyer.com', domains: ['race.com'] });

    // Stripe retries the SAME event id → must now fulfill (ledger wasn't burned).
    const evtRetry = completedEvent('evt_race_1', 'cs_race', '', priceCents, 'usd');
    expect((await postWebhook(evtRetry)).status).toBe(201);
    const after = await (await get('/billing/orders/cs_race/license')).json();
    expect(after.status).toBe('fulfilled');
  });

  it('a BAD signature is rejected (400) and mints nothing', async () => {
    const { id, priceCents } = await makePackage({ name: 'SigPro', featureIds: ['export.pdf'], domainBound: true });
    stripeState.nextSessionId = 'cs_sig';
    await post('/billing/checkout', { packageId: id, email: 'sig@buyer.com', domains: ['sig.com'] });

    const evt = completedEvent('evt_sig_1', 'cs_sig', '', priceCents, 'usd');
    expect((await postWebhook(evt, 'forged')).status).toBe(400);

    const after = await (await get('/billing/orders/cs_sig/license')).json();
    expect(after.status).toBe('pending'); // never fulfilled
  });

  it('an unpaid completed session is acknowledged (2xx) but mints nothing', async () => {
    const { id } = await makePackage({ name: 'UnpaidPro', featureIds: ['export.pdf'], domainBound: true });
    stripeState.nextSessionId = 'cs_unpaid';
    await post('/billing/checkout', { packageId: id, email: 'unpaid@buyer.com', domains: ['unpaid.com'] });

    const evt = {
      id: 'evt_unpaid_1', type: 'checkout.session.completed',
      data: { object: { id: 'cs_unpaid', payment_status: 'unpaid', amount_total: 4900, currency: 'usd', metadata: {} } },
    };
    expect((await postWebhook(evt)).status).toBe(201);
    const after = await (await get('/billing/orders/cs_unpaid/license')).json();
    expect(after.status).toBe('pending');
  });

  it('success lookup for an unknown session returns status:unknown', async () => {
    const res = await get('/billing/orders/cs_nope/license');
    expect((await res.json()).status).toBe('unknown');
  });

  it('admin can list orders (fulfilled + failed surfaced), never with a token', async () => {
    const res = await get('/admin/orders', adminToken);
    expect(res.status).toBe(200);
    const orders = await res.json();
    expect(Array.isArray(orders)).toBe(true);
    // the coupon/currency mismatch orders are visible as 'failed'
    expect(orders.some((o: { status: string }) => o.status === 'failed')).toBe(true);
    expect(orders.some((o: { status: string }) => o.status === 'fulfilled')).toBe(true);
    for (const o of orders) expect(o).not.toHaveProperty('token');
  });

  it('POST /admin/licenses/:id/resend-email re-delivers the key for an active license (SMTP-failure recovery)', async () => {
    // Find the fulfilled FlowPro license minted by the FULL FLOW test.
    const licenses = await (await get('/admin/licenses', adminToken)).json();
    const active = licenses.find((l: { planName: string; effectiveStatus: string }) => l.planName === 'FlowPro' && l.effectiveStatus === 'active');
    expect(active).toBeTruthy();

    const res = await post(`/admin/licenses/${active.id}/resend-email`, undefined, adminToken);
    expect(res.status).toBe(201);
    const body = await res.json();
    // Dev email transport (no SMTP configured in tests) reports delivered:true.
    expect(body.delivered).toBe(true);
    expect(body.to).toBe('flow@buyer.com');
    // The resend response NEVER echoes the token back over the wire.
    expect(body).not.toHaveProperty('licenseKey');
    expect(body).not.toHaveProperty('token');
  });

  it('POST /admin/licenses/:id/resend-email refuses a revoked license (400)', async () => {
    const { id } = await makePackage({ name: 'ResendRevokedPlan', domainBound: true });
    const cust = await (await post('/admin/customers', { name: 'RR', email: 'rr@buyer.com', domains: ['rr.com'] }, adminToken)).json();
    const lic = await (await post('/admin/licenses', { customerId: cust.id, packageId: id }, adminToken)).json();
    await post(`/admin/licenses/${lic.id}/revoke`, undefined, adminToken);

    const res = await post(`/admin/licenses/${lic.id}/resend-email`, undefined, adminToken);
    expect(res.status).toBe(400);
  });

  it('POST /admin/licenses/:id/resend-email requires auth (401 without a token)', async () => {
    const res = await post('/admin/licenses/00000000-0000-0000-0000-000000000000/resend-email');
    expect(res.status).toBe(401);
  });

  it('GET /admin/orders supports ?q= (customer email/name) and ?status= filters', async () => {
    const { id } = await makePackage({ name: 'SearchFilterPlan', domainBound: true });
    await post('/billing/checkout', { packageId: id, email: 'searchable@buyer.com', name: 'Searchable Buyer', domains: ['searchable.com'] });

    const byEmail = await (await get('/admin/orders?q=searchable', adminToken)).json();
    expect(byEmail.some((o: { customerEmail: string }) => o.customerEmail === 'searchable@buyer.com')).toBe(true);

    const byEmailCi = await (await get('/admin/orders?q=SEARCHABLE', adminToken)).json();
    expect(byEmailCi.some((o: { customerEmail: string }) => o.customerEmail === 'searchable@buyer.com')).toBe(true);

    const noMatch = await (await get('/admin/orders?q=zzz-nonexistent-zzz', adminToken)).json();
    expect(noMatch).toEqual([]);

    const byStatus = await (await get('/admin/orders?status=pending', adminToken)).json();
    expect(byStatus.length).toBeGreaterThan(0);
    for (const o of byStatus) expect(o.status).toBe('pending');

    // An invalid/unknown status is silently ignored (returns unfiltered), not a 500.
    const invalidStatus = await get('/admin/orders?status=not-a-real-status', adminToken);
    expect(invalidStatus.status).toBe(200);

    // Combined q + status ANDs.
    const combined = await (await get('/admin/orders?q=searchable&status=pending', adminToken)).json();
    expect(combined.some((o: { customerEmail: string }) => o.customerEmail === 'searchable@buyer.com')).toBe(true);
  });

  it('a pending order stuck well past the webhook retry window is flagged stalePending (Phase 5 audit H3)', async () => {
    // A stuck pending order means the webhook never arrived (e.g. the local
    // `stripe listen` forwarder — or a production webhook endpoint — was down
    // when the buyer paid). Without this flag it's a SILENT failure: the
    // buyer's success page times out to a vague "almost there," and nothing
    // tells an admin the order needs attention. This proves `listOrders()`
    // surfaces it.
    const { id } = await makePackage({ name: 'StalePendingPlan', domainBound: true });
    await post('/billing/checkout', { packageId: id, email: 'stale@buyer.com', domains: ['stale.com'] });

    const orders = app.get<import('typeorm').Repository<import('../src/billing/entities/order.entity').OrderEntity>>(
      getRepositoryToken((await import('../src/billing/entities/order.entity')).OrderEntity));
    const fresh = await orders.findOne({ where: { customerEmail: 'stale@buyer.com' } });
    expect(fresh!.status).toBe('pending');

    // A brand-new pending order is NOT stale yet.
    const freshList = await (await get('/admin/orders', adminToken)).json();
    const freshRow = freshList.find((o: { customerEmail: string }) => o.customerEmail === 'stale@buyer.com');
    expect(freshRow.stalePending).toBe(false);

    // Backdate it past the 30-minute threshold — simulates a webhook that
    // never showed up.
    fresh!.createdAt = new Date(Date.now() - 45 * 60 * 1000);
    await orders.save(fresh!);

    const staleList = await (await get('/admin/orders', adminToken)).json();
    const staleRow = staleList.find((o: { customerEmail: string }) => o.customerEmail === 'stale@buyer.com');
    expect(staleRow.status).toBe('pending');
    expect(staleRow.stalePending).toBe(true);

    // A FULFILLED order, however old, is never flagged stale — the flag is
    // specifically about a payment stuck waiting for fulfillment.
    const fulfilledRow = staleList.find((o: { status: string }) => o.status === 'fulfilled');
    expect(fulfilledRow.stalePending).toBe(false);
  });

  it('isStalePending() flags an UNREADABLE createdAt as stale rather than silently "fine" (fails toward visible)', async () => {
    // `new Date(malformed).getTime()` is NaN, and a bare `NaN > threshold`
    // comparison is ALWAYS false — that would silently report
    // stalePending:false for a row whose timestamp is itself broken, hiding a
    // real data problem behind a falsely reassuring flag. Unit-tested
    // directly (not round-tripped through a real DB): both MySQL (strict
    // mode) and sqljs reject writing a literal invalid string into a
    // DATETIME column, so this specific defect can only be exercised at the
    // pure-function level, not by actually corrupting a live row.
    const { OrderService } = await import('../src/billing/order.service');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isStalePending = (OrderService as any).isStalePending as
      (status: string, createdAt: unknown, now: number) => boolean;

    const now = Date.now();
    expect(isStalePending('pending', undefined, now)).toBe(true); // unreadable -> flagged
    expect(isStalePending('pending', 'not-a-real-date', now)).toBe(true); // unreadable -> flagged
    expect(isStalePending('pending', new Date(now - 45 * 60 * 1000), now)).toBe(true); // genuinely stale
    expect(isStalePending('pending', new Date(now - 5 * 60 * 1000), now)).toBe(false); // fresh
    expect(isStalePending('fulfilled', undefined, now)).toBe(false); // non-pending never flagged, even with bad data
  });
});
