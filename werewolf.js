'use strict';
/* ============================================================================
   Werewolf / Mafia — eased pacing + smarter villagers.

   Pacing (per the request to slow everything down)
   - Every timed phase shows a live countdown so nobody is left guessing.
   - Night 14 s · Morning discussion 20 s · Vote 30 s · Result 12 s.
   - Bots act at human speed, spread across the window, not in one burst.

   Brains
   - Evidence ledger: who voted for a confirmed wolf, who defended one, who
     stayed silent, who was cleared by the Seer.
   - Difficulty levels: easy / normal / hard / expert.
   - Wolves coordinate in the den and can fake a Seer claim at higher levels.
   ========================================================================== */

const { BOT_NAMES, BOT_AVATARS } = require('./utils');
const ai = require('./ai');

const ROLE_INFO = {
  wolf: '🐺 Werewolf — hunt with your pack at night, blend in by day.',
  seer: '🔮 Seer — investigate one player each night.',
  doctor: '💉 Doctor — protect one player each night.',
  villager: '🧑‍🌾 Villager — your vote is your weapon.',
};

const PHASE_SECONDS = {
  reveal: 0,
  night: 14,
  morning: 20,
  vote: 30,
  voteResult: 12,
  over: 0,
};

const pick = a => a[Math.floor(Math.random() * a.length)];

class WerewolfEngine {
  constructor(room, broadcast) {
    this.room = room;
    this.broadcast = broadcast;
    this.destroyed = false;
    this.phase = 'lobby';
    this.round = 1;
    this.wolfChat = [];
    this.suspicion = {};
    this.evidence = {};
    this.claims = {};
    this.ready = new Set();
    this.nightSub = {};
    this.votes = {};
    this.investigations = {};
    this.message = '';
    this.phaseEndsAt = 0;
    this.phaseTimer = null;
    this.continued = new Set();
    this.difficulty = ai.normalizeLevel(room.difficulty);
  }

  log(m) { this.room.log.push(m); if (this.room.log.length > 60) this.room.log.shift(); }
  alive() { return this.room.players.filter(p => p.alive); }
  aliveIds() { return this.alive().map(p => p.id); }

  /* ---- pacing ---- */
  phaseSeconds(phase = this.phase) {
    const base = PHASE_SECONDS[phase] || 0;
    // more players need a little more discussion time
    const bump = phase === 'vote' || phase === 'morning' ? Math.min(10, Math.floor(this.room.players.length / 2)) : 0;
    return base ? base + bump : 0;
  }
  startPhase(phase) {
    this.phase = phase;
    this.continued = new Set();
    const secs = this.phaseSeconds(phase);
    this.phaseEndsAt = secs ? Date.now() + secs * 1000 : 0;
    if (this.phaseTimer) { clearInterval(this.phaseTimer); this.phaseTimer = null; }
    if (!secs) return;
    this.phaseTimer = setInterval(() => {
      if (this.destroyed || this.phase !== phase) { clearInterval(this.phaseTimer); this.phaseTimer = null; return; }
      if (Date.now() >= this.phaseEndsAt) {
        clearInterval(this.phaseTimer); this.phaseTimer = null;
        this.timeoutPhase(phase);
      }
    }, 500);
  }
  /** When the clock runs out, move the game along instead of hanging. */
  timeoutPhase(phase) {
    if (phase === 'night') {
      // anyone who dithered gets a sensible default
      for (const a of this.requiredNightActors()) {
        if (this.nightSub[a.pid]) continue;
        const actor = this.room.players.find(p => p.id === a.pid);
        if (actor) this.nightSub[a.pid] = this.botNightChoice(a.kind, actor);
      }
      this.resolveNight();
      return;
    }
    if (phase === 'vote') {
      for (const p of this.alive()) if (!this.votes[p.id]) this.votes[p.id] = this.botVote(p);
      this.resolveVote();
      return;
    }
    if (phase === 'morning') return this.startVoting();
    if (phase === 'voteResult') { this.round++; return this.startNight(); }
  }
  /** Everyone tapping "continue" skips the wait. */
  readyToAdvance() { return this.alive().filter(p => !p.isBot).every(p => this.continued.has(p.id)); }

