// JSON-file persistence — pure JS, no native deps. Suitable for
// hundreds-of-accounts scale; swap for Postgres/Turso when justified.
//
// Design:
//   - All state held in memory; written through to a single JSON file on
//     every mutation (debounced 200ms to coalesce bursts).
//   - Atomic writes via temp-file + rename to survive crashes.
//   - API surface mirrors what a SQL impl would expose so we can swap
//     the backend later without touching auth.js.

const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.DB_FILE
  || path.join(__dirname, '..', '..', 'arenabots.db.json');

// In-memory store
const state = {
  nextId: 1,
  accounts: {},   // id -> account
  byUsername: {}, // lowercase username -> id
  stats: {},      // accountId -> stats
};

loadFromDisk();

let writeTimer = null;
function persist() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(writeToDisk, 200);
}

function writeToDisk() {
  writeTimer = null;
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[db] writeToDisk failed:', err.message);
  }
}

function loadFromDisk() {
  if (!fs.existsSync(DB_FILE)) {
    console.log(`[db] starting fresh at ${DB_FILE}`);
    return;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const obj = JSON.parse(raw);
    Object.assign(state, obj);
    console.log(`[db] loaded ${Object.keys(state.accounts).length} accounts from ${DB_FILE}`);
  } catch (err) {
    console.warn(`[db] failed to read ${DB_FILE}: ${err.message} — starting fresh`);
  }
}

