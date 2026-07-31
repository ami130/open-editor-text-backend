/**
 * catalog-drift.test.ts — enforces that the UNIFIED vendored catalog
 * (feature-catalog.ts) stays in sync with the editor engine's TWO real sources:
 *   • premium features → packages/entitlements/src/feature-registry.js (FEATURES)
 *   • core + plugin    → packages/core/src/entitlements/feature-catalog.js
 *                        (EDITOR_FEATURES + PLUGIN_FEATURES)
 * Vendoring is a copy; a copy can drift. This turns silent drift into a loud CI
 * failure: an engine feature not vendored → the admin can't sell it; a stale
 * vendored id → tokens for a feature the engine no longer honors. (#9 / C1)
 *
 * SKIPS gracefully when the sibling engine repo isn't present (the backend is
 * standalone; a CI checkout without the engine must not hard-fail this file).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { FEATURE_CATALOG } from '../src/licensing/feature-catalog';

// The REAL sources of truth live in the sibling monorepo. The backend is a
// STANDALONE project — in a CI checkout without the engine beside it, this test
// must SKIP gracefully, not hard-fail the build (the codegen is author-time).
// So load the engine via existence-guarded dynamic import instead of a static
// top-level import (which would be an unrecoverable module-resolution error).
const ENGINE_DIR = process.env.ENGINE_DIR || resolve(__dirname, '../../open-editor');
const REG_PATH = resolve(ENGINE_DIR, 'packages/entitlements/src/feature-registry.js');
const CORE_PATH = resolve(ENGINE_DIR, 'packages/core/src/entitlements/feature-catalog.js');
const GEN_PATH = resolve(__dirname, '../scripts/sync-feature-catalog.mjs');
const engineAvailable = existsSync(REG_PATH) && existsSync(CORE_PATH);

// Loaded below only when the engine is present (keeps types simple).
let FEATURES: Record<string, { title: string; deprecated?: boolean }> = {};
let EDITOR_FEATURES: Array<{ id: string; title: string; group: string }> = [];
let PLUGIN_FEATURES: Array<{ id: string; title: string; group: string }> = [];
let PREMIUM_GROUPS: Record<string, string> = {};

if (engineAvailable) {
  // `/* @vite-ignore */` + a non-literal specifier stops Vite from statically
  // resolving/bundling these at transform time — they're real runtime paths
  // outside the project that may be absent in a standalone CI checkout (handled
  // by the existsSync guard above). vitest's runtime loader resolves them. A
  // file:// URL is required because the paths contain a space.
  const load = (p: string) => import(/* @vite-ignore */ p + '');
  const reg = await load(REG_PATH);
  const core = await load(CORE_PATH);
  // PREMIUM_GROUPS is the SOLE source of truth for premium grouping (the engine
  // registry has no `group` field), so import it from the generator to verify
  // the vendored file wasn't hand-edited away from it. (Audit M1.)
  const gen = await load(GEN_PATH);
  FEATURES = reg.FEATURES as typeof FEATURES;
  EDITOR_FEATURES = core.EDITOR_FEATURES as typeof EDITOR_FEATURES;
  PLUGIN_FEATURES = core.PLUGIN_FEATURES as typeof PLUGIN_FEATURES;
  PREMIUM_GROUPS = gen.PREMIUM_GROUPS as typeof PREMIUM_GROUPS;
}

// Union of every id the engine defines across BOTH catalogs.
const premiumIds = Object.keys(FEATURES);
const coreIds = [
  ...EDITOR_FEATURES.map((f) => f.id),
  ...PLUGIN_FEATURES.map((f) => f.id),
];
const engineIds = [...new Set([...premiumIds, ...coreIds])].sort();

const vendoredById = new Map(FEATURE_CATALOG.map((f) => [f.id, f]));
const vendoredIds = FEATURE_CATALOG.map((f) => f.id).sort();

describe.skipIf(!engineAvailable)('feature catalog ↔ engine (no drift, unified)', () => {
  it('every ENGINE feature id (core + plugin + premium) is in the vendored catalog', () => {
    const missing = engineIds.filter((id) => !vendoredById.has(id));
    expect(missing, `engine features missing from vendored catalog: ${missing.join(', ')}`).toEqual([]);
  });

  it('the vendored catalog has NO stale ids the engine no longer defines', () => {
    const engineSet = new Set(engineIds);
    const stale = vendoredIds.filter((id) => !engineSet.has(id));
    expect(stale, `stale vendored ids not in any engine catalog: ${stale.join(', ')}`).toEqual([]);
  });

  it('PREMIUM titles match the engine registry verbatim', () => {
    const mismatches: string[] = [];
    for (const id of premiumIds) {
      const engineTitle = (FEATURES as Record<string, { title: string }>)[id].title;
      const v = vendoredById.get(id);
      if (v && v.title !== engineTitle) mismatches.push(`${id}: "${v.title}" ≠ "${engineTitle}"`);
    }
    expect(mismatches, mismatches.join(' | ')).toEqual([]);
  });

  it('CORE/PLUGIN titles match the engine core catalog verbatim', () => {
    const coreTitleById = new Map<string, string>();
    for (const f of [...(EDITOR_FEATURES as Array<{ id: string; title: string }>),
                     ...(PLUGIN_FEATURES as Array<{ id: string; title: string }>)]) {
      coreTitleById.set(f.id, f.title);
    }
    const mismatches: string[] = [];
    for (const [id, title] of coreTitleById) {
      const v = vendoredById.get(id);
      if (v && v.title !== title) mismatches.push(`${id}: "${v.title}" ≠ "${title}"`);
    }
    expect(mismatches, mismatches.join(' | ')).toEqual([]);
  });

  it('deprecated premium flags match the engine registry', () => {
    const mismatches: string[] = [];
    for (const id of premiumIds) {
      const engineDep = !!(FEATURES as Record<string, { deprecated?: boolean }>)[id].deprecated;
      const v = vendoredById.get(id);
      if (v && !!v.deprecated !== engineDep) mismatches.push(`${id}: vendored=${!!v.deprecated}, engine=${engineDep}`);
    }
    expect(mismatches, mismatches.join(' | ')).toEqual([]);
  });

  it('deprecated features are never marked sellable', () => {
    const bad = FEATURE_CATALOG.filter((f) => f.deprecated && f.sellable).map((f) => f.id);
    expect(bad, `deprecated but sellable: ${bad.join(', ')}`).toEqual([]);
  });

  it('every feature has a non-empty group and a valid kind', () => {
    const KINDS = new Set(['core', 'plugin', 'premium']);
    const badGroup = FEATURE_CATALOG.filter((f) => !f.group || !f.group.trim()).map((f) => f.id);
    const badKind = FEATURE_CATALOG.filter((f) => !KINDS.has(f.kind)).map((f) => `${f.id}(${f.kind})`);
    expect(badGroup, `features with no group: ${badGroup.join(', ')}`).toEqual([]);
    expect(badKind, `features with invalid kind: ${badKind.join(', ')}`).toEqual([]);
  });

  it('CORE/PLUGIN groups match the engine core catalog verbatim', () => {
    const coreGroupById = new Map<string, string>();
    for (const f of [...EDITOR_FEATURES, ...PLUGIN_FEATURES]) coreGroupById.set(f.id, f.group);
    const mismatches: string[] = [];
    for (const [id, group] of coreGroupById) {
      const v = vendoredById.get(id);
      if (v && v.group !== group) mismatches.push(`${id}: "${v.group}" ≠ "${group}"`);
    }
    expect(mismatches, mismatches.join(' | ')).toEqual([]);
  });

  it('PREMIUM groups match the generator PREMIUM_GROUPS map (its only source of truth)', () => {
    // The premium registry has no `group` field; PREMIUM_GROUPS defines it.
    // This catches a hand-edit of the generated file's premium group. (Audit M1.)
    const mismatches: string[] = [];
    for (const id of premiumIds) {
      const expected = PREMIUM_GROUPS[id];
      const v = vendoredById.get(id);
      if (v && v.group !== expected) mismatches.push(`${id}: vendored="${v.group}" ≠ map="${expected}"`);
    }
    expect(mismatches, mismatches.join(' | ')).toEqual([]);
  });

  it('every premium id has a PREMIUM_GROUPS entry (no silent fallback)', () => {
    const ungrouped = premiumIds.filter((id) => !PREMIUM_GROUPS[id]);
    expect(ungrouped, `premium ids missing a PREMIUM_GROUPS entry: ${ungrouped.join(', ')}`).toEqual([]);
  });
});

/**
 * Sell-vaporware guard (runs WITHOUT the engine too — depends only on the
 * vendored catalog). A premium feature must never be sellable unless a premium
 * plugin actually IMPLEMENTS it: otherwise an admin can compose it into a
 * package, a customer can PAY, a valid token mints, and the editor unlocks
 * NOTHING. This pins the set of premium ids that a real gated plugin exists for
 * (premium/{ai,export-docx,export-pdf,seo}/src/index.js). When a new premium
 * plugin ships, add its id here AND remove it from NOT_YET_IMPLEMENTED in
 * scripts/sync-feature-catalog.mjs, then re-run `npm run sync:features`.
 */
// Premium plugins that both EXIST in the editor AND are sold.
const IMPLEMENTED_PREMIUM = new Set([
  'export.docx', // premium/export-docx
  'export.pdf',  // premium/export-pdf
]);

// Premium plugins whose CODE exists but which are DELIBERATELY not sold (product
// decision: no AI, no SEO). They must be deprecated + non-sellable in the catalog.
// Kept implemented so the code isn't ripped out (re-enable = flip the catalog
// flags + move the id into IMPLEMENTED_PREMIUM). This is the inverse of vaporware:
// real code, intentionally unsold — allowed, not a drift.
const IMPLEMENTED_BUT_NOT_SOLD = new Set([
  'ai.quickActions', 'ai.panel', 'ai.translate', 'ai.review', // premium/ai (no-AI launch)
  'seo',                                                       // premium/seo (no-SEO launch)
]);

describe('sell-vaporware guard (premium sellable ⟺ implemented)', () => {
  it('every SELLABLE premium feature is actually implemented by a plugin', () => {
    const sellableUnimplemented = FEATURE_CATALOG
      .filter((f) => f.kind === 'premium' && f.sellable && !IMPLEMENTED_PREMIUM.has(f.id))
      .map((f) => f.id);
    expect(
      sellableUnimplemented,
      `sellable premium features with NO editor plugin (customers would pay and get nothing): ${sellableUnimplemented.join(', ')}`,
    ).toEqual([]);
  });

  it('every SOLD premium feature is present in the catalog and sellable', () => {
    // The inverse: a shipped+sold plugin whose id is missing/non-sellable means a
    // real product can't be sold — also a drift, just in the other direction.
    const notSellable = [...IMPLEMENTED_PREMIUM].filter((id) => {
      const f = vendoredById.get(id);
      return !f || !f.sellable;
    });
    expect(
      notSellable,
      `sold premium features that are missing or not sellable in the catalog: ${notSellable.join(', ')}`,
    ).toEqual([]);
  });

  it('every IMPLEMENTED-BUT-NOT-SOLD premium feature is present, deprecated + non-sellable', () => {
    // AI: the code exists but we deliberately do NOT sell it. Guard the decision so
    // a future edit can't silently re-enable AI for sale without updating this test.
    const wrong = [...IMPLEMENTED_BUT_NOT_SOLD].filter((id) => {
      const f = vendoredById.get(id);
      return !f || f.sellable || !f.deprecated;
    });
    expect(
      wrong,
      `features that must be deprecated + non-sellable (no-AI decision) but aren't: ${wrong.join(', ')}`,
    ).toEqual([]);
  });
});
