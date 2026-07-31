# Phase G — Production hardening & deploy-ready

**Decisions locked (from the user):**
- **Deploy-ready, host-agnostic** — Dockerfiles + `.dockerignore` + generic
  deploy docs; NO host-specific config (Railway/Render/etc. left to you).
- **One baseline migration** — a single initial migration capturing the whole
  current schema, verified to apply on a fresh MySQL. `synchronize` stays for
  tests/dev only.
- **Stripe live: I make it deploy-ready + verify the checklist; YOU run** the
  one-time test-mode purchase (needs your account + a public URL).
- **Observability: structured JSON logs + the existing `/health`** — no paid APM.

**Guiding principle:** Phase G adds NO new product features. It closes the
"we'll handle it in prod" notes left across A–F and makes the two apps safe to
run on a public host. Everything here is verifiable locally except the live
Stripe round-trip.

**What already exists (verified — do NOT rebuild):** prod-secret enforcement
(`auth.config.ts` throws if secrets missing/identical in prod), a real `/health`
with DB+AI checks, CORS allowlist (editor + admin origins), migration *infra*
(`data-source.ts` + `migration:*` npm scripts), the `secure` cookie flag in
prod, license key-rotation support. Phase G fills the gaps around these.

---

## The gaps Phase G closes (grounded in the codebase)

| Area | Current state | Phase G |
|------|---------------|---------|
| Migrations | infra present, **zero migrations written**; schema via `synchronize` | one baseline migration, verified on fresh MySQL |
| Rate limiting | **none** (`@nestjs/throttler` not installed) | throttle public + auth + AI + billing routes |
| Security headers | **none** (`helmet` not installed) | helmet on the API; security headers on web |
| Deploy artifacts | **none** (no Dockerfile) | Dockerfile (both apps) + `.dockerignore` + compose for local prod-like run |
| Logging | Nest default console logger | structured JSON logs w/ request id, secret-safe |
| Rate-limit note in code | `ai.controller.ts` + `billing.controller.ts` say "Phase G" | delivered |
| DB backups / ops | undocumented | documented (mysqldump cadence, restore) |

---

## Workstreams (each verified before the next)

### G1 — Baseline migration + real-MySQL sanity
- Write **one** initial migration from the current entities: users, roles,
  permissions, role_permissions, user_roles, packages, features,
  package_features, customers, licenses, orders, processed_stripe_events (+ the
  `publiclyListed`, `featureIds`, `domainBound`, `licenseDelivered` columns
  added in F/its hardening).
- Author it via `migration:generate` against a throwaway MySQL, then hand-review
  (generated migrations often need index/charset/onDelete tweaks).
- **Verify:** `migration:run` on an empty MySQL 8 (via the local docker) creates
  the schema; boot the app against it with `DB_SYNCHRONIZE=false` and run the
  seed → admin login works. Keep the sqljs test suite unchanged (still 87 green).
- Guard: confirm `synchronize` can never be true in production (already enforced
  in `database.config.ts` — re-verify + document).

### G2 — Rate limiting (the one deferred security item)
- Add `@nestjs/throttler`. Global sane default (e.g. 100 req/min/IP) + tighter,
  named limits where abuse is costly:
  - `POST /auth/login` + `/auth/refresh` — strict (brute-force / token-spam).
  - `POST /billing/checkout` — strict (creates Stripe sessions + DB rows).
  - `POST /billing/webhook` — **exempt** (Stripe's own IPs; signature is the
    gate; throttling it would drop legitimate retries). Document why.
  - `GET /public/*` — moderate.
  - `/api/ai` — per-the existing note (cost guard).
- Trust proxy: behind a reverse proxy the client IP is in `X-Forwarded-For` —
  configure Express `trust proxy` so the limiter keys on the real IP, not the
  proxy. (Also matters for the CSRF Origin check.)
- **Verify:** an e2e test that hammers `/auth/login` past the limit → 429; a
  normal request still 200; webhook not throttled.

