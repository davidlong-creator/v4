'use strict';
/* ============================================================================
   Smash-style Boxing + Platform Arena renderer
   Blocks, bevels, parallax and particles are drawn procedurally so the game
   stays a single fast-loading canvas — no extra image requests.
   ========================================================================== */
(function () {
  const W = 960, H = 540;
  const input = { left: false, right: false, jump: false, punch: false, heavy: false, block: false, dodge: false, down: false };
  const TEAM = ['#ff5d68', '#5ab0ff'];
  const FX = ['#ffe9a8', '#ffd166', '#ff8f4d', '#ff5d68', '#c084fc', '#7ee2a0'];

  let active = false, canvas = null, ctx = null, state = null, socket = null, builtFor = '';
  let raf = 0, sendTimer = 0, avatarCache = {}, imageCache = {};
  let shake = 0, particles = [], lastTickAt = performance.now(), camX = 0;
  let lastPhase = '', swingSeen = new Set();
  let labelLanes = new Map();

  /**
   * Stack name plates so players standing on top of each other stay readable:
   * walk fighters left to right and give each the lowest lane nobody nearby uses.
   */
  function computeLabelLanes(fighters) {
    const lanes = new Map();
    const groups = [];
    [...fighters].filter(f => f.alive).sort((a, b) => a.x - b.x).forEach(f => {
      let group = groups.find(gr => Math.abs(gr.x - f.x) < 92 && gr.lanes.size < 4);
      if (!group) { group = { x: f.x, lanes: new Set() }; groups.push(group); }
      let lane = 0;
      while (group.lanes.has(lane)) lane++;
      group.lanes.add(lane);
      lanes.set(f.id, lane);
    });
    return lanes;
  }
  const flashUntil = new Map();

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  const atlas = new Image(); atlas.src = '/fighters.png';
  const ANIM = {
    running: { start: 0, frames: 3, fps: 9 },
    blocking: { start: 3, frames: 3, fps: 6 },
    punching: { start: 6, frames: 3, fps: 16 },
    powerful: { start: 9, frames: 6, fps: 20 },
    jump: { start: 15, frames: 3, fps: 8 },
  };

  function cacheAvatars(s) {
    (s.lobbyPlayers || []).forEach(p => {
      if (p.avatarImage && avatarCache[p.id] !== p.avatarImage) {
        avatarCache[p.id] = p.avatarImage;
        const img = new Image(); img.src = p.avatarImage; imageCache[p.id] = img;
      }
    });
  }

  /* ---------------- HUD text ---------------- */
  function scoreHTML(g) {
    if (g.hillMode) {
      const rows = g.fighters.map(f => {
        const side = g.teams ? f.team : f.id;
        const label = g.teams ? (f.team === 0 ? '🔴 Red' : '🔵 Blue') : esc(f.name);
        const pts = Math.floor((g.scores && g.scores[side]) || 0);
        return `<span style="white-space:nowrap;">${label} <b style="color:#ffe98a;">${pts}</b></span>`;
      });
      return [...new Set(rows)].join('<span style="opacity:.4;"> · </span>');
    }
    const sideStocks = new Map();
    g.fighters.forEach(f => {
      const side = g.teams ? f.team : f.id;
      const prev = sideStocks.get(side) || 0;
      sideStocks.set(side, prev + Math.max(0, f.stocks));
    });
    const parts = [];
    for (const [side, stocks] of sideStocks) {
      const pips = '●'.repeat(Math.min(6, stocks));
      if (g.teams) {
        const color = TEAM[Number(side) % 2];
        parts.push(`<span style="white-space:nowrap; color:${color}; font-weight:900;">${Number(side) === 0 ? '🔴 RED' : '🔵 BLUE'}</span> <span style="color:#fff;">${pips || '—'}</span>`);
      } else {
        const f = g.fighters.find(x => x.id === side) || {};
        parts.push(`<span style="white-space:nowrap; color:${TEAM[(f.slot || 0) % 2]}; font-weight:800;">${esc(f.name || '')}</span> <span style="color:#fff;">${pips || '—'}</span>`);
      }
    }
    return parts.join('<span style="opacity:.35;"> · </span>');
  }

  function statusLine(g) {
    if (g.phase === 'over') return g.winner || 'Match over';
    const clock = g.timeLeft ? `${Math.floor(g.timeLeft / 60)}:${String(g.timeLeft % 60).padStart(2, '0')}` : '';
    if (g.mode === 'boxing') return `🥊 3 stocks each · knock them off the stage · respawn in 5s${clock ? ' · ' + clock : ''}`;
    if (g.hillMode) return `👑 Hold the hill uncontested — first to ${g.hillWin} points wins`;
    return `⚔️ 3 stocks each · most stocks left when the clock runs out`;
  }

  /* ---------------- screen chrome ---------------- */
  function render(opts) {
    active = true; state = opts.state; socket = opts.socket;
    cacheAvatars(state);
    const key = `${state.code}:${state.gameType}:${state.variant}`;
    if (builtFor !== key || !canvas || !opts.screen.contains(canvas)) {
      builtFor = key;
      const isBoxing = state.gameType === 'boxing';
      opts.screen.innerHTML = `${opts.topbarHTML(isBoxing ? '🥊 <b>Smash Boxing</b>' : '⚔️ <b>Platform Arena</b>')}
        <div class="smash-hud">
          <div class="smash-score" id="smashScore"></div>
          <div class="smash-status" id="smashStatus"></div>
        </div>
        <div class="smash-stage-wrap">
          <canvas id="arcadeCanvas" width="${W}" height="${H}" aria-label="Fight arena"></canvas>
          <div class="smash-hint" id="smashHint">Tap the screen or press a key to start moving</div>
        </div>
        <div class="smash-feed" id="smashFeed"></div>
        <div class="smash-pad" id="arcadeTouch">
          <div class="smash-pad-col">
            <button data-control="left" aria-label="Move left">◀</button>
            <button data-control="right" aria-label="Move right">▶</button>
          </div>
          <div class="smash-pad-col">
            <button data-control="block" class="pad-alt" aria-label="Block">🛡</button>
            <button data-control="dodge" class="pad-alt" aria-label="Dodge">💨</button>
          </div>
          <div class="smash-pad-col">
            <button data-control="jump" class="pad-jump" aria-label="Jump">⬆</button>
            <button data-control="down" class="pad-alt" aria-label="Fast fall">⬇</button>
          </div>
          <div class="smash-pad-col pad-buttons">
            <button data-control="punch" class="pad-a" aria-label="Quick attack">A</button>
            <button data-control="heavy" class="pad-b" aria-label="Smash attack">B</button>
          </div>
        </div>
        <p class="hint smash-keys">Keyboard: <b>A / D</b> move · <b>Space</b> jump (twice for a double jump) · <b>S</b> fast-fall · <b>J</b> quick attack · <b>K</b> smash attack · <b>L</b> shield · <b>Shift</b> dodge</p>
        <div style="text-align:center; margin:12px 0;"><button class="btn-gold" id="arcadeAgain" style="display:none; width:auto;">🔁 Rematch</button></div>
        ${opts.logHTML()}`;
      opts.wireTopbar();
      canvas = $('arcadeCanvas'); ctx = canvas.getContext('2d');
      $('arcadeAgain').onclick = () => socket.emit('playAgain');
      opts.screen.querySelectorAll('[data-control]').forEach(bindControl);
      if (!sendTimer) sendTimer = setInterval(sendInput, 50);
      if (!raf) raf = requestAnimationFrame(draw);
    }
    $('smashScore').innerHTML = scoreHTML(state.game);
    $('smashStatus').textContent = statusLine(state.game);
    $('arcadeAgain').style.display = state.game.phase === 'over' ? 'inline-block' : 'none';
    const hintEl = $('smashHint');
    if (hintEl && !hintEl.dataset.faded) {
      setTimeout(() => {
        if (!hintEl.dataset.faded) { hintEl.dataset.faded = '1'; hintEl.style.opacity = '0'; setTimeout(() => hintEl.remove(), 700); }
      }, 4200);
    }
    const feed = $('smashFeed');
    const rows = (state.game.koFeed || []).filter(e => Date.now() - e.at < 9000).slice(-3);
    feed.innerHTML = rows.map(e => `<div class="smash-feed-row">💥 <b>${esc(e.name)}</b>${e.by ? ` was launched by <b>${esc(e.by)}</b>` : ' fell off the stage'}</div>`).join('');
  }

  function bindControl(btn) {
    const name = btn.dataset.control;
    if (!name) return;
    const down = e => {
      e.preventDefault();
      input[name] = true; btn.classList.add('held');
      if (btn.setPointerCapture && e.pointerId !== undefined) { try { btn.setPointerCapture(e.pointerId); } catch (_) {} }
    };
    const up = e => { e.preventDefault(); input[name] = false; btn.classList.remove('held'); };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
    btn.addEventListener('contextmenu', e => e.preventDefault());
  }

  let lastJumpAt = 0;
  const origJumpSound = () => {
    if (!state || !state.game) return;
    const me = (state.game.fighters || []).find(f => f.id === state.meId);
    if (!me || !me.alive) return;
    if (!input.jump) return;
    const now = performance.now();
    if (me.onGround && now - lastJumpAt > 320) { lastJumpAt = now; fx('jump'); }
  };
  window.addEventListener('keydown', e => { if ([' ', 'w', 'ArrowUp'].includes(e.key)) setTimeout(origJumpSound, 0); });

  function sendInput() {
    if (!active || !socket || !state || !state.game || state.game.phase !== 'playing') return;
    socket.emit('gameAction', { type: 'input', input });
  }

  function deactivate() {
    active = false; state = null; socket = null; builtFor = ''; canvas = null; ctx = null;
    Object.keys(input).forEach(k => input[k] = false);
    if (raf) cancelAnimationFrame(raf); raf = 0;
    if (sendTimer) clearInterval(sendTimer); sendTimer = 0;
    particles = []; flashUntil.clear();
  }

  const keyMap = {
    a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right',
    w: 'jump', arrowup: 'jump', ' ': 'jump', j: 'punch', z: 'punch',
    k: 'heavy', x: 'heavy', l: 'block', c: 'block', shift: 'dodge', v: 'dodge',
    s: 'down', arrowdown: 'down',
  };
  window.addEventListener('keydown', e => {
    if (!active || !state || !state.game || state.game.phase !== 'playing') return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    const name = keyMap[String(e.key).toLowerCase()]; if (!name) return;
    input[name] = true; e.preventDefault();
  });
  window.addEventListener('keyup', e => {
    const name = keyMap[String(e.key).toLowerCase()]; if (!name) return;
    input[name] = false; if (active) e.preventDefault();
  });
  window.addEventListener('blur', () => Object.keys(input).forEach(k => input[k] = false));

  /* ---------------- painting helpers ---------------- */
  const rgba = (hex, a) => {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const shade = (hex, amt) => {
    const n = parseInt(hex.replace('#', ''), 16);
    const c = v => Math.max(0, Math.min(255, Math.round(v + amt)));
    return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
  };
  function hash(x, y) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  // A Minecraft-style block: flat fill, bright top/left bevel, dark bottom bevel.
  function block(x, y, w, h, base, r = 0, bevel = 4) {
    ctx.fillStyle = base;
    if (r) { roundRect(x, y, w, h, r, 'fill'); }
    else ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    ctx.fillRect(x, y, w, Math.max(2, bevel));
    ctx.fillRect(x, y, Math.max(2, bevel), h);
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.fillRect(x, y + h - Math.max(2, bevel), w, Math.max(2, bevel));
    ctx.fillRect(x + w - Math.max(2, bevel), y, Math.max(2, bevel), h);
  }
  function roundRect(x, y, w, h, r, mode) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    if (mode !== 'clip') ctx.fill();
  }

  /* ---------------- world ---------------- */
  function drawSky(g, t) {
    if (g.theme === 'ring') {
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#1b0a13'); grad.addColorStop(0.55, '#2a0f1b'); grad.addColorStop(1, '#12060a');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
      // arena lights
      for (let i = 0; i < 3; i++) {
        const cx = 220 + i * 260;
        const lamp = ctx.createLinearGradient(cx, 0, cx, 300);
        lamp.addColorStop(0, 'rgba(255,226,160,.20)'); lamp.addColorStop(1, 'rgba(255,226,160,0)');
        ctx.fillStyle = lamp;
        ctx.beginPath(); ctx.moveTo(cx - 26, 0); ctx.lineTo(cx + 26, 0); ctx.lineTo(cx + 150, 320); ctx.lineTo(cx - 150, 320); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ffe7b0'; ctx.fillRect(cx - 18, 0, 36, 12);
      }
      // crowd
      for (let row = 0; row < 4; row++) {
        for (let i = 0; i < 34; i++) {
          const x = i * 30 + (row % 2) * 15, y = 208 + row * 34;
          const bob = Math.sin(t / 620 + i + row) * 2;
          ctx.fillStyle = row < 2 ? 'rgba(120,80,95,.5)' : 'rgba(90,58,72,.55)';
          ctx.beginPath(); ctx.arc(x, y + bob, 10, 0, Math.PI * 2); ctx.fill();
          ctx.fillRect(x - 9, y + 6 + bob, 18, 20);
        }
      }
      // banners
      ctx.fillStyle = 'rgba(255,93,104,.18)'; ctx.fillRect(0, 190, W, 10);
      return;
    }

    // overworld sky
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#4a86d8'); sky.addColorStop(0.55, '#8cc3f0'); sky.addColorStop(1, '#d7ecff');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

    // sun block
    ctx.save();
    ctx.globalAlpha = 0.22; ctx.fillStyle = '#fff6c4';
    ctx.beginPath(); ctx.arc(813, 77, 56, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff3b0';
    ctx.beginPath(); ctx.arc(813, 77, 26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff9d6';
    ctx.beginPath(); ctx.arc(806, 70, 15, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // clouds (blocky)
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    const clouds = [[80, 70], [300, 110], [560, 62], [720, 140]];
    clouds.forEach(([cx, cy], i) => {
      const drift = ((t / 90 + i * 140) % (W + 260)) - 130;
      const x = (cx + drift) % (W + 260) - 60;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x, cy, 84, 18); ctx.fillRect(x + 18, cy - 18, 56, 18); ctx.fillRect(x + 96, cy + 6, 40, 12);
      ctx.globalAlpha = 1;
    });

    // far hills (parallax layer)
    const px = -camX * 0.25;
    const base = (g.groundY || 430);
    ctx.fillStyle = '#79b06a';
    for (let i = -1; i < 7; i++) {
      const bx = px + i * 220;
      ctx.beginPath(); ctx.moveTo(bx - 30, base); ctx.lineTo(bx + 110, base - 170); ctx.lineTo(bx + 250, base); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    for (let i = -1; i < 7; i++) {
      const bx = px + i * 220;
      ctx.beginPath(); ctx.moveTo(bx + 74, base - 116); ctx.lineTo(bx + 110, base - 170); ctx.lineTo(bx + 146, base - 116); ctx.closePath(); ctx.fill();
    }

    // floating stage: dirt only under the main platform, sky in the pits
    const floor = (g.groundY || 430);
    const main = (g.platforms || [])[0];
    const left = main ? main.x : 60;
    const right = main ? main.x + main.w : W - 60;
    ctx.fillStyle = '#7a5234'; ctx.fillRect(left, floor, right - left, H - floor);
    ctx.fillStyle = '#8d6240';
    for (let x = left; x < right; x += 24) {
      for (let y = floor + 8; y < H; y += 24) {
        if (hash(x, y) > 0.7) ctx.fillRect(x + 4, y + 6, 12, 10);
      }
    }
    // rocky cliff faces so the stage reads as a chunk of ground
    ctx.fillStyle = 'rgba(20,26,38,.35)';
    ctx.fillRect(left, floor, 6, H - floor);
    ctx.fillRect(right - 6, floor, 6, H - floor);
    ctx.fillStyle = '#4d3320';
    for (let y = floor + 12; y < H; y += 24) {
      ctx.fillRect(left - 5 + hash(1, y) * 3, y, 7, 16);
      ctx.fillRect(right - 2 - hash(2, y) * 3, y, 7, 16);
    }
    ctx.fillStyle = '#5aa64a'; ctx.fillRect(left, floor - 8, right - left, 12);
    ctx.fillStyle = '#7ecb63';
    for (let x = left; x < right; x += 16) if (hash(x, 7) > 0.45) ctx.fillRect(x, floor - 14, 8, 8);
  }

  function drawPlatforms(g) {
    g.platforms.forEach((p, i) => {
      const main = i === 0;
      if (g.theme === 'ring') {
        block(p.x, p.y, p.w, p.h, main ? '#b8452f' : '#8e3524', 0, 6);
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        for (let x = p.x; x < p.x + p.w; x += 46) ctx.fillRect(x, p.y + 4, 3, p.h - 8);
        if (main) {
          ctx.fillStyle = '#f7f1e2'; ctx.fillRect(p.x, p.y - 12, p.w, 12);
          ctx.fillStyle = 'rgba(0,0,0,.16)'; ctx.fillRect(p.x, p.y - 3, p.w, 3);
          // corner posts
          const postTop = p.y - 148;
          ctx.fillStyle = '#c9a227';
          ctx.fillRect(p.x + 4, postTop, 13, 148);
          ctx.fillRect(p.x + p.w - 17, postTop, 13, 148);
          ctx.fillStyle = '#ffe08a';
          ctx.fillRect(p.x + 4, postTop, 13, 8);
          ctx.fillRect(p.x + p.w - 17, postTop, 13, 8);
          // three ropes, top to bottom
          [['#ff5d68', 34], ['#f7f1e2', 78], ['#5ab0ff', 122]].forEach(([c, drop]) => {
            ctx.strokeStyle = c; ctx.lineWidth = 4;
            ctx.beginPath(); ctx.moveTo(p.x + 10, p.y - drop); ctx.lineTo(p.x + p.w - 10, p.y - drop); ctx.stroke();
            ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(p.x + 10, p.y - drop + 2); ctx.lineTo(p.x + p.w - 10, p.y - drop + 2); ctx.stroke();
          });
        }
        return;
      }
      // grass-topped block
      block(p.x, p.y, p.w, Math.max(18, p.h), '#8a5c34', 0, 5);
      ctx.fillStyle = '#5aa64a'; ctx.fillRect(p.x, p.y, p.w, 10);
      ctx.fillStyle = '#7ecb63';
      for (let x = p.x; x < p.x + p.w; x += 14) if (hash(x, p.y) > 0.42) ctx.fillRect(x, p.y - 5, 9, 7);
      // block seams make the platform read as stacked Minecraft blocks
      ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1;
      for (let x = p.x + 18; x < p.x + p.w - 6; x += 18) {
        ctx.beginPath(); ctx.moveTo(x, p.y + 10); ctx.lineTo(x, p.y + Math.max(18, p.h) - 2); ctx.stroke();
      }
      ctx.fillStyle = '#6f4a2c';
      ctx.fillRect(p.x, p.y + Math.max(18, p.h), p.w, 7);
    });
  }

  function drawHill(g, t) {
    if (!g.hill) return;
    const h = g.hill;
    const owner = h.owner;
    const color = owner === null || owner === undefined ? '#ffd166'
      : g.teams ? TEAM[Number(owner) % 2] : '#7ee2a0';
    const pulse = 0.35 + Math.sin(t / 320) * 0.12;
    ctx.fillStyle = rgba(color.replace('#', '#'), 1).replace('rgba', 'rgba');
    ctx.save();
    ctx.globalAlpha = pulse * 0.5;
    ctx.fillStyle = color;
    ctx.fillRect(h.x, h.y - 120, h.w, 120);
    ctx.restore();
    ctx.strokeStyle = rgba(color, 0.9); ctx.lineWidth = 3;
    ctx.strokeRect(h.x + 1.5, h.y - 60, h.w - 3, 60);
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(h.x, h.y - 60, h.w, 20);
    ctx.fillStyle = '#ffe98a'; ctx.font = '900 14px "Google Sans",Roboto,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('👑 THE HILL', h.x + h.w / 2, h.y - 45);
    if (g.hillProgress !== null && g.hillProgress !== undefined) {
      const pct = Math.max(0, Math.min(1, g.hillProgress / (g.hillWin || 60)));
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(h.x + 8, h.y - 34, h.w - 16, 12);
      ctx.fillStyle = color; ctx.fillRect(h.x + 8, h.y - 34, (h.w - 16) * pct, 12);
      ctx.fillStyle = '#fff'; ctx.font = '800 11px "Google Sans",Roboto,sans-serif';
      ctx.fillText(`${Math.floor(g.hillProgress)} / ${g.hillWin || 60}`, h.x + h.w / 2, h.y - 25);
    }
  }

  function drawPickup(p, t) {
    const bob = Math.sin(t / 400 + p.x) * 4;
    const y = p.y + bob;
    ctx.fillStyle = 'rgba(255,225,150,.18)';
    ctx.beginPath(); ctx.arc(p.x, y, 24, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(p.x, y);
    if (p.type === 'sword') {
      ctx.fillStyle = '#dfe6f2'; ctx.fillRect(-3, -20, 6, 30);
      ctx.fillStyle = '#c9a227'; ctx.fillRect(-11, 8, 22, 5); ctx.fillRect(-3, 13, 6, 9);
    } else if (p.type === 'pickaxe') {
      ctx.fillStyle = '#9a6b3f'; ctx.fillRect(-2, -8, 5, 28);
      ctx.fillStyle = '#bfc7d4'; ctx.fillRect(-12, -12, 24, 6); ctx.fillRect(-14, -6, 6, 5); ctx.fillRect(8, -6, 6, 5);
    } else {
      ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 0, 15, -1.2, 1.2); ctx.stroke();
      ctx.strokeStyle = '#e9e3cf'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-9, -14); ctx.lineTo(9, 14); ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------- fighters ---------------- */
  function actionFor(f, g, t) {
    if (f.blocking) return { anim: 'blocking', frame: Math.floor(t / 150) % 3 };
    if (f.shieldBroken) return { anim: 'blocking', frame: 0 };
    if (f.attackKind) {
      const heavy = f.attackKind.startsWith('heavy');
      const dur = heavy ? 300 : 190;
      const progress = clamp01(1 - (f.attackMs || 0) / dur);
      const anim = heavy ? 'powerful' : 'punching';
      const frames = ANIM[anim].frames;
      return { anim, frame: Math.min(frames - 1, Math.floor(progress * frames)) };
    }
    if (!f.onGround) {
      const frame = f.vy < -120 ? 0 : f.vy > 140 ? 2 : 1;
      return { anim: 'jump', frame };
    }
    if (Math.abs(f.vx) > 30) return { anim: 'running', frame: Math.floor(t / 110) % 3 };
    return { anim: 'running', frame: 0 };
  }
  const clamp01 = v => Math.max(0, Math.min(1, v));

  function drawFighter(f, g, t) {
    if (!f.alive) {
      ctx.save();
      ctx.textAlign = 'center';
      const secs = Math.ceil((f.respawnMs || 0) / 1000);
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      roundRect(f.x - 26, f.y - 4, 82, 26, 8, 'fill');
      ctx.fillStyle = '#ffe98a'; ctx.font = '800 13px "Google Sans",Roboto,sans-serif';
      ctx.fillText(`💫 ${secs}s`, f.x + f.w / 2 + 15, f.y + 13);
      ctx.restore();
      return;
    }
    const cx = f.x + f.w / 2;
    const color = g.teams || g.mode === 'boxing' ? TEAM[f.team % 2] : TEAM[f.slot % 2];
    ctx.save();

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.beginPath(); ctx.ellipse(cx, f.y + f.h + 3, 22, 6, 0, 0, Math.PI * 2); ctx.fill();

    // dodge / invuln aura
    if (f.dodging) {
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#cfe9ff';
    }
    if (f.invuln) {
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, f.y + f.h / 2, 34, 0, Math.PI * 2); ctx.stroke();
    }

    const size = 86;
    const { anim, frame } = actionFor(f, g, t);
    const meta = ANIM[anim];
    const row = Math.max(0, Math.min(19, f.sprite || 0));
    const top = f.y + f.h - size + 6;

    if (atlas.complete && atlas.naturalWidth) {
      ctx.save();
      if (f.dir < 0) { ctx.translate(cx, 0); ctx.scale(-1, 1); }
      const dx = f.dir < 0 ? -size / 2 : cx - size / 2;
      ctx.drawImage(atlas, (meta.start + frame) * 32, row * 32, 32, 32, dx, top, size, size);
      ctx.restore();
      if (f.hitstun) {
        ctx.globalAlpha = 0.35; ctx.fillStyle = '#fff';
        roundRect(cx - size / 2 + 6, top + 6, size - 12, size - 12, 10, 'fill');
        ctx.globalAlpha = 1;
      }
    } else {
      block(f.x, f.y + 8, f.w, f.h - 8, color, 6);
      ctx.font = '22px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(f.avatar || '🧑', cx, f.y + 38);
    }

    // held item
    const reach = f.attackKind ? 34 : 20;
    if (f.weapon === 'sword') {
      ctx.strokeStyle = '#e8eef8'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(cx + f.dir * reach, f.y + 30); ctx.lineTo(cx + f.dir * (reach + 32), f.y + 4); ctx.stroke();
      ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(cx + f.dir * (reach - 2), f.y + 36); ctx.lineTo(cx + f.dir * (reach + 10), f.y + 26); ctx.stroke();
    } else if (f.weapon === 'pickaxe') {
      ctx.fillStyle = '#9a6b3f'; ctx.fillRect(cx + f.dir * reach - 3, f.y + 8, 6, 32);
      ctx.fillStyle = '#c3ccda'; ctx.fillRect(cx + f.dir * (reach + 2) - 12, f.y + 6, 24, 6);
    } else if (f.weapon === 'bow') {
      ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx + f.dir * reach, f.y + 30, 16, -1.1, 1.1); ctx.stroke();
    }

    // shield bubble
    if (f.blocking) {
      const r = 30 + Math.sin(t / 120) * 1.5;
      ctx.strokeStyle = rgba('#ffe98a', 0.9); ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(cx, f.y + f.h / 2, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = rgba('#ffe98a', 0.12);
      ctx.beginPath(); ctx.arc(cx, f.y + f.h / 2, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // ---- name plate, damage %, stocks (stacked so they never collide) ----
    const zoom = 1;
    // every fighter gets its own vertical lane so name plates never overlap
    const laneIndex = labelLanes.has(f.id) ? labelLanes.get(f.id) : (f.slot % 4);
    const plateY = f.y - 44 - laneIndex * 21;
    const sideShift = laneIndex % 2 ? (laneIndex === 1 ? 26 : -26) : 0;
    const labelX = Math.max(46, Math.min(W - 46, cx + sideShift));
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '700 11.5px "Google Sans",Roboto,sans-serif';
    const shortName = f.name.length > 9 ? f.name.slice(0, 8) + '…' : f.name;
    const label = shortName + (f.isBot ? ' 🤖' : '');
    const tw = ctx.measureText(label).width + 12;
    ctx.fillStyle = 'rgba(8,10,16,.62)';
    roundRect(labelX - tw / 2, plateY, tw, 17, 8, 'fill');
    ctx.fillStyle = color;
    ctx.fillText(label, labelX, plateY + 12);

    const dmg = Math.round(f.damage);
    const dmgColor = dmg < 50 ? '#ffffff' : dmg < 100 ? '#ffd166' : dmg < 150 ? '#ff8f4d' : '#ff3b3b';
    ctx.font = '900 17px "Google Sans",Roboto,sans-serif';
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.strokeText(`${dmg}%`, labelX, plateY - 7);
    ctx.fillStyle = dmgColor;
    ctx.fillText(`${dmg}%`, labelX, plateY - 7);

    if (f.stocks >= 0) {
      ctx.font = '900 10.5px "Google Sans",Roboto,sans-serif';
      ctx.fillStyle = 'rgba(8,10,16,.55)';
      roundRect(labelX - 17, plateY + 19, 34, 14, 7, 'fill');
      ctx.fillStyle = color;
      ctx.fillText('★'.repeat(Math.min(3, f.stocks)) || '×', labelX, plateY + 29);
    }
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(cx - 21, f.y - 7, 42, 4);
    ctx.fillStyle = f.stamina > 40 ? '#7ee2a0' : '#ff8f4d';
    ctx.fillRect(cx - 21, f.y - 7, 42 * Math.max(0, f.stamina) / 100, 4);
    ctx.restore();
    void zoom;
  }

  /* ---------------- particles & effects ---------------- */
  function spawnParticles(g) {
    const now = Date.now();
    for (const e of g.effects || []) {
      const key = e.id;
      if (flashUntil.has(key)) continue;
      flashUntil.set(key, now);
      const count = e.type === 'ko' ? 26 : e.type === 'hitHeavy' ? 16 : e.type === 'hit' ? 10 : e.type === 'block' ? 6 : 8;
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2, sp = 60 + Math.random() * (e.type === 'ko' ? 380 : 220);
        particles.push({
          x: e.x, y: e.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 60,
          life: 1, decay: 1.6 + Math.random(), size: 2 + Math.random() * 4,
          color: FX[(e.seed + i) % FX.length], kind: e.type,
        });
      }
      if (e.type === 'ko') { shake = Math.max(shake, 14); fx('ko'); }
      else if (e.type === 'hitHeavy') { shake = Math.max(shake, 7); fx('hitHeavy'); }
      else if (e.type === 'hit') { shake = Math.max(shake, 3); fx('hitLight'); }
      else if (e.type === 'block') fx('block');
      else if (e.type === 'pickup') fx('chip');
      else if (e.type === 'respawn') fx('bell');
    }
    if (flashUntil.size > 120) flashUntil.clear();
  }

  function fx(name) { if (window.GameFX) window.GameFX.play(name); }

  /** One result record per match, credited to the local player. */
  function recordResult(g) {
    if (!window.GameStats || g.phase !== 'over' || lastPhase === 'over') { lastPhase = g.phase; return; }
    lastPhase = g.phase;
    const label = String(g.winner || '');
    const meNames = (state.lobbyPlayers || []).filter(p => p.id === state.meId).map(p => p.name);
    const myFighter = (g.fighters || []).find(f => f.id === state.meId);
    let result = 'draw';
    if (/draw|tied/i.test(label)) result = 'draw';
    else if (meNames.some(n => label.includes(n))) result = 'win';
    else if (myFighter && g.teams && /^(Team Red|Team Blue)/.test(label)) {
      const winnerTeam = label.startsWith('Team Red') ? 0 : 1;
      result = winnerTeam === myFighter.team ? 'win' : 'loss';
    } else if (meNames.length) result = 'loss';
    const kos = myFighter ? myFighter.kos : 0;
    window.GameStats.record({ game: state.gameType === 'boxing' ? 'boxing' : 'arena', result, kos });
    fx(result === 'win' ? 'win' : result === 'loss' ? 'lose' : 'click');
  }

  function stepParticles(dt) {
    const keep = [];
    for (const p of particles) {
      p.life -= p.decay * dt;
      if (p.life <= 0) continue;
      p.vy += 620 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.985;
      keep.push(p);
    }
    particles = keep.slice(-220);
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.fillStyle = p.color;
      const s = p.size * (0.6 + p.life * 0.7);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  function drawHudOverlay(g, t) {
    // KO banner
    const ko = (g.koFeed || []).filter(e => t - e.at < 1500).slice(-1)[0];
    if (ko) {
      const age = (t - ko.at) / 1500;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - age);
      ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 150, W, 96);
      ctx.textAlign = 'center';
      ctx.font = '900 44px "Google Sans",Roboto,sans-serif';
      ctx.fillStyle = '#ffe98a';
      ctx.fillText('K.O.!', W / 2, 205 + Math.sin(age * 12) * 2);
      ctx.font = '800 16px "Google Sans",Roboto,sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(`${ko.name} lost a stock${ko.by ? ` to ${ko.by}` : ''}`, W / 2, 232);
      ctx.restore();
    }
    if (g.timeLeft) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = '900 26px "Google Sans",Roboto,sans-serif';
      ctx.fillStyle = g.timeLeft <= 20 ? '#ff5d68' : '#ffffff';
      const label = `${Math.floor(g.timeLeft / 60)}:${String(g.timeLeft % 60).padStart(2, '0')}`;
      ctx.fillStyle = 'rgba(0,0,0,.4)'; roundRect(W / 2 - 44, 14, 88, 40, 12, 'fill');
      ctx.fillStyle = g.timeLeft <= 20 ? '#ff5d68' : '#ffffff';
      ctx.fillText(label, W / 2, 43);
      ctx.restore();
    }
    if (g.phase === 'over') {
      ctx.save();
      ctx.fillStyle = 'rgba(6,8,14,.72)'; ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.font = '900 40px "Google Sans",Roboto,sans-serif'; ctx.fillStyle = '#ffe98a';
      ctx.fillText('GAME!', W / 2, 236);
      ctx.font = '800 20px "Google Sans",Roboto,sans-serif'; ctx.fillStyle = '#fff';
      wrapText(g.winner || 'Match over', W / 2, 274, 620, 26);
      ctx.font = '600 15px "Google Sans",Roboto,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.fillText('Press Rematch to run it back', W / 2, 344);
      ctx.restore();
    }
  }

  function wrapText(text, x, y, maxWidth, lineHeight) {
    const words = String(text).split(' ');
    let line = '', lines = [];
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
  }

  /* ---------------- main loop ---------------- */
  function draw(now) {
    raf = active ? requestAnimationFrame(draw) : 0;
    if (!active || !ctx || !state || !state.game) return;
    const g = state.game, t = now || performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (t - lastTickAt) / 1000));
    lastTickAt = t;

    ctx.imageSmoothingEnabled = false;
    ctx.save();
    if (shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake *= 0.9;
    } else shake = 0;
    ctx.clearRect(-20, -20, W + 40, H + 40);
    drawSky(g, t);
    drawPlatforms(g);
    drawHill(g, t);
    (g.pickups || []).forEach(p => drawPickup(p, t));
    (g.projectiles || []).forEach(p => {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(0, p.dir));
      ctx.fillStyle = '#c9a227'; ctx.fillRect(-12, -1.5, 24, 3);
      ctx.fillStyle = '#e9e3cf'; ctx.beginPath(); ctx.moveTo(p.dir * 14, 0); ctx.lineTo(p.dir * 6, -5); ctx.lineTo(p.dir * 6, 5); ctx.closePath(); ctx.fill();
      ctx.restore();
    });
    spawnParticles(g);
    stepParticles(dt);
    recordResult(g);
    if (g.phase !== 'over') lastPhase = g.phase;
    labelLanes = computeLabelLanes(g.fighters || []);
    (g.fighters || []).forEach(f => drawFighter(f, g, t));
    drawParticles();
    drawHudOverlay(g, t);
    ctx.restore();
  }

  window.ArcadeOnline = { render, deactivate };
})();
