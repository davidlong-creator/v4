'use strict';
/* ============================================================================
   Boxing + Platform Arena engine — Super Smash Bros style combat
   on Minecraft-inspired blocky stages.

   Core rules
   - Every fighter has damage % (0 = fresh). Higher % = launched further.
   - Hits launch fighters; leaving the blast zone costs a stock.
   - Stock loss respawns the fighter (boxing = 5 s, as requested).
   - Boxing: 2v2, 3 stocks each, first team to take all 6 stocks wins.
   - Arena: free-for-all or teams, 3 stocks each, 3 minute limit.
   - King of the Hill: endless stocks, hold the centre hill for 60 points.
   ========================================================================== */

const { BOT_NAMES, BOT_AVATARS } = require('./utils');

const WIDTH = 960, HEIGHT = 540, GROUND_Y = 430;
const FIGHTER_W = 30, FIGHTER_H = 64;
const STEP = 1000 / 60;

// ---- physics -------------------------------------------------------------
const GRAVITY = 1500;
const MAX_FALL = 880;
const MOVE_SPEED = 275, AIR_SPEED = 250;
const GROUND_ACCEL = 2200, AIR_ACCEL = 1200;
const GROUND_FRICTION = 2100, AIR_FRICTION = 240, LAUNCH_FRICTION = 150;
const JUMP_VELOCITY = 650, AIR_JUMP_VELOCITY = 585, AIR_JUMPS = 2;
const BLAST = { left: -130, right: WIDTH + 130, top: -190, bottom: HEIGHT + 170 };

// ---- stages --------------------------------------------------------------
const ARENA_STAGE = {
  theme: 'overworld',
  platforms: [
    { x: 60, y: GROUND_Y, w: 840, h: 110, kind: 'grass' },
    { x: 150, y: 330, w: 170, h: 18, kind: 'grass' },
    { x: 640, y: 330, w: 170, h: 18, kind: 'grass' },
    { x: 395, y: 238, w: 170, h: 18, kind: 'grass' },
  ],
};
const BOXING_STAGE = {
  theme: 'ring',
  platforms: [
    { x: 100, y: GROUND_Y, w: 760, h: 110, kind: 'plank' },
    { x: 175, y: 322, w: 150, h: 16, kind: 'plank' },
    { x: 635, y: 322, w: 150, h: 16, kind: 'plank' },
  ],
};
const HILL = { x: 400, y: 238, w: 160, h: 18 };
const PICKUP_SPOTS = [
  { x: 185, y: 300 }, { x: 775, y: 300 }, { x: 480, y: 208 },
  { x: 300, y: 400 }, { x: 660, y: 400 }, { x: 480, y: 400 },
];
const WEAPONS = ['sword', 'pickaxe', 'bow'];
const HILL_WIN = 60;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const centerX = f => f.x + f.w / 2;
const centerY = f => f.y + f.h / 2;
const facingTarget = (a, t) => (centerX(t) - centerX(a)) * a.dir >= -8;

class ArcadeEngine {
  constructor(room, broadcast, mode) {
    this.room = room;
    this.broadcast = broadcast;
    this.mode = mode; // 'boxing' | 'arena'
    this.destroyed = false;
    this.started = false;
    this.phase = 'lobby';
    this.fighters = [];
    this.botSeq = 0;
    this.projectiles = [];
    this.pickups = [];
    this.effects = [];
    this.scores = {};
    this.winner = '';
    this.timeLeft = 0;
    this.hillOwner = null;
    this.hillProgress = null;
    this.timer = null;
    this.lastTick = Date.now();
    this.koFeed = [];
    this.series = null;      // best-of-3 round wins per side
    this.seriesWins = { 0: 0, 1: 0 };
  }

  get stage() { return this.mode === 'boxing' ? BOXING_STAGE : ARENA_STAGE; }
  get platforms() { return this.stage.platforms; }

  log(message) {
    this.room.log.push(message);
    if (this.room.log.length > 60) this.room.log.shift();
  }

  addBot() {
    const target = this.mode === 'boxing' ? 4 : this.room.size;
    if (this.started || this.room.players.length >= target) return false;
    const n = this.botSeq++;
    const id = `bot_arcade_${Date.now().toString(36)}_${n}`;
    this.room.players.push({
      id, socketId: null, name: BOT_NAMES[n % BOT_NAMES.length], avatar: BOT_AVATARS[n % BOT_AVATARS.length],
      avatarImage: '', sprite: (n * 5 + 3) % 20, isBot: true, connected: true, chips: 0,
    });
    return true;
  }

