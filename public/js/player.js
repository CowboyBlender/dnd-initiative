'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let state               = null;
let ws                  = null;
let activeLayer         = 'a';         // which spotlight layer is currently visible
let lastActiveCombatantId = null;      // detect combatant change for dissolve
let expiredConditions   = [];          // { combatantId, combatantName, conditionName }

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const params   = new URLSearchParams(location.search);
  const roomCode = (params.get('room') || '').toUpperCase();
  if (!roomCode) {
    document.getElementById('room-name').textContent = 'No room code provided';
    return;
  }

  const res = await fetch(`/api/rooms/${roomCode}/state`);
  if (!res.ok) {
    document.getElementById('room-name').textContent = 'Room not found';
    document.getElementById('player-combatants-list').innerHTML =
      '<div class="connecting-msg">This room does not exist. Check your code.</div>';
    return;
  }

  connectWS(roomCode);
})();

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS(roomCode) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${roomCode}&role=player`);

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'state_update') {
      state = msg.data;
      renderAll();

    } else if (msg.type === 'condition_expired') {
      expiredConditions.push(msg.data);
      // Only update spotlight badge area if the expired condition belongs to the current combatant
      if (state && state.combatants.length) {
        const idx = state.current_turn_index % state.combatants.length;
        const cur = state.combatants[idx];
        if (msg.data.combatantId === cur.id) {
          updateExpiredArea(cur.id);
        }
      }
    }
  };

  ws.onclose = () => setTimeout(() => connectWS(roomCode), 3000);
}

// ── Render All ────────────────────────────────────────────────────────────────
function renderAll() {
  if (!state) return;
  document.getElementById('room-name').textContent     = state.name;
  document.getElementById('round-display').textContent = `Round ${state.current_round}`;
  applyBgFromState();
  renderInitiative();
  renderSpotlight();
}

function applyBgFromState() {
  if (!state) return;
  const url   = state.bg_image_url   || '';
  const x     = state.bg_image_x     ?? 50;
  const y     = state.bg_image_y     ?? 50;
  const scale = state.bg_image_scale ?? 100;
  if (url) {
    document.body.style.backgroundImage      = `url(${JSON.stringify(url)})`;
    document.body.style.backgroundSize       = scale === 100 ? 'cover' : `${scale}%`;
    document.body.style.backgroundPosition   = `${x}% ${y}%`;
    document.body.style.backgroundRepeat     = 'no-repeat';
    document.body.style.backgroundAttachment = 'fixed';
  } else {
    document.body.style.backgroundImage = '';
  }
}

// ── Initiative List ───────────────────────────────────────────────────────────
function renderInitiative() {
  const list = document.getElementById('player-combatants-list');

  // Snapshot current HP bar widths for smooth transition animation
  const prevHpPct = {};
  list.querySelectorAll('[data-id]').forEach(el => {
    const fill = el.querySelector('.hp-bar-fill');
    if (fill) prevHpPct[el.dataset.id] = fill.style.width;
  });

  list.innerHTML = '';

  if (!state.combatants.length) {
    list.innerHTML = '<div class="connecting-msg">No combatants yet.</div>';
    return;
  }

  state.combatants.forEach((c, idx) => {
    const isActive = idx === (state.current_turn_index % state.combatants.length);
    const card = buildInitiativeCard(c, isActive);

    // For smooth HP transition: temporarily set bar to previous width (no transition)
    const fill = card.querySelector('.hp-bar-fill');
    const prevW = prevHpPct[String(c.id)];
    if (fill && prevW !== undefined) {
      fill.style.transition = 'none';
      fill.style.width = prevW;
    }

    list.appendChild(card);
  });

  // Animate HP bars to their new values in the next frame
  requestAnimationFrame(() => {
    state.combatants.forEach(c => {
      const card = list.querySelector(`[data-id="${c.id}"]`);
      if (!card) return;
      const fill = card.querySelector('.hp-bar-fill');
      if (fill && prevHpPct[String(c.id)] !== undefined) {
        fill.offsetWidth; // force reflow so CSS transition fires
        fill.style.transition = '';
        if (c.show_hp && c.max_hp) {
          const pct = Math.max(0, Math.min(100, (c.current_hp / c.max_hp) * 100));
          fill.style.width = `${pct}%`;
        }
      }
    });
  });
}

function buildInitiativeCard(c, isActive) {
  const card = document.createElement('div');
  card.className = 'player-combatant-card' + (isActive ? ' active-turn' : '');
  card.dataset.id = String(c.id);
  card.style.backgroundColor = c.card_color || '#2a2a40';

  const imgX     = c.image_x     ?? 50;
  const imgY     = c.image_y     ?? 50;
  const imgScale = c.image_scale ?? 100;

  const sat = c.saturation ?? 1;
  const portraitHtml = c.image_url
    ? `<img class="player-card-portrait" src="${esc(c.image_url)}"
            style="object-position:${imgX}% ${imgY}%;transform:scale(${imgScale/100});transform-origin:${imgX}% ${imgY}%;filter:saturate(${sat})"
            alt="" onerror="this.style.display='none'">`
    : `<div class="player-card-portrait-placeholder">${esc((c.name || '?').trim().substring(0, 2).toUpperCase())}</div>`;

  let hpHtml = '';
  if (c.combatant_type !== 'Layer Action' && c.show_hp && c.max_hp != null) {
    const pct = c.max_hp > 0 ? Math.max(0, Math.min(100, (c.current_hp / c.max_hp) * 100)) : 0;
    const cls = pct > 50 ? 'hp-full' : pct > 25 ? 'hp-mid' : 'hp-low';
    hpHtml = `
      <div class="player-card-hp">${c.current_hp} / ${c.max_hp}${c.temp_hp > 0 ? ` (+${c.temp_hp})` : ''}</div>
      <div class="hp-bar-track" style="height:4px;margin-top:3px">
        <div class="hp-bar-fill ${cls}" style="width:${pct}%"></div>
      </div>`;
  }

  const condHtml = (c.show_conditions && c.conditions.length)
    ? `<div class="player-card-conds">${c.conditions.map(cd =>
        `<span class="condition-badge${cd.rounds_remaining === 1 ? ' expiring' : ''}" style="font-size:10px;padding:1px 5px">${esc(formatCondLabel(cd))}</span>`
      ).join('')}</div>`
    : '';

  card.innerHTML = `
    ${portraitHtml}
    <div class="player-card-info">
      <div class="player-card-name">${esc(c.name)}${isActive ? ' <span style="color:var(--gold)">◀</span>' : ''}</div>
      ${hpHtml}${condHtml}
    </div>`;

  return card;
}

// ── Surgically update just the expired-badge area in the spotlight ─────────────
// Only shows badges for the given combatantId (the currently active combatant)
function updateExpiredArea(activeCombatantId) {
  const curEl = document.getElementById(`spotlight-${activeLayer}`);
  if (!curEl) return;
  const overlay = curEl.querySelector('.spotlight-gradient-overlay');
  if (!overlay) return;

  const relevant = expiredConditions.filter(ec => ec.combatantId === activeCombatantId);
  const expiredHtml = relevant.map(ec =>
    `<div class="expired-cond-badge">Condition Removed: ${esc(ec.conditionName)}</div>`
  ).join('');

  let area = overlay.querySelector('.expired-conditions-area');
  if (expiredHtml) {
    if (!area) {
      area = document.createElement('div');
      area.className = 'expired-conditions-area';
      overlay.prepend(area);
    }
    area.innerHTML = expiredHtml;
  } else if (area) {
    area.remove();
  }
}

// ── Spotlight (fullscreen crossfade) ──────────────────────────────────────────
function renderSpotlight() {
  if (!state) return;

  if (!state.combatants.length) {
    setLayer('<div class="spotlight-empty-state"><p>Waiting for combat to begin…</p></div>', false);
    return;
  }

  const idx  = state.current_turn_index % state.combatants.length;
  const cur  = state.combatants[idx];
  const next = state.combatants.length > 1 ? state.combatants[(idx + 1) % state.combatants.length] : null;

  const combatantChanged = cur.id !== lastActiveCombatantId;

  if (combatantChanged) {
    // Clear expired conditions for the combatant whose turn just ended
    if (lastActiveCombatantId !== null) {
      expiredConditions = expiredConditions.filter(ec => ec.combatantId !== lastActiveCombatantId);
    }
    lastActiveCombatantId = cur.id;
    setLayer(buildSpotlightHtml(cur, next), true);
  } else {
    updateOverlay(cur, next);
  }
}

// ── Build full spotlight HTML (image + overlay) ───────────────────────────────
function buildSpotlightHtml(cur, next) {
  const imgX     = cur.image_x     ?? 50;
  const imgY     = cur.image_y     ?? 50;
  const imgScale = cur.image_scale ?? 100;

  const curSat = cur.saturation ?? 1;
  const imgSection = cur.image_url
    ? `<img class="spotlight-bg-img"
             src="${esc(cur.image_url)}"
             style="object-position:${imgX}% ${imgY}%;transform:scale(${imgScale/100});transform-origin:${imgX}% ${imgY}%;filter:saturate(${curSat})"
             alt="${esc(cur.name)}"
             onerror="this.style.display='none';document.getElementById('spotlight-fallback-${cur.id}').style.display='flex'">`
    + `<div id="spotlight-fallback-${cur.id}" class="spotlight-fallback" style="display:none">${esc(cur.name)}</div>`
    : `<div class="spotlight-fallback">${esc(cur.name)}</div>`;

  return `${imgSection}<div class="spotlight-gradient-overlay">${buildOverlayContent(cur, next)}</div>`;
}

// ── Build overlay content (conditions, death saves, expired badges, up-next) ──
function buildOverlayContent(cur, next) {
  const condHtml = (cur.show_conditions && cur.conditions.length)
    ? cur.conditions.map(cd =>
        `<span class="spotlight-cond-badge${cd.condition_name === 'Exhaustion' ? ' exhaust' : ''}${cd.rounds_remaining === 1 ? ' expiring' : ''}">${esc(formatCondLabel(cd))}</span>`
      ).join('')
    : '';

  // HP bar: only for non-Layer Action combatants
  const hpPct = (cur.combatant_type !== 'Layer Action' && cur.show_hp && cur.max_hp)
    ? Math.max(0, Math.min(100, (cur.current_hp / cur.max_hp) * 100)) : 0;
  const hpCls = hpPct > 50 ? 'hp-full' : hpPct > 25 ? 'hp-mid' : 'hp-low';
  const hpBarHtml = (cur.combatant_type !== 'Layer Action' && cur.show_hp && cur.max_hp != null) ? `
    <div class="spotlight-hp-bar">
      <div class="hp-bar-label">
        <span>HP</span>
        <span>${cur.current_hp}${cur.temp_hp > 0 ? ` + ${cur.temp_hp} tmp` : ''} / ${cur.max_hp}</span>
      </div>
      <div class="hp-bar-track"><div class="hp-bar-fill ${hpCls}" style="width:${hpPct}%"></div></div>
    </div>` : '';

  // Death saves: PC/NPC at 0 HP with DM visibility enabled
  const showDeathSaves = (cur.combatant_type === 'PC' || cur.combatant_type === 'NPC')
    && cur.death_save_fails !== null && cur.death_save_successes !== null;
  const deathSavesHtml = showDeathSaves ? `
    <div class="spotlight-death-saves">
      <div class="death-save-row fails">
        <span class="ds-label">Fails</span>
        ${[0,1,2].map(i => `<span class="ds-pip fail${cur.death_save_fails > i ? ' filled' : ''}"></span>`).join('')}
      </div>
      <div class="death-save-row successes">
        <span class="ds-label">Successes</span>
        ${[0,1,2].map(i => `<span class="ds-pip success${cur.death_save_successes > i ? ' filled' : ''}"></span>`).join('')}
      </div>
    </div>` : '';

  // Only show expired badges for the current combatant
  const relevantExpired = expiredConditions.filter(ec => ec.combatantId === cur.id);
  const expiredHtml = relevantExpired.length
    ? `<div class="expired-conditions-area">${relevantExpired.map(ec =>
        `<div class="expired-cond-badge">Condition Removed: ${esc(ec.conditionName)}</div>`
      ).join('')}</div>`
    : '';

  const nextHtml = next ? `
    <div class="spotlight-up-next">
      <span class="up-next-label">Up Next:</span>
      ${next.image_url
        ? `<img class="up-next-portrait" src="${esc(next.image_url)}"
                style="object-position:${next.image_x ?? 50}% ${next.image_y ?? 50}%"
                alt="" onerror="this.style.display='none'">`
        : ''}
      <span class="up-next-name">${esc(next.name)}</span>
    </div>` : '';

  return `${expiredHtml}
    <div class="spotlight-info">
      <div class="spotlight-name">${esc(cur.name)}</div>
      <div class="spotlight-type-badge">${esc(cur.combatant_type)}</div>
      ${hpBarHtml}
      ${condHtml ? `<div class="spotlight-conditions">${condHtml}</div>` : ''}
      ${deathSavesHtml}
    </div>
    ${nextHtml}`;
}

// ── Partial overlay update (no image reload) ──────────────────────────────────
function updateOverlay(cur, next) {
  const curEl = document.getElementById(`spotlight-${activeLayer}`);
  if (!curEl) return;
  const overlay = curEl.querySelector('.spotlight-gradient-overlay');
  if (!overlay) {
    curEl.innerHTML = buildSpotlightHtml(cur, next);
    curEl.classList.add('visible');
    return;
  }

  // Update image position/scale/saturation live without reloading the image element
  const img = curEl.querySelector('.spotlight-bg-img');
  if (img) {
    const imgX = cur.image_x ?? 50;
    const imgY = cur.image_y ?? 50;
    const imgScale = cur.image_scale ?? 100;
    img.style.objectPosition = `${imgX}% ${imgY}%`;
    img.style.transform = `scale(${imgScale / 100})`;
    img.style.transformOrigin = `${imgX}% ${imgY}%`;
    img.style.filter = `saturate(${cur.saturation ?? 1})`;
  }

  // Snapshot spotlight HP bar width for smooth transition
  const existingFill = overlay.querySelector('.spotlight-hp-bar .hp-bar-fill');
  const prevSpotlightW = existingFill ? existingFill.style.width : null;

  overlay.innerHTML = buildOverlayContent(cur, next);

  // Animate spotlight HP bar
  if (prevSpotlightW !== null) {
    const newFill = overlay.querySelector('.spotlight-hp-bar .hp-bar-fill');
    if (newFill) {
      newFill.style.transition = 'none';
      newFill.style.width = prevSpotlightW;
      requestAnimationFrame(() => {
        newFill.offsetWidth;
        newFill.style.transition = '';
        const pct = (cur.show_hp && cur.max_hp) ? Math.max(0, Math.min(100, (cur.current_hp / cur.max_hp) * 100)) : 0;
        newFill.style.width = `${pct}%`;
      });
    }
  }
}

// ── Layer crossfade ────────────────────────────────────────────────────────────
function setLayer(html, dissolve) {
  const nextLayer = activeLayer === 'a' ? 'b' : 'a';
  const nextEl    = document.getElementById(`spotlight-${nextLayer}`);
  const curEl     = document.getElementById(`spotlight-${activeLayer}`);

  nextEl.innerHTML = html;

  if (dissolve) {
    nextEl.classList.remove('visible');
    nextEl.getBoundingClientRect(); // force layout so transition triggers
    nextEl.classList.add('visible');
    curEl.classList.remove('visible');
    activeLayer = nextLayer;
  } else {
    curEl.innerHTML = html;
    curEl.classList.add('visible');
    nextEl.classList.remove('visible');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatCondLabel(cond) {
  if (cond.condition_name === 'Exhaustion') return `Exhaustion (Level ${cond.exhaustion_level})`;
  if (cond.rounds_remaining != null) {
    const r = cond.rounds_remaining;
    return `${cond.condition_name}: ${r} ${r === 1 ? 'Round' : 'Rounds'} Remaining`;
  }
  return cond.condition_name;
}
