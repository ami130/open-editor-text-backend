/**
 * sync-feature-catalog.mjs — regenerate the vendored backend feature catalog
 * FROM the editor engine's two source-of-truth catalogs, so the admin-facing
 * list can never silently drift from what the engine actually gates.
 *
 * WHY codegen (not a runtime import): the backend is a STANDALONE project with
 * no engine repo beside it in production, so the generated file is COMMITTED and
 * shipped. This runs at author-time (dev) against the sibling monorepo:
 *
 *   npm run sync:features            # regenerate + write the catalog
 *   npm run sync:features:check      # CI: FAIL if the committed file is stale
 *   ENGINE_DIR=/path/to/open-editor npm run sync:features   # custom engine path
 *
 * Plain .mjs (no ts-node/build) so it runs with bare `node`. Derivation rules
 * reproduce the current hand-written catalog exactly:
 *   • ids/titles/deprecated → verbatim from the engine (both catalogs).
 *   • kind: 'premium' (registry) | 'plugin' (core entry has a `plugin` field) |
 *     'core' (rest of the core catalog).
 *   • sellable: false if deprecated OR NEVER_SELL (literal or prefix); else true.
 *   • group: core catalog's `group`; premium ids MUST be in PREMIUM_GROUPS.
 *
 * The generator FAILS LOUD (throws) on: an id defined in both engine sources
 * (collision), or a premium id with no PREMIUM_GROUPS entry — so neither can
 * silently produce wrong catalog data.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = process.env.ENGINE_DIR || resolve(HERE, '../../open-editor');
const OUT = resolve(HERE, '../src/licensing/feature-catalog.ts');
const CHECK = process.argv.includes('--check');

/**
 * Ids that must NEVER be sellable regardless of source. Both explicit literals
 * and prefix patterns — so a future internal flag (e.g. `dev.foo`) can't slip
 * through sellable just because someone forgot to list it. Add a literal for a
 * one-off; add a prefix for a whole namespace of internal/test features.
 */
const NEVER_SELL_LITERAL = new Set(['dev.smoke']);
const NEVER_SELL_PREFIXES = ['dev.'];

/**
 * Registered premium ids that are DECLARED (so licenses granting them stay
 * valid — the registry is additive-only) but have NO editor plugin implementing
 * them yet. They must NOT be sellable: an admin could otherwise compose them
 * into a package, a customer could PAY, a valid token would mint, and the editor
 * would unlock nothing (sell-vaporware). Each stays here until its plugin ships,
 * then delete the line to make it sellable. The catalog-drift test cross-checks
 * this against the real premium plugin manifests so the two can't disagree.
 * (Audit: sell-vaporware gap.)
 */
const NOT_YET_IMPLEMENTED = new Set([
  'export.markdown', 'import.word',
  'versionHistory', 'comments', 'track.changes', 'collab.rt',
  'restrictedEditing.roles', 'lists.legal', 'outline.toc', 'mergeFields', 'pagination',
]);

export const isNeverSell = (id) =>
  NEVER_SELL_LITERAL.has(id) || NOT_YET_IMPLEMENTED.has(id)
  || NEVER_SELL_PREFIXES.some((p) => id.startsWith(p));

/**
 * Curated groups for premium ids (the premium registry has no `group` field, so
 * the admin-tree grouping is defined HERE and nowhere else). Every premium id
 * MUST have an entry — the generator throws on a missing one rather than
 * silently bucketing it under a fallback, so an un-grouped new feature is a loud
 * failure, not a quiet mis-categorization. (Audit M1.)
 */
export const PREMIUM_GROUPS = {
  'export.pdf': 'Export & Import', 'export.docx': 'Export & Import',
  'export.markdown': 'Export & Import', 'import.word': 'Export & Import',
  'seo': 'Premium', 'footnotes': 'Premium', 'restrictedEditing.roles': 'Premium',
  'lists.legal': 'Premium', 'outline.toc': 'Premium', 'mergeFields': 'Premium',
  'pagination': 'Premium', 'dev.smoke': 'Premium',
  'versionHistory': 'Collaboration', 'comments': 'Collaboration',
  'track.changes': 'Collaboration', 'collab.rt': 'Collaboration',
  'ai.panel': 'AI', 'ai.quickActions': 'AI', 'ai.review': 'AI', 'ai.translate': 'AI',
};

