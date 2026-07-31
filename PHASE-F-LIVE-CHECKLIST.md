# Phase F — live Stripe verification checklist

The automated suite (`tests/billing.e2e.test.ts`, 16 tests) proves all the
billing LOGIC offline with a fake Stripe — checkout price-authority, mint +
real-verifier check, idempotency, bad-signature rejection, unpaid handling. What
it CANNOT prove without a public URL is the real Stripe → webhook round-trip.
Run this once against **Stripe test-mode** to confirm that last mile.

> Nothing here is needed to build or test the app. Keys are only for this
> manual pass. Never use live keys for this — test-mode only.

> **`stripe listen` must be running for the ENTIRE time you want local
> self-serve checkout to work** — not just once. It's the only way a webhook
> reaches `localhost:8787` in local dev (there's no public HTTPS endpoint for
> Stripe to call directly). If it's not running when a buyer pays, the order
> is stuck `pending` forever: no license mints, no email sends, and the
> buyer's `/checkout/success` page just times out to a vague "almost there —
> check your email shortly" with no real error. Nothing alerts you either —
> check `GET /admin/orders` for `stalePending: true` (any `pending` order
> older than 30 minutes) if a purchase seems to have vanished. Re-running the
> checkout after starting `stripe listen` again does NOT retroactively
> fulfill an old stuck order; the buyer has to check out again.

## 0. Prereqs
- A free Stripe account. Grab **test-mode** keys:
  https://dashboard.stripe.com/test/apikeys
- Install the Stripe CLI: https://stripe.com/docs/stripe-cli

## 1. Configure the backend (`open-editor-backend/.env`)
```
DB_ENABLED=true
DB_DRIVER=mysql            # or sqljs for a throwaway run
# ... your existing LICENSE_/AUTH_/SEED_ vars ...
STRIPE_SECRET_KEY=sk_test_xxx
WEB_APP_ORIGIN=http://localhost:3000
```
(Leave `STRIPE_WEBHOOK_SECRET` blank for a moment — the CLI prints it next.)

## 2. Start the webhook forwarder
```
stripe login
stripe listen --forward-to localhost:8787/billing/webhook
```
Copy the `whsec_...` it prints into `.env` as `STRIPE_WEBHOOK_SECRET`, then
start the backend so it picks up the secret:
```
npm run build && node dist/main.js
```

## 3. Start the web app
```
cd ../open-editor-web && npm run dev     # http://localhost:3000
```

## 4. Prepare a purchasable package
- Log in to the admin panel (`/admin`) → **Packages** → create one with a price
  and at least one sellable feature, and tick **“List on public pricing page.”**
- (If domain-bound, you'll enter a domain at checkout.)

## 5. Buy it
- Open `http://localhost:3000/pricing` → the package appears → **Buy now**.
- Enter an email (+ domain if bound) → **Continue** → you're on Stripe Checkout.
- Pay with the test card: **`4242 4242 4242 4242`**, any future expiry, any CVC/ZIP.

## 6. Verify the outcome
- [x] `stripe listen` shows `checkout.session.completed` forwarded → `201`.
- [x] Backend log shows `fulfilled order … → license …` and a real SMTP send
      line (`license email sent via SMTP to …`) — confirmed the transport is
      genuinely `smtp.gmail.com` (not the `[dev-email]` log-only fallback);
      inbox-arrival itself was not independently re-checked in this pass
      (accepted the real-SMTP-send log as sufficient evidence).
- [x] The browser lands on `/checkout/success` and shows the **license key**.
- [x] Admin panel → **Licenses** shows the new license (status active); the
      buyer appears under **Customers**.
- [x] The key verifies in the editor (`@openeditors/entitlements`) for the
      domain entered (also proven offline; confirmed live via the Basic/Pro
      purchases in Phase 5b — see FEATURE-GATING-PHASES.md).
      **Verified live 2026-07-27** (Phase 5 audit remediation), with real
      Stripe test-mode keys, a real browser checkout, `4242 4242 4242 4242`.

## 7. Idempotency (the important one)
```
stripe events resend <evt_id>      # id from the `stripe listen` output
```
- [x] Backend logs `already processed — skipping`.
- [x] Admin **Licenses** still shows exactly **one** license for that buyer
      (no duplicate mint).
      **Verified live 2026-07-27**: purchased against "Basic" as
      `idempotency-check@parselab.com`, captured the real
      `checkout.session.completed` event id from `stripe listen`'s log,
      ran `stripe events resend <id>`, confirmed the backend logged
      `stripe event … already processed — skipping`, and confirmed exactly
      one license (same id, before and after) via `GET /admin/licenses`.
      This step had never actually been run before — earlier phase claims
      that "idempotency was proven" rested on the code + offline fake-Stripe
      tests only.

## 8. Negative check
```
curl -sS -X POST localhost:8787/billing/webhook \
  -H 'stripe-signature: forged' -H 'content-type: application/json' \
  -d '{"id":"evt_x","type":"checkout.session.completed","data":{"object":{"id":"cs_x","payment_status":"paid"}}}'
```
- [x] Responds **400** (`invalid signature`) and mints nothing.
      **Verified live 2026-07-27.**

---
When all boxes are ticked, Phase F is verified end-to-end against real Stripe.
The remaining production concerns (public HTTPS webhook endpoint, rate limiting
on the public routes, real email provider) are Phase G.
