'use strict';
/* ============================================================================
   Shared AI layer for Poker, Chess and Werewolf.

   Goals
   - Four difficulty levels: easy / normal / hard / expert.
   - "Smart catch-up": bots quietly ease off while a human is losing badly and
     push harder when a human is on a run, so games stay close and fun.
   - Real maths, not vibes: Monte-Carlo poker equity, chess search depth with
     an opening book, evidence-weighted Werewolf deduction.
   ========================================================================== */

const { evaluateHand, evaluateBest, SUITS } = require('./utils');

const LEVELS = ['easy', 'normal', 'hard', 'expert'];
const LEVEL_LABEL = { easy: 'Easy', normal: 'Normal', hard: 'Hard', expert: 'Expert' };

const PROFILES = {
  easy: {
    chessDepth: 1, chessBlunder: 0.34, chessQuiet: 0.22,
    pokerIters: 120, pokerAggro: 0.18, pokerBluff: 0.04, pokerCallMargin: 0.16, pokerTrap: 0.02,
    wolfDeduction: 0.25, wolfBluff: 0.05, wolfCoordination: 0.2, wolfClaimSeer: 0.02,
  },
  normal: {
    chessDepth: 3, chessBlunder: 0.12, chessQuiet: 0.12,
    pokerIters: 200, pokerAggro: 0.34, pokerBluff: 0.08, pokerCallMargin: 0.07, pokerTrap: 0.06,
    wolfDeduction: 0.55, wolfBluff: 0.18, wolfCoordination: 0.5, wolfClaimSeer: 0.08,
  },
  hard: {
    chessDepth: 4, chessBlunder: 0.035, chessQuiet: 0.06,
    pokerIters: 260, pokerAggro: 0.52, pokerBluff: 0.15, pokerCallMargin: 0.02, pokerTrap: 0.12,
    wolfDeduction: 0.78, wolfBluff: 0.32, wolfCoordination: 0.75, wolfClaimSeer: 0.15,
  },
  expert: {
    chessDepth: 5, chessBlunder: 0.008, chessQuiet: 0.03,
    pokerIters: 380, pokerAggro: 0.68, pokerBluff: 0.22, pokerCallMargin: -0.02, pokerTrap: 0.18,
    wolfDeduction: 0.93, wolfBluff: 0.45, wolfCoordination: 0.92, wolfClaimSeer: 0.22,
  },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const normalizeLevel = level => (LEVELS.includes(level) ? level : 'normal');
const profile = level => PROFILES[normalizeLevel(level)];

/**
 * Smart catch-up. `humanStanding` is >0 when the human is ahead and <0 when the
 * human is struggling. The bot slides one level either way, never more, and
 * only past a meaningful gap.
 */
function adaptiveLevel(baseLevel, humanStanding = 0) {
  const base = LEVELS.indexOf(normalizeLevel(baseLevel));
  let delta = 0;
  if (humanStanding <= -0.45) delta = -1;        // human losing badly → ease off
  else if (humanStanding >= 0.45) delta = 1;     // human on a run → push harder
  return LEVELS[clamp(base + delta, 0, LEVELS.length - 1)];
}

/* --------------------------------------------------------------------------
   POKER — Monte-Carlo equity
   -------------------------------------------------------------------------- */

/* Deterministic, fast RNG (mulberry32) so equity maths is reproducible. */
function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fullDeck() {
  const d = [];
  for (const suit of SUITS) for (let rank = 2; rank <= 14; rank++) d.push({ rank, suit });
  return d;
}

const cardKey = c => `${c.rank}${c.suit}`;

/** Remaining unknown cards once known cards are removed, shuffled. */
function unknownCards(known, rng) {
  const used = new Set(known.map(cardKey));
  const rest = fullDeck().filter(c => !used.has(cardKey(c)));
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return rest;
}

const equityCache = new Map();
const equityCacheKey = (hole, board, variant, opponents) =>
  `${variant}|${opponents}|${hole.map(cardKey).sort().join(',')}|${board.map(cardKey).sort().join(',')}`;

/**
 * Equity = chance of winning (ties split) against `opponents` random hands.
 * draw = 5 hole cards, no board; holdem = 2 hole; omaha = 4 hole.
 */
function equity(hole, board, variant, opponents, iterations, seed) {
  if (!hole || !hole.length) return 0;
  const key = equityCacheKey(hole, board, variant, opponents);
  if (equityCache.has(key)) return equityCache.get(key);
  const rng = makeRng((seed === undefined ? key.length * 2654435761 + hole[0].rank * 7919 : seed) >>> 0);
  const boardNeeds = variant === 'draw' ? 0 : 5 - board.length;
  const oppHole = variant === 'holdem' ? 2 : variant === 'omaha' ? 4 : 5;
  const need = boardNeeds + oppHole * opponents;
  const pool = unknownCards([...hole, ...board], rng);
  if (pool.length < need) { equityCache.set(key, 0.5); return 0.5; }

  const iters = Math.max(20, iterations | 0);
  const mine = variant === 'draw' ? null : null;
  void mine;
  let scored = 0, valid = 0;
  const draw = new Array(need);
  for (let i = 0; i < iters; i++) {
    // fresh partial shuffle each trial: draw `need` distinct cards from the pool
    for (let k = 0; k < need; k++) {
      const j = k + Math.floor(rng() * (pool.length - k));
      const tmp = pool[k]; pool[k] = pool[j]; pool[j] = tmp;
      draw[k] = pool[k];
    }
    let cursor = 0;
    const fullBoard = variant === 'draw' ? [] : [...board, ...draw.slice(cursor, cursor + boardNeeds)];
    cursor += boardNeeds;
    const myHand = variant === 'draw' ? evaluateHand(hole) : evaluateBest(hole, fullBoard, variant);
    if (!myHand) continue;
    let beaten = false, ties = 0;
    for (let o = 0; o < opponents; o++) {
      const oppCards = draw.slice(cursor, cursor + oppHole);
      cursor += oppHole;
      const theirs = variant === 'draw' ? evaluateHand(oppCards) : evaluateBest(oppCards, fullBoard, variant);
      if (!theirs) continue;
      if (theirs.score > myHand.score) { beaten = true; break; }
      if (theirs.score === myHand.score) ties++;
    }
    if (beaten) continue;
    valid++;
    scored += 1 / (1 + ties);
  }
  const result = valid ? scored / iters : 0.5;
  equityCache.set(key, result);
  if (equityCache.size > 4000) equityCache.clear();
  return result;
}

/**
 * Best 5-card-draw discard plan: try every keep-subset and measure how often
 * the redraw wins against one random hand.
 */
function bestDrawKeep(cards, level, seed) {
  const cfg = profile(level);
  const iters = Math.max(30, Math.round(cfg.pokerIters / 3));
  const rng = makeRng((seed === undefined ? 12345 : seed) >>> 0);
  let best = null;
  for (let mask = 1; mask < 32; mask++) {
    const keep = [];
    for (let i = 0; i < 5; i++) if (mask & (1 << i)) keep.push(i);
    const held = keep.map(i => cards[i]);
    let wins = 0, valid = 0;
    for (let n = 0; n < iters; n++) {
      const pool = unknownCards(cards, rng);
      const draw = pool.slice(0, 5 - held.length);
      const oppHole = pool.slice(5, 10);
      const mine = evaluateHand([...held, ...draw]);
      const theirs = evaluateHand(oppHole);
      valid++;
      if (mine.score > theirs.score) wins++;
      else if (mine.score === theirs.score) wins += 0.5;
    }
    const rate = valid ? wins / valid : 0;
    if (!best || rate > best.rate) best = { rate, discard: [0, 1, 2, 3, 4].filter(i => !keep.includes(i)) };
  }
  return best ? best.discard : [];
}

/**
 * Decide a poker action.
 * Returns { type: 'fold'|'check'|'call'|'raise', raiseTo }.
 */
function pokerDecision(opts) {
  const {
    level = 'normal', hole, board = [], variant = 'draw', opponents = 2,
    toCall = 0, pot = 1, myChips = 1000, currentBet = 0, minRaise = 10,
    myBet = 0, bigBlind = 10, standing = 0, position = 0.5,
  } = opts;
  const cfg = profile(adaptiveLevel(level, standing));
  const rng = Math.random;

  const eq = equity(hole, board, variant, Math.max(1, opponents), cfg.pokerIters);
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const noise = (rng() - 0.5) * (cfg.pokerCallMargin + 0.06);
  const edge = eq - potOdds + noise;
  const stack = Math.max(1, myChips);
  const potSizedRaise = () => Math.round(clamp(currentBet + minRaise + pot * (0.4 + rng() * 0.5), Math.max(currentBet + minRaise, myBet + 1), myBet + stack - 1));

  const wantValueRaise = eq > 0.68 && rng() < cfg.pokerAggro + 0.25;
  const wantProbe = eq > 0.5 && rng() < cfg.pokerAggro * 0.5 && toCall <= bigBlind * 2;
  const wantBluff = toCall === 0 && rng() < cfg.pokerBluff * (0.6 + position * 0.8) && eq < 0.42;
  const wantTrap = eq > 0.85 && rng() < cfg.pokerTrap;

  if (toCall === 0) {
    if (wantTrap) return { type: 'check' };
    if (wantValueRaise || wantBluff || wantProbe) return { type: 'raise', raiseTo: potSizedRaise() };
    return { type: 'check' };
  }
  if (wantTrap) return { type: 'call' };
  if (wantValueRaise && edge > 0.12) return { type: 'raise', raiseTo: potSizedRaise() };
  if (edge > 0) return { type: 'call' };
  if (edge > -0.06 && rng() < 0.25 + cfg.pokerCallMargin) return { type: 'call' };
  if (toCall <= bigBlind && rng() < 0.35 && eq > 0.3) return { type: 'call' };
  return { type: 'fold' };
}

/* --------------------------------------------------------------------------
   CHESS — search settings, blunders and an opening book
   -------------------------------------------------------------------------- */

const OPENERS = [
  // from-square is implicit; these are common first/second moves in (fc,tr,tc) form
  { w: [[4, 4, 3, 3], [4, 4, 3, 4], [7, 7, 4, 7], [6, 4, 4, 4], [7, 6, 5, 5]], b: [[4, 4, 3, 4], [3, 0, 4, 3], [5, 3, 6, 3]] },
];

function chessSettings(level, standing = 0, materialBalance = 0) {
  const cfg = profile(adaptiveLevel(level, standing));
  // If the bot is well ahead on material, it takes its foot off the pedal a
  // little; if it is behind, it digs in and searches harder.
  let depth = cfg.chessDepth;
  let blunder = cfg.chessBlunder;
  if (materialBalance > 600) blunder += 0.05;
  if (materialBalance < -600) { blunder = Math.max(0, blunder - 0.02); depth += 1; }
  return { depth: clamp(depth, 1, 5), blunder: clamp(blunder, 0, 0.5) };
}

/** Pick a random legal move, preferring not to hang the queen. */
function blunderMove(moves, rng = Math.random) {
  if (!moves || !moves.length) return null;
  const safe = moves.filter(m => !m.capture || m.capture === 'p');
  const pool = safe.length > 2 && rng() < 0.8 ? safe : moves;
  return pool[Math.floor(rng() * pool.length)];
}

/* --------------------------------------------------------------------------
   WEREWOLF — evidence-based suspicion
   -------------------------------------------------------------------------- */

/**
 * Score how suspicious `target` looks to `voter`, from real events:
 *  - voting history (did they vote with the wolves' known dead?)
 *  - quiet players attract attention
 *  - a seer claim is trusted or doubted by level
 *  - wolves protect their pack
 */
function werewolfSuspicion(opts) {
  const {
    level = 'normal', standing = 0, isWolf = false, voterId, targetId,
    suspicion = {}, evidence = {}, aliveIds = [], claims = {},
  } = opts;
  const cfg = profile(adaptiveLevel(level, standing));
  const base = suspicion[targetId] || 0;
  const ev = evidence[targetId] || {};
  let score = base * (0.4 + cfg.wolfDeduction);

  if (ev.votedWithWolf) score += 3 * cfg.wolfDeduction;
  if (ev.defendedAccused) score += 2 * cfg.wolfDeduction;
  if (ev.silentRounds) score += Math.min(4, ev.silentRounds) * 0.5 * cfg.wolfDeduction;
  if (ev.accusedSeer) score += 2.5 * cfg.wolfDeduction;
  if (claims[targetId] === 'seer') score -= 2 * cfg.wolfDeduction;
  if (claims[targetId] === 'seer' && claims[voterId] === 'seer') score += 4 * cfg.wolfDeduction; // two seers can't both be true
  if (ev.survivedNight) score -= 0.8 * cfg.wolfDeduction; // rarely targeted by wolves

  if (isWolf) {
    // Wolves never vote a packmate unless the pack has agreed to bus them
    if (ev.isPackmate) score -= 100;
    score += (Math.random() - 0.5) * (1 - cfg.wolfCoordination) * 4;
  }
  score += (Math.random() - 0.5) * (1 - cfg.wolfDeduction) * 5; // weaker bots guess
  void aliveIds;
  return score;
}

/** Wolf kill / seer / doctor targeting that gets sharper with level. */
function werewolfNightChoice(opts) {
  const { level = 'normal', standing = 0, role, candidates = [], threats = {}, previous = null } = opts;
  if (!candidates.length) return null;
  const cfg = profile(adaptiveLevel(level, standing));
  if (role === 'doctor') {
    // doctors protect the most obviously useful player, sometimes themselves
    const sorted = [...candidates].sort((a, b) => (threats[b.id] || 0) - (threats[a.id] || 0));
    return Math.random() < cfg.wolfDeduction ? sorted[0] : candidates[Math.floor(Math.random() * candidates.length)];
  }
  if (role === 'seer') {
    const fresh = candidates.filter(c => !previous || !(previous[c.id] || 0));
    const pool = fresh.length ? fresh : candidates;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  // wolves: eat the biggest threat, unless that repeats a mistake
  const sorted = [...candidates].sort((a, b) => (threats[b.id] || 0) - (threats[a.id] || 0));
  if (Math.random() < cfg.wolfDeduction) return sorted[0];
  return candidates[Math.floor(Math.random() * candidates.length)];
}

module.exports = {
  LEVELS, LEVEL_LABEL, PROFILES, profile, normalizeLevel, adaptiveLevel,
  equity, bestDrawKeep, pokerDecision, makeRng,
  chessSettings, blunderMove, OPENERS,
  werewolfSuspicion, werewolfNightChoice,
};
