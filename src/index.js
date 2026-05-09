// Entry point — boots HTTP + Colyseus together on a single port.
require('dotenv').config();

const http = require('http');
const cors = require('cors');
const express = require('express');
const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { monitor } = require('@colyseus/monitor');

const { ArenaRoom } = require('./rooms/ArenaRoom');
const { router: authRouter } = require('./auth/auth');
const { router: paymentsRouter, webhookHandler } = require('./payments/stripe');

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

// Colyseus monitor (admin dashboard at /colyseus)
app.use('/colyseus', monitor());

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
