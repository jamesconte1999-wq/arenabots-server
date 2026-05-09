// ArenaRoom: authoritative FFA combat-bot match.
// Lifecycle phases:
//   lobby     -> waiting for >=2 players
//   countdown -> 5s pre-match countdown when >=2 players present
//   active    -> match running, ~90s or until <=1 alive
//   result    -> 6s scoreboard, then back to lobby

const { Room } = require('colyseus');
const { ArenaState, BotState } = require('../schema/ArenaState');
const { deriveStats } = require('./gameData');
const db = require('../db/db');
const { verify: verifyJwt } = require('../auth/auth');

const TICK_RATE = 30;        // simulation Hz
const PATCH_RATE = 20;       // state broadcast Hz
const MAX_CLIENTS = 8;
const COUNTDOWN_SECS = 5;
const MATCH_SECS = 90;
const RESULT_SECS = 6;
const ARENA_W = 900;
const ARENA_H = 560;
const WALL = 18;

// Pit + saw hazards mirror client/js/arena.js
const HAZARDS = {
  pit:    { x: ARENA_W / 2, y: ARENA_H / 2, w: 110, h: 70 },
  saws:   [
    { x: 130,           y: 110,           r: 26, ang: 0, spin: 6,  dmg: 14 },
    { x: ARENA_W - 130, y: ARENA_H - 110, r: 26, ang: 0, spin: -6, dmg: 14 },
  ],
  spikes: { x: 60, y: ARENA_H / 2 - 90, w: 18, h: 180, dmg: 12 },
};

class ArenaRoom extends Room {
  onCreate(options) {
    this.maxClients = MAX_CLIENTS;
    this.setState(new ArenaState());
    this.state.phase = 'lobby';
    this.state.timer = 0;
    this.state.matchId = newId();
    this.hazardHits = new Map(); // key -> last dmg tick

    this.setPatchRate(1000 / PATCH_RATE);
    this.setSimulationInterval(
      (dt) => this.update(dt / 1000),
      Math.floor(1000 / TICK_RATE),
    );

    this.onMessage('input', (client, payload) => this.onInput(client, payload));
  }

  // Called BEFORE onJoin. Decode JWT (if any) so the persistent account
  // travels with the client. Anonymous play still allowed: returns true.
  onAuth(client, options = {}) {
    const token = options && typeof options.token === 'string' ? options.token : '';
    if (!token) return { account: null };
    const u = verifyJwt(token);
    if (!u) return { account: null };
    return { account: { id: u.id, username: u.username, name: u.name } };
  }

  // -------------------------------------------------------------------------
  onJoin(client, options = {}) {
    const loadout = sanitizeLoadout(options.loadout || {});
    const derived = deriveStats(loadout);

    const bot = new BotState();
    bot.id = client.sessionId;
    bot.name = sanitizeName(options.name) || 'PLAYER';
    bot.color = String(loadout.color || '#ff6a00').slice(0, 9);
    bot.accent = String(loadout.accent || '#ffffff').slice(0, 9);
    bot.pattern = String(loadout.pattern || 'solid').slice(0, 16);
    bot.chassis = loadout.chassis;
    bot.weapon = loadout.weapon;
    bot.maxHp = derived.maxHp;
    bot.hp = derived.maxHp;
    bot.dead = false;
    bot.score = 0;
    bot.kills = 0;
    bot.derived = derived;

    // Pull the authenticated account (if any) attached by onAuth.
    bot.accountId = (client.auth && client.auth.account && client.auth.account.id) || null;
    if (bot.accountId) {
      // Trust display name from JWT for authenticated players, ignoring the
      // request body so users can't spoof other players' names visually.
      const acctName = sanitizeName(client.auth.account.name);
      if (acctName) bot.name = acctName;
    }

    this.spawnAtRandom(bot);
    this.state.bots.set(client.sessionId, bot);

    console.log(`[ArenaRoom ${this.roomId}] ${bot.name} joined (${this.state.bots.size}/${MAX_CLIENTS})`);

    // First two players trigger countdown
    if (this.state.phase === 'lobby' && this.state.bots.size >= 2) {
      this.startCountdown();
    }
  }

  onLeave(client) {
    const bot = this.state.bots.get(client.sessionId);
    if (bot) console.log(`[ArenaRoom ${this.roomId}] ${bot.name} left`);
    this.state.bots.delete(client.sessionId);
    if (this.state.phase !== 'lobby' && this.state.bots.size < 2) {
      // Not enough players to continue meaningfully; bail to lobby.
      this.toLobby();
    }
  }

