#!/usr/bin/env node
// Launches `stripe listen` forwarding webhooks to the local server, and
// automatically writes the generated webhook signing secret back into .env.
//
// Usage:
//   node scripts/webhook-forward.js
//
// Keep this running in a terminal for your dev session. On deploy to a
// public URL, register a permanent webhook endpoint in the Stripe Dashboard
// and stop using this script.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const STRIPE_CLI = process.env.STRIPE_CLI
  || (process.platform === 'win32' ? findStripeOnWindows() : 'stripe');
const SECRET = process.env.STRIPE_SECRET_KEY;
const PORT = process.env.PORT || 2567;
const TARGET = `http://localhost:${PORT}/api/stripe/webhook`;

if (!SECRET) {
  console.error('STRIPE_SECRET_KEY not set in .env — paste your secret key first.');
  process.exit(1);
}
if (!STRIPE_CLI) {
  console.error('Stripe CLI binary not found. Install with `winget install Stripe.StripeCli`');
  console.error('or download from https://github.com/stripe/stripe-cli/releases');
  process.exit(1);
}

console.log(`[webhook] forwarding Stripe webhooks → ${TARGET}`);
console.log(`[webhook] using CLI: ${STRIPE_CLI}`);

const child = spawn(STRIPE_CLI, ['listen', '--forward-to', TARGET], {
  env: { ...process.env, STRIPE_API_KEY: SECRET },
  stdio: ['inherit', 'pipe', 'pipe'],
});

let secretWritten = false;
function handle(buf) {
  const str = buf.toString();
  process.stdout.write(str);
  if (!secretWritten) {
    const m = str.match(/(whsec_[A-Za-z0-9]+)/);
    if (m) {
      secretWritten = true;
      writeEnv('STRIPE_WEBHOOK_SECRET', m[1]);
      console.log(`\n[webhook] ✓ wrote STRIPE_WEBHOOK_SECRET=${m[1].slice(0, 12)}... into .env`);
      console.log('[webhook] ✓ RESTART the server (Ctrl+C, node src/index.js) to pick it up.');
      console.log('[webhook]   Keep THIS terminal open — it forwards webhooks to your local server.\n');
    }
  }
}
child.stdout.on('data', handle);
child.stderr.on('data', handle);
child.on('exit', (code) => {
  console.log(`[webhook] stripe listen exited (${code})`);
  process.exit(code || 0);
});

// ---------------------------------------------------------------------------
function writeEnv(key, value) {
  const envPath = path.resolve(__dirname, '..', '.env');
  let env = fs.readFileSync(envPath, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(env)) env = env.replace(re, `${key}=${value}`);
  else env += `\n${key}=${value}\n`;
  fs.writeFileSync(envPath, env);
}
function findStripeOnWindows() {
  // Try PATH first — works after a shell restart post-winget install.
  const { spawnSync } = require('child_process');
  const r = spawnSync('where', ['stripe'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout) {
    return r.stdout.split(/\r?\n/)[0].trim();
  }
  // Fallback: common winget-managed install path.
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(local, 'Microsoft', 'WinGet', 'Packages',
      'Stripe.StripeCli_Microsoft.Winget.Source_8wekyb3d8bbwe', 'stripe.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}
