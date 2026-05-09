// Server-side mirror of the gameplay-relevant subset of CONFIG.
// Cosmetic-only data (paint patterns, accent colors) lives client-only.
// Keep this file in sync with arenabots-arena/js/config.js whenever
// chassis/weapon/mod stats change. A future improvement is to share the
// data via a generated JSON file in both projects.

const CHASSIS = {
  wedge:      { radius: 22, hp: 0,   speedMul: 1.06, turn: 0,   massMul: 1,    frontDeflect: 0.30 },
  brick:      { radius: 24, hp: 0,   speedMul: 1,    turn: 0,   massMul: 1 },
  tank:       { radius: 28, hp: 50,  speedMul: 1,    turn: -0.6, massMul: 1.2 },
  hover:      { radius: 24, hp: -30, speedMul: 1,    turn: 0,   massMul: 1,    hover: true },
  speeder:    { radius: 20, hp: -25, speedMul: 1.30, turn: 0.4, massMul: 0.8 },
  tracked:    { radius: 26, hp: 20,  speedMul: 0.95, turn: 0,   massMul: 1.1 },
  walker:     { radius: 24, hp: 10,  speedMul: 1,    turn: 0.7, massMul: 1,    knockResist: 0.4 },
  invertible: { radius: 24, hp: 25,  speedMul: 1,    turn: 0.2, massMul: 1 },
  pyramid:    { radius: 26, hp: 0,   speedMul: 0.85, turn: -0.4, massMul: 1,   deflect: 0.40 },
  saucer:     { radius: 23, hp: -15, speedMul: 1.10, turn: 0.6, massMul: 0.9 },
  titan:      { radius: 30, hp: 90,  speedMul: 0.82, turn: -0.5, massMul: 1.3, knockResist: 0.25, pro: true },
  phantom:    { radius: 22, hp: 30,  speedMul: 1.25, turn: 0,   massMul: 1,    knockResist: 0.5,  frontDeflect: 0.20, pro: true },
};

const PI = Math.PI;
const WEAPONS = {
  spinner:  { type: 'passive', damage: 6,   tickInterval: 0.18, knockback: 280, selfKnockback: 110, reach: 16, arc: PI * 1.0 },
  drum:     { type: 'passive', damage: 3.4, tickInterval: 0.12, knockback: 140, selfKnockback: 30,  reach: 10, arc: PI * 0.55 },
  vertspin: { type: 'passive', damage: 7.5, tickInterval: 0.22, knockback: 380, selfKnockback: 70,  reach: 14, arc: PI * 0.40 },
  spinbar:  { type: 'passive', damage: 5,   tickInterval: 0.20, knockback: 240, selfKnockback: 90,  reach: 24, arc: PI * 1.4 },
  twinsaws: { type: 'passive', damage: 3.0, tickInterval: 0.15, knockback: 120, selfKnockback: 10,  reach: 8,  arc: PI * 1.6, side: true },
  hammer:   { type: 'active',  damage: 30,  cooldown: 1.4, windup: 0.12, active: 0.18, knockback: 360, reach: 22, arc: PI * 0.55 },
  axe:      { type: 'active',  damage: 42,  cooldown: 2.0, windup: 0.22, active: 0.16, knockback: 300, reach: 24, arc: PI * 0.45 },
  spear:    { type: 'active',  damage: 14,  cooldown: 0.7, windup: 0.05, active: 0.12, knockback: 180, reach: 30, arc: PI * 0.18 },
  flipper:  { type: 'active',  damage: 12,  cooldown: 1.6, windup: 0.06, active: 0.18, knockback: 620, reach: 18, arc: PI * 0.45 },
  lifter:   { type: 'active',  damage: 8,   cooldown: 1.0, windup: 0.05, active: 0.15, knockback: 380, reach: 16, arc: PI * 0.40 },
  crusher:  { type: 'active',  damage: 55,  cooldown: 2.4, windup: 0.18, active: 0.20, knockback: 80,  reach: 14, arc: PI * 0.35 },
  flame:    { type: 'active',  damage: 5,   dmgTickInterval: 0.10, cooldown: 0.9, windup: 0.05, active: 0.5, knockback: 30, reach: 60, arc: PI * 0.30 },
  plasma:   { type: 'active',  damage: 38,  cooldown: 1.6, windup: 0.30, active: 0.18, knockback: 420, reach: 80, arc: PI * 0.20, pro: true },
  vortex:   { type: 'passive', damage: 8,   tickInterval: 0.20, knockback: 340, selfKnockback: 130, reach: 22, arc: PI * 1.2, pro: true },
};

// Stat-derivation curves (must match client)
const HP_FROM_ARMOR    = a => 60 + a * 30;
const SPEED_FROM_SPEED = s => 1.6 + s * 0.55;
const TURN_FROM_SPEED  = s => 2.6 + s * 0.45;
const DMG_FROM_POWER   = p => 0.5 + p * 0.18;
const MASS_FROM_WEIGHT = w => 1.0 + w * 0.45;

// Resolve a player's loadout into derived combat stats applied at spawn.
function deriveStats(loadout) {
  const c = CHASSIS[loadout.chassis] || CHASSIS.brick;
  const w = WEAPONS[loadout.weapon]   || WEAPONS.spinner;
  const s = loadout.stats || { armor: 4, speed: 4, power: 3, weight: 3 };

  const hp = Math.max(40, HP_FROM_ARMOR(s.armor) + (c.hp || 0));
  const accel    = SPEED_FROM_SPEED(s.speed) * 110 * (c.speedMul || 1);
  const maxSpeed = (90 + s.speed * 35) * (c.speedMul || 1);
  const turn     = TURN_FROM_SPEED(s.speed) + (c.turn || 0);
  const dmgMul   = DMG_FROM_POWER(s.power);
  const mass     = Math.max(0.4, MASS_FROM_WEIGHT(s.weight) * (c.massMul || 1));

  return {
    chassisDef: c, weaponDef: w,
    radius: c.radius,
    maxHp: hp,
    accel, maxSpeed, turn,
    dmgMul, mass,
    deflect: c.deflect || 0,
    frontDeflect: c.frontDeflect || 0,
    knockResist: c.knockResist || 0,
    hover: !!c.hover,
  };
}

module.exports = { CHASSIS, WEAPONS, deriveStats };
