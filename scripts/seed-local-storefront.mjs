/**
 * seed-local-storefront.mjs — give a local backend the same STOREFRONT that
 * production has, so /pricing and the purchase flow behave the same in both.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Local and production drifting apart cost real debugging time. `/public/packages`
 * returned `[]` locally while production returned one plan, so "free isn't
 * showing on the website" and "checkout returns an error" looked like code bugs
 * when they were data differences. A developer cannot test a purchase flow
 * against a storefront that has nothing in it.
 *
 * This is deliberately NOT part of the app's own seeding. `seed.service.ts`
 * creates the minimum a backend needs to boot; this creates a realistic SHOP,
 * which is a development convenience and must never run in production.
 *
 * ─── WHAT IT CREATES ────────────────────────────────────────────────────────
 *   Free   $0    listed, isFree, every feature the FREE build supports
 *   Pro    $49   listed, domain-bound, every feature the PREMIUM build supports
 *
 * Both feature lists are read from the ENGINE VERSION that is actually
 * published locally — never hard-coded. A hard-coded list silently rots the
 * moment the engine changes, and would recreate exactly the over-claiming this
 * project already hit once (a version advertising 73 features it did not have).
 *
 * ─── USAGE ──────────────────────────────────────────────────────────────────
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/seed-local-storefront.mjs
 *
 * Idempotent: a package with the same name is UPDATED, not duplicated, so it is
 * safe to re-run after changing the engine or the feature catalog.
 */
const API = process.env.API || 'http://127.0.0.1:8787';
const EMAIL = process.env.ADMIN_EMAIL || 'admin@local.test';
const PASSWORD = process.env.ADMIN_PASSWORD || 'local-dev-password';

// Refuse to touch anything that is not obviously a local backend. This script
// creates and overwrites packages by name; pointing it at production would
// rewrite a real storefront.
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(API)) {
  console.error(`\n  ✗ Refusing to run against ${API}`);
  console.error('    This seeds a DEVELOPMENT storefront and overwrites packages by name.');
  console.error('    Set API to a localhost address, or make the change in the admin panel.\n');
  process.exit(1);
}

const req = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3000',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

const login = await req('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!login.body?.accessToken) {
  console.error(`\n  ✗ Login failed (HTTP ${login.status}) for ${EMAIL}.`);
  console.error('    Set ADMIN_EMAIL / ADMIN_PASSWORD to your SEED_ADMIN_* values.\n');
  process.exit(1);
}
const token = login.body.accessToken;
const auth = { Authorization: `Bearer ${token}` };

// ── Read what the PUBLISHED engine actually supports ────────────────────────
const versions = await req('/admin/engine/versions', { headers: auth });
const list = Array.isArray(versions.body) ? versions.body : (versions.body?.items || []);
if (!list.length) {
  console.error('\n  ✗ No engine versions are published locally.');
  console.error('    Run `npm run publish:local` first — the feature lists are read from it.\n');
  process.exit(1);
}

// ⚠️ Use the DESIGNATED GLOBAL DEFAULT, not the highest version number.
//
// "Highest wins" looks obviously right and is wrong: test fixtures live
// alongside real builds. A first run of this script picked `7.7.7` — a
// 1-feature fixture — and overwrote the real Free package with it, which is
// exactly the over-claiming/under-claiming failure this project already hit
// once. The default pointer is the only thing that says which build visitors
// actually receive, so it is the only honest source for "what can we sell?".
const defaults = await req('/admin/engine/defaults', { headers: auth });
const globalDefault = (Array.isArray(defaults.body) ? defaults.body : [])
  .find((d) => d.scope === 'global');
if (!globalDefault?.version) {
  console.error('\n  ✗ No global default engine version is set.');
  console.error('    Run `npm run publish:local` first — it publishes and designates one.\n');
  process.exit(1);
}
const newest = globalDefault.version;
const featuresFor = (plan) => {
  const row = list.find((v) => v.version === newest && v.plan === plan);
  return (row?.supportedFeatures || []).slice();
};

const freeFeatures = featuresFor('free');
const premiumFeatures = featuresFor('premium');
if (!freeFeatures.length || !premiumFeatures.length) {
  console.error(`\n  ✗ Engine ${newest} is missing a free or premium build.\n`);
  process.exit(1);
}

console.log(`\n  seeding storefront from engine ${newest} (the designated default) → ${API}`);
console.log(`    free build supports    ${freeFeatures.length} features`);
console.log(`    premium build supports ${premiumFeatures.length} features\n`);

// ── Upsert by name ──────────────────────────────────────────────────────────
const existing = await req('/admin/packages', { headers: auth });
const current = Array.isArray(existing.body) ? existing.body : (existing.body?.items || []);
const findByName = (name) => current.find((p) => p.name === name);

async function upsert(spec) {
  const found = findByName(spec.name);
  if (found) {
    const r = await req(`/admin/packages/${found.id}`, {
      method: 'PATCH', headers: auth, body: JSON.stringify(spec),
    });
    if (r.status >= 300) {
      console.log(`    ✗ ${spec.name}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      return null;
    }
    console.log(`    · ${spec.name.padEnd(6)} updated  (${spec.featureIds.length} features)`);
    return r.body;
  }
  const r = await req('/admin/packages', {
    method: 'POST', headers: auth, body: JSON.stringify(spec),
  });
  if (r.status >= 300) {
    console.log(`    ✗ ${spec.name}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    return null;
  }
  console.log(`    ✓ ${spec.name.padEnd(6)} created  (${spec.featureIds.length} features)`);
  return r.body;
}

const free = await upsert({
  name: 'Free',
  description: 'Everything you need to ship a rich text editor. No card, no signup, no licence key — install the package and it works.',
  priceCents: 0,
  currency: 'USD',
  billingInterval: 'once',
  isFree: true,
  domainBound: false,
  publiclyListed: true,
  featureIds: freeFeatures,
});

await upsert({
  name: 'Pro',
  description: 'Everything in Free, plus PDF and Word export.',
  priceCents: 4900,
  currency: 'USD',
  billingInterval: 'yearly',
  isFree: false,
  domainBound: true,
  publiclyListed: true,
  featureIds: premiumFeatures,
});

// ── The free package must be what unlicensed visitors resolve to ────────────
if (free?.id) {
  const d = await req('/admin/packages/default', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ packageId: free.id, reason: 'local storefront seed' }),
  });
  console.log(d.status < 300
    ? '    · Free designated as the default for unlicensed visitors'
    : `    ✗ could not designate default: HTTP ${d.status}`);
}

// ── Prove it from the PUBLIC endpoint, not the admin one ────────────────────
const pub = await req('/public/packages');
const shown = Array.isArray(pub.body) ? pub.body : [];
console.log('\n  /public/packages now returns:');
for (const p of shown) {
  console.log(`    ${String(p.name).padEnd(6)} ${p.priceCents === 0 ? 'free' : `$${(p.priceCents / 100).toFixed(2)}`}  ${p.features?.length ?? 0} features`);
}
if (!shown.length) {
  console.log('    (nothing — the storefront is still empty; check the errors above)');
}
console.log('');
