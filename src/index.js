// Entry point — boots HTTP + Colyseus together on a single port.
require('dotenv').config();

const http = require('http');
const cors = require('cors');
const express = require('express');
const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { monitor } = require('@colyseus/monitor');

const { ArenaRoom } = require('./rooms/ArenaRoom');
const { router: authRouter, requireAuth } = require('./auth/auth');
const { router: paymentsRouter, webhookHandler } = require('./payments/stripe');
const db = require('./db/db');

const PORT = Number(process.env.PORT) || 2567;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim());

const app = express();
app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  credentials: false,
}));

// IMPORTANT: Stripe webhooks require the RAW request body for signature
// verification. Mount the raw-body handler BEFORE express.json() so the
// JSON parser doesn't consume the stream first.
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  webhookHandler);

app.use(express.json());

// Health
app.get('/', (_req, res) => res.json({
  ok: true, service: 'arenabots-server', version: '0.1.0',
}));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// REST: auth + ladder
app.use('/api', authRouter);
// REST: payments (products, entitlements, checkout)
app.use('/api', paymentsRouter);

// REST: presets (requires auth)
app.get('/api/presets', requireAuth, (req, res) => {
  const userId = req.user.id;
  try {
    const presets = db.getPresets(userId);
    res.json({ presets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/presets', requireAuth, (req, res) => {
  const userId = req.user.id;
  try {
    const { name, spec } = req.body;
    if (!name || !spec) return res.status(400).json({ error: 'Missing name or spec' });
    const presets = db.savePreset(userId, { name, spec });
    res.json({ presets });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/presets/:name', requireAuth, (req, res) => {
  const userId = req.user.id;
  try {
    const presets = db.deletePreset(userId, req.params.name);
    res.json({ presets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Colyseus monitor (admin dashboard at /colyseus)
app.use('/colyseus', monitor());

// TEMPORARY: Admin endpoint to add evelyn account to production
app.post('/admin/add-evelyn', async (req, res) => {
  const ADMIN_SECRET = process.env.ADMIN_SECRET || 'temp-admin-secret-2024';
  const { secret } = req.body;
  
  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  
  const bcrypt = require('bcryptjs');
  const username = 'evelyn';
  const password = 'evelyn123';
  const displayName = 'Evelyn';
  
  try {
    // Check if account exists
    const existing = db.findByUsername(username);
    if (existing) {
      // Update entitlements if exists
      db.setProUntil(existing.id, 'lifetime', 'exclusive');
      db.addCrowns(existing.id, 10000);
      return res.json({ message: 'Updated existing evelyn account', id: existing.id });
    }
    
    // Create new account
    const passwordHash = await bcrypt.hash(password, 10);
    const accountId = db.createAccount(username, passwordHash, displayName);
    db.setProUntil(accountId, 'lifetime', 'exclusive');
    db.addCrowns(accountId, 10000);
    db.saveStats(accountId, {
      xp: 100000,
      level: 32,
      rank_points: 10000,
      wins: 500,
      losses: 50,
      kills: 5000,
      matches_played: 550,
      streak_current: 10,
      streak_best: 50
    });
    
    res.json({ message: 'Created evelyn account', id: accountId, username, password });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TEMPORARY: Admin endpoint to reset password
app.post('/admin/reset-password', async (req, res) => {
  const ADMIN_SECRET = process.env.ADMIN_SECRET || 'temp-admin-secret-2024';
  const { secret, username, newPassword } = req.body;
  
  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  
  const bcrypt = require('bcryptjs');
  
  try {
    const acct = db.findByUsername(username);
    if (!acct) {
      return res.status(404).json({ error: 'account not found' });
    }
    
    const passwordHash = await bcrypt.hash(newPassword, 10);
    
    // Direct mutation since db module doesn't expose password update
    const fs = require('fs');
    const path = require('path');
    const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'arenabots.db.json');
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    data.accounts[acct.id].password_hash = passwordHash;
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    
    res.json({ message: 'Password reset', username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

// Rooms ---------------------------------------------------------------------
gameServer.define('arena_ffa', ArenaRoom);

// Boot ----------------------------------------------------------------------
server.listen(PORT, () => {
  console.log('================================================');
  console.log(`  ArenaBots.io server`);
  console.log(`  HTTP:        http://localhost:${PORT}`);
  console.log(`  WebSocket:   ws://localhost:${PORT}`);
  console.log(`  Monitor UI:  http://localhost:${PORT}/colyseus`);
  console.log(`  Allowed CORS origins: ${allowedOrigins.join(', ')}`);
  console.log('================================================');
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\nReceived ${sig}, shutting down...`);
    await gameServer.gracefullyShutdown();
    process.exit(0);
  });
}
