#!/usr/bin/env node
// Seeds the Arenabots product catalog into your Stripe account and writes
// the resulting price IDs back into .env. Run once:
//
//   node scripts/seed-stripe-products.js
//
// Idempotent: if a product with the same internal `metadata.arenabots_sku`
// already exists, we reuse it and attach a new price only if the amount or
// billing interval has changed.

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const Stripe = require('stripe');
const { SKUS } = require('../src/payments/products');

const SECRET = process.env.STRIPE_SECRET_KEY;
if (!SECRET) {
  console.error('STRIPE_SECRET_KEY not set — paste it into .env first.');
  process.exit(1);
}
if (!SECRET.startsWith('sk_test_') && !SECRET.startsWith('sk_live_')) {
  console.error('STRIPE_SECRET_KEY does not look like a Stripe key.');
  process.exit(1);
}

const LIVE = SECRET.startsWith('sk_live_');
const stripe = new Stripe(SECRET, { apiVersion: '2024-06-20' });

const ENV_PATH = path.resolve(__dirname, '..', '.env');

// ---------------------------------------------------------------------------
// Catalog definition: derives from SKUS (the same source the runtime uses).
// ---------------------------------------------------------------------------
const CATALOG = [];
for (const kind of Object.keys(SKUS)) {
  for (const sku of Object.keys(SKUS[kind])) {
    const meta = SKUS[kind][sku];
    CATALOG.push({
      kind, sku,
      envKey: meta.envPrice,
      name:   productName(kind, sku, meta),
      description: productDesc(kind, sku, meta),
      unit_amount: Math.round(meta.usd * 100),
      currency: 'usd',
      recurring: meta.mode === 'subscription'
        ? { interval: sku === 'yearly' ? 'year' : 'month' }
        : undefined,
      metadata: { arenabots_sku: `${kind}.${sku}` },
    });
  }
}

function productName(kind, sku, meta) {
  if (kind === 'crowns') return `Arenabots — ${meta.label} Crown Pack`;
  if (kind === 'pro')    return `Arenabots Pro Pass — ${meta.label}`;
  return `Arenabots ${kind}.${sku}`;
}
function productDesc(kind, sku, meta) {
  if (kind === 'crowns') {
    const total = (meta.crowns || 0) + (meta.bonus || 0);
    return `${total} Crowns (${meta.crowns} base${meta.bonus ? ` + ${meta.bonus} bonus` : ''}). Premium in-game currency.`;
  }
  if (kind === 'pro' && sku === 'lifetime') return 'Arenabots Pro Pass — permanent unlock of every premium cosmetic, 2x match rewards.';
  if (kind === 'pro') return `Arenabots Pro Pass (${meta.label}). Unlock every premium cosmetic + 2x match rewards while active.`;
  return '';
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`[seed] mode: ${LIVE ? 'LIVE 💸' : 'TEST 🧪'}`);
  if (LIVE) {
    console.log('[seed] WARNING: you are seeding into a LIVE Stripe account.');
    console.log('[seed] Products will appear in your real dashboard and be sellable to real customers.');
  }

  // 1. Find-or-create each Product by arenabots_sku metadata.
  const products = await stripe.products.search({
    query: `metadata['arenabots_sku']:'crowns.starter' OR metadata['arenabots_sku']:'crowns.plus' OR metadata['arenabots_sku']:'crowns.pro' OR metadata['arenabots_sku']:'crowns.elite' OR metadata['arenabots_sku']:'pro.monthly' OR metadata['arenabots_sku']:'pro.yearly' OR metadata['arenabots_sku']:'pro.lifetime'`,
    limit: 50,
  });
  const byKey = new Map();
  for (const p of products.data) byKey.set(p.metadata.arenabots_sku, p);

  const results = [];
  for (const entry of CATALOG) {
    const key = `${entry.kind}.${entry.sku}`;
    let product = byKey.get(key);
    if (product) {
      console.log(`[seed] reuse   product ${product.id}  ${key}`);
      // Keep name/description in sync in case we tweak copy.
      if (product.name !== entry.name || product.description !== entry.description) {
        product = await stripe.products.update(product.id, {
          name: entry.name, description: entry.description,
        });
      }
    } else {
      product = await stripe.products.create({
        name: entry.name,
        description: entry.description,
        metadata: entry.metadata,
      });
      console.log(`[seed] created product ${product.id}  ${key}`);
    }

    // 2. Find-or-create a Price matching unit_amount + recurring config.
    const existing = await stripe.prices.list({ product: product.id, active: true, limit: 10 });
    const wantInterval = entry.recurring ? entry.recurring.interval : null;
    let price = existing.data.find(p =>
      p.unit_amount === entry.unit_amount
      && p.currency === entry.currency
      && ((p.recurring && p.recurring.interval) || null) === wantInterval
    );
    if (!price) {
      const opts = {
        product: product.id,
        unit_amount: entry.unit_amount,
        currency: entry.currency,
        metadata: entry.metadata,
      };
      if (entry.recurring) opts.recurring = entry.recurring;
      price = await stripe.prices.create(opts);
      console.log(`[seed] created price   ${price.id}  $${(entry.unit_amount/100).toFixed(2)} ${wantInterval || 'one-time'}`);
    } else {
      console.log(`[seed] reuse   price   ${price.id}  $${(entry.unit_amount/100).toFixed(2)} ${wantInterval || 'one-time'}`);
    }
    results.push({ envKey: entry.envKey, priceId: price.id, sku: key });
  }

  // 3. Patch .env with the price IDs.
  if (fs.existsSync(ENV_PATH)) {
    let env = fs.readFileSync(ENV_PATH, 'utf8');
    for (const r of results) {
      const re = new RegExp(`^${r.envKey}=.*$`, 'm');
      if (re.test(env)) {
        env = env.replace(re, `${r.envKey}=${r.priceId}`);
      } else {
        env += `\n${r.envKey}=${r.priceId}`;
      }
    }
    fs.writeFileSync(ENV_PATH, env);
    console.log(`[seed] wrote ${results.length} price IDs into ${ENV_PATH}`);
  } else {
    console.log('[seed] NOTE: .env missing — printing price IDs so you can paste them:');
    for (const r of results) console.log(`  ${r.envKey}=${r.priceId}`);
  }

  console.log('[seed] done.');
  process.exit(0);
}

main().catch(err => {
  console.error('[seed] FAIL:', err.message);
  process.exit(1);
});
