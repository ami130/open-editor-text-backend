# Open Editor Backend — Master Plan & Roadmap

This document explains **why this backend exists**, **what it does**, and the
**step-by-step plan** to complete it — from the AI proxy (done) to a full
licensing + billing + admin system. It is the single source of truth for the
backend's direction. Read top-to-bottom.

---

## 1. Why is a backend needed at all?

The Open Editor is a **frontend npm package**. On its own it cannot safely do
two things — and both require a server that the browser cannot inspect:

### Reason 1 — AI features need a secret API key (security)
The AI features (Translate, Quick Actions, Chat, Review) call an LLM
(Groq/OpenAI/…). That call needs an **API key**. If the browser holds the key,
**anyone can read it** (DevTools → Network, or the JS bundle) and drain your
quota or run up bills. There is no secure way to keep a key in frontend code —
it is a hard impossibility, not a limitation of effort.

> The only secure design: `Browser → YOUR backend (holds the key) → LLM`.
> The key lives in the server env and never reaches the browser.

### Reason 2 — Selling premium features needs licensing + billing (business)
The editor's premium features (SEO, PDF/DOCX export, AI, …) are **gated on
ES256-signed license tokens** — this already works in the editor. But something
must **create, sign, sell, and manage** those licenses:

- An **admin** creates packages (bundles of features) and sets prices.
- A **customer** buys a package.
- The system **mints a signed license** granting exactly those features, bound
  to the customer's domain(s), with an expiry.
- The editor **verifies** it offline (already implemented).

That "create/sell/manage licenses" engine is a backend with a database, auth,
an admin panel, and a payment integration. It cannot live in the browser (the
signing **private key** must stay secret, and billing needs a trusted server).

### What already exists (so we don't rebuild it)
The `@openeditors/entitlements` package in the editor repo already provides the
hard cryptographic parts, tested:
- **Feature registry** — every sellable feature id + title.
- **License issuer** (`generateDevKeyPair`, ES256 signing, feature validation,
  domain binding, expiry) — exposed at `@openeditors/entitlements/issuer`.
- **Offline verifier** — the editor already checks signatures against a public
  key.

**So the backend's licensing job is to wrap this existing issuer with a
database, an admin UI, and payments — not to invent crypto.**

---

## 1b. Product vision & flow (the commercial model — like CKEditor / Jodit)

The goal: sell the editor's features as **dynamic packages**, exactly like
CKEditor/Jodit sell commercial licenses.

### The end-to-end flow
1. **Admin logs into the admin panel** (in `open-editor-web`, at `/admin`).
2. Admin sees **every feature the engine offers, listed one by one** (pulled
   live from the engine's feature registry — never hand-typed, so it can't
   drift from what the engine actually has).
3. Admin **builds a package** (e.g. *Free*, *Pro*, *Premium* — but any name and
   any combination) by **hand-picking individual features**, and sets a
   **price**. Packages are fully **dynamic** — composed at runtime, not
   hardcoded tiers.
4. A **customer buys a package** → the backend **mints a signed license key**
   granting **exactly and only** that package's features, **bound to the
   customer's domain(s)**, perpetual by default with an **optional expiry**.
5. The customer drops the key into their editor → the engine **verifies it
   offline** and unlocks **precisely those features** — nothing more.

### Two SEPARATE permission systems (never conflate them)
| System | Question it answers | Who it applies to |
|--------|---------------------|-------------------|
| **Editor features** (`seo`, `ai.translate`, …) | "What does this customer's LICENSE unlock in the editor?" | end customers, via their license |
| **Admin roles & permissions** (`package.create`, `license.issue`, …) | "What is this admin-panel USER allowed to DO in the backend?" | staff, via RBAC |

They share nothing. RBAC guards the admin API; licenses gate the editor.

### Roles, permissions & seeding
- **Roles** (e.g. `admin`, `manager`, `support`) are **dynamic** — an admin can
  create roles and assign **granular permissions**.
- The backend ships a **seed file**: a default `admin` role with all
  permissions + a first admin user, and the feature catalog synced from the
  engine registry — so a fresh install is immediately usable.

### Decisions locked for this build
- **License lifetime:** perpetual by default, **optional per-license expiry**
  (supports one-time sales now, subscriptions later — no rework).
- **Domain binding:** **yes** — a license works only on its registered
  domain(s) (engine already supports it; stops leaked-key reuse).
- **Purchase:** **admin-issues licenses now**; real payment (Stripe) is a clean
  add-on in Phase F, not blocking the core engine.

