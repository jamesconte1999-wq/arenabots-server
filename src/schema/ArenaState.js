// Colyseus schema definitions — only fields declared with defineTypes
// are sync'd over the wire (delta-encoded). Internal-only fields are
// declared on `this` but NOT in defineTypes, so they stay server-side.

const { Schema, MapSchema, defineTypes } = require('@colyseus/schema');

// ---------------------------------------------------------------------------
// BotState — one per connected player
// ---------------------------------------------------------------------------
class BotState extends Schema {
  constructor() {
    super();

    // Identity (sync'd)
    this.id = '';
    this.name = '';
    this.color = '#ff6a00';
    this.accent = '#ffffff';
    this.pattern = 'solid';
    this.chassis = 'brick';
    this.weapon = 'spinner';
    this.isPro = false; // PRO badge status

    // Pose (sync'd)
    this.x = 0;
    this.y = 0;
    this.angle = 0;

    // Combat (sync'd)
    this.hp = 200;
    this.maxHp = 200;
    this.dead = false;
    this.score = 0;
    this.kills = 0;

    // Weapon visual phase (sync'd)
    this.weaponPhase = 'idle';

    // ----- Server-only physics state (NOT sync'd) -----
    this.vx = 0;
    this.vy = 0;
    this.input = { throttle: 0, turn: 0, fire: false };
    this.lastInputAt = 0;
    this.weaponCd = 0;
    this.weaponPhaseT = 0;
    this.lastHitMap = new Map();      // target.id -> seconds
    this.spec = null;                  // resolved chassis/weapon refs
    this.derived = null;               // derived stats (accel, dmgMul, etc.)
    this.accountId = null;             // linked account ID (server-only)
  }
}

defineTypes(BotState, {
  id: 'string',
  name: 'string',
  color: 'string',
  accent: 'string',
  pattern: 'string',
  chassis: 'string',
  weapon: 'string',
  isPro: 'boolean',
  x: 'number',
  y: 'number',
  angle: 'number',
  hp: 'number',
  maxHp: 'number',
  dead: 'boolean',
  score: 'number',
  kills: 'number',
  weaponPhase: 'string',
});

// ---------------------------------------------------------------------------
// ArenaState — top-level room state
// ---------------------------------------------------------------------------
class ArenaState extends Schema {
  constructor() {
    super();
    this.bots = new MapSchema();
    this.phase = 'lobby';   // lobby | countdown | active | result
    this.timer = 30;        // seconds remaining in current phase
    this.matchId = '';      // unique id per match
    this.winnerId = '';
  }
}

defineTypes(ArenaState, {
  bots: { map: BotState },
  phase: 'string',
  timer: 'number',
  matchId: 'string',
  winnerId: 'string',
});

module.exports = { ArenaState, BotState };