async function loadEngine() {
  const regUrl = pathToFileURL(resolve(ENGINE_DIR, 'packages/entitlements/src/feature-registry.js')).href;
  const coreUrl = pathToFileURL(resolve(ENGINE_DIR, 'packages/core/src/entitlements/feature-catalog.js')).href;
  const registry = await import(regUrl);
  const core = await import(coreUrl);
  const rows = [];
  const seen = new Set();
  for (const f of [...core.EDITOR_FEATURES, ...core.PLUGIN_FEATURES]) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const kind = f.plugin ? 'plugin' : 'core';
    // Read `deprecated` from the engine (don't assume false) so a retired core /
    // plugin feature is never left sellable. (Audit L1.)
    const deprecated = !!f.deprecated;
    rows.push({ id: f.id, title: f.title, group: f.group, kind, deprecated, sellable: !deprecated && !isNeverSell(f.id) });
  }
  for (const [id, meta] of Object.entries(registry.FEATURES)) {
    // A premium id that also exists in the core catalog would be silently
    // skipped here and mis-typed as core (losing kind/deprecated). That must
    // never happen unnoticed — fail loud. (Audit C1.)
    if (seen.has(id)) {
      throw new Error(`Feature id "${id}" is defined in BOTH the core catalog and the premium registry — ` +
        `ids must be unique across engine sources. Resolve the collision in the engine before syncing.`);
    }
    const group = PREMIUM_GROUPS[id];
    if (!group) {
      throw new Error(`Premium feature "${id}" has no PREMIUM_GROUPS entry — add one in ` +
        `scripts/sync-feature-catalog.mjs so it's grouped correctly in the admin tree.`);
    }
    seen.add(id);
    const deprecated = !!meta.deprecated;
    rows.push({ id, title: meta.title, group, kind: 'premium', deprecated, sellable: !deprecated && !isNeverSell(id) });
  }
  return rows;
}

// Escape for a single-quoted TS string literal: backslash and quote (so the
// literal can't be broken out of) plus the control/line chars that are illegal
// unescaped in a JS/TS string (newline, CR, tab, U+2028, U+2029). (Audit M5.)
const esc = (s) => String(s)
  .replace(/\\/g, '\\\\')
  .replace(/'/g, "\\'")
  .replace(/\n/g, '\\n')
  .replace(/\r/g, '\\r')
  .replace(/\t/g, '\\t')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

function render(rows) {
  const line = (r) => {
    const parts = [`id: '${esc(r.id)}'`, `title: '${esc(r.title)}'`, `group: '${esc(r.group)}'`, `kind: '${r.kind}'`];
    if (r.deprecated) parts.push('deprecated: true');
    parts.push(`sellable: ${r.sellable}`);
    return `  { ${parts.join(', ')} },`;
  };
  return `/**
 * feature-catalog.ts — GENERATED by scripts/sync-feature-catalog.mjs. DO NOT
 * EDIT BY HAND. Re-run \`npm run sync:features\` when the engine catalogs change.
 *
 * The UNIFIED list of every editor feature an admin can compose into a package,
 * derived from the engine's two sources (core/plugin catalog + premium
 * registry). ONE license grants a set of these ids; the editor gates BOTH its
 * core features and its premium plugins from that same set. \`sellable=false\` =
 * never offered (internal/test or deprecated).
 */

export type FeatureKind = 'core' | 'plugin' | 'premium';

export interface CatalogFeature {
  id: string;
  title: string;
  group: string;
  kind: FeatureKind;
  deprecated?: boolean;
  sellable: boolean;
}

export const FEATURE_CATALOG: CatalogFeature[] = [
${rows.map(line).join('\n')}
];

const BY_ID = new Map(FEATURE_CATALOG.map((f) => [f.id, f]));

/** Is this a known engine feature id? */
export function isKnownFeature(id: string): boolean {
  return BY_ID.has(id);
}

/** Is this feature allowed to be composed into a sellable package? */
export function isSellableFeature(id: string): boolean {
  const f = BY_ID.get(id);
  return !!f && f.sellable && !f.deprecated;
}
`;
}

// Run the generator ONLY when invoked as a script (`node sync-feature-catalog.mjs`),
// not when imported for its exported maps (e.g. by catalog-drift.test.ts) — an
// import must never write or exit the process.
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  const rows = await loadEngine();
  const out = render(rows);
  if (CHECK) {
    const current = readFileSync(OUT, 'utf8');
    if (current !== out) {
      console.error('feature-catalog.ts is STALE — run `npm run sync:features` and commit.');
      process.exit(1);
    }
    console.log(`feature-catalog.ts is in sync (${rows.length} features).`);
  } else {
    writeFileSync(OUT, out);
    console.log(`Wrote feature-catalog.ts (${rows.length} features).`);
  }
}