  fillBots() {
    const target = this.mode === 'boxing' ? 4 : this.room.size;
    while (this.room.players.length < target) if (!this.addBot()) break;
  }

  isTeams() {
    return this.mode === 'boxing' || this.room.variant === 'teams' || this.room.variant === 'hillTeams';
  }

  isHill() {
    return this.mode === 'arena' && (this.room.variant === 'hill' || this.room.variant === 'hillTeams');
  }

  stocksPerFighter() { return this.mode === 'boxing' ? 3 : 3; }
  respawnDelay() {
    if (this.mode === 'boxing') return 5000; // requested 5-second respawns
    return this.isHill() ? 4000 : 2600;
  }

  start() {
    this.fillBots();
    const target = this.mode === 'boxing' ? 4 : this.room.size;
    const roster = this.room.players.slice(0, target);
    if (!roster.length) return;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.projectiles = [];
    this.effects = [];
    this.scores = {};
    this.winner = '';
    this.hillOwner = null;
    this.hillProgress = null;
    this.koFeed = [];
    this.timeLeft = this.mode === 'arena' ? 180 : 0;
    this.started = true;
    this.phase = 'playing';
    this.lastTick = Date.now();
    const stocks = this.isHill() ? Infinity : this.stocksPerFighter();

    this.fighters = roster.map((p, i) => {
      const team = this.isTeams() ? (this.mode === 'boxing' ? (i < 2 ? 0 : 1) : i % 2) : i;
      const side = this.isTeams() ? team : p.id;
      if (!(side in this.scores)) this.scores[side] = 0;
      const f = {
        id: p.id, name: p.name, avatar: p.avatar || '🧑',
        sprite: Number.isInteger(p.sprite) ? p.sprite : i % 20,
        isBot: !!p.isBot, connected: p.connected !== false,
        team, index: i, slot: i,
        x: 0, y: 0, w: FIGHTER_W, h: FIGHTER_H,
        vx: 0, vy: 0, dir: i % 2 ? -1 : 1, onGround: true,
        damage: 0, stamina: 100, stocks,
        alive: true, respawnAt: 0, invulnUntil: Date.now() + 1600,
        airJumps: AIR_JUMPS, airJumpsUsed: 0, fastFall: false,
        weapon: 'fists', weaponUntil: 0,
        nextAttack: 0, attackKind: '', attackUntil: 0, attackDir: 1,
        blocking: false, shieldBrokenUntil: 0,
        dodgeReady: 0, dodgeUntil: 0, hitstunUntil: 0,
        lastHitBy: null, lastHitAt: 0,
        kos: 0, deaths: 0,
        input: {}, prevInput: {}, botThinkAt: 0, botPulse: '', botJumpHold: 0, botIntent: 'chase',
      };
      this.placeAtSpawn(f, true);
      return f;
    });
    this.pickups = this.mode === 'arena' ? PICKUP_SPOTS.map((s, i) => ({
      id: `pickup_${i}`, x: s.x, y: s.y, type: WEAPONS[i % WEAPONS.length], active: true, respawnAt: 0,
    })) : [];

    this.log(this.mode === 'boxing'
      ? '🥊 Smash Boxing — 2v2, 3 stocks per player. Build damage, then launch them off the stage!'
      : this.isHill()
        ? '👑 King of the Hill — hold the glowing hill uncontested. First to 60 points wins!'
        : '⚔️ Platform Arena — 3 stocks each, 3 minutes. Most stocks left wins!');
    this.broadcast(false);
    this.timer = setInterval(() => this.tick(), STEP);
  }

  spawnPoints() {
    if (this.mode === 'boxing') return [
      { x: 200, y: GROUND_Y, team: 0 }, { x: 300, y: GROUND_Y, team: 0 },
      { x: 660, y: GROUND_Y, team: 1 }, { x: 760, y: GROUND_Y, team: 1 },
    ];
    return [
      { x: 150, y: GROUND_Y }, { x: 810, y: GROUND_Y }, { x: 370, y: GROUND_Y },
      { x: 590, y: GROUND_Y }, { x: 260, y: GROUND_Y }, { x: 700, y: GROUND_Y },
      { x: 480, y: GROUND_Y }, { x: 480, y: GROUND_Y },
    ];
  }

  placeAtSpawn(f, first = false) {
    const spots = this.spawnPoints();
    const spot = spots[f.index % spots.length];
    f.x = clamp(spot.x, 40, WIDTH - 70);
    f.y = GROUND_Y - f.h;
    if (!first) f.y = 90; // drop back in from the sky
    f.vx = 0; f.vy = 0; f.onGround = false;
    f.dir = f.x < WIDTH / 2 ? 1 : -1;
    f.airJumpsUsed = 0; f.fastFall = false;
  }