### The three projects
| Project | Role | Language |
|---------|------|----------|
| `open-editor` | pure-JS editor **engine** (all features) — untouched | JS |
| `open-editor-backend` | **NestJS API only, no UI**: auth, RBAC, packages, features, licensing (mint/verify), AI proxy. The secure fortress. | TS |
| `open-editor-web` | **frontend**: login → role routing (**user → `/profile`**, **admin → `/admin`**); the admin panel UI. Calls the backend API. | (web) |

> Security note: role routing in the web app is convenience only — **every**
> admin capability is enforced by a **guard on the backend API**, so hitting
> `/admin` directly without a valid admin token is rejected server-side.

---

## 2. Architecture (the whole system)

```
┌──────────────────────────┐         ┌──────────────────────────────────────┐
│  Browser                 │         │  open-editor-backend (this project)    │
│  ┌────────────────────┐  │  POST   │  ┌────────────────────────────────┐   │
│  │ Open Editor        │──┼────────►│  │ AI proxy  /api/ai              │──┼──► Groq / OpenAI
│  │  aiEndpoint        │◄─┼─stream──│  │  (holds the LLM key)           │   │
│  │  license token     │  │         │  └────────────────────────────────┘   │
│  └────────────────────┘  │         │  ┌────────────────────────────────┐   │
│         ▲ verifies        │  buy    │  │ Licensing / Admin              │   │
│         │ offline (ES256) │◄────────┼──│  packages · prices · customers │   │
└─────────┼────────────────┘  license │  │  mints ES256 licenses (issuer) │◄─┼── MySQL
          │                            │  │  admin panel + payments        │   │
          └────────────────────────────┼──┘                                   │
        signed license token           └──────────────────────────────────────┘
```

- **Editor** stays a pure frontend package. Its only links to the backend are
  runtime config: `aiEndpoint` (a URL) and a `license` token string.
- **This backend** is standalone (own repo folder, own npm install). Stack:
  **NestJS + MySQL + TypeORM**.

---

## 3. Phased plan

Each phase is independently useful and independently verifiable. We finish and
test one before starting the next.

### ✅ Phase A — Secure AI proxy (DONE)
- `POST /api/ai` streams `{prompt, system}` → LLM, key server-side only.
- Input validation, CORS allowlist, disconnect-abort, sanitized errors, clean
  503 when unconfigured.
- 16 tests pass (unit + HTTP e2e); a test asserts the key never appears in the
  browser-facing response.
- **Remaining action for you:** run it once with a real Groq key to confirm a
  real translation (see README "Run it").

### ✅ Phase B — Backend foundation (DONE)
Turned the single-purpose proxy into a real application skeleton.
- **B1. ✅** MySQL/TypeORM wired via `DatabaseModule.forRoot()`, env-driven
  (`database.config.ts`). **Optional by design**: `DB_ENABLED=false` → app boots
  and the AI proxy works with no database (the two concerns are decoupled).
- **B2. ✅** Standalone `data-source.ts` for the TypeORM CLI + `migration:*`
  npm scripts (schema versioned via migrations; `synchronize` is dev-only and
  force-disabled in production).
- **B3. ✅** `GET /health` reports structured per-subsystem status (database:
  up/down/disabled, ai: configured/not) with an overall ok/degraded roll-up;
  global `ValidationPipe` (whitelist + transform) for the coming admin DTOs.
- **B4. ✅** All config from env (`ai.config.ts`, `database.config.ts`); the
  signing-key config joins in Phase C.
- *Verified:* build clean; **20 tests pass**; app boots + serves `/health` and
  the AI proxy with **no DB**; a health e2e locks in the "AI works without a DB"
  guarantee.

### ✅ Phase C — Licensing core (DONE — no UI yet)
Built and **proven end-to-end against the editor's real verifier**:
- **Own production ES256 signer** (`license-signer.service.ts`) — same token
  format as the editor expects; private key env-only, `kid` rotation; TTL
  clamped under the verifier's ~3y ceiling ("perpetual" = re-mint on renewal).
- **Entities** (TypeORM): `Feature`, `Package` (hand-picked features + price +
  domainBound + ttl), `Customer` (domains), `License` (record + issued token +
  status + snapshot of granted features/domains).
- **Feature catalog** vendored from the engine registry + synced to the DB on
  boot; only *sellable* (non-deprecated, non-internal) features are offered.
