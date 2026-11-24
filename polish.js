'use strict';
/* ============================================================================
   Shared polish layer
   - GameFX: tiny Web Audio synth (no audio files to load or download)
   - GameStats: local win/loss records, streaks, achievements and a profile card
   Everything is stored on the device, so it survives refreshes and redeploys.
   ========================================================================== */
(function () {
  /* ------------------------------ sound ------------------------------ */
  const SOUND_KEY = 'gamesOnlineSound';
  let audioCtx = null;
  let enabled = (() => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch (_) { return true; } })();

  function ctx() {
    if (typeof window === 'undefined') return null;
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { audioCtx = new AC(); } catch (_) { return null; }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  /** Play a short synthesised blip. */
  function tone({ freq = 440, to = null, dur = 0.12, type = 'sine', gain = 0.06, delay = 0 }) {
    if (!enabled) return;
    const ac = ctx();
    if (!ac) return;
    const t0 = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const amp = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(30, to), t0 + dur);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise({ dur = 0.16, gain = 0.05, delay = 0, lowpass = 1400 }) {
    if (!enabled) return;
    const ac = ctx();
    if (!ac) return;
    const frames = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buffer = ac.createBuffer(1, frames, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = lowpass;
    const amp = ac.createGain(); amp.gain.value = gain;
    src.connect(filter).connect(amp).connect(ac.destination);
    src.start(ac.currentTime + delay);
  }

  const SOUNDS = {
    click: () => tone({ freq: 620, to: 520, dur: 0.06, type: 'triangle', gain: 0.03 }),
    card: () => { noise({ dur: 0.09, gain: 0.05, lowpass: 2600 }); tone({ freq: 320, dur: 0.05, gain: 0.02 }); },
    shuffle: () => { for (let i = 0; i < 4; i++) noise({ dur: 0.07, gain: 0.035, delay: i * 0.06, lowpass: 2200 }); },
    chip: () => { tone({ freq: 900, to: 1200, dur: 0.06, type: 'square', gain: 0.025 }); },
    hitLight: () => { noise({ dur: 0.1, gain: 0.07, lowpass: 1800 }); tone({ freq: 220, to: 140, dur: 0.1, type: 'square', gain: 0.04 }); },
    hitHeavy: () => { noise({ dur: 0.22, gain: 0.1, lowpass: 1100 }); tone({ freq: 150, to: 70, dur: 0.24, type: 'sawtooth', gain: 0.06 }); },
    block: () => tone({ freq: 520, to: 640, dur: 0.09, type: 'triangle', gain: 0.04 }),
    jump: () => tone({ freq: 300, to: 620, dur: 0.12, type: 'sine', gain: 0.035 }),
    ko: () => { tone({ freq: 90, to: 45, dur: 0.5, type: 'sawtooth', gain: 0.09 }); noise({ dur: 0.4, gain: 0.09, lowpass: 800 }); },
    bell: () => { [0, 0.16].forEach(d => tone({ freq: 1180, to: 900, dur: 0.6, type: 'sine', gain: 0.05, delay: d })); },
    win: () => { [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.05, delay: i * 0.11 })); },
    lose: () => { [400, 330, 260].forEach((f, i) => tone({ freq: f, dur: 0.26, type: 'sine', gain: 0.05, delay: i * 0.13 })); },
    message: () => tone({ freq: 780, to: 980, dur: 0.09, type: 'sine', gain: 0.03 }),
    turn: () => tone({ freq: 660, dur: 0.08, type: 'triangle', gain: 0.03 }),
  };

  const GameFX = {
    play(name) { const fn = SOUNDS[name]; if (fn) try { fn(); } catch (_) {} },
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = !!on;
      try { localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off'); } catch (_) {}
      syncButton();
    },
    toggle() { this.setEnabled(!enabled); if (enabled) this.play('click'); },
  };

  /* ---------------------------- statistics ---------------------------- */
  const STATS_KEY = 'gamesOnlineStats';
  const blankStats = () => ({ games: 0, wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0, history: [], achievements: [], perGame: {} });

  const ACHIEVEMENTS = [
    { id: 'first_game', name: 'Table for one', desc: 'Finish your first game', icon: '🎲' },
    { id: 'first_win', name: 'Opening act', desc: 'Win your first game', icon: '🥇' },
    { id: 'win_5', name: 'On a heater', desc: 'Win 5 games', icon: '🔥' },
    { id: 'win_15', name: 'House favourite', desc: 'Win 15 games', icon: '👑' },
    { id: 'streak_3', name: 'Three in a row', desc: 'Win 3 games back to back', icon: '⚡' },
    { id: 'streak_5', name: 'Unstoppable', desc: 'Win 5 games back to back', icon: '🌩️' },
    { id: 'poker_win', name: 'Card sharp', desc: 'Win a poker game', icon: '🃏' },
    { id: 'chess_win', name: 'Checkmate', desc: 'Win a chess game', icon: '♟️' },
    { id: 'wolf_win', name: 'Trust nobody', desc: 'Win a Werewolf game', icon: '🐺' },
    { id: 'fight_win', name: 'Ring master', desc: 'Win a boxing or arena match', icon: '🥊' },
    { id: 'ko_3', name: 'Knockout artist', desc: 'Land 3 knockouts in one match', icon: '💥' },
    { id: 'comeback', name: 'Never count me out', desc: 'Win after losing twice in a row', icon: '🪄' },
    { id: 'social', name: 'Good company', desc: 'Send 10 chat messages', icon: '💬' },
  ];

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return blankStats();
      return { ...blankStats(), ...raw, perGame: raw.perGame || {}, history: raw.history || [], achievements: raw.achievements || [] };
    } catch (_) { return blankStats(); }
  }
  let stats = load();
  function save() { try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (_) {} }

  function unlock(id) {
    if (!ACHIEVEMENTS.some(a => a.id === id) || stats.achievements.includes(id)) return null;
    stats.achievements.push(id);
    save();
    const meta = ACHIEVEMENTS.find(a => a.id === id);
    toast(`${meta.icon} Achievement unlocked: ${meta.name}`);
    GameFX.play('win');
    renderProfileCard();
    return meta;
  }

  const GameStats = {
    get all() { return stats; },
    achievements: ACHIEVEMENTS,
    record({ game = 'game', result = 'draw', kos = 0 } = {}) {
      stats.games++;
      const per = stats.perGame[game] || { games: 0, wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0 };
      per.games++;
      if (result === 'win') { stats.wins++; per.wins++; stats.streak++; per.streak++; }
      else if (result === 'loss') { stats.losses++; per.losses++; stats.streak = 0; per.streak = 0; }
      else { stats.draws++; per.draws++; }
      stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
      per.bestStreak = Math.max(per.bestStreak || 0, per.streak);
      stats.perGame[game] = per;
      stats.history.unshift({ game, result, at: Date.now() });
      stats.history = stats.history.slice(0, 40);
      save();

      unlock('first_game');
      if (result === 'win') {
        unlock('first_win');
        if (stats.wins >= 5) unlock('win_5');
        if (stats.wins >= 15) unlock('win_15');
        if (stats.streak >= 3) unlock('streak_3');
        if (stats.streak >= 5) unlock('streak_5');
        if (game === 'poker') unlock('poker_win');
        if (game === 'chess') unlock('chess_win');
        if (game === 'werewolf') unlock('wolf_win');
        if (game === 'boxing' || game === 'arena') unlock('fight_win');
      }
      if (kos >= 3) unlock('ko_3');
      renderProfileCard();
      return stats;
    },
    countChat() {
      stats.chats = (stats.chats || 0) + 1;
      save();
      if (stats.chats >= 10) unlock('social');
    },
    reset() { stats = blankStats(); save(); renderProfileCard(); toast('Stats cleared.'); },
    renderProfileCard,
  };

  /* ------------------------------ UI bits ------------------------------ */
  function toast(message) {
    let host = document.getElementById('gpToasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'gpToasts';
      host.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:9800;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText = 'background:#141a24;color:#fff;font:650 13.5px "Google Sans",Inter,system-ui,sans-serif;padding:11px 16px;border-radius:12px;box-shadow:0 12px 30px rgba(16,24,40,.28);opacity:0;transform:translateY(8px);transition:opacity .2s,transform .2s;max-width:90vw;';
    host.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'none'; });
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; setTimeout(() => el.remove(), 260); }, 3200);
  }

  const CSS = `
    #profileBtn { display:inline-flex; align-items:center; gap:7px; }
    #profilePanel { position:fixed; inset:0; z-index:9700; display:none; align-items:center; justify-content:center; padding:16px; background:rgba(15,20,30,.45); backdrop-filter:blur(3px); }
    #profilePanel.open { display:flex; }
    .pp-card { background:#fff; color:#141a24; width:min(520px,100%); max-height:86vh; overflow-y:auto; border-radius:20px; box-shadow:0 24px 60px rgba(16,24,40,.28); padding:22px; font-family:"Google Sans",Inter,system-ui,sans-serif; }
    .pp-head { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
    .pp-head h2 { font-size:19px; margin:0; }
    .pp-close { margin-left:auto; border:1px solid #dfe5ee; background:#fff; border-radius:10px; padding:7px 11px; cursor:pointer; font-weight:700; color:#141a24; }
    .pp-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin:12px 0 16px; }
    .pp-stat { background:#f4f6fa; border-radius:12px; padding:11px 8px; text-align:center; }
    .pp-stat b { display:block; font-size:20px; }
    .pp-stat span { font-size:11px; color:#667085; text-transform:uppercase; letter-spacing:.4px; }
    .pp-section h3 { font-size:12px; text-transform:uppercase; letter-spacing:.5px; color:#667085; margin:16px 0 8px; }
    .pp-ach { display:flex; gap:9px; align-items:flex-start; padding:8px 0; border-bottom:1px solid #eef2f8; font-size:13.5px; }
    .pp-ach.locked { opacity:.42; }
    .pp-ach .ico { font-size:18px; }
    .pp-ach b { display:block; font-size:13.5px; }
    .pp-ach small { color:#667085; }
    .pp-foot { display:flex; gap:8px; margin-top:16px; }
    .pp-foot button { flex:1; border-radius:11px; padding:11px; font-weight:700; cursor:pointer; border:1px solid #dfe5ee; background:#fff; color:#141a24; }
    .pp-foot button.danger { color:#d92d3a; border-color:#f3c9cc; }
    #soundBtn { display:inline-flex; align-items:center; gap:6px; }
    @media(max-width:520px){ .pp-grid{grid-template-columns:repeat(2,1fr);} }
  `;

  function ensureUI() {
    if (document.getElementById('ppStyle')) return;
    const style = document.createElement('style');
    style.id = 'ppStyle';
    style.textContent = CSS;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'profilePanel';
    panel.innerHTML = `<div class="pp-card" id="ppCard"></div>`;
    document.body.appendChild(panel);
    panel.addEventListener('click', e => { if (e.target === panel) panel.classList.remove('open'); });
  }

  function renderProfileCard() {
    ensureUI();
    const card = document.getElementById('ppCard');
    if (!card) return;
    const per = stats.perGame || {};
    const gameRows = Object.entries(per).map(([game, s]) => {
      const name = { poker: '🃏 Poker', chess: '♟️ Chess', werewolf: '🐺 Werewolf', boxing: '🥊 Boxing', arena: '⚔️ Arena' }[game] || game;
      const rate = s.games ? Math.round((s.wins / s.games) * 100) : 0;
      return `<div class="pp-ach"><span class="ico">${name.slice(0, 2)}</span><div><b>${name.slice(2).trim()}</b><small>${s.wins}W · ${s.losses}L · ${rate}% win rate · best streak ${s.bestStreak || 0}</small></div></div>`;
    }).join('') || '<div class="pp-ach locked"><div><b>No games yet</b><small>Your first result lands here.</small></div></div>';
    const achRows = ACHIEVEMENTS.map(a => {
      const got = stats.achievements.includes(a.id);
      return `<div class="pp-ach ${got ? '' : 'locked'}"><span class="ico">${a.icon}</span><div><b>${a.name}</b><small>${a.desc}</small></div></div>`;
    }).join('');
    card.innerHTML = `
      <div class="pp-head">
        <div style="font-size:26px;">🏅</div>
        <div><h2>Your profile</h2><div style="font-size:12.5px;color:#667085;">Saved on this device</div></div>
        <button class="pp-close" id="ppClose">Close</button>
      </div>
      <div class="pp-grid">
        <div class="pp-stat"><b>${stats.games}</b><span>Games</span></div>
        <div class="pp-stat"><b>${stats.wins}</b><span>Wins</span></div>
        <div class="pp-stat"><b>${stats.wins && stats.games ? Math.round((stats.wins / stats.games) * 100) : 0}%</b><span>Win rate</span></div>
        <div class="pp-stat"><b>${stats.bestStreak}</b><span>Best streak</span></div>
      </div>
      <div class="pp-section"><h3>By game</h3>${gameRows}</div>
      <div class="pp-section"><h3>Achievements (${stats.achievements.length}/${ACHIEVEMENTS.length})</h3>${achRows}</div>
      <div class="pp-foot">
        <button id="ppSound">${enabled ? '🔊 Sound on' : '🔇 Sound off'}</button>
        <button id="ppReset" class="danger">Reset stats</button>
      </div>`;
    const closeBtn = document.getElementById('ppClose');
    if (closeBtn) closeBtn.onclick = () => document.getElementById('profilePanel').classList.remove('open');
    const soundBtn = document.getElementById('ppSound');
    if (soundBtn) soundBtn.onclick = () => { GameFX.toggle(); renderProfileCard(); };
    const resetBtn = document.getElementById('ppReset');
    if (resetBtn) resetBtn.onclick = () => { if (confirm('Clear your local stats and achievements?')) GameStats.reset(); };
  }

  function openProfile() { ensureUI(); renderProfileCard(); document.getElementById('profilePanel').classList.add('open'); }

  function syncButton() {
    const btn = document.getElementById('soundBtn');
    if (btn) { btn.textContent = enabled ? '🔊' : '🔇'; btn.title = enabled ? 'Mute sound effects' : 'Turn sound on'; }
  }

  /* add the header buttons once the header exists */
  function mountHeaderButtons() {
    const right = document.querySelector('.app-header .header-right');
    if (!right || document.getElementById('profileBtn')) return;
    const sound = document.createElement('button');
    sound.id = 'soundBtn'; sound.className = 'btn-ghost'; sound.type = 'button';
    sound.style.padding = '8px 12px';
    sound.onclick = () => { GameFX.toggle(); };
    const profile = document.createElement('button');
    profile.id = 'profileBtn'; profile.className = 'btn-ghost'; profile.type = 'button';
    profile.style.padding = '8px 14px';
    profile.innerHTML = '🏅 Profile';
    profile.onclick = openProfile;
    right.prepend(sound);
    right.prepend(profile);
    syncButton();
  }

  /* subtle sound feedback on any button press */
  document.addEventListener('pointerdown', e => {
    const b = e.target.closest && e.target.closest('button');
    if (b && !b.disabled) GameFX.play('click');
  }, { passive: true });

  window.GameFX = GameFX;
  window.GameStats = GameStats;
  window.GameToast = toast;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountHeaderButtons);
  else mountHeaderButtons();
  setTimeout(mountHeaderButtons, 400);
})();