  // -------------------------------------------------------------------------
  onInput(client, payload) {
    const bot = this.state.bots.get(client.sessionId);
    if (!bot || bot.dead) return;
    bot.input.throttle = clamp(num(payload?.throttle, 0), -1, 1);
    bot.input.turn     = clamp(num(payload?.turn, 0),     -1, 1);
    bot.input.fire     = !!payload?.fire;
    bot.lastInputAt    = Date.now();
  }

  // -------------------------------------------------------------------------
  // Phase transitions
  // -------------------------------------------------------------------------
  startCountdown() {
    this.state.phase = 'countdown';
    this.state.timer = COUNTDOWN_SECS;
  }
  startMatch() {
    this.state.phase = 'active';
    this.state.timer = MATCH_SECS;
    this.state.matchId = newId();
    this.state.winnerId = '';
    this.hazardHits.clear();
    this.state.bots.forEach(b => {
      b.hp = b.maxHp;
      b.dead = false;
      b.score = 0;
      b.kills = 0;
      b.weaponPhase = 'idle';
      b.weaponCd = 0;
      b.weaponPhaseT = 0;
      b.lastHitMap.clear();
      this.spawnAtRandom(b);
    });
  }
  toResult(winnerId) {
    this.state.phase = 'result';
    this.state.timer = RESULT_SECS;
    this.state.winnerId = winnerId || '';
    if (winnerId) {
      const w = this.state.bots.get(winnerId);
      if (w) w.score += 100;
    }
    // Persist progression for every authenticated participant.
    this.state.bots.forEach(b => {
      if (!b.accountId) return;
      try {
        db.recordMatch(b.accountId, {
          won: b.id === winnerId,
          kills: b.kills | 0,
        });
      } catch (err) {
        console.warn('[ArenaRoom] recordMatch failed:', err.message);
      }
    });
    this.broadcast('match-end', { winnerId, matchId: this.state.matchId });
  }
  toLobby() {
    this.state.phase = 'lobby';
    this.state.timer = 0;
    this.state.winnerId = '';
  }

  // -------------------------------------------------------------------------
  // Per-tick simulation
  // -------------------------------------------------------------------------
  update(dt) {
    this.state.timer = Math.max(0, this.state.timer - dt);

    switch (this.state.phase) {
      case 'lobby':
        if (this.state.bots.size >= 2) this.startCountdown();
        break;
      case 'countdown':
        if (this.state.timer <= 0) this.startMatch();
        else if (this.state.bots.size < 2) this.toLobby();
        break;
      case 'active':
        this.simulate(dt);
        const winnerId = this.evaluateWin();
        if (winnerId !== undefined) this.toResult(winnerId);
        else if (this.state.timer <= 0) this.toResult(this.highestHpId());
        break;
      case 'result':
        if (this.state.timer <= 0) {
          if (this.state.bots.size >= 2) this.startCountdown();
          else this.toLobby();
        }
        break;
    }
  }

  simulate(dt) {
    // 1) Drive each bot
    this.state.bots.forEach(b => this.simBot(b, dt));
    // 2) Wall collisions
    this.state.bots.forEach(b => this.clampToArena(b));
    // 3) Bot-bot collisions (push + ram dmg)
    this.botBotCollisions();
    // 4) Passive weapon contact dmg
    this.passiveWeaponDamage();
    // 5) Active weapon resolution handled inline in simBot
    // 6) Hazards
    this.handleHazards(dt);
  }

  simBot(bot, dt) {
    if (bot.dead) return;

    const d = bot.derived;
    const inp = bot.input;

    // Steering
    bot.angle += clamp(inp.turn, -1, 1) * d.turn * dt;

    // Throttle
    const t = clamp(inp.throttle, -1, 1);
    bot.vx += Math.cos(bot.angle) * d.accel * t * dt;
    bot.vy += Math.sin(bot.angle) * d.accel * t * dt;

    const speed = Math.hypot(bot.vx, bot.vy);
    const max = d.maxSpeed * (t === 0 ? 0.6 : 1);
    if (speed > max) {
      bot.vx *= max / speed;
      bot.vy *= max / speed;
    }
    const drag = t === 0 ? 2.6 : 0.6;
    bot.vx -= bot.vx * drag * dt;
    bot.vy -= bot.vy * drag * dt;

    bot.x += bot.vx * dt;
    bot.y += bot.vy * dt;

    // Active weapon state machine
    const w = d.weaponDef;
    if (w.type === 'active') {
      if (bot.weaponCd > 0) bot.weaponCd -= dt;
      if (bot.weaponPhase === 'idle' && inp.fire && bot.weaponCd <= 0) {
        bot.weaponPhase = 'windup';
        bot.weaponPhaseT = w.windup;
      } else if (bot.weaponPhase === 'windup') {
        bot.weaponPhaseT -= dt;
        if (bot.weaponPhaseT <= 0) {
          bot.weaponPhase = 'active';
          bot.weaponPhaseT = w.active;
          if (!w.dmgTickInterval) this.applyActiveHit(bot);
          else bot._activeDmgT = 0;
        }
      } else if (bot.weaponPhase === 'active') {
        bot.weaponPhaseT -= dt;
        if (w.dmgTickInterval) {
          bot._activeDmgT = (bot._activeDmgT || 0) - dt;
          if (bot._activeDmgT <= 0) {
            bot._activeDmgT = w.dmgTickInterval;
            this.applyActiveHit(bot);
          }
        }
        if (bot.weaponPhaseT <= 0) {
          bot.weaponPhase = 'idle';
          bot.weaponCd = w.cooldown;
        }
      }
    }
  }

