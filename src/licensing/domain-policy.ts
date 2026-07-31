/**
 * domain-policy.ts — the SINGLE source of truth for domain normalization,
 * acceptability, and host matching (Phase 5). Before this, three copies of
 * `normalizeDomains` had drifted (license.service, order.service, admin.controller)
 * and the server refresh matcher disagreed with the editor's verifier on the
 * wildcard-apex rule. This module unifies all of it, and mirrors the editor's
 * `packages/entitlements/src/domain-check.js` matcher EXACTLY so a host that
 * refreshes online also verifies offline (and vice-versa).
 *
 * The `throw` for over-broad bindings is injected by the caller (this module stays
 * framework-free); callers pass a small `reject` fn so we don't import Nest here.
 */

/** Curated shared-hosting suffixes that must NOT be licensed as a whole (would
 *  grant every tenant). Not a full PSL — the real-exposure set. */
export const PUBLIC_SUFFIXES = new Set([
  'vercel.app', 'netlify.app', 'herokuapp.com', 'github.io', 'gitlab.io',
  'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'azurewebsites.net',
  'onrender.com', 'railway.app', 'fly.dev', 'surge.sh', 'now.sh', 'glitch.me',
  'repl.co', 'appspot.com', 'cloudfront.net', 'amplifyapp.com', 'wixsite.com',
  'blogspot.com', 'wordpress.com', 'shopify.com', 'myshopify.com',
  // Multi-label ccTLD REGISTRY suffixes (audit A1): a 2-label base like `co.uk`
  // passes the "≥2 labels" structural check but is a whole-registry suffix —
  // licensing it would grant every site under it. Curated common set (not a full
  // PSL); an unlisted exotic registry suffix would still slip, but the high-volume
  // ones are covered. A `*.co.uk` also normalizes to this base and is caught.
  'co.uk', 'org.uk', 'me.uk', 'gov.uk', 'ac.uk', 'co.jp', 'or.jp', 'ne.jp',
  'com.au', 'net.au', 'org.au', 'co.nz', 'com.br', 'com.cn', 'com.mx',
  'co.in', 'co.za', 'com.sg', 'co.kr', 'com.tr', 'com.tw', 'co.il',
]);

/** Lowercase, strip a trailing FQDN dot + stray port. Pure per-domain cleanup. */
export function normalizeOneDomain(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '') // trailing dot (FQDN)
    .replace(/:\d+$/, ''); // stray port
}

/**
 * Normalize + de-dup a domain list AND apex↔www auto-pair (Phase 5 §7-A): binding
 * `example.com` also allows `www.example.com` and vice-versa, so a customer never
 * hits the "works on apex but not www" footgun. Auto-pairing is done HERE (at
 * normalize/issue time) so the stored `domains[]` is explicit and the matcher stays
 * simple. Wildcards (`*.x`) are NOT paired (they already span subdomains, and the
 * reconciled matcher makes `*.x` cover the apex too).
 */
export function normalizeDomains(domains: string[] = []): string[] {
  const out = new Set<string>();
  for (const raw of domains) {
    const d = normalizeOneDomain(raw);
    if (!d) continue;
    out.add(d);
    // apex↔www auto-pair (skip wildcards + anything that isn't a plain host).
    if (!d.startsWith('*.') && !d.includes('*')) {
      if (d.startsWith('www.')) {
        out.add(d.slice(4)); // www.example.com → example.com
      } else if (d.split('.').length === 2) {
        // a bare apex `example.com` → add `www.example.com`. Only for a 2-label
        // apex; we don't guess www for `app.example.com` (that's an intentional host).
        out.add(`www.${d}`);
      }
    }
  }
  return [...out];
}

/**
 * Reject over-broad / abusable bindings at ISSUE time (M3). `reject(msg)` throws
 * the framework error (kept out of this module). Blocks a bare public suffix /
 * `*.<public-suffix>` and a single-label base (`*.com`).
 */
export function assertDomainsAcceptable(domains: string[], reject: (msg: string) => never): void {
  for (const d of domains) {
    const base = d.startsWith('*.') ? d.slice(2) : d;
    if (base.split('.').length < 2) {
      reject(`domain "${d}" is too broad to license`);
    }
    if (PUBLIC_SUFFIXES.has(base)) {
      reject(`"${d}" is a shared public-hosting domain and cannot be licensed as a whole; bind your specific host instead`);
    }
  }
}

/**
 * Match one host against one pattern — the SERVER twin of the editor's
 * `hostMatchesPattern` (kept byte-for-byte equivalent in behavior):
 *   `customer.com`   → exact only
 *   `*.customer.com` → any single sub-label AND the apex `customer.com`
 * Case-insensitive; malformed → false (fail closed). `host` should be a bare host.
 */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  if (typeof host !== 'string' || typeof pattern !== 'string') return false;
  const h = host.toLowerCase();
  const pat = pattern.toLowerCase();
  if (!pat.startsWith('*.')) return h === pat;
  const base = pat.slice(2);
  if (base === '' || base.includes('*')) return false;
  if (h === base) return true; // apex covered by its own wildcard (reconciled)
  if (!h.endsWith(`.${base}`)) return false;
  const label = h.slice(0, h.length - base.length - 1);
  return label.length > 0 && !label.includes('.');
}

/** True if `host` matches ANY of the license's domain patterns. */
export function hostAllowed(host: string, domains: string[]): boolean {
  if (!Array.isArray(domains)) return false;   // malformed → fail closed
  if (domains.length === 0) return true;       // non-domain-bound → any host (parity w/ editor, F2)
  return domains.some((d) => hostMatchesPattern(host, d));
}