  /* ---- roster ---- */
  addBot() {
    if (this.room.players.length >= this.room.size) return false;
    const used = this.room.players.map(p => p.name);
    let i = BOT_NAMES.findIndex(n => !used.includes(n));
    if (i < 0) i = Math.floor(Math.random() * BOT_NAMES.length);
    this.room.players.push({
      id: 'bot_' + Math.random().toString(36).slice(2, 9), name: BOT_NAMES[i],
      avatar: BOT_AVATARS[i], isBot: true, connected: true, chips: 0,
      sprite: (this.room.players.length * 3) % 20,
    });
    this.log(`🤖 ${BOT_NAMES[i]} joins the village.`);
    return true;
  }

  start() {
    while (this.room.players.length < this.room.size) if (!this.addBot()) break;
    if (this.room.players.length < 5) return;
    const n = this.room.players.length;
    const nWolves = n >= 9 ? 3 : n >= 6 ? 2 : 1;
    const roles = [];
    for (let i = 0; i < nWolves; i++) roles.push('wolf');
    roles.push('seer', 'doctor');
    while (roles.length < n) roles.push('villager');
    for (let i = roles.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [roles[i], roles[j]] = [roles[j], roles[i]]; }
    this.room.players.forEach((p, i) => {
      p.role = roles[i]; p.alive = true; p.roleRevealed = false;
      this.suspicion[p.id] = 0;
      this.investigations[p.id] = [];
      this.evidence[p.id] = { votedWithWolf: 0, defendedAccused: 0, silentRounds: 0, accusedSeer: 0, survivedNight: 0 };
    });
    this.claims = {};
    this.wolfChat = [];
    this.votes = {};
    this.nightSub = {};
    this.round = 1;
    this.ready.clear();
    this.message = 'Secret roles have been dealt. Read yours, then tap Ready.';
    this.log(`🌕 Werewolf begins with ${n} villagers… ${nWolves} wolf${nWolves > 1 ? 'ves' : ''} among them.`);
    this.room.players.filter(p => p.isBot).forEach(p => this.ready.add(p.id));
    this.startPhase('reveal');
    this.broadcast();
    this.checkRevealDone();
  }

  checkRevealDone() {
    if (this.phase !== 'reveal') return;
    const humans = this.room.players.filter(p => !p.isBot && p.connected);
    if (humans.every(p => this.ready.has(p.id))) this.startNight();
    else {
      // never leave a sleeping player stuck
      if (this.revealTimer) clearTimeout(this.revealTimer);
      this.revealTimer = setTimeout(() => { if (!this.destroyed && this.phase === 'reveal') this.startNight(); }, 45000);
    }
  }

  requiredNightActors() {
    const a = [];
    this.alive().filter(p => p.role === 'wolf').forEach(p => a.push({ pid: p.id, kind: 'wolf' }));
    const d = this.alive().find(p => p.role === 'doctor'); if (d) a.push({ pid: d.id, kind: 'doctor' });
    const s = this.alive().find(p => p.role === 'seer'); if (s) a.push({ pid: s.id, kind: 'seer' });
    return a;
  }

  /* ---- night ---- */
  startNight() {
    if (this.phaseTimer) { clearInterval(this.phaseTimer); this.phaseTimer = null; }
    if (this.revealTimer) { clearTimeout(this.revealTimer); this.revealTimer = null; }
    this.nightSub = {};
    this.startPhase('night');
    this.message = `🌙 Night ${this.round} — secret roles are acting. The village sleeps.`;
    this.log(`🌙 Night ${this.round} falls.`);
    const botWolf = this.alive().find(p => p.isBot && p.role === 'wolf');
    const wolfCount = this.room.players.filter(p => p.role === 'wolf').length;
    if (botWolf && wolfCount > 1) {
      const threats = this.packThreats(botWolf);
      if (threats.length) this.wolfChat.push({ from: botWolf.name, text: `Pack — I like ${threats[0].name} tonight. 🌕` });
      else {
        const targets = this.alive().filter(p => p.role !== 'wolf');
        if (targets.length) this.wolfChat.push({ from: botWolf.name, text: `Pack… I say we hunt ${pick(targets).name} tonight. 🌕` });
      }
    }
    this.broadcast();
    // bots act spread across the night window, at human-ish speed
    this.requiredNightActors()
      .filter(a => { const p = this.room.players.find(x => x.id === a.pid); return p && p.isBot; })
      .forEach((a, i) => setTimeout(() => {
        if (this.destroyed || this.phase !== 'night') return;
        this.nightSub[a.pid] = this.botNightChoice(a.kind, this.room.players.find(x => x.id === a.pid));
        this.checkNightDone();
        this.broadcast();
      }, 2200 + i * 1800));
  }