- **LicenseService**: `issue` / `renew` (re-mint) / `revoke` / `list`, guarding
  unknown/non-sellable features and domain-bound requirements.
- **JWKS** at `/.well-known/jwks.json` (public key for editors) + a
  `key:generate` CLI to mint the signing keypair.
- **DB optional**: the signer + JWKS work with no DB; issue/renew/revoke need
  one. Tested with pure-JS `sqljs` (no native build / no MySQL required).
- *Verified:* **49 backend tests pass**. The flow test does: sync catalog →
  compose package → create customer → issue → **editor verifies exact features**
  → domain-bind → renew → revoke → non-sellable guard.

**Post-audit hardening (all fixed + tested):**
- lic-id → `crypto.randomUUID` (was 32-bit random; collision-safe).
- **Real key rotation**: JWKS serves current + `LICENSE_RETIRED_KEYS`, so
  licenses signed by an old key keep verifying after rotation (tested).
- Default token TTL **30 days** (was 1yr) so revocation actually bites; renewal
  re-mints. Revocation latency = TTL window (documented).
- `renew()` **re-validates** sellability + rejects a deactivated package (no
  silent re-grant of withdrawn features).
- `effectiveStatus()` derives `expired` on read (the column never stores it).
- No eager loads on `license.package`; `list()` uses explicit relations.
- `sellable` **persisted** on Feature; catalog sync is **atomic + reaps**
  removed ids.
- License **snapshots plan name/price/currency** → survives package delete.
- `customer.domains` TEXT column has no literal default (MySQL-safe).
- **Catalog-drift test** imports the real engine registry and fails CI on any
  id/title/deprecated mismatch — the vendoring guard.
- 400-iteration signature loop proves the DER→P1363 conversion (no flaky sigs).

**Carried forward (correct home is a later phase):**
- **M1 — package economics validation** (price ≥ 0, ISO currency, enum billing
  interval, ttl bounds): enforced by the admin **DTO + ValidationPipe in
  Phase D**, where packages are actually created over HTTP.
- **Real-MySQL test run** + `list()` pagination: **Phase G** (deploy/hardening).

<details><summary>original Phase C plan (for reference)</summary>
The engine that mints and manages licenses, built on the existing issuer.
- **C1.** Entities: `Feature` (synced from the registry), `Package` (name,
  features[], price, interval), `Customer`, `License` (token, features,
  domains, expiry, status, package/customer refs).
- **C2.** Signing-key management: generate/store the ES256 **private key**
  securely (env/secret store, never in DB plaintext or git); expose the public
  key/JWKS for editors to verify against.
- **C3.** License service: `mint(package, customer, domains, expiry)` → wraps
  `@openeditors/entitlements/issuer`; `revoke`, `renew`, `list`.
- **C4.** Public verification endpoint / JWKS so integrators can fetch the
  public key.
- *Verify:* mint a license via a service test → the editor's verifier accepts
  it and grants exactly the package's features; revoked/expired are rejected.
</details>

### ✅ Phase D — Admin API + auth (DONE)
Secure, standard auth + RBAC + the guarded admin REST API.
- **Auth model** — short-lived **access JWT** (Bearer, 15m) + **rotating
  refresh token in an httpOnly/Secure/SameSite cookie** (XSS-safe). bcrypt
  password hashing; `tokenVersion` for logout-everywhere; prod refuses dev
  secrets. Endpoints: `POST /auth/login|refresh|logout`, `GET /auth/me`.
- **RBAC** — `User` → `Role[]` → `Permission[]` entities; a granular permission
  catalog (`package.create`, `license.issue`, …) + wildcard `*`. Two GLOBAL
  guards (secure-by-default): `JwtAuthGuard` (auth, `@Public()` opts out) then
  `PermissionsGuard` (`@RequirePermissions(...)`). Server-side is the real gate.
- **Seed** — idempotent boot seed: permission catalog, a built-in `admin` role
  (wildcard), and a first admin user from `SEED_ADMIN_*` (skips weak defaults in
  prod).
- **Admin REST API** (all guarded): `GET /admin/features[/sellable]`; packages
  CRUD with **M1 economics validation** (price≥0, ISO currency, enum interval,
  TTL bounds, sellable-feature re-check server-side); customers CRUD; licenses
  `issue`/`renew`/`revoke`/`list` (effective status surfaced).
- **DB-gated** — auth/admin load only when `DB_ENABLED=true`; the AI-only mode
  stays guard-free and dependency-light.
