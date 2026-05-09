// Stripe integration: creates Checkout Sessions, processes webhooks,
// exposes entitlements. Auth-protected — a signed-in account is required
// before anything can be purchased.

const express = require('express');
const Stripe  = require('stripe');

const db = require('../db/db');
const { requireAuth } = require('../auth/auth');
const products = require('./products');

// Lazy init: do not throw if the key is absent, just expose a disabled
// router so the rest of the server keeps working (demo mode).
let stripe = null;
function getStripe() {
  if (stripe) return stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  return stripe;
}

function publicBase() {
  return (process.env.PUBLIC_BASE_URL || 'http://localhost:8765').replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Router: normal JSON routes (mounted under /api)
// ---------------------------------------------------------------------------
const router = express.Router();

// Return the public product catalog + whether Stripe is enabled.
router.get('/products', (_req, res) => {
  res.json(products.listProducts());
});

// Current authenticated player's entitlements (crowns balance, pro_until).
router.get('/entitlements', requireAuth, (req, res) => {
  const ent = db.getEntitlements(req.user.id);
  const history = db.getPurchaseHistory(req.user.id).slice(-20);
  res.json({
    account_id: req.user.id,
    crowns:    ent.crowns | 0,
    pro_until: ent.pro_until,
    pro_plan:  ent.pro_plan,
    pro_active: isProActive(ent),
    history,
  });
});

// Create a Checkout Session. Body: { kind: 'crowns'|'pro', sku: string }
router.post('/checkout/create', requireAuth, async (req, res) => {
  const s = getStripe();
  if (!s) return res.status(503).json({ error: 'payments disabled (no STRIPE_SECRET_KEY)' });
  const { kind, sku } = req.body || {};
  const meta = products.getSku(kind, sku);
  if (!meta) return res.status(400).json({ error: 'unknown sku' });
  if (!meta.priceId) {
    return res.status(400).json({
      error: `no price configured for ${kind}/${sku} — set env ${products.SKUS[kind][sku].envPrice}`,
    });
  }

  // Reuse or create Stripe customer tied to this account.
  const acct = db.findById(req.user.id);
  let customerId = acct && acct.stripe_customer_id;
  if (!customerId) {
    const customer = await s.customers.create({
      name:     acct.display_name,
      metadata: { account_id: String(acct.id), username: acct.username },
    });
    customerId = customer.id;
    db.setStripeCustomerId(acct.id, customerId);
  }

  const base = publicBase();
  const successUrl = `${base}/?stripe_session={CHECKOUT_SESSION_ID}&kind=${encodeURIComponent(kind)}&sku=${encodeURIComponent(sku)}`;
  const cancelUrl  = `${base}/?stripe_cancel=1`;

  const session = await s.checkout.sessions.create({
    mode: meta.mode,
    customer: customerId,
    client_reference_id: String(acct.id),
    line_items: [{ price: meta.priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url:  cancelUrl,
    metadata: {
      account_id: String(acct.id),
      kind, sku,
    },
    // For subscriptions, remember which plan was purchased so the webhook
    // can resolve the SKU even if the priceId ever changes.
    subscription_data: meta.mode === 'subscription'
      ? { metadata: { account_id: String(acct.id), kind, sku } }
      : undefined,
  });

  res.json({ id: session.id, url: session.url });
});

// ---------------------------------------------------------------------------
// Webhook handler (must be mounted with raw body parser, not JSON!)
// ---------------------------------------------------------------------------
async function webhookHandler(req, res) {
  const s = getStripe();
  if (!s) return res.status(503).send('payments disabled');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[stripe] STRIPE_WEBHOOK_SECRET not set — refusing webhook');
    return res.status(500).send('webhook secret not configured');
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = s.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.warn('[stripe] webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(s, event);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(s, event);
        break;
      case 'customer.subscription.deleted':
      case 'customer.subscription.updated':
        await handleSubscriptionChange(s, event);
        break;
      default:
        // Unhandled event types are fine — just acknowledge.
        break;
    }
  } catch (err) {
    console.error('[stripe] handler for', event.type, 'failed:', err);
    // Returning 500 tells Stripe to retry.
    return res.status(500).send('handler error');
  }

  res.json({ received: true });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

// One-time payments (crowns pack, pro lifetime): fulfill here.
// Subscriptions: we also receive this (session.mode === 'subscription') but
// fulfillment happens via invoice.paid for the first period.
async function handleCheckoutCompleted(stripe, event) {
  const session = event.data.object;
  const md = session.metadata || {};
  const accountId = parseInt(md.account_id || session.client_reference_id || '0', 10);
  if (!accountId) return;

  // Subscriptions are fulfilled on invoice.paid to capture renewals too.
  if (session.mode === 'subscription') return;

  const sku = products.getSku(md.kind, md.sku);
  if (!sku) {
    console.warn('[stripe] checkout.session.completed with unknown sku', md);
    return;
  }

  const applied = db.recordPurchase(accountId, {
    eventId:     event.id,
    kind:        sku.kind,
    sku:         sku.sku,
    amountCents: session.amount_total | 0,
    currency:    session.currency || 'usd',
    mode:        session.mode,
  });
  if (!applied) return; // already processed

  if (sku.kind === 'crowns') {
    db.addCrowns(accountId, sku.crowns + sku.bonus);
  } else if (sku.kind === 'pro' && sku.sku === 'lifetime') {
    db.setProUntil(accountId, 'lifetime', 'lifetime');
  }
  console.log(`[stripe] granted ${sku.kind}/${sku.sku} to account ${accountId}`);
}

// Subscription first payment and every renewal arrives as invoice.paid.
async function handleInvoicePaid(stripe, event) {
  const invoice = event.data.object;
  if (!invoice.subscription) return;        // only care about subscription invoices
  const sub = await stripe.subscriptions.retrieve(invoice.subscription);
  const md  = sub.metadata || {};
  let accountId = parseInt(md.account_id || '0', 10);
  if (!accountId) {
    // Fallback: look up by Stripe customer id.
    const acct = db.findByStripeCustomerId(sub.customer);
    if (acct) accountId = acct.id;
  }
  if (!accountId) return;

  // Resolve SKU either from metadata or by priceId lookup.
  const priceId = sub.items.data[0]?.price?.id;
  const sku = products.getSku(md.kind, md.sku) || products.findSkuByPriceId(priceId);
  if (!sku) return;

  const applied = db.recordPurchase(accountId, {
    eventId:     event.id,
    kind:        sku.kind,
    sku:         sku.sku,
    amountCents: invoice.amount_paid | 0,
    currency:    invoice.currency || 'usd',
    mode:        'subscription',
  });
  if (!applied) return;

  const untilIso = new Date(sub.current_period_end * 1000).toISOString();
  db.setProUntil(accountId, untilIso, sku.sku);
  console.log(`[stripe] pro ${sku.sku} active until ${untilIso} for account ${accountId}`);
}

async function handleSubscriptionChange(stripe, event) {
  const sub = event.data.object;
  const md  = sub.metadata || {};
  let accountId = parseInt(md.account_id || '0', 10);
  if (!accountId) {
    const acct = db.findByStripeCustomerId(sub.customer);
    if (acct) accountId = acct.id;
  }
  if (!accountId) return;

  if (event.type === 'customer.subscription.deleted' || sub.status === 'canceled') {
    // Subscription ended: revoke pro at the end of the paid period.
    const until = sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : new Date().toISOString();
    db.setProUntil(accountId, until, md.sku || 'monthly');
    console.log(`[stripe] pro expires ${until} for account ${accountId} (sub canceled)`);
    return;
  }

  // Active subscription update (e.g. renewal scheduled, plan change).
  if (sub.status === 'active' || sub.status === 'trialing') {
    const until = new Date(sub.current_period_end * 1000).toISOString();
    db.setProUntil(accountId, until, md.sku || null);
  }
  if (sub.status === 'past_due' || sub.status === 'unpaid') {
    // Don't revoke yet — let Stripe Smart Retries handle it. We keep pro_until
    // at the current period end; once it passes, isProActive() returns false.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isProActive(ent) {
  if (!ent || !ent.pro_until) return false;
  if (ent.pro_until === 'lifetime') return true;
  return Date.parse(ent.pro_until) > Date.now();
}

module.exports = { router, webhookHandler, isProActive };
