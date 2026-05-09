// Smoke test: sign up a user, join the arena with that JWT, and confirm
// the room accepts auth (anonymous parallel join should also work).
//   node smoke-auth.js

const { Client } = require('colyseus.js');

const URL_HTTP = process.env.SMOKE_HTTP || 'http://localhost:2567';
const URL_WS   = process.env.SMOKE_WS   || 'ws://localhost:2567';

async function postJson(path, body) {
  const res = await fetch(URL_HTTP + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  // Make a fresh user to avoid clashing with existing accounts.
  const username = 'smoke_' + Math.floor(Math.random() * 1e9).toString(36);
  console.log('[smoke-auth] signup', username);
  const su = await postJson('/api/signup', {
    username, password: 'smoke12345', displayName: username.toUpperCase(),
  });
  if (!su.ok) {
    console.error('[smoke-auth] signup FAIL', su.status, su.data);
    process.exit(1);
  }
  const token = su.data.token;
  console.log('[smoke-auth] signup OK, token len', token.length);

  // Join WITH auth.
  const client = new Client(URL_WS);
  const loadout = {
    chassis: 'brick', weapon: 'spinner',
    color: '#ff6a00', accent: '#ffffff', pattern: 'solid',
    stats: { armor: 4, speed: 4, power: 3, weight: 3 },
  };
  const authed = await client.joinOrCreate('arena_ffa', {
    name: 'AuthBot', loadout, token,
  });
  console.log('[smoke-auth] authed sid', authed.sessionId);

  // Companion (anonymous) so the room would normally trigger a countdown.
  const guest = await client.joinOrCreate('arena_ffa', {
    name: 'Guest', loadout,
  });
  console.log('[smoke-auth] guest sid', guest.sessionId);

  // Wait briefly so server attaches state, then check both bots present.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('state timeout')), 5000);
    authed.onStateChange.once(s => {
      const names = [];
      s.bots.forEach(b => names.push(b.name));
      console.log('[smoke-auth] state seen, bots:', names.join(', '));
      clearTimeout(t);
      resolve();
    });
  });

  await authed.leave(true).catch(() => {});
  await guest.leave(true).catch(() => {});

  // Verify /api/me works with the token.
  const meRes = await fetch(URL_HTTP + '/api/me', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!meRes.ok) {
    console.error('[smoke-auth] /api/me FAIL', meRes.status);
    process.exit(1);
  }
  const me = await meRes.json();
  console.log('[smoke-auth] /api/me OK, level=' + me.stats.level + ' xp=' + me.stats.xp);

  console.log('[smoke-auth] PASS');
  process.exit(0);
}

main().catch(err => {
  console.error('[smoke-auth] FAIL:', err.message);
  process.exit(1);
});