- **Test infra upgrade** — vitest now transforms via **SWC** (esbuild silently
  ignores `emitDecoratorMetadata`, breaking class-validator/DI in tests); added
  a `sqljs` DB driver (`DB_DRIVER`) so the full DB-on app is testable with no
  MySQL/native build.
**Post-audit hardening (all fixed + tested):**
- **C2** guards moved to a root `SecurityModule` (always loaded) + fail-closed:
  a protected route with no auth backend returns 503, never serves unguarded —
  guard coverage no longer tied to `DB_ENABLED`.
- **C1** access tokens are revocation-checked on EVERY request
  (`verifyActiveAccess`: tokenVersion + active), so logout / password-change /
  deactivation kill outstanding access tokens immediately (not just refresh).
- **I3** refresh **reuse detection** (jti stored per user; replaying a rotated
  token revokes the whole family) + **Origin allowlist** on `/auth/refresh`
  (CSRF defense independent of SameSite).
- **I2** license list no longer returns the signed token (only issue/renew do).
- **I5** constant-time login (dummy bcrypt on the miss path — no user
  enumeration by timing). **HS256 pinned** on sign+verify.
- **I4** seed never uses a weak default from an ambiguous `NODE_ENV`; a real
  `SEED_ADMIN_PASSWORD` is required unless `SEED_DEV_ADMIN=true`. Seed race
  tolerated.
- **I6** customer update/delete return **404** on unknown id.
- **I1** `LicensingModule` is `@Global`, imported once — no double init / double
  catalog-sync.
- **CORS** allows PATCH/DELETE + admin origins + credentials.
- **Config-drift killed**: the `ValidationPipe` (whitelist + forbidNonWhitelisted
  + transform) is an `APP_PIPE` provider, so prod and tests validate identically.
- *Verified:* **63 tests pass** (added C1/I2/I3/I6/forbidNonWhitelisted
  regression tests). `admin-flow.e2e` proves: login → 401 without token → **403
  without permission** → invalid-price **400** → non-sellable **400** →
  unexpected-field **400** → create package → customer → issue license →
  **editor verifies exact features** → refresh rotation → **reuse detection** →
  **logout kills the access token** → 404 on unknown customer.

### Phase E — Admin panel (UI) — in `open-editor-web` ✅ DONE
Decision: a **separate frontend** (`open-editor-web`, Next.js 16) using a
**BFF** pattern — the browser only ever calls Next's own same-origin `/api/*`
routes; the backend URL + tokens never reach the client.

- **E1.** ✅ Dashboard to manage packages/prices/customers/licenses
  (`AdminDashboard` with Packages / Customers / Licenses tabs).
- **E2.** ✅ "Create package" flow with the sellable feature registry as
  checkboxes; price/currency/interval; issue/revoke buttons; license viewer
  (effective status, features, domains; token shown once on issue).
- **E3.** ✅ Auth: httpOnly `oe_session` cookie holding a short-lived access
  token + rotating refresh cookie (reuse-detected); transparent
  refresh-and-retry on 401 in the server-side backend client.
- **E4.** ✅ Role routing: `proxy.ts` (Next 16 renamed middleware) optimistic
  redirect — user → `/profile`, admin → `/admin`; real authz gate is the DAL
  (`requireUser`/`requireAdmin`) on each server page + BFF route.
- **E5.** ✅ Role & permission management (requirement d) — full stack:
  - Backend `RbacService` + `admin/permissions` (catalog, wildcard excluded),
    `admin/roles` (CRUD, `role.read`/`role.manage`), `admin/users` (CRUD,
    `user.read`/`user.manage`). Security invariants enforced in the service:
    wildcard `*` is NEVER assignable via the API (no minting a super-admin);
    system roles are immutable/undeletable; a role in use can't be deleted;
    role/active/password changes bump `tokenVersion` (instant effect); the last
    active user-manager can't be deactivated/deleted (lockout guard);
    `passwordHash` never selected/returned.
  - BFF routes `/api/admin/{permissions,roles,roles/[id],users,users/[id]}`.
  - UI: `RolesPanel` (create/edit a role from grouped permission checkboxes,
    delete non-system roles) + `UsersPanel` (create/edit staff users, assign
    roles, toggle active, reset password). Tabs appear only when the session
    holds the matching `role.*`/`user.*` permission.
