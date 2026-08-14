#!/usr/bin/env node
/**
 * check-delivery.mjs — assert the CUSTOMER-VISIBLE delivery chain, from outside.
 *
 * ─── WHY /health IS NOT ENOUGH ──────────────────────────────────────────────
 * `/health` verifies that a default engine version exists and that its BYTES
 * are present. That is real, and it would catch a half-finished publish. But
 * every defect that actually reached production got past it:
 *
 *   • the bundle shipped with an EMPTY KEYRING       → bytes present, health ok
 *   • premium buttons never reached the toolbar      → engine internals, health ok
 *   • PDF export always reported "popup blocked"     → browser-only, health ok
 *
 * Health answers "is the service up?". Nobody was asking "does a customer still
 * get a working editor?" — so nothing failed, and the answers came from a
 * person clicking, weeks later. This script asks the second question.
 *
 * ─── WHAT IT ASSERTS ────────────────────────────────────────────────────────
 *   1. an anonymous session resolves to a plan with features
 *   2. the promised bundle downloads
 *   3. its SHA-256 matches what the session promised   ← integrity, end to end
 *   4. it carries a licence keyring                    ← the silent premium killer
 *   5. it looks like a real engine, not a stub or an error page
 *   6. (with a key) a licence resolves to premium and grants what it should
 *
 * Deliberately uses ONLY the public API — no database, no admin token, no
 * internals. If this passes, a customer's editor works; if it fails, it fails
 * for the same reason theirs would.
 *
 * ─── USAGE ──────────────────────────────────────────────────────────────────
 *   node scripts/check-delivery.mjs                        # anonymous chain
 *   LICENCE_KEY=<key> node scripts/check-delivery.mjs      # + the premium chain
 *   API=https://staging... node scripts/check-delivery.mjs
 *
 * Exits 0 when everything passes, 1 otherwise — so cron, CI, or any uptime
 * service that can run a command will page on a real customer-facing break.
 * `--json` prints a machine-readable summary for pipes into an alerting tool.
 */
import { createHash } from 'node:crypto';

const API = (process.env.API || 'https://open-editor-text-backend-production.up.railway.app').replace(/\/$/, '');
const LICENCE_KEY = process.env.LICENCE_KEY || '';
const ORIGIN = process.env.ORIGIN || 'https://demo.parselab.com';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30_000);
const JSON_OUT = process.argv.includes('--json');

const results = [];
const pass = (name, detail) => results.push({ name, ok: true, detail });
const fail = (name, detail) => results.push({ name, ok: false, detail });

const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
]);

async function session(licenceKey) {
  const res = await withTimeout(fetch(`${API}/delivery/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(licenceKey ? { licenceKey } : {}),
  }), TIMEOUT_MS, 'session');
  if (!res.ok) throw new Error(`session HTTP ${res.status}`);
  return res.json();
}

const absolute = (url) => (url.startsWith('http') ? url : `${API}${url}`);

// ── 1-5: the anonymous chain every visitor walks ────────────────────────────
let anon;
try {
  anon = await session('');
  if (anon.plan && Array.isArray(anon.features) && anon.features.length > 0) {
    pass('anonymous session', `plan=${anon.plan} features=${anon.features.length} version=${anon.version}`);
  } else {
    fail('anonymous session', `plan=${anon.plan} features=${anon.features?.length ?? 0} — a visitor would get an editor that can do nothing`);
  }
} catch (err) {
  fail('anonymous session', err.message);
}

if (anon?.engine?.url) {
  let bytes = null;
  try {
    const res = await withTimeout(fetch(absolute(anon.engine.url)), TIMEOUT_MS, 'bundle download');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
    pass('bundle downloads', `${(bytes.length / 1024).toFixed(0)} KB`);
  } catch (err) {
    fail('bundle downloads', err.message);
  }

  if (bytes) {
    // 3. Integrity. The loader refuses to execute a mismatch, so a mismatch here
    //    means every customer's editor is refusing to start.
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest === anon.engine.sha256) {
      pass('sha-256 matches the session', digest.slice(0, 16) + '…');
    } else {
      fail('sha-256 matches the session', `promised ${anon.engine.sha256?.slice(0, 16)}… got ${digest.slice(0, 16)}… — the loader will refuse to run this`);
    }

    const src = bytes.toString('utf8');

    // 4. THE SILENT PREMIUM KILLER. Licences are verified OFFLINE against keys
    //    compiled into the bundle. With none, every licence fails and every
    //    paying customer silently drops to free — with a perfect server
    //    response and nothing in any log. This shipped once.
    const kid = src.match(/licenseKeys:\[\{kid:"([^"]+)"/);
    if (kid) {
      pass('bundle carries a licence keyring', `kid=${kid[1]}`);
    } else {
      fail('bundle carries a licence keyring',
        'licenseKeys is null/empty — EVERY paying customer silently drops to free. See RUNBOOK 6b.');
    }

    // 5. Cheap sanity: an error page or truncated upload is bytes too.
    if (bytes.length > 100_000 && /\bexport\s*\{/.test(src)) {
      pass('bundle looks like a real engine', 'has ESM exports and a plausible size');
    } else {
      fail('bundle looks like a real engine', `${bytes.length} bytes, ESM exports ${/\bexport\s*\{/.test(src)} — possibly a stub or an error page`);
    }
  }
}

// ── 6: the premium chain, when a key is supplied ────────────────────────────
if (LICENCE_KEY) {
  try {
    const lic = await session(LICENCE_KEY);
    const f = lic.features || [];
    if (lic.plan === 'premium' && f.length > (anon?.features?.length ?? 0)) {
      pass('licence resolves to premium', `plan=${lic.plan} features=${f.length} bundle=${lic.engine?.key}`);
    } else {
      fail('licence resolves to premium',
        `plan=${lic.plan} features=${f.length} refusal=${lic.refusal ?? 'none'} — a paying customer is being served the free tier`);
    }
    // Name the premium features explicitly: "premium" with the free feature set
    // is the exact shape of the bug that took longest to find.
    const missing = ['export.pdf', 'export.docx'].filter((id) => !f.includes(id));
    if (missing.length === 0) {
      pass('premium features granted', 'export.pdf, export.docx');
    } else {
      fail('premium features granted', `missing: ${missing.join(', ')}`);
    }
  } catch (err) {
    fail('licence resolves to premium', err.message);
  }
} else {
  results.push({ name: 'premium chain', ok: true, skipped: true, detail: 'no LICENCE_KEY set — anonymous chain only' });
}

// ── Report ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);

if (JSON_OUT) {
  console.log(JSON.stringify({ api: API, ok: failed.length === 0, results }, null, 2));
} else {
  console.log(`\n  delivery check → ${API}\n`);
  for (const r of results) {
    const mark = r.skipped ? '·' : r.ok ? '✓' : '✗';
    console.log(`    ${mark} ${r.name.padEnd(32)} ${r.detail}`);
  }
  console.log(failed.length === 0
    ? '\n  All checks passed — a customer gets a working editor.\n'
    : `\n  ${failed.length} CHECK(S) FAILED — customers are affected. See RUNBOOK.md.\n`);
}

process.exit(failed.length === 0 ? 0 : 1);
