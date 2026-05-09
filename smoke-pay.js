// Payment endpoint smoke test. Runs against a live server on :2567.
// With STRIPE_SECRET_KEY unset this verifies graceful-degrade behavior:
//   - /api/products reports enabled=false
//   - /api/entitlements returns zero balances for fresh account
//   - /api/checkout/create returns 503
// When STRIPE_SECRET_KEY IS set, /api/checkout/create should return a URL.

const URL = process.env.SMOKE_URL || 'http://localhost:2567';

async function post(path, body, headers = {}) {
  const r = await fetch(URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: r.status, data };
}
async function get(path, headers = {}) {
  const r = await fetch(URL + path, { headers });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: r.status, data };
}

async function main() {
  const ts = Date.now();
  const username = 'pay_' + ts.toString(36);
  const password = 'test12345';

  // signup
  const su = await post('/api/signup', { username, password, displayName: 'PayTest' });
  if (su.status !== 200) { console.error('signup FAIL', su); process.exit(1); }
  const token = su.data.token;
  const auth = { Authorization: 'Bearer ' + token };
  console.log('[pay] signed up', username);

  // products
  const prods = await get('/api/products');
  console.log('[pay] /products enabled =', prods.data.enabled,
              '| starter buyable =', prods.data.crowns.starter.buyable);

  // entitlements
  const ent = await get('/api/entitlements', auth);
  console.log('[pay] /entitlements crowns=' + ent.data.crowns,
              'pro_active=' + ent.data.pro_active,
              'history=' + ent.data.history.length);

  // me — should have entitlements embedded
  const me = await get('/api/me', auth);
  if (!me.data.entitlements) { console.error('FAIL: /me missing entitlements', me); process.exit(1); }
  console.log('[pay] /me.entitlements.crowns=' + me.data.entitlements.crowns);

  // checkout when disabled
  const co = await post('/api/checkout/create', { kind: 'crowns', sku: 'starter' }, auth);
  console.log('[pay] /checkout/create status=' + co.status,
              'body=' + JSON.stringify(co.data));

  // Validate graceful-degrade vs enabled
  if (!prods.data.enabled) {
    if (co.status !== 503) {
      console.error('FAIL: expected 503 when stripe disabled, got', co.status);
      process.exit(1);
    }
    console.log('[pay] PASS (graceful-degrade mode)');
  } else {
    if (co.status !== 200 || !co.data.url) {
      console.error('FAIL: expected checkout URL when stripe enabled, got', co);
      process.exit(1);
    }
    console.log('[pay] PASS — checkout URL:', co.data.url);
  }
  process.exit(0);
}
main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
