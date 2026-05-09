// Products: canonical SKU catalog. Public metadata (label, currency amount,
// crowns granted) lives here on the server so the client cannot tamper with
// it. Real Stripe Price IDs come from environment variables — keep them out
// of the repo.
//
// If STRIPE_SECRET_KEY is unset the rest of the system gracefully degrades
// to demo mode (free in-game grants).

const SKUS = {
  // ----- Hard currency packs (one-time payment) -------------------------
  crowns: {
    starter: {
      label: 'Starter',
      crowns: 100, bonus: 0,
      usd: 1.99,
      mode: 'payment',
      envPrice: 'STRIPE_PRICE_CROWNS_STARTER',
    },
    plus: {
      label: 'Plus',
      crowns: 300, bonus: 60, hot: true,
      usd: 4.99,
      mode: 'payment',
      envPrice: 'STRIPE_PRICE_CROWNS_PLUS',
    },
    pro: {
      label: 'Pro Pack',
      crowns: 700, bonus: 200, best: true,
      usd: 9.99,
      mode: 'payment',
      envPrice: 'STRIPE_PRICE_CROWNS_PRO',
    },
    elite: {
      label: 'Elite',
      crowns: 1500, bonus: 500,
      usd: 19.99,
      mode: 'payment',
      envPrice: 'STRIPE_PRICE_CROWNS_ELITE',
    },
  },

  // ----- Pro Pass (subscription for monthly/yearly, one-time for lifetime)
  pro: {
    monthly: {
      label: 'Monthly',
      days: 30,
      usd: 4.99,
      mode: 'subscription',
      envPrice: 'STRIPE_PRICE_PRO_MONTHLY',
    },
    yearly: {
      label: 'Yearly',
      days: 365, savePct: 33, best: true,
      usd: 39.99,
      mode: 'subscription',
      envPrice: 'STRIPE_PRICE_PRO_YEARLY',
    },
    lifetime: {
      label: 'Lifetime',
      days: null,                 // permanent
      usd: 79.99,
      mode: 'payment',
      envPrice: 'STRIPE_PRICE_PRO_LIFETIME',
    },
  },
};

function isStripeEnabled() {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Server-internal lookup: returns full SKU including the resolved price id.
function getSku(kind, sku) {
  const k = SKUS[kind];
  if (!k) return null;
  const meta = k[sku];
  if (!meta) return null;
  return {
    kind, sku,
    label: meta.label,
    usd: meta.usd,
    mode: meta.mode,
    days: meta.days,
    crowns: meta.crowns || 0,
    bonus: meta.bonus || 0,
    priceId: process.env[meta.envPrice] || '',
  };
}

// Iterate every SKU. Useful for the webhook lookup-by-priceId path.
function findSkuByPriceId(priceId) {
  if (!priceId) return null;
  for (const kind of Object.keys(SKUS)) {
    for (const sku of Object.keys(SKUS[kind])) {
      const meta = SKUS[kind][sku];
      if (process.env[meta.envPrice] === priceId) return getSku(kind, sku);
    }
  }
  return null;
}

// Public listing for the client (no env names, no secrets).
function listProducts() {
  const enabled = isStripeEnabled();
  const out = {
    enabled,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    crowns: {},
    pro: {},
  };
  for (const kind of ['crowns', 'pro']) {
    for (const sku of Object.keys(SKUS[kind])) {
      const meta = SKUS[kind][sku];
      const priceId = process.env[meta.envPrice] || '';
      out[kind][sku] = {
        label: meta.label,
        usd: meta.usd,
        crowns: meta.crowns || 0,
        bonus: meta.bonus || 0,
        days: meta.days || null,
        savePct: meta.savePct || null,
        hot: !!meta.hot,
        best: !!meta.best,
        mode: meta.mode,
        // Important: a SKU is buyable only when both Stripe is enabled and
        // a real price id is configured. The client uses this to decide
        // whether to show "Buy" or "Demo" buttons.
        buyable: enabled && !!priceId,
      };
    }
  }
  return out;
}

module.exports = {
  SKUS,
  isStripeEnabled,
  getSku,
  findSkuByPriceId,
  listProducts,
};