- **E6.** ✅ Security hardening pass:
  - Session cookie `SameSite=strict`; independent CSRF/Origin check (`csrf.ts`)
    on every mutating `/api/auth/*` + `/api/admin/*` handler.
  - `requireAdminApi()` fails fast at every BFF admin route (defense-in-depth;
    backend RBAC still the ultimate gate).
  - Refresh-token rotation reads `Headers.getSetCookie()` and refuses to reuse a
    stale token (was fragile `.get('set-cookie')` + old-token fallback).
  - Single shared admin-detection predicate (`lib/permissions.ts`) used by the
    DAL, proxy, and login page (was three divergent copies).
  - Scoped errors: a failed license revoke / role|user action no longer tears
    down the whole panel.
- *Verify:* ✅ backend `74 tests` green incl. `rbac-admin.e2e` (create role →
  create user → user acts within role; wildcard-assign blocked 400; unknown
  perm 400; system role immutable 400; role-change invalidates token 401; last
  admin protected 400; role-in-use 409). Earlier live e2e: login → httpOnly
  session → create package/customer → issue license → token verifies in the
  REAL `@openeditors/entitlements` verifier with the picked features + domain
  binding; wrong domain rejected. Web `npm run lint` + `npm run build` clean.

Deferred (not blocking): feature-catalog browser page, license renew/detail
view (backend `license.renew` exists; no UI yet), audit log.

### Phase F — Billing (self-serve, one-time) ✅ DONE (logic + local live test-mode pass; production webhook pass pending a deployed host)
Decisions: **public self-serve storefront**, **one-time payments only** (Stripe
`payment` mode; perpetual, renewed manually later), delivery via **success page
+ email** (dev-logged until a provider is wired), tested with **mocked Stripe +
a live checklist**.

Security spine: the **webhook is the only thing that mints** a paid license
(signature-verified); **price is server-authoritative** (from the DB package,
never the client); fulfillment is **idempotent** (a `processed_stripe_events`
ledger + an order↔license link → exactly one license per payment). Secret keys
are backend-only; hosted Checkout redirect means no client Stripe key at all.

- **F1.** ✅ `StripeService` (mockable via the `STRIPE_CLIENT` token; 503s when
  no key, like the AI proxy) + `BillingConfig`. `stripe` SDK added.
- **F2.** ✅ Data: `publiclyListed` flag on packages, `OrderEntity` (Stripe↔
  License bridge), `ProcessedStripeEventEntity` (idempotency ledger).
- **F3.** ✅ `OrderService` — `prepareOrder` (validates active+public+price+
  domain, snapshots the authoritative amount) and idempotent `fulfillFromEvent`
  (upserts the buyer as a customer, then reuses `LicenseService.issue()` verbatim
  → same signed token an admin issue produces) + best-effort email.
- **F4.** ✅ `BillingController` — `POST /billing/checkout` (@Public),
  `POST /billing/webhook` (@Public, raw body via `rawBody:true`, signature
  verified → 400 on forge), `GET /billing/orders/:sid/license` (success-page key
  retrieval). Plus `PublicController`: `/public/packages` (safe fields) +
  `/public/billing-status`.
- **F5.** ✅ Admin `publiclyListed` toggle (DTO + service + PackagesPanel
  checkbox/badge).
- **F6.** ✅ Web storefront: public `/pricing` (cards + buy dialog → Stripe
  redirect), `/checkout/success` (polls, shows key once + copy), `/checkout/
  cancel`; BFF `/api/public/{packages,billing-status,checkout,orders/[id]/
  license}` (checkout is CSRF-guarded; `proxy.ts` leaves public pages ungated).
- *Verify:* ✅ `tests/billing.e2e.test.ts` (9) — public listing filters to
  active+public; checkout uses DB price (client amount rejected by whitelist);
  non-public/inactive/domainless → 400; paid webhook → license minted &
  **verified in the REAL `@openeditors/entitlements` verifier**; **same event
  twice → one license**; bad signature → 400 mints nothing; unpaid → no mint.
  Full backend suite **83 green**. Web lint + build clean.
  **Live pass:** `PHASE-F-LIVE-CHECKLIST.md` (Stripe test-mode + CLI) — to run
  once a public webhook URL exists (Phase G deploy).

