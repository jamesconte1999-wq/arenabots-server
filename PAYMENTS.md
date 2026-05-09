# ArenaBots Payments Setup (Stripe)

Real payments with Stripe Checkout (one-time buys) and Stripe Subscriptions
(recurring Pro Pass). Without Stripe configured the client falls back to
demo mode — no UI rewrites required.

**Estimated setup time: 5 minutes in test mode, 10 minutes live.**

---

## Quickstart (TL;DR)

```bash
# 1. Paste keys into .env (see "Step 2" below for details)
# 2. Create all 7 products + prices in Stripe automatically
node scripts/seed-stripe-products.js

# 3. In another terminal, forward webhooks to localhost
stripe login
stripe listen --forward-to localhost:2567/api/stripe/webhook
# (copy the 'whsec_...' it prints into STRIPE_WEBHOOK_SECRET in .env)

# 4. Restart the server
node src/index.js

# 5. In the client, sign in → Pro Store → Buy Crowns → card 4242 4242 4242 4242
```

---

## Step 1 — Get your Stripe keys

### Test mode (strongly recommended for the first run)

1. <https://dashboard.stripe.com/register> — sign up (free).
2. Stay in **Test mode** (toggle top-right).
3. **Developers → API keys** → reveal **Secret key** starting `sk_test_...`.
4. Copy both the **Secret key** (`sk_test_...`) and the **Publishable key**
   (`pk_test_...`).

### Live mode

Same page, but the toggle says **Live mode** and the keys start `sk_live_...`
/ `pk_live_...`. **Never** paste a live key into chat logs, Git, Slack,
screenshots, or AI tools. Always rotate via the "Roll key" button if it's
ever exposed.

---

## Step 2 — Paste keys into `.env`

The file is at `arenabots-server/.env`. It's gitignored; it never leaves
your machine.

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
# leave STRIPE_WEBHOOK_SECRET blank for now — step 4 fills it in
STRIPE_WEBHOOK_SECRET=

# where Stripe Checkout redirects after the buy flow
PUBLIC_BASE_URL=http://localhost:8765
```

Leave all `STRIPE_PRICE_*` lines blank. The next step fills them in
automatically.

---

## Step 3 — Seed products + prices (one command)

```bash
cd arenabots-server
node scripts/seed-stripe-products.js
```

This script:

- Reads your secret key from `.env`.
- Creates all 7 Products + Prices in your Stripe account:
  - `crowns.starter` ($1.99 one-time, +100 crowns)
  - `crowns.plus`    ($4.99 one-time, +360 crowns)
  - `crowns.pro`     ($9.99 one-time, +900 crowns)
  - `crowns.elite`   ($19.99 one-time, +2000 crowns)
  - `pro.monthly`    ($4.99/mo subscription)
  - `pro.yearly`     ($39.99/yr subscription)
  - `pro.lifetime`   ($79.99 one-time)
- Writes each `price_...` id back into `.env` under the matching
  `STRIPE_PRICE_*` variable.
- Is **idempotent**: running it again reuses existing products (matched by
  the `arenabots_sku` metadata) and only creates a new Price if the amount
  or interval has changed.

Open the Stripe Dashboard afterwards → **Products** — you'll see all seven
listed.

---

## Step 4 — Set up the webhook (required for fulfillment)

Purchases are fulfilled **only** when Stripe sends a webhook. The redirect
URL is never trusted — an attacker could forge it, so we always wait for
`checkout.session.completed` / `invoice.paid` events over the webhook.

### Local development

Use the [Stripe CLI](https://docs.stripe.com/stripe-cli):

```bash
# one-time install
scoop install stripe        # Windows
# or: brew install stripe/stripe-cli/stripe   # macOS
# or: see https://docs.stripe.com/stripe-cli

# one-time login
stripe login

# start forwarding webhooks → your local server
stripe listen --forward-to localhost:2567/api/stripe/webhook
```

The CLI prints a line like `> Ready! Your webhook signing secret is whsec_...`.
Copy that value into `.env`:

```env
STRIPE_WEBHOOK_SECRET=whsec_...
```

Keep `stripe listen` running in its own terminal for the whole dev session.

### Production

1. In Stripe Dashboard → **Developers → Webhooks → Add endpoint**.
2. URL: `https://your-server.example.com/api/stripe/webhook`.
3. Events to send: check all of these:
   - `checkout.session.completed`
   - `invoice.paid`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Click **Add endpoint**, then reveal the **Signing secret** — paste into
   `STRIPE_WEBHOOK_SECRET` on the production host (Render environment vars,
   not `.env` in the container image).

