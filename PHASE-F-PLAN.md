# Phase F — Billing (self-serve, one-time payments)

**Decisions locked (from the user):**
- Purchase flow: **public self-serve storefront** (`/pricing` on open-editor-web).
- Billing model: **one-time payments only** (Stripe `payment` mode; perpetual license, renewed manually later — no subscriptions in F).
- Delivery: **success page (shows key once) + email** (swappable provider, dev-safe: logs the key when no creds).
- Testing: **mocked Stripe in vitest + a written live checklist** (Stripe test-mode with the CLI).

**Guiding principle:** the money layer is *additive*. It reuses the existing
`LicenseService.issue()` mint primitive verbatim; a paid purchase is just
"issue, triggered by a verified Stripe webhook instead of an admin click." No
change to the token format, verifier, or RBAC.

---

## Security posture (non-negotiables)

1. **The webhook is the ONLY thing that mints a paid license** — never the
   success page, never the browser. The success-redirect can be forged; only a
   `stripe.webhooks.constructEvent()`-verified `checkout.session.completed`
   event (signature checked against `STRIPE_WEBHOOK_SECRET`) mints.
2. **Amount/price is authoritative on the SERVER.** The browser never sends a
   price. The backend creates the Checkout Session from the DB package's
   `priceCents`/`currency`. A tampered client can't buy Premium for $1.
3. **Idempotency.** Stripe retries webhooks. We store the Stripe event id +
   the checkout `session.id`; a duplicate event is a no-op (never double-mint).
   A `ProcessedEvent` table (or a unique column on the order) enforces this.
4. **Webhook route bypasses the normal pipes.** It needs the **raw body** for
   signature verification (JSON parsing breaks the signature) and must be
   `@Public()` (no admin JWT) — but it is authenticated by the Stripe
   signature instead. It is NOT behind the CSRF/Origin BFF (Stripe calls the
   backend directly, server-to-server).
5. **No secret leaks.** `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` are
   backend-only env. The browser only ever sees the **publishable** key (or,
   simpler, nothing — we use hosted Stripe Checkout redirect, so not even that).
6. **Public endpoints are rate-limitable** (checkout-session creation is public);
   add a basic limiter here or defer to Phase G — noted, not silently skipped.

---

## Data model changes

### PackageEntity — add public-storefront fields
- `publiclyListed: boolean` (default `false`) — only these show on `/pricing`.
  (Distinct from `active`: a package can be active/issuable by admin yet not
  publicly sold.)
- (No `stripePriceId` needed — we pass `price_data` inline at session creation
  from `priceCents`/`currency`, so pricing stays DB-driven and dynamic. If we
  later want Stripe-dashboard-managed prices we can add it, but inline keeps the
  "admin sets price in our panel" model intact.)

### New: OrderEntity (`orders`)
Tracks a purchase attempt/outcome — the bridge between Stripe and a License.
- `id` (uuid)
- `stripeSessionId` (unique, indexed) — the Checkout Session id
- `stripeEventId` (nullable) — the event that fulfilled it (idempotency audit)
- `packageId` (FK, SET NULL) + snapshot `packageName`, `amountCents`, `currency`
- `customerEmail`, `customerName`, `domains: simple-json` (collected at checkout)
- `status`: `pending | paid | fulfilled | failed | expired`
- `licenseId` (FK, nullable) — set once minted
- timestamps

### New: ProcessedStripeEvent (`processed_stripe_events`) — idempotency ledger
- `eventId` (PK, Stripe event id) + `type` + `createdAt`. Insert-if-absent;
  presence ⇒ already handled ⇒ skip. (Alternatively fold into OrderEntity via a
  unique `stripeEventId`; a dedicated table also covers non-order events.)

### CustomerEntity — reuse/create-on-purchase
On fulfillment we upsert a customer by email (create if new), so a self-serve
buyer becomes a first-class customer record the admin can see. Domains bound to
the license come from what the buyer entered at checkout (required when the
package is `domainBound`).

---

## Backend (open-editor-backend)

