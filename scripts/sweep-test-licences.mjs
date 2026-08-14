#!/usr/bin/env node
/**
 * sweep-test-licences.mjs — find (and optionally revoke) non-production
 * licences sitting in a live database.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * §1.8 added an `isTest` flag so staging and support licences could be swept
 * before a billing reconciliation. The flag is written and surfaced — and
 * NOTHING EVER READS IT. No sweep, no filter, no exclusion from any count.
 *
 * The predictable result: production accumulated 12 synthetic licences
 * (`A-prem 1786608455820`, `S3a …`, `S3 Probe …`, domains like `demo.example`),
 * every one of them `isTest: false`, all indistinguishable from real customers
 * in the admin list. Each was a working premium credential. They were found by
 * reading the licence table by hand, not by any tooling.
 *
 * This closes that loop. It reports first and only acts when told to.
 *
 * ─── WHAT COUNTS AS A TEST LICENCE ──────────────────────────────────────────
 *   1. isTest === true                       — declared, the intended path
 *   2. plan name ending in a 13-digit epoch  — `Rev 1786595841425`, generated
 *                                              by automated runs
 *   3. an obviously synthetic customer email — @t.com, @test.com, @example.com,
 *                                              or a local part ending in digits
 *                                              that look like a timestamp
 *   4. a reserved-for-documentation domain   — *.example, example.com/.org/.net
 *                                              (RFC 2606 — these can never be
 *                                              a real customer's site)
 *
 * Rules 2-4 are heuristics for licences created BEFORE anyone set isTest, which
 * is how the existing mess arose. They are reported with the reason that
 * matched so you can judge each one; nothing is revoked without --revoke.
 *
 * ─── USAGE ──────────────────────────────────────────────────────────────────
 *   ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/sweep-test-licences.mjs
 *   … --revoke        actually revoke the ACTIVE ones it found
 *   … --json          machine-readable, for a reconciliation pipeline
 *
 * Revoking is deliberately opt-in and never touches an already-revoked licence.
 */
const API = (process.env.API || 'http://127.0.0.1:8787').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL || 'admin@local.test';
const PASSWORD = process.env.ADMIN_PASSWORD || 'local-dev-password';
const REVOKE = process.argv.includes('--revoke');
const JSON_OUT = process.argv.includes('--json');

const req = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3000',
      ...(init.headers || {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const login = await req('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!login.body?.accessToken) {
  console.error(`\n  ✗ Login failed (HTTP ${login.status}) for ${EMAIL}.\n`);
  process.exit(1);
}
const auth = { Authorization: `Bearer ${login.body.accessToken}` };

const listed = await req('/admin/licenses', { headers: auth });
const all = Array.isArray(listed.body) ? listed.body : (listed.body?.items || []);

/** RFC 2606 reserves these; they can never belong to a real customer. */
const RESERVED = /(^|\.)(example|test|invalid|localhost)(\.|$)/i;
const TIMESTAMP = /\d{13}$/;
const SYNTHETIC_EMAIL = /@(t|test|example)\.(com|org|net)$/i;

function classify(l) {
  const reasons = [];
  if (l.isTest === true) reasons.push('isTest flag');
  if (TIMESTAMP.test(String(l.planName || ''))) reasons.push('timestamped plan name');
  const email = String((l.customer || {}).email || '');
  if (SYNTHETIC_EMAIL.test(email) || /\d{10,}@/.test(email)) reasons.push('synthetic email');
  const doms = l.domains || [];
  if (doms.length && doms.every((d) => RESERVED.test(String(d)))) reasons.push('reserved domain');
  return reasons;
}

const flagged = all
  .map((l) => ({ l, reasons: classify(l) }))
  .filter((x) => x.reasons.length > 0);

const activeFlagged = flagged.filter((x) => x.l.status === 'active');

if (JSON_OUT) {
  console.log(JSON.stringify({
    api: API,
    total: all.length,
    flagged: flagged.length,
    activeFlagged: activeFlagged.length,
    licences: flagged.map((x) => ({
      id: x.l.id, plan: x.l.planName, status: x.l.status,
      email: (x.l.customer || {}).email, reasons: x.reasons,
    })),
  }, null, 2));
} else {
  console.log(`\n  test-licence sweep → ${API}`);
  console.log(`  ${all.length} licences, ${flagged.length} look non-production (${activeFlagged.length} still ACTIVE)\n`);
  for (const { l, reasons } of flagged) {
    const mark = l.status === 'active' ? '!' : '·';
    console.log(`    ${mark} ${String(l.planName).slice(0, 26).padEnd(26)} ${String(l.status).padEnd(8)} ${String((l.customer || {}).email).slice(0, 30).padEnd(30)} ${reasons.join(', ')}`);
  }
  if (!flagged.length) console.log('    (none — clean)');
}

if (!REVOKE) {
  if (activeFlagged.length && !JSON_OUT) {
    console.log(`\n  ${activeFlagged.length} active. Each is a WORKING credential. Revoke with --revoke\n`);
  } else if (!JSON_OUT) {
    console.log('');
  }
  process.exit(0);
}

if (!activeFlagged.length) {
  console.log('\n  Nothing active to revoke.\n');
  process.exit(0);
}

console.log(`\n  revoking ${activeFlagged.length} active test licence(s)…`);
let failed = 0;
for (const { l, reasons } of activeFlagged) {
  const r = await req(`/admin/licenses/${l.id}/revoke`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ reason: `test-licence sweep: ${reasons.join(', ')}` }),
  });
  const ok = r.status < 300 && r.body?.status === 'revoked';
  if (!ok) failed++;
  console.log(`    ${ok ? '✓' : '✗'} ${String(l.planName).slice(0, 30)}`);
}
console.log(failed ? `\n  ${failed} failed.\n` : '\n  Done.\n');
process.exit(failed ? 1 : 0);