  /** Ranked list of who the wolves should fear most. */
  packThreats(wolf) {
    return this.alive()
      .filter(p => p.role !== 'wolf')
      .map(p => {
        let threat = 1;
        if (p.role === 'seer') threat += 6;
        if (p.role === 'doctor') threat += 3;
        if (this.claims[p.id] === 'seer') threat += 7;
        if (!p.isBot) threat += 2; // humans think, so they're dangerous
        threat += (this.evidence[p.id]?.votedWithWolf || 0) * 1.5;
        return { ...p, threat };
      })
      .sort((a, b) => b.threat - a.threat);
  }

  botNightChoice(kind, actor) {
    const alive = this.alive();
    const level = ai.adaptiveLevel(this.difficulty, this.standingFor());
    const cfg = ai.profile(level);
    if (kind === 'wolf') {
      const threats = this.packThreats(actor);
      const prey = threats.filter(p => p.role !== 'wolf');
      if (!prey.length) return null;
      // mostly hunt the biggest threat; sometimes the pack goes for a safe kill
      if (Math.random() < cfg.wolfDeduction) return prey[0].id;
      return pick(prey.slice(0, Math.min(3, prey.length))).id;
    }
    const others = alive.filter(p => p.id !== actor.id);
    if (kind === 'seer') {
      // investigate people nobody has cleared, prioritising loud/suspicious players
      const known = new Set((this.investigations[actor.id] || []).map(r => r.targetId));
      const unknown = others.filter(p => !known.has(p.id));
      const pool = unknown.length ? unknown : others;
      const scored = pool.map(p => ({ p, s: (this.suspicion[p.id] || 0) + Math.random() * (1 - cfg.wolfDeduction) * 3 }));
      scored.sort((a, b) => b.s - a.s);
      return scored[0].p.id;
    }
    if (kind === 'doctor') {
      // protect the Seer if one has spoken up, else yourself / the most valuable
      const claimedSeer = alive.find(p => this.claims[p.id] === 'seer' && p.id !== actor.id);
      if (claimedSeer && Math.random() < cfg.wolfDeduction) return claimedSeer.id;
      if (Math.random() < 0.4) return actor.id;
      const likelyTarget = this.packThreats(actor)[0];
      return likelyTarget ? likelyTarget.id : pick(alive).id;
    }
    return pick(alive).id;
  }

  checkNightDone() {
    if (this.phase !== 'night') return;
    const req = this.requiredNightActors();
    if (req.length && req.every(a => this.nightSub[a.pid])) this.resolveNight();
  }

  resolveNight() {
    if (this.phase !== 'night') return;
    const wolfVotes = this.requiredNightActors().filter(a => a.kind === 'wolf').map(a => this.nightSub[a.pid]).filter(Boolean);
    const tally = {};
    wolfVotes.forEach(id => tally[id] = (tally[id] || 0) + 1);
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    const victimId = top ? top[0] : null;
    const doctorActor = this.requiredNightActors().find(a => a.kind === 'doctor');
    const savedId = doctorActor ? this.nightSub[doctorActor.pid] : null;
    const seerActor = this.requiredNightActors().find(a => a.kind === 'seer');
    if (seerActor && this.nightSub[seerActor.pid]) {
      const t = this.room.players.find(p => p.id === this.nightSub[seerActor.pid]);
      if (t) {
        this.investigations[seerActor.pid].push({ targetId: t.id, name: t.name, isWolf: t.role === 'wolf', round: this.round });
        // a confident bot Seer shares the result, which the village trusts
        if (seerActor.isBot && ai.profile(this.difficulty).wolfDeduction > 0.5) {
          this.claims[seerActor.id] = 'seer';
          this.log(`💬 ${seerActor.name}: "I am the Seer — trust me and I'll find the wolves."`);
          if (t.role === 'wolf') this.log(`💬 ${seerActor.name}: "I checked ${t.name}. They are a WEREWOLF."`);
        }
      }
    }
    const victim = this.room.players.find(p => p.id === victimId);
    this.alive().forEach(p => { if (p.id !== victimId) this.evidence[p.id].survivedNight++; });
    if (victim && savedId !== victim.id) {
      victim.alive = false; victim.roleRevealed = true;
      this.message = `☀️ Dawn — ${victim.name} (${ROLE_INFO[victim.role].split(' —')[0]}) was killed by the wolves!`;
      this.log(`☀️ Day ${this.round}: ${victim.name} (${victim.role}) was killed.`);
    } else {
      this.message = '☀️ Dawn — nobody died! The Doctor may have saved a life…';
      this.log(`☀️ Day ${this.round}: nobody died.`);
    }
    this.startPhase('morning');
    if (this.checkWin()) return;
    this.broadcast();
    // a bot or two reacts, slowly, so the day feels alive
    const speakers = this.alive().filter(p => p.isBot).slice(0, 2);
    speakers.forEach((bot, i) => setTimeout(() => {
      if (this.destroyed || this.phase !== 'morning') return;
      const lines = victim && savedId !== victim.id
        ? [`Poor ${victim.name}… the wolves are among us.`, `Someone is lying to us. ${victim.name} paid for it.`]
        : ['Nobody died? The Doctor deserves a medal.', 'A quiet night — that worries me more.'];
      this.log(`💬 ${bot.name}: "${pick(lines)}"`);
      this.broadcast();
    }, 1500 + i * 2600));
  }

