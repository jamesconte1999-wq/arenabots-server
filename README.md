# arenabots-server

Authoritative realtime multiplayer server for **ArenaBots.io**.
Node.js + [Colyseus](https://colyseus.io) + SQLite.

## What it does

- **Authoritative simulation** of FFA combat-bot arenas (8 players max).
- **State sync** at 20 Hz over WebSocket (delta-encoded via Colyseus schemas).
- **Accounts** with password auth, JWT sessions.
- **Persistent stats** — XP, level, rank points, wins, losses, kills, streaks.
- **Top-50 ladder** REST endpoint.
- **Colyseus monitor** dashboard at `/colyseus` for live debugging.

## Local development

Requires Node.js 18+.

```pwsh
cd arenabots-server
npm install
copy .env.example .env       # then edit JWT_SECRET to something random
npm run dev
```

Server boots on `http://localhost:2567`. Useful URLs:

| URL | Purpose |
|---|---|
| `http://localhost:2567/` | Health JSON |
| `http://localhost:2567/colyseus` | Live admin dashboard |
| `ws://localhost:2567` | Colyseus client connection |
| `POST /api/signup` | Create account → JWT |
| `POST /api/login` | Login → JWT |
| `GET /api/me` (Bearer token) | Current account + stats |
| `GET /api/ladder` | Top 50 by rank points |

## Architecture

```
src/
  index.js              Express + Colyseus boot
  rooms/
    ArenaRoom.js        Authoritative FFA room (lobby/countdown/active/result)
    gameData.js         Chassis + weapon stat tables (mirrors client config)
  schema/
    ArenaState.js       Colyseus schema synced to clients
  auth/
    auth.js             Signup, login, /me, /ladder, JWT
  db/
    db.js               SQLite (better-sqlite3) with WAL journaling
```

## Tick budget

| Setting | Value |
|---|---|
| Simulation tick rate | 30 Hz |
| State broadcast rate | 20 Hz (delta-encoded) |
| Max clients per room | 8 |
| Match duration | 90 s |
| Pre-match countdown | 5 s |
| Post-match scoreboard | 6 s |

## Client integration

The client connects with the [`colyseus.js`](https://www.npmjs.com/package/colyseus.js) browser SDK. Sketch:

```js
import { Client } from 'colyseus.js';
const client = new Client('ws://localhost:2567');
const room = await client.joinOrCreate('arena_ffa', {
  name: 'YOU',
  loadout: { chassis: 'wedge', weapon: 'spinner', stats: {...}, color, accent, pattern },
});
room.onStateChange(state => render(state));
room.send('input', { throttle, turn, fire });
room.onMessage('match-end', payload => showResult(payload));
```

See `arenabots-arena/MULTIPLAYER.md` for the full client roadmap.

## Deployment to Render.com

The included `render.yaml` is an Infrastructure-as-Code blueprint:

1. Push this folder to a GitHub repo.
2. In Render, **New → Blueprint**, select the repo.
3. Render reads `render.yaml`, provisions the service, mounts the persistent
   disk for `arenabots.db`, and generates a `JWT_SECRET`.
4. After the first deploy, set `ALLOWED_ORIGINS` in the dashboard to your
   frontend domain (e.g. `https://arenabots-arena.netlify.app`).
5. Update the client's `WS_URL` to `wss://your-service.onrender.com`.

**Cost note:** the FREE Render plan sleeps after ~15 min of inactivity, which
breaks live matches. Use the **Starter** plan (~$7/mo) for a real deployment.

## Security checklist (production)

- [ ] Set a long random `JWT_SECRET` (the `render.yaml` does this automatically).
- [ ] Lock `ALLOWED_ORIGINS` to the actual frontend domain.
- [ ] Add per-IP rate limiting on `/api/signup` + `/api/login` (e.g. `express-rate-limit`).
- [ ] Server-side input validation (already done via `clamp()` and `sanitizeLoadout`).
- [ ] Never trust client-submitted positions — only inputs (already enforced).
- [ ] HTTPS / WSS only — Render gives you this for free.
- [ ] Backups for `arenabots.db` (Render disk snapshots).