// Flush on graceful shutdown so no writes are lost.
for (const sig of ['SIGINT', 'SIGTERM', 'beforeExit']) {
  process.on(sig, () => { if (writeTimer) writeToDisk(); });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
function createAccount(username, passwordHash, displayName) {
  const key = username.toLowerCase();
  if (state.byUsername[key]) throw new Error('username taken');
  const id = state.nextId++;
  const created_at = new Date().toISOString();
  state.accounts[id] = {
    id,
    username,
    password_hash: passwordHash,
    display_name: displayName,
    created_at,
    stripe_customer_id: null,
  };
  state.byUsername[key] = id;
  state.stats[id] = blankStats(id);
  if (!state.entitlements) state.entitlements = {};
  if (!state.purchases)    state.purchases = {};
  state.entitlements[id] = blankEntitlements(id);
  state.purchases[id] = [];
  persist();
  return id;
}

function findByUsername(username) {
  if (typeof username !== 'string') return null;
  const id = state.byUsername[username.toLowerCase()];
  return id ? state.accounts[id] : null;
}
function findById(id) { return state.accounts[id] || null; }
function getStats(accountId) { return state.stats[accountId] || null; }

function saveStats(accountId, s) {
  if (!state.accounts[accountId]) return;
  state.stats[accountId] = {
    account_id: accountId,
    xp:             s.xp | 0,
    level:          s.level | 0,
    rank_points:    s.rank_points | 0,
    wins:           s.wins | 0,
    losses:         s.losses | 0,
    kills:          s.kills | 0,
    matches_played: s.matches_played | 0,
    streak_current: s.streak_current | 0,
    streak_best:    s.streak_best | 0,
    last_played_at: new Date().toISOString(),
  };
  persist();
}

// Record the outcome of a single match for a player.
// {won: bool, kills: int} → mutates xp/level/rank/streaks/wins/losses/etc.
function recordMatch(accountId, { won, kills } = {}) {
  const s = state.stats[accountId];
  if (!s) return null;
  const k = Math.max(0, kills | 0);
  s.matches_played += 1;
  s.kills += k;
  // XP: base + win bonus + per-kill
  s.xp += 50 + (won ? 100 : 0) + k * 25;
  // Level curve: 100xp -> L1, 400xp -> L2, 900xp -> L3 …
  s.level = 1 + Math.floor(Math.sqrt(s.xp / 100));
  if (won) {
    s.wins += 1;
    s.rank_points += 18;
    s.streak_current += 1;
    if (s.streak_current > s.streak_best) s.streak_best = s.streak_current;
  } else {
    s.losses += 1;
    s.rank_points = Math.max(0, s.rank_points - 12);
    s.streak_current = 0;
  }
  s.last_played_at = new Date().toISOString();
  persist();
  return s;
}

function topLadder(limit = 50) {
  const ids = Object.keys(state.stats);
  return ids
    .map(id => {
      const s = state.stats[id];
      const a = state.accounts[id];
      if (!a) return null;
      return {
        display_name: a.display_name,
        level: s.level,
        rank_points: s.rank_points,
        wins: s.wins,
        kills: s.kills,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.rank_points - a.rank_points) || (b.wins - a.wins))
    .slice(0, limit);
}

function blankStats(accountId) {
  return {
    account_id: accountId,
    xp: 0, level: 1, rank_points: 0,
    wins: 0, losses: 0, kills: 0, matches_played: 0,
    streak_current: 0, streak_best: 0,
    last_played_at: null,
  };
}

function blankEntitlements(accountId) {
  return {
    account_id:    accountId,
    crowns:        0,
    pro_until:     null, // ISO string or null. 'lifetime' for permanent.
    pro_plan:      null, // 'monthly'|'yearly'|'lifetime'
    last_event_at: null,
  };
}

// ---------------------------------------------------------------------------
// Stripe / entitlements API
// ---------------------------------------------------------------------------
function ensurePaymentTables() {
  if (!state.entitlements) state.entitlements = {};
  if (!state.purchases)    state.purchases = {};
  if (!state.byStripeCustomer) state.byStripeCustomer = {};
  // Backfill: any account created before payments existed gets blanks.
  for (const id of Object.keys(state.accounts)) {
    if (!state.entitlements[id]) state.entitlements[id] = blankEntitlements(+id);
    if (!state.purchases[id])    state.purchases[id] = [];
    if (state.accounts[id].stripe_customer_id === undefined) {
      state.accounts[id].stripe_customer_id = null;
    }
  }
}

function setStripeCustomerId(accountId, customerId) {
  const acct = state.accounts[accountId];
  if (!acct) return;
  acct.stripe_customer_id = customerId;
  state.byStripeCustomer[customerId] = accountId;
  persist();
}
function findByStripeCustomerId(customerId) {
  ensurePaymentTables();
  const id = state.byStripeCustomer[customerId];
  return id ? state.accounts[id] : null;
}

function getEntitlements(accountId) {
  ensurePaymentTables();
  return state.entitlements[accountId] || blankEntitlements(accountId);
}

function _ent(accountId) {
  ensurePaymentTables();
  if (!state.entitlements[accountId]) {
    state.entitlements[accountId] = blankEntitlements(accountId);
  }
  return state.entitlements[accountId];
}

function addCrowns(accountId, amount) {
  const e = _ent(accountId);
  e.crowns = Math.max(0, (e.crowns | 0) + (amount | 0));
  e.last_event_at = new Date().toISOString();
  persist();
  return e.crowns;
}
function spendCrowns(accountId, amount) {
  const e = _ent(accountId);
  const cost = Math.max(0, amount | 0);
  if ((e.crowns | 0) < cost) return false;
  e.crowns -= cost;
  e.last_event_at = new Date().toISOString();
  persist();
  return true;
}

function setProUntil(accountId, untilIso, plan) {
  const e = _ent(accountId);
  e.pro_until = untilIso || null;     // null = no pro; 'lifetime' = permanent
  e.pro_plan  = plan || null;
  e.last_event_at = new Date().toISOString();
  persist();
  return e;
}

// Idempotent: same eventId is only applied once.
function recordPurchase(accountId, { eventId, kind, sku, amountCents, currency, mode }) {
  ensurePaymentTables();
  if (!state.purchases[accountId]) state.purchases[accountId] = [];
  const list = state.purchases[accountId];
  if (eventId && list.some(p => p.event_id === eventId)) return false; // dup
  list.push({
    event_id: eventId || null,
    kind, sku,
    amount_cents: amountCents | 0,
    currency: currency || 'usd',
    mode: mode || 'payment',
    at: new Date().toISOString(),
  });
  persist();
  return true;
}

function getPurchaseHistory(accountId) {
  ensurePaymentTables();
  return [...(state.purchases[accountId] || [])];
}

ensurePaymentTables();

module.exports = {
  createAccount, findByUsername, findById,
  getStats, saveStats, recordMatch, topLadder,
  // payments
  setStripeCustomerId, findByStripeCustomerId,
  getEntitlements, addCrowns, spendCrowns,
  setProUntil, recordPurchase, getPurchaseHistory,
};