  applyActiveHit(bot) {
    const w = bot.derived.weaponDef;
    const reach = bot.derived.radius + w.reach;
    this.state.bots.forEach(t => {
      if (t === bot || t.dead) return;
      const dx = t.x - bot.x, dy = t.y - bot.y;
      const dist = Math.hypot(dx, dy);
      if (dist > reach + t.derived.radius + 12) return;
      const ang = Math.atan2(dy, dx);
      if (Math.abs(angDiff(ang, bot.angle)) > w.arc / 2) return;
      this.damage(t, w.damage * bot.derived.dmgMul, bot.angle, bot);
      const k = w.knockback;
      this.applyImpulse(t, Math.cos(bot.angle) * k, Math.sin(bot.angle) * k);
    });
  }

  passiveWeaponDamage() {
    const now = Date.now() / 1000;
    this.state.bots.forEach(a => {
      if (a.dead) return;
      const w = a.derived.weaponDef;
      if (w.type !== 'passive') return;
      const offsets = w.side
        ? [a.angle + Math.PI / 2, a.angle - Math.PI / 2]
        : [a.angle];
      this.state.bots.forEach(b => {
        if (b === a || b.dead) return;
        for (const oAng of offsets) {
          const reach = a.derived.radius + w.reach;
          const wx = a.x + Math.cos(oAng) * reach;
          const wy = a.y + Math.sin(oAng) * reach;
          const dx = b.x - wx, dy = b.y - wy;
          const dist = Math.hypot(dx, dy);
          if (dist > b.derived.radius + 6) continue;
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          if (Math.abs(angDiff(ang, oAng)) > w.arc / 2) continue;
          const last = a.lastHitMap.get(b.id) || -999;
          if (now - last < w.tickInterval) return;
          a.lastHitMap.set(b.id, now);
          this.damage(b, w.damage * a.derived.dmgMul, oAng, a);
          const k = w.knockback;
          this.applyImpulse(b, Math.cos(oAng) * k, Math.sin(oAng) * k);
          this.applyImpulse(a, -Math.cos(oAng) * w.selfKnockback, -Math.sin(oAng) * w.selfKnockback);
          return;
        }
      });
    });
  }

