/**
 * publish-local-bundles.mjs — publish the built engine to a RUNNING backend,
 * so runtime delivery works on your machine.
 *
 * Until now this only ever happened inside test harnesses. Running the stack by
 * hand meant a backend with an empty registry: `/delivery/session` correctly
 * returns 404 ("no engine version is configured"), which looks like a bug and
 * is really just an unpublished engine.
 *
 * It does exactly what the admin API does in production — publish free +
 * premium, promote to stable, point the global default at it — reading the
 * manifest the build emits so the hashes always describe real bytes.
 *
 * Usage (backend already running):
 *   node scripts/publish-local-bundles.mjs
 *
 * Env:
 *   API   backend base URL      (default http://127.0.0.1:8787)
 *   CORE  path to packages/core (default ../open-editor/packages/core)
 *   ADMIN_EMAIL / ADMIN_PASSWORD  (default the SEED_ADMIN_* values)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const API = process.env.API || 'http://127.0.0.1:8787';
const CORE = resolve(process.env.CORE || '../open-editor/packages/core');
const EMAIL = process.env.ADMIN_EMAIL || 'admin@local.test';
const PASSWORD = process.env.ADMIN_PASSWORD || 'local-dev-password';

const DELIVERY = join(CORE, 'dist', 'delivery');
const MANIFEST = join(DELIVERY, 'manifest.json');

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

if (!existsSync(MANIFEST)) {
  die(`No engine build found at ${DELIVERY}.\n`
    + '  Build it first:\n'
    + `    cd ${CORE}\n`
    + "    DELIVERY_LICENSE_KEYS='[{\"kid\":\"…\",\"jwk\":{…}}]' npm run build:delivery");
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
const { version } = manifest;

const post = (path, body, token) => fetch(`${API}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const patch = (path, body, token) => fetch(`${API}${path}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

// ── 1. Authenticate ─────────────────────────────────────────────────────────
let login;
try {
  login = await post('/auth/login', { email: EMAIL, password: PASSWORD });
} catch {
  die(`Cannot reach the backend at ${API}. Start it first:\n    npm run start:dev`);
}
if (!login.ok) {
  die(`Login failed (HTTP ${login.status}) for ${EMAIL}.\n`
    + '  Set ADMIN_EMAIL / ADMIN_PASSWORD to your SEED_ADMIN_* values.');
}
const { accessToken } = await login.json();

// ── 1b. THE KEYRING MUST MATCH THIS BACKEND ─────────────────────────────────
//
// Licences are verified OFFLINE against a public key compiled into the bundle.
// So a bundle built with one environment's keyring cannot verify licences
// issued by another — and the failure is SILENT: the session resolves, the
// bytes download, the digest matches, and every paying customer quietly drops
// to the free tier. That exact shape already reached production once (an EMPTY
// keyring), and it was found by a person clicking, not by any check.
//
// Publishing a staging-keyring bundle to production would do the same thing to
// everyone at once. `verify-bundles.mjs` checks a keyring is PRESENT; nothing
// checked it was the RIGHT one. This does.
//
// Read the kid out of the built bundle and compare it with the JWKS the target
// backend actually publishes. Mismatch = refuse, before a single byte is sent.
{
  const freeSrc = readFileSync(join(DELIVERY, 'free.js'), 'utf-8');
  const m = freeSrc.match(/licenseKeys:\[\{kid:"([^"]+)"/);
  const bundleKid = m ? m[1] : null;

  let backendKids = [];
  try {
    const res = await fetch(`${API}/.well-known/jwks.json`);
    if (res.ok) {
      const jwks = await res.json();
      backendKids = (jwks.keys || []).map((k) => k.kid).filter(Boolean);
    }
  } catch { /* handled below */ }

  if (!bundleKid) {
    // A keyless bundle verifies NOTHING. Never publish one.
    die('The built bundle carries NO licence keyring, so every licence would\n'
      + '  fail and every paying customer would silently drop to free.\n\n'
      + '  Rebuild with the target backend\'s keys:\n'
      + `    DELIVERY_RELEASE=1 DELIVERY_LICENSE_KEYS="$(curl -s ${API}/.well-known/jwks.json)" \\\n`
      + '      npm run build:delivery');
  }

  if (!backendKids.length) {
    die(`Could not read ${API}/.well-known/jwks.json, so the bundle's keyring\n`
      + `  ("${bundleKid}") cannot be checked against this backend.\n\n`
      + '  Refusing to publish blind: a mismatched keyring breaks every paying\n'
      + '  customer at once, silently. Fix the endpoint and retry.');
  }

  if (!backendKids.includes(bundleKid)) {
    die(`KEYRING MISMATCH — refusing to publish.\n\n`
      + `    bundle was built with : ${bundleKid}\n`
      + `    ${API} publishes      : ${backendKids.join(', ')}\n\n`
      + '  This bundle cannot verify any licence issued by that backend. Every\n'
      + '  paying customer would silently drop to the free tier.\n\n'
      + '  You are almost certainly publishing a bundle built for a DIFFERENT\n'
      + '  environment. Rebuild against this one:\n'
      + `    DELIVERY_RELEASE=1 DELIVERY_LICENSE_KEYS="$(curl -s ${API}/.well-known/jwks.json)" \\\n`
      + '      npm run build:delivery');
  }

  console.log(`\n  keyring ✓ bundle "${bundleKid}" matches ${API}`);
}

