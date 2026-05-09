// Smoke test: simulates 2 clients joining arena_ffa concurrently and
// observes the lobby → countdown → active phase transition. Run while
// the server is up:
//   node smoke-mp.js
//
// Exit code 0 = pass, 1 = fail.

const { Client } = require('colyseus.js');

const URL = process.env.SMOKE_URL || 'ws://localhost:2567';
const TIMEOUT_MS = 12_000;

async function main() {
  const client = new Client(URL);
  console.log(`[smoke] connecting two players to ${URL}`);

  const loadout = (color, chassis) => ({
    chassis, weapon: 'spinner', color, accent: '#ffffff', pattern: 'solid',
    stats: { armor: 4, speed: 4, power: 3, weight: 3 },
  });

  const a = await client.joinOrCreate('arena_ffa', {
    name: 'BotA', loadout: loadout('#ff6a00', 'brick'),
  });
  console.log(`[smoke] A joined room ${a.roomId} sid=${a.sessionId}`);
  const b = await client.joinOrCreate('arena_ffa', {
    name: 'BotB', loadout: loadout('#36c5ff', 'tank'),
  });
  console.log(`[smoke] B joined room ${b.roomId} sid=${b.sessionId}`);

  if (a.roomId !== b.roomId) {
    console.error('[smoke] ERROR: clients landed in different rooms');
    process.exit(1);
  }

  const seenPhases = new Set();
  let resolved = false;
  const phaseTransitions = [];

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (!resolved) reject(new Error('timeout waiting for phases'));
    }, TIMEOUT_MS);

    function check(state) {
      if (!state || !state.phase) return;
      if (!seenPhases.has(state.phase)) {
        seenPhases.add(state.phase);
        phaseTransitions.push({ phase: state.phase, t: Date.now() });
        console.log(`[smoke] phase -> ${state.phase} (timer=${state.timer.toFixed(1)}, bots=${state.bots.size})`);
      }
      if (state.phase === 'active') {
        // Send a few inputs from A to confirm input pipeline works.
        try { a.send('input', { throttle: 1, turn: 0.4, fire: false }); } catch (_) {}
      }
      if (seenPhases.has('countdown') && seenPhases.has('active')) {
        resolved = true;
        clearTimeout(t);
        resolve();
      }
    }

    a.onStateChange(check);
    b.onStateChange(check);
  });

  console.log('[smoke] OK — observed phases:', [...seenPhases].join(', '));

  await a.leave(true).catch(() => {});
  await b.leave(true).catch(() => {});
  process.exit(0);
}

main().catch(err => {
  console.error('[smoke] FAIL:', err.message);
  process.exit(1);
});