### BillingModule (DB-gated, like AdminModule)
- `StripeService` — thin wrapper around the `stripe` SDK. Constructed from
  `STRIPE_SECRET_KEY`. Exposes `createCheckoutSession(pkg, {email,name,domains})`
  and `constructWebhookEvent(rawBody, sig)`. **Mockable** — tests inject a fake.
  If no key is set, billing endpoints 503 with a clear message (mirrors the AI
  proxy's "no key → 503" pattern), so the app still boots without Stripe.
- `EmailService` — `sendLicenseEmail(to, {key, planName})`. Provider behind an
  interface; default **dev transport logs** the email (no creds needed). A real
  transport (Resend/SES/SMTP) is a drop-in later; abstract now.
- `OrderService` — create pending order, fulfill order (idempotent):
  upsert customer → `LicenseService.issue()` → attach license → mark fulfilled
  → send email. All wrapped so a retry can't double-issue.
- `BillingController`:
  - `POST /billing/checkout` **(@Public)** — body `{ packageId, email, name?, domains? }`.
    Validates package is `active && publiclyListed`; if `domainBound`, requires
    ≥1 domain. Creates a pending Order + a Stripe Checkout Session
    (`mode: 'payment'`, inline `price_data` from the package, `success_url`/
    `cancel_url` to the web app, `metadata: { orderId }`). Returns `{ url }`.
  - `POST /billing/webhook` **(@Public, raw body)** — verifies signature;
    on `checkout.session.completed` with `payment_status: 'paid'` → idempotent
    fulfill via `OrderService`. Returns 200 fast (Stripe requires quick ack).
  - `GET /billing/orders/:sessionId/license` **(@Public)** — for the success
    page: given a Checkout Session id, returns the license **key once** IF the
    order is fulfilled and belongs to that session. (Rate-limit / unguessable
    session id is the bearer here; acceptable for one-time retrieval. We can
    also gate it to only return within N minutes of fulfillment.)
- **Public package listing**: `GET /packages/public` **(@Public)** — id, name,
  description, price, currency, features (titles), domainBound. For `/pricing`.
  (Separate from the admin `/admin/packages` which needs `package.read`.)

### main.ts / wiring
- Register the Stripe **raw-body** parser for `POST /billing/webhook` ONLY
  (e.g. `express.raw({type:'application/json'})` on that path), while the rest
  of the app keeps JSON parsing. Order matters — mount before the global JSON.
- Add `publiclyListed` to the admin package create/update DTO + UI (so admin
  chooses what's on the storefront).

---

## Frontend (open-editor-web)

- **`/pricing` (public, static-ish)** — fetches `GET /api/public/packages`
  (a new BFF passthrough to `/packages/public`, no session needed) and renders
  cards. "Buy" opens a small form (email, name, domain(s) if domainBound) →
  `POST /api/public/checkout` → redirect to the returned Stripe `url`.
- **`/checkout/success`** — reads `?session_id=...`, polls
  `GET /api/public/orders/:sessionId/license` until fulfilled (webhook may lag a
  second), then shows the license key once with a copy button + "also emailed."
- **`/checkout/cancel`** — friendly "payment cancelled" page.
- BFF routes under `/api/public/*` — these are **public** (no `requireAdminApi`),
  but still same-origin; the checkout POST keeps the CSRF/Origin guard.
- Admin **PackagesPanel**: add a "List on public pricing page" checkbox
  (`publiclyListed`) and show a badge.
- `proxy.ts` matcher stays admin/profile/login only — `/pricing`,
  `/checkout/*` are public and must NOT be gated.

---

## Testing

### Automated (offline, vitest — like the sqljs e2e suite)
`tests/billing.e2e.test.ts`:
- Inject a **fake StripeService** (no network): `createCheckoutSession` returns
  a canned `{ id, url }`; `constructWebhookEvent` returns a crafted event.
- Assert:
  1. `POST /billing/checkout` for a `publiclyListed` package → creates a pending
     Order + returns a url; amount comes from the DB package, not the request.
  2. Checkout for a non-public / inactive package → 400/404.
  3. domainBound package without a domain → 400.
  4. A crafted `checkout.session.completed` (paid) webhook → order becomes
     `fulfilled`, a **License is minted**, and its token **verifies in the REAL
     `@openeditors/entitlements` verifier** with the package's features + the
     buyer's domain (reuses the existing verifier import).
  5. **Idempotency:** posting the SAME event twice mints exactly ONE license.
  6. A webhook with a bad signature → 400, no mint.
  7. Success endpoint returns the key once for a fulfilled order; 404 for an
     unknown/pending session.
- Keep the existing 74 tests green (billing is additive).

### Manual (live, once) — `PHASE-F-LIVE-CHECKLIST.md`
1. `STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_…` in backend `.env`.
2. `stripe listen --forward-to localhost:8787/billing/webhook` → paste the
   `whsec_…` it prints.
3. Start backend + web; open `/pricing`; buy with test card `4242 4242 4242 4242`.
4. Confirm: redirected to success page → key shown → license appears in admin
   panel → email logged (or delivered) → token verifies in the editor.
5. Re-send the event via `stripe events resend` → no duplicate license.

---

## Env additions (documented in both `.env.example`s)
Backend:
- `STRIPE_SECRET_KEY` (test/live secret) — billing 503s if unset.
- `STRIPE_WEBHOOK_SECRET` — required to accept webhooks.
- `CHECKOUT_SUCCESS_URL` / `CHECKOUT_CANCEL_URL` (default to the web app origin).
- `EMAIL_FROM` + provider creds (optional; dev logs if unset).

Web:
- `NEXT_PUBLIC_` — none needed (hosted Checkout redirect; no client Stripe key).

---

## Build order (each step verified before the next)
1. Data model: `publiclyListed` + `OrderEntity` + idempotency ledger (+ migration
   note for Phase G; sqljs `synchronize` covers dev/tests).
2. `StripeService` (+ fake) and `EmailService` (+ dev transport).
3. `OrderService.fulfill()` (idempotent) reusing `LicenseService.issue()`.
4. `BillingController` (checkout + webhook + success) with raw-body wiring.
5. Public package listing endpoint + admin `publiclyListed` toggle.
6. Web `/pricing`, `/checkout/success`, `/checkout/cancel` + `/api/public/*` BFF.
7. `billing.e2e.test.ts` (all cases) → full suite green.
8. Docs: env, live checklist, ROADMAP Phase F marked done.

## Explicitly OUT of scope for Phase F (→ Phase G or later)
- Subscriptions / recurring / proration (billingInterval stays 'once' path).
- Refund/chargeback automation (Stripe dashboard for now).
- Real email provider selection (abstracted; dev-logs until chosen).
- Production rate limiting / secret management / deploy (Phase G).