  disconnect(pid) {
    const f = this.fighters.find(x => x.id === pid);
    if (f) { f.isBot = true; f.connected = false; f.input = {}; f.botThinkAt = 0; }
  }

  action(pid, data) {
    if (!this.started || this.phase !== 'playing') return;
    const f = this.fighters.find(x => x.id === pid);
    if (!f || f.isBot || !f.alive) return;
    if (data.type === 'input') {
      const src = data.input || {};
      f.input = {
        left: !!src.left, right: !!src.right, jump: !!src.jump, punch: !!src.punch,
        heavy: !!src.heavy, block: !!src.block, dodge: !!src.dodge, down: !!src.down,
      };
    }
  }

  aliveTeams() {
    const map = new Map();
    for (const f of this.fighters) {
      const side = this.isTeams() ? f.team : f.id;
      const entry = map.get(side) || { side, stocks: 0 };
      entry.stocks += f.alive ? f.stocks : 0;
      map.set(side, entry);
    }
    return map;
  }

  publicState() {
    const now = Date.now();
    return {
      players: this.room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, isBot: p.isBot, connected: p.connected })),
      game: {
        kind: 'arcade', mode: this.mode, phase: this.phase, variant: this.room.variant,
        width: WIDTH, height: HEIGHT, theme: this.stage.theme, groundY: GROUND_Y,
        platforms: this.platforms, blast: BLAST,
        fighters: this.fighters.map(f => ({
          id: f.id, name: f.name, avatar: f.avatar, sprite: f.sprite, isBot: f.isBot, connected: f.connected,
          team: f.team, slot: f.slot,
          x: Math.round(f.x * 10) / 10, y: Math.round(f.y * 10) / 10,
          vx: Math.round(f.vx), vy: Math.round(f.vy), onGround: f.onGround,
          w: f.w, h: f.h, dir: f.dir, damage: Math.max(0, Math.round(f.damage)), stamina: Math.round(f.stamina),
          stocks: f.stocks === Infinity ? -1 : f.stocks,
          alive: f.alive, respawnMs: f.alive ? 0 : Math.max(0, f.respawnAt - now),
          invuln: f.invulnUntil > now, hitstun: f.hitstunUntil > now,
          weapon: f.weapon, attackKind: f.attackUntil > now ? f.attackKind : '',
          attackMs: f.attackUntil > now ? f.attackUntil - now : 0, blocking: f.blocking,
          shieldBroken: f.shieldBrokenUntil > now,
          dodging: f.dodgeUntil > now, kos: f.kos, deaths: f.deaths,
        })),
        projectiles: this.projectiles.map(p => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y), dir: p.dir, owner: p.owner, team: p.team })),
        pickups: this.pickups.filter(p => p.active).map(p => ({ id: p.id, x: p.x, y: p.y, type: p.type })),
        effects: this.effects.map(e => ({ ...e, age: now - e.at })),
        scores: this.scores, teams: this.isTeams(), hillMode: this.isHill(), hillWin: HILL_WIN,
        hill: this.isHill() ? { ...HILL, owner: this.hillOwner, progress: this.hillProgress } : null,
        timeLeft: Math.max(0, Math.ceil(this.timeLeft)), winner: this.winner,
        series: this.isTeams() ? { red: this.seriesWins[0] || 0, blue: this.seriesWins[1] || 0 } : null,
        koFeed: this.koFeed.slice(-4), serverTime: now,
      },
    };
  }

  tick() {
    if (this.destroyed) { if (this.timer) clearInterval(this.timer); this.timer = null; return; }
    if (!this.started || this.phase !== 'playing') return;
    const now = Date.now();
    const dt = clamp((now - this.lastTick) / 1000, 0.008, 0.08);
    this.lastTick = now;
    if (this.mode === 'arena') {
      this.timeLeft = Math.max(0, this.timeLeft - dt);
      if (this.timeLeft <= 0) { this.isHill() ? this.finishByHillScore() : this.finishByStocks(); return; }
    }
    for (const f of this.fighters) {
      if (!f.alive) { if (now >= f.respawnAt) this.respawn(f, now); continue; }
      if (f.isBot) this.updateBot(f, now);
      this.updateFighter(f, dt, now);
    }
    this.effects = this.effects.filter(e => now - e.at < 900);
    this.updateProjectiles(dt, now);
    this.updatePickups(now);
    if (this.isHill()) this.updateHill(dt);
    this.broadcast(true);
  }

  // ---- movement ----------------------------------------------------------
  updateFighter(f, dt, now) {
    const input = f.input || {}, prev = f.prevInput || {};
    const pulse = f.botPulse || '';
    f.botPulse = '';
    const punch = (input.punch && !prev.punch) || pulse === 'punch';
    const heavy = (input.heavy && !prev.heavy) || pulse === 'heavy';
    const jump = (input.jump && !prev.jump) || pulse === 'jump';
    const dodge = (input.dodge && !prev.dodge) || pulse === 'dodge';

    const stunned = now < f.hitstunUntil;
    const shieldBroken = now < f.shieldBrokenUntil;

    if (!stunned && !shieldBroken) {
      if (input.left && !input.right) f.dir = -1;
      if (input.right && !input.left) f.dir = 1;
    }

    // stamina: shields and dodges draw on it
    f.blocking = !stunned && !shieldBroken && !!input.block && f.stamina > 1;
    if (f.blocking) {
      f.stamina = Math.max(0, f.stamina - 26 * dt);
      if (f.stamina <= 0) { f.blocking = false; f.shieldBrokenUntil = now + 700; f.stamina = 0; this.addEffect('shieldBreak', centerX(f), centerY(f)); }
    } else {
      f.stamina = Math.min(100, f.stamina + (f.onGround ? 30 : 18) * dt);
    }

    if (!stunned && !shieldBroken && dodge && now >= f.dodgeReady && f.stamina >= 22) {
      f.stamina -= 22; f.dodgeReady = now + 780; f.dodgeUntil = now + 260;
      f.blocking = false;
      f.vx = f.dir * 620;
      if (!f.onGround) f.vy = Math.min(f.vy, -60);
    }

    // jumping (double jump, Smash style)
    if (!stunned && !shieldBroken && jump && this.mode) {
      if (f.onGround) {
        f.vy = -JUMP_VELOCITY; f.onGround = false; f.airJumpsUsed = 0; f.fastFall = false;
        this.addEffect('dust', centerX(f), f.y + f.h);
      } else if (f.airJumpsUsed < AIR_JUMPS) {
        f.airJumpsUsed++; f.vy = -AIR_JUMP_VELOCITY; f.fastFall = false;
        this.addEffect('ring', centerX(f), f.y + f.h);
      }
    }
    if (!stunned && input.down && !f.onGround && !f.fastFall && f.vy > -80) {
      f.fastFall = true; f.vy = Math.max(f.vy, 700);
    }

    if (!stunned && !shieldBroken && punch) this.tryAttack(f, false, now);
    if (!stunned && !shieldBroken && heavy) this.tryAttack(f, true, now);

    // horizontal control
    let speed = f.onGround ? MOVE_SPEED : AIR_SPEED;
    if (f.blocking) speed *= 0.4;
    if (f.weapon === 'pickaxe') speed *= 0.92;
    if (this.isHill()) speed *= 1.02;
    let move = 0;
    if (!stunned && !shieldBroken) move = input.left && !input.right ? -1 : input.right && !input.left ? 1 : 0;
    if (now < f.dodgeUntil) move = 0;

    if (now < f.hitstunUntil) {
      // launched: no control, very light air drag
      f.vx *= Math.max(0, 1 - LAUNCH_FRICTION * dt / Math.max(120, Math.abs(f.vx)));
    } else if (move) {
      const accel = f.onGround ? GROUND_ACCEL : AIR_ACCEL;
      f.vx += clamp(move * speed - f.vx, -accel * dt, accel * dt);
    } else if (f.onGround) {
      const brake = GROUND_FRICTION * dt;
      f.vx = Math.abs(f.vx) <= brake ? 0 : f.vx - Math.sign(f.vx) * brake;
    } else {
      f.vx *= Math.max(0, 1 - 1.4 * dt);
    }

    // gravity + integration
    f.vy = Math.min(MAX_FALL, f.vy + GRAVITY * dt);
    const oldBottom = f.y + f.h;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    f.onGround = false;
    if (f.vy >= 0) {
      for (const p of this.platforms) {
        if (f.x + f.w <= p.x + 2 || f.x >= p.x + p.w - 2) continue;
        if (oldBottom <= p.y + 10 && f.y + f.h >= p.y) {
          f.y = p.y - f.h; f.vy = 0; f.onGround = true; f.airJumpsUsed = 0; f.fastFall = false;
          break;
        }
      }
    }
    // soft walls only at the very edge of the screen keep the fight readable;
    // there are no walls — the blast zone handles escapes.
    if (f.weapon !== 'fists' && now >= f.weaponUntil) f.weapon = 'fists';
    f.prevInput = { ...input };

    if (this.mode === 'arena') {
      for (const p of this.pickups) {
        if (!p.active) continue;
        if (Math.abs(centerX(f) - p.x) < 34 && Math.abs(centerY(f) - p.y) < 52) {
          f.weapon = p.type; f.weaponUntil = now + 26000;
          p.active = false; p.respawnAt = now + 12000;
          this.addEffect('pickup', p.x, p.y);
          this.log(`🎁 ${f.name} grabbed a ${p.type}.`);
        }
      }
    }

    // blast zones = stock loss
    if (f.x + f.w < BLAST.left || f.x > BLAST.right || f.y < BLAST.top || f.y > BLAST.bottom) {
      this.loseStock(f, now);
    }
  }

  // ---- combat ------------------------------------------------------------
  tryAttack(f, heavy, now) {
    if (!f.alive || now < f.nextAttack || f.blocking || now < f.hitstunUntil) return;
    const weapon = f.weapon;
    const cost = heavy ? 22 : 8;
    if (f.stamina < cost) return;
    f.stamina -= cost;
    const cooldown = weapon === 'pickaxe' ? (heavy ? 950 : 620)
      : weapon === 'bow' ? (heavy ? 720 : 380)
        : heavy ? 700 : 290;
    f.nextAttack = now + cooldown;
    f.attackKind = heavy ? `heavy-${weapon}` : `quick-${weapon}`;
    f.attackUntil = now + (heavy ? 300 : 190);
    f.attackDir = f.dir;

    if (weapon === 'bow') {
      this.projectiles.push({
        id: `arrow_${now}_${Math.random().toString(36).slice(2, 6)}`,
        owner: f.id, team: f.team, x: centerX(f) + f.dir * 26, y: f.y + 26,
        vx: f.dir * (heavy ? 760 : 660), dir: f.dir, damage: heavy ? 9 : 5, life: 1.6,
      });
      this.addEffect(heavy ? 'heavy' : 'light', centerX(f) + f.dir * 26, f.y + 26);
      return;
    }

    let range = heavy ? 86 : 66;
    let damage = heavy ? 13 : 7;
    let base = heavy ? 300 : 190;
    let growth = heavy ? 5.4 : 3.1;
    let reachY = 76;
    if (weapon === 'sword') { range += 26; damage += heavy ? 5 : 3; base += 30; growth += 0.4; }
    if (weapon === 'pickaxe') { range += 6; damage += heavy ? 8 : 3; base += 70; growth += 0.9; reachY += 10; }

    let landed = 0;
    for (const target of this.fighters) {
      if (!this.canHit(f, target)) continue;
      const dx = centerX(target) - centerX(f), dy = Math.abs(centerY(target) - centerY(f));
      if (Math.abs(dx) > range || dy > reachY) continue;
      if (dx * f.dir < -20) continue;
      this.applyHit(f, target, { damage, base, growth, heavy, weapon, now });
      landed++;
    }
    this.addEffect(landed ? (heavy ? 'heavy' : 'light') : 'whiff',
      centerX(f) + f.dir * (range * 0.7), centerY(f));
  }

  canHit(attacker, target) {
    if (!target || target.id === attacker.id || !target.alive) return false;
    return !(this.isTeams() && attacker.team === target.team);
  }

  applyHit(attacker, target, opts) {
    const now = opts.now || Date.now();
    if (!attacker || !target || attacker.id === target.id) return;
    if (!target.alive || target.invulnUntil > now || target.dodgeUntil > now) return;
    const facing = facingTarget(target, attacker);
    let damage = opts.damage, base = opts.base, growth = opts.growth;
    let blocked = false;
    if (target.blocking && facing) {
      blocked = true;
      damage *= 0.25; base *= 0.35; growth *= 0.35;
      target.stamina = Math.max(0, target.stamina - (opts.heavy ? 18 : 11));
      this.addEffect('block', centerX(target) + target.dir * 18, centerY(target));
    }
    target.damage = Math.min(999, target.damage + damage);
    const kb = clamp(base + target.damage * growth, 70, 1500);
    const dir = Math.sign(centerX(target) - centerX(attacker)) || attacker.dir;
    if (!blocked) {
      target.vx = dir * kb * 0.78;
      target.vy = -kb * 0.62;
      target.onGround = false;
      target.fastFall = false;
      target.hitstunUntil = now + Math.min(1100, 150 + kb * 0.6);
      target.blocking = false;
      target.airJumpsUsed = Math.max(target.airJumpsUsed, 0);
      this.addEffect(opts.heavy ? 'hitHeavy' : 'hit', centerX(target), centerY(target));
    } else {
      target.vx += dir * kb * 0.2;
    }
    target.lastHitBy = attacker.id;
    target.lastHitAt = now;
    if (target.damage >= 999) this.loseStock(target, now);
  }

  loseStock(f, now = Date.now()) {
    if (!f.alive) return;
    f.alive = false;
    f.deaths++;
    f.stocks = f.stocks === Infinity ? Infinity : Math.max(0, f.stocks - 1);
    f.vx = 0; f.vy = 0; f.input = {}; f.blocking = false; f.damage = 0; f.weapon = 'fists';
    f.respawnAt = now + this.respawnDelay();
    f.hitstunUntil = 0;
    f.x = clamp(f.x, BLAST.left, BLAST.right);
    f.y = clamp(f.y, BLAST.top, BLAST.bottom);

    const killer = f.lastHitBy && now - f.lastHitAt < 6000
      ? this.fighters.find(x => x.id === f.lastHitBy && x.id !== f.id) : null;
    if (killer) {
      killer.kos++;
      const side = this.isTeams() ? killer.team : killer.id;
      this.scores[side] = (this.scores[side] || 0) + 1;
    }
    this.koFeed.push({ at: now, name: f.name, by: killer ? killer.name : '', team: f.team, stocks: f.stocks });
    this.addEffect('ko', centerX(f), Math.max(60, centerY(f)));
    this.log(killer
      ? `💥 ${killer.name} launched ${f.name} into the blast zone${f.stocks === Infinity ? '' : ` — ${f.stocks} stock${f.stocks === 1 ? '' : 's'} left`}.`
      : `☠️ ${f.name} fell out of the blast zone.`);
    if (this.mode === 'boxing') this.checkBoxingWin();
    else if (!this.isHill()) this.checkLastStanding();
  }

  checkBoxingWin() {
    const t0 = this.fighters.filter(f => f.team === 0).reduce((n, f) => n + (f.alive ? f.stocks : 0), 0);
    const t1 = this.fighters.filter(f => f.team === 1).reduce((n, f) => n + (f.alive ? f.stocks : 0), 0);
    if (t0 <= 0 && t1 <= 0) return this.finish('Double knockout — the bout is a draw! 🤝');
    if (t1 <= 0) return this.finish(`${this.teamLabel(0)} wins the bout! 🏆`);
    if (t0 <= 0) return this.finish(`${this.teamLabel(1)} wins the bout! 🏆`);
  }

  checkLastStanding() {
    const map = this.aliveTeams();
    const alive = [...map.values()].filter(e => e.stocks > 0);
    if (alive.length === 1) {
      const side = alive[0].side;
      const name = this.isTeams() ? this.teamLabel(side) : (this.fighters.find(f => f.id === side) || {}).name || 'Player';
      this.finish(`${name} wins the arena! 🏆`);
    } else if (!alive.length) {
      this.finishByStocks();
    }
  }

  respawn(f, now) {
    if (f.stocks <= 0 && f.stocks !== Infinity) return;
    f.alive = true;
    f.damage = 0; f.stamina = 100; f.weapon = 'fists'; f.weaponUntil = 0;
    f.invulnUntil = now + 2200; f.nextAttack = now + 240;
    f.dodgeUntil = 0; f.attackUntil = 0; f.hitstunUntil = 0;
    f.input = {}; f.prevInput = {}; f.botPulse = ''; f.botJumpHold = 0;
    this.placeAtSpawn(f, false);
    this.addEffect('respawn', centerX(f), f.y + f.h);
  }

  updateProjectiles(dt, now) {
    const keep = [];
    for (const p of this.projectiles) {
      p.x += p.vx * dt; p.life -= dt;
      if (p.life <= 0 || p.x < -30 || p.x > WIDTH + 30) continue;
      let hit = false;
      const owner = this.fighters.find(f => f.id === p.owner);
      if (owner) {
        for (const target of this.fighters) {
          if (!this.canHit(owner, target)) continue;
          if (Math.abs(centerX(target) - p.x) < 26 && Math.abs(centerY(target) - p.y) < 42) {
            this.applyHit(owner, target, { damage: p.damage, base: 150, growth: 2.4, heavy: false, weapon: 'bow', now });
            hit = true; break;
          }
        }
      }
      if (!hit) keep.push(p);
    }
    this.projectiles = keep;
  }

  updatePickups(now) {
    for (const p of this.pickups) {
      if (!p.active && now >= p.respawnAt) {
        p.active = true;
        p.type = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
      }
    }
  }

  updateHill(dt) {
    const occupants = this.fighters.filter(f => f.alive && f.onGround &&
      centerX(f) >= HILL.x && centerX(f) <= HILL.x + HILL.w &&
      Math.abs((f.y + f.h) - HILL.y) < 14);
    const sides = [...new Set(occupants.map(f => this.isTeams() ? f.team : f.id))];
    this.hillOwner = sides.length === 1 ? sides[0] : null;
    this.hillProgress = sides.length === 1 ? (this.scores[sides[0]] || 0) : null;
    if (sides.length !== 1) return;
    const side = sides[0];
    this.scores[side] = (this.scores[side] || 0) + dt;
    if (this.scores[side] >= HILL_WIN) {
      const name = this.isTeams() ? this.teamLabel(side) : (this.fighters.find(f => f.id === side) || {}).name || 'Player';
      this.finish(`${name} held the hill for ${HILL_WIN} points! 👑`);
    }
  }

  teamLabel(team) { return Number(team) === 0 ? 'Team Red' : 'Team Blue'; }

  /** Hill games end on time too: most hill points wins. */
  finishByHillScore() {
    const rows = Object.entries(this.scores || {}).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return this.finish('Time! Nobody scored the hill — draw! 🤝');
    const [side, score] = rows[0];
    const name = this.isTeams() ? this.teamLabel(side) : (this.fighters.find(f => f.id === side) || {}).name || 'Player';
    this.finish(`Time! ${name} wins with ${Math.floor(score)} hill points! 🏆`);
  }

  finishByStocks() {
    const map = this.aliveTeams();
    const rows = [...map.entries()].map(([side, e]) => {
      const parts = this.fighters.filter(f => (this.isTeams() ? f.team === side : f.id === side));
      return { side, stocks: parts.reduce((n, f) => n + (f.alive ? f.stocks : 0), 0), damage: parts.reduce((n, f) => n + f.damage, 0) };
    }).sort((a, b) => (b.stocks - a.stocks) || (a.damage - b.damage));
    if (!rows.length) return this.finish('Draw!');
    if (rows.length > 1 && rows[0].stocks === rows[1].stocks && Math.abs(rows[0].damage - rows[1].damage) < 0.6) {
      return this.finish('Time! Scores tied — it\'s a draw! 🤝');
    }
    const name = this.isTeams() ? this.teamLabel(rows[0].side) : (this.fighters.find(f => f.id === rows[0].side) || {}).name || 'Player';
    this.finish(`Time! ${name} wins with ${rows[0].stocks} stock${rows[0].stocks === 1 ? '' : 's'} left! 🏆`);
  }

  addEffect(type, x, y) {
    this.effects.push({
      id: `fx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      type, x: Math.round(x), y: Math.round(y), at: Date.now(),
      seed: Math.floor(Math.random() * 1000),
    });
    if (this.effects.length > 40) this.effects.shift();
  }

  /** Track a best-of-3 series so rematches have something riding on them. */
  updateSeries(message) {
    if (!this.seriesWins) this.seriesWins = { 0: 0, 1: 0 };
    if (!this.isTeams()) return '';
    const red = /Team Red/.test(message) || this.lastWinnerSide === 0;
    const blue = /Team Blue/.test(message) || this.lastWinnerSide === 1;
    if (!red && !blue) return '';
    const side = red ? 0 : 1;
    this.seriesWins[side] = (this.seriesWins[side] || 0) + 1;
    if (this.seriesWins[side] >= 2) {
      const label = this.teamLabel(side);
      this.seriesWins = { 0: 0, 1: 0 };
      return ` — ${label} wins the best-of-3 series! 🏆`;
    }
    return ` — series ${this.seriesWins[0] || 0}–${this.seriesWins[1] || 0}`;
  }

  finish(message) {
    if (this.phase === 'over') return;
    const winnerName = String(message).replace(/^Time! /, '');
    const named = this.fighters.find(f => winnerName.includes(f.name));
    this.lastWinnerId = named ? named.id : null;
    this.lastWinnerSide = /Team Red/.test(message) ? 0 : /Team Blue/.test(message) ? 1 : null;
    const seriesNote = this.seriesWins ? this.updateSeries(message) : '';
    if (seriesNote) message = message + seriesNote;
    this.phase = 'over'; this.winner = message;
    this.log(`🏁 ${message}`);
    for (const f of this.fighters) { f.input = {}; f.vx = 0; }
    this.broadcast(false);
  }

  // ---- bots --------------------------------------------------------------
  updateBot(f, now) {
    if (now < f.botThinkAt) return;
    const skill = 0.55 + ((f.slot % 4) * 0.12);
    f.botThinkAt = now + 90 + Math.random() * 90;
    const input = { left: false, right: false, jump: false, punch: false, heavy: false, block: false, dodge: false, down: false };
    const enemies = this.fighters.filter(t => this.canHit(f, t) && t.alive);
    if (!enemies.length) { f.input = input; return; }

    // ---- recovery first: get back to the stage ----
    const offStage = centerX(f) < 40 || centerX(f) > WIDTH - 40 || f.y > GROUND_Y + 20;
    if (!f.onGround && (offStage || f.y > 330) && f.vy > -60) {
      const towardX = centerX(f) < WIDTH / 2 ? 1 : -1;
      input[towardX > 0 ? 'right' : 'left'] = true;
      if (f.airJumpsUsed < AIR_JUMPS && f.vy > 40) input.jump = true;
      f.botIntent = 'recover';
      f.botPulse = Math.random() < 0.5 ? 'jump' : '';
      f.input = input;
      return;
    }

    enemies.sort((a, b) => Math.hypot(centerX(a) - centerX(f), centerY(a) - centerY(f)) - Math.hypot(centerX(b) - centerX(f), centerY(b) - centerY(f)));
    const target = enemies[0];
    let goalX = centerX(target);
    let goalY = centerY(target);
    f.botIntent = 'chase';

    if (this.isHill() && (this.hillOwner !== (this.isTeams() ? f.team : f.id))) {
      goalX = HILL.x + HILL.w / 2;
      goalY = HILL.y;
      f.botIntent = 'hill';
    }
    if (this.mode === 'arena' && f.weapon === 'fists' && f.damage < 70) {
      const available = this.pickups.filter(p => p.active)
        .sort((a, b) => Math.hypot(a.x - centerX(f), a.y - centerY(f)) - Math.hypot(b.x - centerX(f), b.y - centerY(f)));
      if (available[0] && Math.hypot(available[0].x - centerX(f), available[0].y - centerY(f)) < 210) {
        goalX = available[0].x; goalY = available[0].y; f.botIntent = 'weapon';
      }
    }

    const dx = goalX - centerX(f);
    const dy = goalY - (f.y + f.h);
    const desired = f.weapon === 'bow' ? 230 : 44;
    if (Math.abs(dx) > desired) input[dx > 0 ? 'right' : 'left'] = true;
    if (Math.abs(dx) <= desired && target) f.dir = centerX(target) >= centerX(f) ? 1 : -1;

    // jump toward platforms or a target overhead
    const needsHeight = dy < -70;
    if (f.onGround && needsHeight && Math.abs(dx) < 260 && Math.random() < 0.75) input.jump = true;
    if (f.onGround && Math.abs(dx) > 40 && Math.random() < 0.06) input.jump = true;

    const targetDx = centerX(target) - centerX(f);
    const targetDy = (target.y + target.h) - (f.y + f.h);
    const reach = f.weapon === 'sword' ? 96 : f.weapon === 'pickaxe' ? 92 : 80;
    const inRange = Math.abs(targetDx) < reach && Math.abs(targetDy) < 76;
    const canShoot = f.weapon === 'bow' && Math.abs(targetDx) < 480 && Math.abs(targetDy) < 110;

    if (inRange || canShoot) {
      f.dir = targetDx >= 0 ? 1 : -1;
      const finisher = target.damage > 85;
      f.botPulse = Math.random() < (finisher ? 0.62 : 0.3) ? 'heavy' : 'punch';
      if (Math.random() > skill && Math.random() < 0.3) input.block = true;
    }
    // defend against an incoming swing
    if (target.attackUntil > now && Math.abs(targetDx) < 110 && Math.random() < skill * 0.75) {
      if (Math.random() < 0.4) f.botPulse = 'dodge'; else input.block = true;
    }
    // avoid being pushed off the edge
    if (Math.abs(centerX(f) - (WIDTH / 2)) > 400 && f.onGround && Math.random() < 0.5) {
      input[centerX(f) < WIDTH / 2 ? 'right' : 'left'] = true;
    }
    f.input = input;
  }
}

class BoxingEngine extends ArcadeEngine {
  constructor(room, broadcast) { super(room, broadcast, 'boxing'); }
}
class ArenaEngine extends ArcadeEngine {
  constructor(room, broadcast) { super(room, broadcast, 'arena'); }
}

module.exports = { ArcadeEngine, BoxingEngine, ArenaEngine, WIDTH, HEIGHT, HILL };
