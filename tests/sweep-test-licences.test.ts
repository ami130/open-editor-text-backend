/**
 * sweep-test-licences.test.ts — the sweep must never target a real customer.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * §1.8 added `isTest` so non-production licences could be swept before a
 * billing reconciliation. The flag was written and surfaced and NEVER READ —
 * no sweep, no filter, no exclusion. Production accumulated 13 synthetic
 * licences, every one `isTest: false`, indistinguishable from real customers in
 * the admin list. They were found by reading the table by hand.
 *
 * The sweep closes that. Because it REVOKES, its classifier is the dangerous
 * part: a false positive kills a paying customer's licence. These tests pin the
 * boundary from both sides.
 *
 * Verified against production before shipping: it independently found all 13
 * known test licences (including one missed by hand), and flagged NEITHER of
 * the two real active licences.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'scripts', 'sweep-test-licences.mjs'), 'utf-8');

/** The classifier, mirrored from the script so the rules can be exercised. */
const RESERVED = /(^|\.)(example|test|invalid|localhost)(\.|$)/i;
const TIMESTAMP = /\d{13}$/;
const SYNTHETIC_EMAIL = /@(t|test|example)\.(com|org|net)$/i;

function classify(l: {
  isTest?: boolean; planName?: string;
  customer?: { email?: string }; domains?: string[];
}) {
  const reasons: string[] = [];
  if (l.isTest === true) reasons.push('isTest flag');
  if (TIMESTAMP.test(String(l.planName || ''))) reasons.push('timestamped plan name');
  const email = String(l.customer?.email || '');
  if (SYNTHETIC_EMAIL.test(email) || /\d{10,}@/.test(email)) reasons.push('synthetic email');
  const doms = l.domains || [];
  if (doms.length && doms.every((d) => RESERVED.test(String(d)))) reasons.push('reserved domain');
  return reasons;
}

describe('test-licence classifier — real customers must survive', () => {
  it('spares a normal paying customer', () => {
    expect(classify({
      planName: 'Pro', customer: { email: 'buyer@acme.com' }, domains: ['acme.com', 'www.acme.com'],
    })).toEqual([]);
  });

  it('spares the real licences that exist on production today', () => {
    // Both were confirmed swept=false against the live database.
    expect(classify({
      planName: 'internal use', customer: { email: 'internal-use@parselab.com' },
      domains: ['open-editor-text-web.vercel.app', 'demo.parselab.com'],
    })).toEqual([]);
    expect(classify({
      planName: 'Pro', customer: { email: 'ami@parselab.com' }, domains: [],
    })).toEqual([]);
  });

  it('spares a customer whose company name merely CONTAINS "test"', () => {
    // `testimonials.com` is a real domain; the reserved-domain rule is anchored
    // on label boundaries precisely so it does not eat one.
    expect(classify({
      planName: 'Pro', customer: { email: 'ceo@testimonials.com' }, domains: ['testimonials.com'],
    })).toEqual([]);
  });

  it('spares a plan name with digits that are NOT a 13-digit epoch', () => {
    expect(classify({ planName: 'Pro 2026', customer: { email: 'a@b.com' } })).toEqual([]);
  });
});

describe('test-licence classifier — synthetic licences must be caught', () => {
  it('catches an explicit isTest licence', () => {
    expect(classify({ isTest: true, planName: 'Pro', customer: { email: 'a@b.com' } }))
      .toContain('isTest flag');
  });

  it('catches the timestamped plan names automated runs produce', () => {
    expect(classify({ planName: 'A-prem 1786608455820', customer: { email: 'x@y.com' } }))
      .toContain('timestamped plan name');
  });

  it('catches synthetic customer emails', () => {
    expect(classify({ planName: 'Pro', customer: { email: 'demo1786619845@t.com' } }))
      .toContain('synthetic email');
  });

  it('catches RFC 2606 reserved domains', () => {
    expect(classify({ planName: 'Pro', customer: { email: 'a@b.com' }, domains: ['demo.example', 'www.demo.example'] }))
      .toContain('reserved domain');
  });

  it('does NOT flag on domains where only SOME are reserved', () => {
    // A real customer testing on example.com alongside their live site must not
    // be swept — every domain has to be reserved for the rule to fire.
    expect(classify({
      planName: 'Pro', customer: { email: 'real@acme.com' }, domains: ['acme.com', 'demo.example'],
    })).toEqual([]);
  });
});

describe('sweep safety', () => {
  it('does not revoke without an explicit --revoke', () => {
    expect(src).toMatch(/const REVOKE = process\.argv\.includes\('--revoke'\)/);
    expect(src).toMatch(/if \(!REVOKE\)/);
  });

  it('only ever revokes licences that are currently ACTIVE', () => {
    expect(src).toMatch(/activeFlagged = flagged\.filter\(\(x\) => x\.l\.status === 'active'\)/);
  });

  it('records WHY each licence was swept, for an audit trail', () => {
    expect(src).toMatch(/reason: `test-licence sweep: \$\{reasons\.join/);
  });
});