  botBotCollisions() {
    const arr = [];
    this.state.bots.forEach(b => arr.push(b));
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        if (a.dead || b.dead) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.001;
        const minDist = a.derived.radius + b.derived.radius;
        if (dist >= minDist) continue;
        const nx = dx / dist, ny = dy / dist;
        const overlap = minDist - dist;
        const totalMass = a.derived.mass + b.derived.mass;
        a.x -= nx * overlap * (b.derived.mass / totalMass);
        a.y -= ny * overlap * (b.derived.mass / totalMass);
        b.x += nx * overlap * (a.derived.mass / totalMass);
        b.y += ny * overlap * (a.derived.mass / totalMass);
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel < 0) {
          const k = -rel * 0.4;
          a.vx -= nx * k * (b.derived.mass / totalMass);
          a.vy -= ny * k * (b.derived.mass / totalMass);
          b.vx += nx * k * (a.derived.mass / totalMass);
          b.vy += ny * k * (a.derived.mass / totalMass);
        }
      }
    }
  }

  handleHazards(dt) {
    const now = Date.now() / 1000;
    // Pit (instant KO unless hover)
    this.state.bots.forEach(b => {
      if (b.dead || b.derived.hover) return;
      const p = HAZARDS.pit;
      if (b.x > p.x - p.w / 2 && b.x < p.x + p.w / 2 &&
          b.y > p.y - p.h / 2 && b.y < p.y + p.h / 2) {
        b.hp = 0;
        b.dead = true;
      }
    });
    // Saws
    HAZARDS.saws.forEach((s, i) => {
      this.state.bots.forEach(b => {
        if (b.dead) return;
        const dx = b.x - s.x, dy = b.y - s.y;
        const d = Math.hypot(dx, dy);
        if (d < s.r + b.derived.radius) {
          const key = `saw${i}_${b.id}`;
          const last = this.hazardHits.get(key) || -999;
          if (now - last > 0.25) {
            this.hazardHits.set(key, now);
            this.damage(b, s.dmg, Math.atan2(dy, dx), null);
            this.applyImpulse(b, dx / d * 280, dy / d * 280);
          }
        }
      });
    });
    // Spikes (DoT)
    this.state.bots.forEach(b => {
      if (b.dead || b.derived.hover) return;
      const sp = HAZARDS.spikes;
      if (b.x > sp.x && b.x < sp.x + sp.w + b.derived.radius &&
          b.y > sp.y && b.y < sp.y + sp.h) {
        this.damage(b, sp.dmg * dt, null, null);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Combat helpers
  // -------------------------------------------------------------------------
  damage(target, amount, fromAngle, attacker) {
    if (target.dead) return;
    const totalDeflect = (target.derived.deflect || 0) + (target.derived.frontDeflect || 0);
    if (totalDeflect > 0 && fromAngle != null) {
      const delta = Math.abs(angDiff(target.angle, fromAngle + Math.PI));
      if (delta < Math.PI * 0.55) amount *= 1 - Math.min(0.85, totalDeflect);
    }
    target.hp = Math.max(0, target.hp - amount);
    if (target.hp <= 0 && !target.dead) {
      target.dead = true;
      if (attacker) {
        attacker.kills += 1;
        attacker.score += 50;
      }
    }
  }
  applyImpulse(target, fx, fy) {
    const k = 1 - (target.derived.knockResist || 0);
    target.vx += fx * k / target.derived.mass;
    target.vy += fy * k / target.derived.mass;
  }

  clampToArena(b) {
    const r = b.derived.radius;
    if (b.x < WALL + r) { b.x = WALL + r; b.vx = Math.abs(b.vx) * 0.4; }
    if (b.x > ARENA_W - WALL - r) { b.x = ARENA_W - WALL - r; b.vx = -Math.abs(b.vx) * 0.4; }
    if (b.y < WALL + r) { b.y = WALL + r; b.vy = Math.abs(b.vy) * 0.4; }
    if (b.y > ARENA_H - WALL - r) { b.y = ARENA_H - WALL - r; b.vy = -Math.abs(b.vy) * 0.4; }
  }

  spawnAtRandom(b) {
    // Random spawn well clear of pit + saws.
    let tries = 0;
    while (tries++ < 30) {
      b.x = WALL + 50 + Math.random() * (ARENA_W - WALL * 2 - 100);
      b.y = WALL + 50 + Math.random() * (ARENA_H - WALL * 2 - 100);
      const okPit = Math.hypot(b.x - HAZARDS.pit.x, b.y - HAZARDS.pit.y) > 120;
      const okSaw = HAZARDS.saws.every(s => Math.hypot(b.x - s.x, b.y - s.y) > 80);
      if (okPit && okSaw) break;
    }
    b.angle = Math.random() * Math.PI * 2;
    b.vx = 0; b.vy = 0;
  }

  evaluateWin() {
    let alive = 0, lastAlive = '';
    this.state.bots.forEach(b => { if (!b.dead) { alive++; lastAlive = b.id; } });
    if (this.state.bots.size <= 1) return undefined;
    if (alive === 0) return ''; // draw
    if (alive === 1) return lastAlive;
    return undefined;
  }
  highestHpId() {
    let best = '', bestHp = -1;
    this.state.bots.forEach(b => {
      if (b.hp > bestHp) { bestHp = b.hp; best = b.id; }
    });
    return best;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function num(v, dflt) { return Number.isFinite(v) ? v : dflt; }
function angDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function newId() { return Math.random().toString(36).slice(2, 10); }
function sanitizeName(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[^A-Za-z0-9_\- ]/g, '').trim().slice(0, 14);
}
function sanitizeLoadout(l) {
  const { CHASSIS, WEAPONS } = require('./gameData');
  return {
    chassis: CHASSIS[l.chassis] ? l.chassis : 'brick',
    weapon:  WEAPONS[l.weapon]  ? l.weapon  : 'spinner',
    color:   typeof l.color === 'string' ? l.color : '#ff6a00',
    accent:  typeof l.accent === 'string' ? l.accent : '#ffffff',
    pattern: typeof l.pattern === 'string' ? l.pattern : 'solid',
    stats: {
      armor:  clamp(num(l.stats?.armor,  4), 1, 8),
      speed:  clamp(num(l.stats?.speed,  4), 1, 8),
      power:  clamp(num(l.stats?.power,  3), 1, 8),
      weight: clamp(num(l.stats?.weight, 3), 1, 8),
    },
  };
}

module.exports = { ArenaRoom };