// ── 2. Publish both plans, bytes included ───────────────────────────────────
console.log(`\n  publishing engine ${version} → ${API}`);
for (const plan of ['free', 'premium']) {
  const entry = manifest.plans[plan];
  const file = join(DELIVERY, `${plan}.js`);
  if (!existsSync(file)) die(`missing ${file} — run build:delivery`);

  const res = await post('/admin/engine/versions', {
    version,
    plan,
    supportedFeatures: entry.features,
    bundleKey: entry.bundleKey,
    bundleSha256: entry.sha256,
    bundleBytes: entry.bytes,
    // Bytes travel WITH the metadata so the row and its bundle land together —
    // a registry row whose bytes are missing resolves fine and then 404s.
    bundleBase64: readFileSync(file).toString('base64'),
  }, accessToken);

  if (res.status === 201) {
    console.log(`    ✓ ${plan.padEnd(8)} ${(entry.bytes / 1024).toFixed(0)} KB  ${entry.sha256.slice(0, 12)}…`);
  } else if (res.status === 400 && /immutable/i.test(await res.clone().text())) {
    // Already published: bundles are immutable by design, so this is a no-op,
    // not a failure. Re-running the script must be safe.
    console.log(`    · ${plan.padEnd(8)} already published (immutable)`);
  } else {
    die(`publish ${plan} failed (HTTP ${res.status}): ${await res.text()}`);
  }
}

// ── 3. Promote + point the default at it ────────────────────────────────────
const promoted = await patch(`/admin/engine/versions/${version}/channel`, { channel: 'stable' }, accessToken);
if (!promoted.ok) die(`promote failed (HTTP ${promoted.status}): ${await promoted.text()}`);

const defaulted = await post('/admin/engine/defaults', { scope: 'global', version }, accessToken);
if (!defaulted.ok) die(`set default failed (HTTP ${defaulted.status}): ${await defaulted.text()}`);

// ── 4. Prove it end to end, the way the loader will ─────────────────────────
const session = await (await post('/delivery/session', {})).json();
const bundle = await fetch(new URL(session.engine.url, API));

console.log(`
  ✓ ${version} is live on ${API}

    plan      ${session.plan}
    features  ${session.features.length}
    bundle    ${session.engine.url.slice(0, 60)}…
    download  HTTP ${bundle.status}

  Point an editor at it:

    import { createEditor } from 'openeditor-text';
    await createEditor('#app', { endpoint: '${API}' });
`);