- **F7.** ✅ Post-audit hardening (deep adversarial review of the money path):
  - **Amount authority at fulfillment** — the webhook now verifies Stripe's
    `amount_total` + `currency` equal the order's snapshot before minting; a
    $0/100%-off coupon or currency mismatch → order `failed`, no license.
    `payment_status:'paid'` only (never `no_payment_required`).
  - **Single-use key retrieval** — the success endpoint returns the signed token
    exactly ONCE (atomic `licenseDelivered` flip); a leaked/replayed success URL
    gets "already retrieved, check email", not the bearer token.
  - **attachSession race fixed** — a webhook that arrives before the order is
    visible returns 503 (Stripe retries) instead of burning the idempotency
    ledger, so no "paid-but-no-license".
  - **Snapshot fulfillment** — order snapshots `featureIds` + `domainBound`;
    `LicenseService.issueFromSnapshot()` mints even if the package was edited/
    deleted mid-flight (re-checks features are still sellable).
  - **No cross-customer domain merge** — a self-serve buyer reuses/creates a
    customer by email but never mutates an existing record's domain list (the
    license binds its own domains).
  - **Admin Orders view** (`order.read`) surfaces fulfilled + failed orders so a
    non-fulfilled payment is visible, never silently lost. Email logs no longer
    include a key preview; success page has a clipboard fallback.
  - *Verify:* billing e2e now **13 tests** (added amount-mismatch, currency-
    mismatch, webhook-before-order race→retry, single-use retrieval, admin
    orders). Full backend suite **87 green**.

Deferred (→ Phase G / later): subscriptions & recurring (billingInterval stays
the 'once' path), refund/chargeback automation, real email provider selection,
**rate limiting on the public routes** (the one audit item intentionally left
for Phase G).

### Phase G — Production hardening & deploy ✅ DONE (deploy-ready; live Stripe pass pending a host)
Decision: **host-agnostic** — Docker images + a compose stack + generic docs; no
host-specific config. Baseline migration; structured logs + `/health` (no paid
APM). The live Stripe pass is made turnkey for the user to run once deployed.

- **G1.** ✅ Baseline migration (`src/migrations/…InitialSchema`) covering the
  full schema incl. all F/F7 columns. **Verified on real MySQL**: migrate on a
  fresh DB → boot with `synchronize:false` → seed + admin login + package
  create + RBAC read all work. `synchronize` stays for sqljs tests only.