  /* ---- day ---- */
  startVoting() {
    if (this.phaseTimer) { clearInterval(this.phaseTimer); this.phaseTimer = null; }
    this.votes = {};
    this.startPhase('vote');
    this.message = '🗳️ Vote: choose who you think is a werewolf.';
    this.broadcast();
    this.alive().filter(p => p.isBot).forEach((p, i) => setTimeout(() => {
      if (this.destroyed || this.phase !== 'vote' || !p.alive) return;
      if (this.votes[p.id]) return;
      this.votes[p.id] = this.botVote(p);
      const t = this.room.players.find(x => x.id === this.votes[p.id]);
      if (t && Math.random() < 0.6) {
        const level = this.difficulty;
        const reason = level === 'easy' ? 'Something feels off about them.'
          : level === 'normal' ? 'They have been very quiet.'
            : `They voted with the wolves ${Math.max(1, this.evidence[t.id]?.votedWithWolf || 1)} time${(this.evidence[t.id]?.votedWithWolf || 0) > 1 ? 's' : ''}.`;
        this.log(`💬 ${p.name}: "I vote ${t.name}. ${reason}"`);
      }
      this.checkVoteDone();
      this.broadcast();
    }, 2500 + i * 2200));
  }

  botVote(voter) {
    const others = this.alive().filter(p => p.id !== voter.id);
    if (!others.length) return null;
    const level = ai.adaptiveLevel(this.difficulty, this.standingFor());
    const cfg = ai.profile(level);

    // a Seer always follows their evidence
    if (voter.role === 'seer') {
      const inv = this.investigations[voter.id] || [];
      const knownWolf = inv.find(r => r.isWolf && others.some(p => p.id === r.targetId));
      if (knownWolf) return knownWolf.targetId;
    }

    if (voter.role === 'wolf') {
      // vote out an innocent, ideally one already under suspicion
      const prey = others.filter(p => p.role !== 'wolf');
      if (!prey.length) return pick(others).id;
      const scored = prey.map(p => ({ p, s: (this.suspicion[p.id] || 0) + Math.random() * (1 - cfg.wolfCoordination) * 4 }));
      scored.sort((a, b) => b.s - a.s);
      return scored[0].p.id;
    }

    const cleared = new Set((this.investigations[voter.id] || []).filter(r => !r.isWolf).map(r => r.targetId));
    const pool = others.filter(p => !cleared.has(p.id));
    const use = pool.length ? pool : others;
    const scored = use.map(p => ({
      p,
      s: ai.werewolfSuspicion({
        level, standing: this.standingFor(), isWolf: false, voterId: voter.id, targetId: p.id,
        suspicion: this.suspicion, evidence: this.evidence, aliveIds: this.aliveIds(), claims: this.claims,
      }),
    }));
    scored.sort((a, b) => b.s - a.s);
    // strongest bots don't always follow the crowd — they can be wrong
    if (Math.random() < cfg.wolfDeduction) return scored[0].p.id;
    return pick(use).id;
  }

  checkVoteDone() {
    if (this.phase !== 'vote') return;
    if (this.alive().every(p => this.votes[p.id])) this.resolveVote();
  }