### G3 — Security headers
- `helmet` on the backend (sensible defaults; CSP is mostly the web app's job).
- Web: add security headers via Next config (`X-Frame-Options`,
  `Referrer-Policy`, `X-Content-Type-Options`, a basic CSP for the admin/
  storefront). Confirm the storefront + Stripe redirect still work under it.
- **Verify:** headers present on responses; build + existing flows unaffected.

### G4 — Structured logging
- Swap the Nest logger for JSON structured output (pino or a small custom
  Nest `LoggerService`): `{ level, time, reqId, method, path, status, ms }`.
- A request-id middleware (incoming `X-Request-Id` or generated) echoed on the
  response + included in every log line for tracing.
- **Secret-safety pass:** audit that NOTHING logs tokens, passwords, Stripe
  keys, or license keys (we already fixed the email-key log in F-hardening;
  re-grep the whole tree). Redact `authorization`/`cookie` headers.
- **Verify:** logs are valid JSON, carry a reqId, and a grep for known secret
  patterns in captured log output is clean.

### G5 — Deploy artifacts (host-agnostic)
- **Backend Dockerfile:** multi-stage (build → slim runtime), non-root user,
  `node dist/main.js`, `NODE_ENV=production`, healthcheck hitting `/health`.
- **Web Dockerfile:** Next standalone output build.
- `.dockerignore` for both (no `node_modules`, `.env`, tests).
- **`docker-compose.prod.yml`** for a local prod-like run: backend + web + MySQL
  (named volume) + a reverse proxy (caddy/nginx) terminating TLS and routing.
  This is the thing that lets YOU do the live Stripe pass locally-public (or
  lift onto any host).
- **Verify:** `docker compose up` boots all three; `/health` green; admin login
  + a full create-package→issue-license flow works through the proxy.

### G6 — Production config + docs
- A single **`DEPLOY.md`**: required env (all secrets, generated how), the
  migrate-then-start sequence, reverse-proxy/TLS notes, `trust proxy`,
  DB backup/restore (mysqldump cadence + restore steps), and how to rotate the
  license signing key + JWT secrets safely.
- Update both `.env.example`s with anything new (throttle knobs, `TRUST_PROXY`,
  `LOG_LEVEL`, request-id header name).
- Confirm the **editor→backend wiring**: document exactly which env the editor
  (`open-editor`) needs to point `/api/ai` + JWKS at the deployed backend
  (the code paths exist: `ai-complete.js`, entitlements verifier). No code
  change expected — just the wiring doc + a sanity check.
- Update the PHASE-F-LIVE-CHECKLIST for the compose/reverse-proxy setup so your
  one-time Stripe test-mode pass is turnkey.

### G7 — Final verification gate
- Backend: full suite green (87 + new throttle/migration tests).
- Web: lint + build clean.
- `docker compose up` → walk the WHOLE product flow end to end through the
  proxy: admin login → create public package → (Stripe test-mode) buy on
  /pricing → webhook mints → license verifies in the editor → admin sees the
  order. This is the Phase G "staging" verify from the roadmap.

---

## Explicitly OUT of scope for Phase G
- Host-specific deploy config (you chose host-agnostic) — the Dockerfiles +
  compose + DEPLOY.md make any host straightforward, but no Railway/Render/Fly
  files.
- Paid observability (Sentry/APM) — structured logs + /health only.
- Subscriptions/refunds (Phase F deferrals — a later phase if ever).
- Multi-region / autoscaling / k8s — over-engineering for this stage; the
  compose setup scales vertically fine and lifts to a single host.
- A real email provider — still dev-logged; wiring one is a config drop-in
  (documented in DEPLOY.md) but not built here.

## Risks / watch-items
- **Generated migration accuracy** — TypeORM's generator vs. sqljs quirks;
  must hand-review + test on real MySQL (that's why G1 verifies on MySQL 8).
- **`trust proxy` + CSRF/rate-limit interaction** — get the proxy IP handling
  right or the Origin check and limiter misbehave behind TLS termination.
- **CSP breaking the Stripe redirect / admin panel** — tune CSP against the
  real pages, verify before declaring done.
- **The live Stripe pass is the one thing I cannot fully verify** — everything
  is made turnkey, but the final green tick is yours to produce.