- **G2.** ✅ Rate limiting (`@nestjs/throttler`): one global default; `@Throttle`
  tightens `/auth/login`+`/refresh` and `/billing/checkout`; `@SkipThrottle()`
  exempts the Stripe webhook (retries must not be dropped). `TRUST_PROXY` so
  limits + CSRF key on the real client IP. (Caught + fixed the "extra named
  throttlers apply globally" footgun.)
- **G3.** ✅ Security headers: `helmet` on the API (CSP off — JSON only); web
  gets CSP + HSTS + nosniff + frame-DENY + Referrer/Permissions-Policy. CSP
  verified against the real rendered pages (script `'unsafe-inline'` kept for
  Next's inline bootstrap, with a documented nonce upgrade path).
- **G4.** ✅ Structured JSON access logs `{level,time,reqId,method,path,status,
  ms}` + request-id middleware (echoed on the response). **Secret-safety pass**:
  no bodies/headers logged; verified at runtime that a login password + JWT
  appear in 0 log lines.
- **G5.** ✅ Deploy artifacts: multi-stage Dockerfiles (backend npm / web pnpm,
  non-root, healthchecks), `.dockerignore`s, `docker-compose.prod.yml` (mysql →
  one-shot migrate → backend → web → Caddy) + `Caddyfile` (TLS + routing) +
  `.env.prod.example`.
- **G6.** ✅ `DEPLOY.md` (secrets, migrate-then-start, routing, editor→backend
  wiring, backups, key rotation, hardening knobs); `.env.example` updated with
  the G knobs; Stripe live checklist ready.
- *Verify:* backend suite **89 green** (incl. new `throttle.e2e`); web lint +
  build clean; migration proven on real MySQL. **Live Stripe test-mode pass**
  (`PHASE-F-LIVE-CHECKLIST.md`) does NOT need a public host — the Stripe CLI's
  `stripe listen` forwards webhooks to localhost in test-mode, and this pass
  was completed locally 2026-07-27 (real checkout, real webhook, real
  idempotency replay — see `PHASE-F-LIVE-CHECKLIST.md` for evidence). What
  DOES still need a real deployed host is the **production** webhook path
  (Stripe calling a real HTTPS endpoint directly, no CLI forwarder) — that
  remains turnkey, to be run once a host exists.
- *Not done (by design):* host-specific config, paid APM, Redis rate-limit
  store (single-node in-memory is fine until scale-out).

### Post-audit remediation (full A→G adversarial pass) ✅ DONE
A 6-way parallel deep audit (auth/RBAC, licensing/crypto, billing, AI proxy,
deploy, web/tests) found the core sound (no forgery / free-license / auth-bypass
/ secret-leak) plus a set of real issues, ALL now fixed + regression-tested:
- **H1** BFF refresh sent `Origin:BACKEND_URL` → 403 once `ADMIN_CORS_ORIGINS`
  set (admins logged out every 15m). Fixed: server-to-server `BFF_SHARED_SECRET`
  header + `assertTrustedOrigin` accepts it (constant-time); L7 missing-origin
  hole closed. `refresh-csrf.e2e` (6 tests).
- **H2** Billing idempotency ledger was inserted before the mint, outside a txn
  → a mint failure permanently lost a paid license. Fixed: ledger+mint+order
  save in ONE transaction (rolls back → Stripe retries); permanent failures mark
  the order `failed` (visible), not stuck. `billing.e2e` +2 (concurrent-dup,
  mint-fail-not-burned).
- **H3** RBAC had no privilege ceiling → `role.manage`+`user.manage` could
  self-escalate to all-but-`*`. Fixed: can only grant permissions you hold, can't
  assign broader roles, can't edit your own roles; super-admin exempt.
  `rbac-admin.e2e` +6.
- **M1** real email transport (vendor-neutral `EMAIL_WEBHOOK_URL`) + dev-log
  fallback. **M3** issue-time public-suffix / over-broad-wildcard domain cap.
  **M4** prod secret guard rejects `change-me`/short secrets. **M5** dedicated
  `/api/ai` throttle + documented open-proxy cost note. **M6** pinned pnpm
  (`packageManager`) so the web Docker build is deterministic.
- **L1** Caddy TLS-by-default. **L2** package TTL default 365d→30d (matches
  revocation model). **L3** self-serve licenses use the plan TTL. **L4** unbound
  plans no longer bind buyer-typed domains. **L5** domain normalization (trailing
  dot/port). **L6** BFF refresh single-flight (no reuse-detection lockout).
  **L9** dummy-hash cost matches bcrypt rounds (enumeration timing).
- *Verify:* backend suite **103 green** (+14 regression tests); migration
  re-proven on real MySQL.

### Coverage completion (closing the audit's two test gaps) ✅ DONE
- **Web app now has a test suite** (was zero — the gap that let H1 through).
  `open-editor-web` runs **vitest** (`npm test`): `csrf`, `session`,
  `permissions`, `backend` (refresh single-flight + retry-once + BFF-secret +
  rotation), `dal` (requireAdminApi 401/403/pass) — **32 tests**. Writing them
  surfaced a real gap: `order.read` was missing from the shared admin-detection
  predicate (`hasAdminAccess`) — an order-only admin wouldn't reach the panel.
  Fixed + regression-tested.
- **Real-MySQL e2e run** (was sqljs-only). `npm run test:mysql`
  (`scripts/test-mysql.sh`) runs all 5 e2e suites against a real MySQL, each in
  its own fresh DB — proving the transactional idempotency/race (H2), FK
  SET NULL, and unique-constraint behaviour on the real engine, not just sqljs.
  sqljs stays the fast default (`npm test`). All 54 e2e tests pass on MySQL.
- Remaining by-design (documented, non-blocking): fake-Stripe signature stub
  (real HMAC exercised only in the live checklist); no browser-level E2E
  (Playwright installed but the vitest BFF tests cover the H1-class logic).

### Feature gating — full catalog + admin packaging (Phases 1–4) ✅ DONE
Every editor feature (core formatting AND premium) is now composable into a
package; a purchased license grants ONLY those features and the editor gates
exactly that set. The backend's job here is the **catalog** + **sync guard**.

- **Unified catalog (72 features).** `src/licensing/feature-catalog.ts` lists
  every id an admin can sell — core (`kind: 'core'`), free plugins
  (`'plugin'`), and premium (`'premium'`) — each with `group`, `sellable`, and
  optional `deprecated`. `FeatureEntity` gained `group`/`kind` columns, added by
  the **additive** migration `1784733336198-AddFeatureGroupKind` (idempotent,
  INFORMATION_SCHEMA-guarded — safe on already-migrated DBs).

- **Catalog is GENERATED, not hand-maintained.**
  `scripts/sync-feature-catalog.mjs` regenerates `feature-catalog.ts` from the
  engine's two sources (core `feature-catalog.js` + premium
  `feature-registry.js`). The backend stays **standalone** — the generated file
  is committed and shipped; the engine is never imported at runtime.
  - `npm run sync:features` — regenerate + write (run when the engine changes).
  - `npm run sync:features:check` — CI guard: **fails** if the committed file is
    stale (belt-and-suspenders alongside `catalog-drift.test.ts`).
  - `ENGINE_DIR=/path/to/open-editor npm run sync:features` — custom engine path.
  - **Workflow when the engine adds/changes a feature:** drift test (or
    `sync:features:check`) goes red → `npm run sync:features` → review the diff →
    commit. Derivation rules: `kind` = premium (registry) / plugin (core entry
    has a `plugin` field) / core (rest); `sellable` = false if deprecated or on
    the `NEVER_SELL` list (`dev.smoke`); `group` from the core catalog, or the
    curated `PREMIUM_GROUPS` map for premium ids.

- **The `installAllPlugins` host contract (Phase-5 prerequisite).** A license
  grant can only **suppress** a plugin, never install one — plugin installation
  is host-driven. So a gated host MUST install the full free-plugin superset and
  let the grant trim it. The engine exports `installAllPlugins(editor)` (+
  `ALL_FREE_PLUGINS`) for exactly this: call it after constructing the editor,
  and the grant alone decides what appears. Premium plugins are wired via the
  premium runtime the same way (install the superset; the shared granted set
  gates both). Without this, an un-granted feature can't leak — but a granted
  one silently won't appear. This is the invariant Phase 5's live buy→editor
  proof depends on.

- **Generator fails LOUD** (throws) on an id defined in both engine sources
  (collision → would otherwise silently downgrade premium→core) and on a premium
  id with no `PREMIUM_GROUPS` entry (→ would otherwise silently mis-group).
  `deprecated` is read from BOTH catalogs (a retired core feature is never left
  sellable), and `NEVER_SELL` matches the `dev.*` prefix, not just literals.

- **Verified:** generator reproduces the current 72-feature catalog exactly (and
  the guardrails were exercised on throwaway engine copies: collision → throw,
  missing group → throw, `dev.*` → not sellable); drift-red→sync→green proven;
  migrations run cleanly on real MySQL via **`npm run test:mysql:migrations`**
  (additive column add + no-op re-run asserted via INFORMATION_SCHEMA row-count,
  not log text; SKIPS if no MySQL); the drift test **skips gracefully** when the
  sibling engine repo is absent (standalone CI safe) and now also verifies core
  groups vs the engine catalog + premium groups vs `PREMIUM_GROUPS`; the
  integrated `full-stack-gating.test.js` asserts toolbar+free-plugins+commands
  agree AND that the same unified grant yields the right verdict for premium ids
  (real premium-plugin install/stub is proven in `premium/runtime/tests/gate.test.js`);
  a real-backend e2e asserts `/admin/features` HTTP serialization carries
  group/kind on every feature (the BFF passthrough test pins the proxy shape).

---

## 4. Key decisions (made / pending)

| Decision | Status |
|----------|--------|
| Backend location | ✅ Standalone `open-editor-backend/` (sibling, not in the editor monorepo) |
| Framework | ✅ NestJS |
| Database / ORM | ✅ MySQL + TypeORM |
| Package manager | ✅ npm (self-contained) |
| LLM provider (now) | ✅ Groq free tier (OpenAI-compatible; paid providers later = config change) |
| Admin panel location | ✅ In `open-editor-web` (frontend); backend stays API-only |
| License lifetime | ✅ Perpetual + optional per-license expiry |
| Domain binding | ✅ Yes — licenses bound to registered domain(s) |
| Purchase flow | ✅ Admin-issued now; Stripe in Phase F |
| ES256 private-key storage | ✅ Env secret + `kid`-based rotation (→ cloud secret manager in prod) |
| Payment provider | ⏳ decide at Phase F |

---

## 5. Guiding principles

1. **The editor stays a pure frontend package** — the backend depends on it
   (its entitlements issuer), never the reverse.
2. **Secrets never reach the browser** — LLM key and signing private key live
   only on the server.
3. **Reuse the tested crypto** — licensing wraps `@openeditors/entitlements`,
   not a new implementation.
4. **One phase at a time, each verified** — build, test, confirm, then advance.
5. **Fail loud, never silently** — clear errors, no silent no-ops.