  resolveVote() {
    if (this.phase !== 'vote') return;
    if (this.phaseTimer) { clearInterval(this.phaseTimer); this.phaseTimer = null; }
    const tally = {};
    Object.values(this.votes).filter(Boolean).forEach(id => tally[id] = (tally[id] || 0) + 1);
    const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const nameOf = id => (this.room.players.find(p => p.id === id) || {}).name || '?';
    const summary = entries.map(([id, n]) => `${nameOf(id)}: ${n}`).join(' · ');

    if (entries.length && (entries.length === 1 || entries[0][1] > entries[1][1])) {
      const out = this.room.players.find(p => p.id === entries[0][0]);
      // ledger: who backed the winning accusation, who defended a wolf
      Object.entries(this.votes).forEach(([voterId, targetId]) => {
        if (!this.evidence[voterId]) return;
        if (targetId === out.id) {
          if (out.role === 'wolf') this.suspicion[voterId] = Math.max(0, (this.suspicion[voterId] || 0) - 2);
          else this.suspicion[voterId] = (this.suspicion[voterId] || 0) + 1;
        }
        if (out.role === 'wolf' && targetId !== out.id && voterId !== out.id) this.evidence[voterId].defendedAccused++;
      });
      out.alive = false; out.roleRevealed = true;
      if (out.role === 'seer' && this.claims[out.id] === 'seer') {
        Object.keys(this.evidence).forEach(id => { this.evidence[id].accusedSeer++; });
      }
      // wolves who voted for their own packmate look clean for now
      const votersForWolf = Object.entries(this.votes).filter(([, t]) => t === out.id).map(([v]) => v);
      this.message = `⚖️ Vote (${summary}) — ${out.name} is eliminated and was a ${ROLE_INFO[out.role].split(' —')[0]}!`;
      this.log(`⚖️ ${this.message}`);
      void votersForWolf;
    } else {
      this.message = `⚖️ Tie vote (${summary || 'no votes'}) — nobody is eliminated.`;
      this.log(`⚖️ ${this.message}`);
    }
    this.startPhase('voteResult');
    if (this.checkWin()) return;
    this.broadcast();
  }

  checkWin() {
    const wolves = this.alive().filter(p => p.role === 'wolf').length;
    const others = this.alive().length - wolves;
    let winner = null;
    if (!wolves) winner = '🎉 THE VILLAGE WINS!';
    else if (wolves >= others) winner = '🐺 THE WEREWOLVES WIN!';
    if (!winner) return false;
    this.phase = 'over'; this.message = winner;
    if (this.phaseTimer) { clearInterval(this.phaseTimer); this.phaseTimer = null; }
    this.room.players.forEach(p => p.roleRevealed = true);
    this.log(winner);
    this.broadcast();
    return true;
  }

  /** Smart catch-up: how far ahead/behind the human villagers are. */
  standingFor() {
    const human = this.room.players.find(p => !p.isBot && p.connected);
    if (!human) return 0;
    const humansAlive = this.alive().filter(p => !p.isBot).length;
    const humansTotal = this.room.players.filter(p => !p.isBot).length || 1;
    return Math.max(-1, Math.min(1, (humansAlive / humansTotal) * 2 - 1));
  }

