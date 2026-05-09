// Auth: signup, login, JWT verification, ladder query.
// Anonymous play is supported — clients can still join rooms without
// a token; stats just won't persist for them.

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const JWT_EXPIRY = '30d';

const router = express.Router();

const USERNAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
const NAME_RE     = /^[A-Za-z0-9 _\-]{1,14}$/;

router.post('/signup', async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!USERNAME_RE.test(username || '')) {
    return res.status(400).json({ error: 'username must be 3-16 chars [A-Za-z0-9_-]' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password must be 6+ chars' });
  }
  const display = displayName || username;
  if (!NAME_RE.test(display)) {
    return res.status(400).json({ error: 'displayName invalid' });
  }
  if (db.findByUsername(username)) {
    return res.status(409).json({ error: 'username taken' });
  }
  const hash = await bcrypt.hash(password, 10);
  const accountId = db.createAccount(username, hash, display);
  const token = sign({ id: accountId, username, name: display });
  return res.json({ token, account: { id: accountId, username, displayName: display } });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const acct = db.findByUsername(username || '');
  if (!acct) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(String(password || ''), acct.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = sign({ id: acct.id, username: acct.username, name: acct.display_name });
  return res.json({
    token,
    account: { id: acct.id, username: acct.username, displayName: acct.display_name },
  });
});

router.get('/me', requireAuth, (req, res) => {
  const acct = db.findById(req.user.id);
  if (!acct) return res.status(404).json({ error: 'account gone' });
  const stats = db.getStats(acct.id) || {};
  const ent = db.getEntitlements(acct.id);
  const proActive = ent.pro_until === 'lifetime'
    || (ent.pro_until && Date.parse(ent.pro_until) > Date.now());
  res.json({
    account: { id: acct.id, username: acct.username, displayName: acct.display_name },
    stats,
    entitlements: {
      crowns:    ent.crowns | 0,
      pro_until: ent.pro_until,
      pro_plan:  ent.pro_plan,
      pro_active: !!proActive,
    },
  });
});

router.get('/ladder', (_req, res) => {
  res.json({ entries: db.topLadder(50) });
});

// ---- helpers ----
function sign(payload) { return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY }); }
function verify(token) { try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; } }

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/i);
  const u = m && verify(m[1]);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.user = u;
  next();
}

module.exports = { router, verify, requireAuth };