---

## Step 5 — Test a purchase

1. Restart the server: `node src/index.js`. Logs should show Stripe is
   active when you hit `/api/products` (`"enabled": true`).
2. Open the client (`http://localhost:8765`) and **sign in** or create an
   account. (You must be signed in to purchase — real payments attach to a
   persisted account.)
3. Click **Pro Store** → **Plus Crown Pack**.
4. Confirm the Stripe Checkout redirect.
5. Use a test card:

   | Card number           | Scenario |
   | --------------------- | -------- |
   | `4242 4242 4242 4242` | Success |
   | `4000 0000 0000 9995` | Decline (insufficient funds) |
   | `4000 0025 0000 3155` | Requires 3D Secure |
   | Any future expiry, any 3-digit CVC, any postal/ZIP | |

6. Stripe redirects you back to the game. The client polls
   `/api/entitlements` for ~10s; you'll see a toast `+360 Crowns added to
   your account!` once the webhook lands.
7. Reload the page — crowns persist. Sign out → sign in on another device
   (or another browser) — crowns still persist, tied to the account.

### Subscription test

Buy **Pro Pass Monthly**. Stripe creates a subscription. On a test clock
the first invoice settles instantly; you'll see the ★ PRO badge and a
`pro_until` ~30 days from now. Cancel from Stripe Dashboard → customers
→ subscriptions, and `customer.subscription.deleted` removes the badge.

---

## Going live

Once everything works in test mode:

1. Flip the Stripe Dashboard toggle to **Live mode**.
2. Regenerate prod API keys (`sk_live_...` / `pk_live_...`) and put them in
   the **production** environment (not in `.env` — use the hosting
   provider's secret manager).
3. Re-run `node scripts/seed-stripe-products.js` against the live key so
   the same 7 products exist in your live Stripe account. The new `price_...`
   IDs go into your production env.
4. Register a **live-mode webhook** at the production URL per Step 4.
5. **Tax compliance** is your responsibility (Stripe is not a Merchant of
   Record). Depending on your jurisdiction you may need to register for
   sales tax / VAT / GST. Stripe Tax ($0 until you opt in) can calculate
   and collect it automatically. See <https://stripe.com/tax>.

---

## Troubleshooting

**`/api/checkout/create` returns 503**
→ `STRIPE_SECRET_KEY` empty in `.env`. Paste it, restart.

**`/api/checkout/create` returns 400 "no price configured"**
→ The `STRIPE_PRICE_*` env var for that SKU is empty. Re-run the seeder.

**`stripe listen` prints signature errors when I buy something**
→ `STRIPE_WEBHOOK_SECRET` doesn't match. Copy the `whsec_...` from the CLI
output into `.env` and restart the server.

**Crowns never appear after a successful payment**
→ Webhook didn't reach the server. Check `stripe listen` is still running
and pointing at port 2567.

**I bought something in live mode by accident**
→ Refund from Stripe Dashboard → Payments → find the charge → Refund. Then
rotate your live API key.

---

## Architecture reference

```
Client (js/payments.js)
   │
   │ 1. POST /api/checkout/create   (Bearer JWT)
   ▼
Server (src/payments/stripe.js)
   │
   │ 2. Creates Stripe Customer (if new) + Checkout Session
   ▼
Stripe Checkout
   │
   │ 3. User pays
   │
   │ 4. Stripe POSTs webhook → /api/stripe/webhook
   ▼
Server webhook handler
   │
   │ 5. Verifies signature, grants entitlements in db
   │
   │ 6. User's browser redirects back to PUBLIC_BASE_URL?stripe_session=...
   ▼
Client (js/payments.js detectReturn)
   │
   │ 7. Polls /api/entitlements until crowns/pro update visible
   │
   │ 8. Shows success toast, balance HUD updates
```

Key guarantees:

- **Fulfillment is webhook-driven**, never redirect-driven. Forging the
  return URL does nothing.
- **Events are idempotent**: each Stripe `event.id` is stored in the
  purchase history; re-delivery doesn't double-grant.
- **Subscriptions auto-renew**: each renewal fires `invoice.paid` which
  extends `pro_until` to the new `current_period_end`.
- **Cancellations respect the paid period**: `customer.subscription.deleted`
  sets `pro_until` to the subscription's `current_period_end`, so users
  keep what they paid for until the period ends.