  action(pid, data) {
    const me = this.room.players.find(p => p.id === pid);
    if (!me) return;
    if (data.type === 'ready' && this.phase === 'reveal') {
      this.ready.add(pid); this.checkRevealDone(); this.broadcast(); return;
    }
    if (data.type === 'continue') {
      if (!me.alive && this.phase !== 'over') return;
      this.continued.add(pid);
      const humans = this.alive().filter(p => !p.isBot);
      const everyone = humans.length ? humans.every(p => this.continued.has(p.id)) : true;
      if (!everyone && this.phase !== 'over') { this.broadcast(); return; }
      if (this.phase === 'morning') return this.startVoting();
      if (this.phase === 'voteResult') { this.round++; return this.startNight(); }
      if (this.phase === 'over') return this.start();
      return;
    }
    if (data.type === 'night' && this.phase === 'night' && me.alive) {
      const req = this.requiredNightActors().find(a => a.pid === pid);
      if (!req || req.kind !== data.kind) return;
      const target = this.room.players.find(p => p.id === data.targetId);
      if (!target || !target.alive) return;
      if (req.kind === 'wolf' && target.role === 'wolf') return;
      if (req.kind !== 'doctor' && target.id === pid) return;
      this.nightSub[pid] = target.id;
      this.checkNightDone(); this.broadcast(); return;
    }
    if (data.type === 'vote' && this.phase === 'vote' && me.alive) {
      const target = this.room.players.find(p => p.id === data.targetId);
      if (!target || !target.alive || target.id === pid) return;
      this.votes[pid] = target.id;
      this.checkVoteDone(); this.broadcast(); return;
    }
    if (data.type === 'wolfChat') {
      if (me.role !== 'wolf') return;
      const text = String(data.text || '').trim().slice(0, 200);
      if (!text) return;
      this.wolfChat.push({ from: me.name, text });
      if (this.wolfChat.length > 50) this.wolfChat.shift();
      const botWolf = this.alive().find(p => p.isBot && p.role === 'wolf' && p.id !== pid);
      if (botWolf && Math.random() < 0.8) {
        const mentioned = this.alive().find(p => p.role !== 'wolf' && text.toLowerCase().includes(p.name.toLowerCase()));
        setTimeout(() => {
          if (this.destroyed) return;
          this.wolfChat.push({
            from: botWolf.name,
            text: mentioned ? `Agreed — ${mentioned.name} won't see the dawn. 🌕`
              : pick(['The moon looks tasty tonight. 🌕', 'Keep your head down tomorrow, packmate.', 'Careful — the Seer is still out there.']),
          });
          this.broadcast();
        }, 1800);
      }
      this.broadcast(); return;
    }
  }

  disconnect(pid) {
    const p = this.room.players.find(x => x.id === pid); if (!p) return;
    if (this.phase !== 'lobby' && this.phase !== 'over' && p.alive) {
      p.alive = false; p.roleRevealed = true;
      this.log(`👋 ${p.name} left and was eliminated (${p.role || '?'})`);
      if (this.phase === 'night') this.checkNightDone();
      if (this.phase === 'vote') this.checkVoteDone();
      this.checkWin();
    }
    this.broadcast();
  }

  publicState(viewerId) {
    const me = this.room.players.find(p => p.id === viewerId);
    const players = this.room.players.map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, sprite: p.sprite, isBot: p.isBot, connected: p.connected,
      alive: !!p.alive,
      role: (p.roleRevealed || this.phase === 'over' || p.id === viewerId) && p.role ? ROLE_INFO[p.role].split(' —')[0] : null,
      voted: this.phase === 'vote' ? (this.votes[p.id] ? true : false) : undefined,
      claim: this.claims[p.id] || null,
    }));
    let myPrompt = null;
    if (me && me.alive) {
      if (this.phase === 'night') {
        const req = this.requiredNightActors().find(a => a.pid === viewerId);
        if (req && !this.nightSub[viewerId]) {
          const targets = this.alive().filter(t => req.kind === 'wolf' ? t.role !== 'wolf' : (t.id !== viewerId || req.kind === 'doctor'));
          myPrompt = { type: 'night', kind: req.kind, targets: targets.map(t => ({ id: t.id, name: t.name, avatar: t.avatar })) };
        }
      } else if (this.phase === 'vote' && !this.votes[viewerId]) {
        myPrompt = { type: 'vote', targets: this.alive().filter(t => t.id !== viewerId).map(t => ({ id: t.id, name: t.name, avatar: t.avatar })) };
      }
    }
    const secondsLeft = this.phaseEndsAt ? Math.max(0, Math.ceil((this.phaseEndsAt - Date.now()) / 1000)) : 0;
    return {
      players,
      game: {
        phase: this.phase, round: this.round, message: this.message,
        phaseSeconds: secondsLeft,
        iHaveContinued: this.continued.has(viewerId),
        humansLeftToContinue: this.alive().filter(p => !p.isBot && !this.continued.has(p.id)).length,
        myRole: me && me.role ? {
          key: me.role, label: ROLE_INFO[me.role].split(' — ')[0], desc: ROLE_INFO[me.role],
          pack: me.role === 'wolf' ? this.room.players.filter(p => p.role === 'wolf').map(p => p.name) : [],
        } : null,
        iAmReady: this.ready.has(viewerId),
        myPrompt,
        myInvestigations: me ? (this.investigations[viewerId] || []) : [],
        wolfChat: me && me.role === 'wolf' ? this.wolfChat : null,
        iAmAlive: me ? !!me.alive : false,
        iVotedFor: this.votes[viewerId] || null,
        myClaim: this.claims[viewerId] || null,
      },
    };
  }
}

module.exports = { WerewolfEngine };
