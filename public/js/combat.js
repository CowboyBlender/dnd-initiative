'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const CONDITIONS = [
  'Blinded', 'Charmed', 'Concentrating', 'Dead', 'Deafened', 'Exhaustion', 'Frightened',
  'Grappled', 'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified',
  'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious',
];

// ── State ──────────────────────────────────────────────────────────────────────
let state = null;         // latest room state from server
let ws    = null;
let condDialogCombatantId = null;
let condDialogPendingCondition = null;
let dragSrcId = null;
const expandedCropIds        = new Set(); // preserve open state of crop sections across re-renders
const expandedLayerActionIds = new Set(); // preserve open state of layer action sections
const layerActionNotes       = new Map(); // preserve textarea content by combatant id
let bgFormInitialized = false;

// ── Init ───────────────────────────────────────────────────────────────────────
(async () => {
  const me = await fetch('/api/auth/me').then(r => r.json());
  if (!me.authenticated) { location.href = '/'; return; }

  const params   = new URLSearchParams(location.search);
  const roomCode = (params.get('room') || '').toUpperCase();
  if (!roomCode) { location.href = '/dashboard.html'; return; }

  connectWS(roomCode);
  setupUI(roomCode);
})();

// ── WebSocket ──────────────────────────────────────────────────────────────────
function connectWS(roomCode) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${roomCode}&role=dm`);

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state_update') {
      state = msg.data;
      renderAll();
    } else if (msg.type === 'condition_expired') {
      showBanner(`Condition removed: ${msg.data.conditionName} from ${msg.data.combatantName}`);
    }
  };

  ws.onclose = () => {
    // Attempt reconnect after 3s
    setTimeout(() => connectWS(roomCode), 3000);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── UI Setup (event listeners that don't change on re-render) ─────────────────
function setupUI(roomCode) {
  // Copy player link
  document.getElementById('copy-link-btn').addEventListener('click', () => {
    const url = `${location.origin}/player.html?room=${roomCode}`;
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('copy-link-btn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = 'Copy Player Link'; }, 2000);
    });
  });

  // Toggle add-form
  document.getElementById('add-form-toggle').addEventListener('click', () => {
    document.getElementById('add-combatant-form').classList.toggle('hidden');
  });

  // Add combatant form
  document.getElementById('add-combatant-form').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    send({
      type: 'add_combatant',
      data: {
        name:           fd.get('name'),
        combatant_type: fd.get('combatant_type'),
        initiative:     parseInt(fd.get('initiative')) || 0,
        max_hp:         parseInt(fd.get('max_hp')) || 10,
        image_url:      fd.get('image_url') || '',
        card_color:     fd.get('card_color') || '#2a2a40',
        image_x:        parseInt(fd.get('image_x'))     || 50,
        image_y:        parseInt(fd.get('image_y'))     || 50,
        image_scale:    parseInt(fd.get('image_scale')) || 100,
        layer_action:   fd.get('layer_action') || '',
        is_visible:     fd.get('hidden_from_players') ? false : true,
      },
    });
    e.target.reset();
    e.target.querySelector('input[name="card_color"]').value = '#2a2a40';
    e.target.querySelector('input[name="name"]').focus();
  });

  // Turn controls
  document.getElementById('next-btn').addEventListener('click', () => send({ type: 'next_turn', data: {} }));
  document.getElementById('prev-btn').addEventListener('click', () => send({ type: 'prev_turn', data: {} }));
  document.getElementById('reset-btn').addEventListener('click', () => {
    if (confirm('Reset combat to Round 1? Turn order is preserved.')) send({ type: 'reset_combat', data: {} });
  });

  // Condition dialog
  setupConditionDialog();

  // Background image form
  setupBgForm();
}

// ── Render All ─────────────────────────────────────────────────────────────────
function renderAll() {
  if (!state) return;
  document.getElementById('room-name').textContent = state.name;
  document.getElementById('room-code').textContent = state.code;
  document.getElementById('round-display').textContent = `Round ${state.current_round}`;
  applyBgFromState();
  renderInitiativeList();
  renderSpotlight();
  // Refresh condition dialog if open
  if (condDialogCombatantId && document.getElementById('condition-dialog').open) {
    renderConditionGrid();
  }
}

// ── Background Image ───────────────────────────────────────────────────────────
function setupBgForm() {
  document.getElementById('bg-form-toggle').addEventListener('click', () => {
    document.getElementById('bg-form').classList.toggle('hidden');
  });

  const bgUrlInput = document.getElementById('bg-url-input');
  const bgX        = document.getElementById('bg-x');
  const bgY        = document.getElementById('bg-y');
  const bgScale    = document.getElementById('bg-scale');

  const sendBg = () => send({
    type: 'update_bg_image',
    data: {
      bg_image_url:   bgUrlInput.value.trim(),
      bg_image_x:     parseInt(bgX.value),
      bg_image_y:     parseInt(bgY.value),
      bg_image_scale: parseInt(bgScale.value),
    },
  });

  let bgTimer = null;
  const sendBgDebounced = () => { clearTimeout(bgTimer); bgTimer = setTimeout(sendBg, 300); };

  const previewBg = () => applyBgImage(bgUrlInput.value.trim(), parseInt(bgX.value), parseInt(bgY.value), parseInt(bgScale.value));

  bgUrlInput.addEventListener('input', () => { previewBg(); sendBgDebounced(); });
  bgX.addEventListener('input',        () => { previewBg(); sendBgDebounced(); });
  bgY.addEventListener('input',        () => { previewBg(); sendBgDebounced(); });
  bgScale.addEventListener('input',    () => { previewBg(); sendBgDebounced(); });
  [bgX, bgY, bgScale].forEach(el => el.addEventListener('change', sendBg));

  document.getElementById('bg-clear-btn').addEventListener('click', () => {
    bgUrlInput.value = '';
    previewBg();
    sendBg();
  });
}

function applyBgImage(url, x, y, scale) {
  if (url) {
    document.body.style.backgroundImage    = `url(${JSON.stringify(url)})`;
    document.body.style.backgroundSize     = scale === 100 ? 'cover' : `${scale}%`;
    document.body.style.backgroundPosition = `${x}% ${y}%`;
    document.body.style.backgroundRepeat   = 'no-repeat';
    document.body.style.backgroundAttachment = 'fixed';
  } else {
    document.body.style.backgroundImage = '';
  }
}

function applyBgFromState() {
  if (!state) return;
  const url   = state.bg_image_url   || '';
  const x     = state.bg_image_x     ?? 50;
  const y     = state.bg_image_y     ?? 50;
  const scale = state.bg_image_scale ?? 100;

  applyBgImage(url, x, y, scale);

  // Populate form inputs on first load only (avoid interrupting active editing)
  if (!bgFormInitialized) {
    bgFormInitialized = true;
    document.getElementById('bg-url-input').value = url;
    document.getElementById('bg-x').value         = x;
    document.getElementById('bg-y').value         = y;
    document.getElementById('bg-scale').value     = scale;
  }
}

// ── Initiative List ────────────────────────────────────────────────────────────
function renderInitiativeList() {
  const list = document.getElementById('combatants-list');
  if (!state.combatants.length) {
    list.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">Add combatants above to begin.</div>`;
    return;
  }

  // Remember scroll position
  const scrollTop = list.scrollTop;

  list.innerHTML = '';
  state.combatants.forEach((c, idx) => {
    const isActive = idx === (state.current_turn_index % state.combatants.length);
    list.appendChild(buildCombatantCard(c, isActive));
  });

  list.scrollTop = scrollTop;
}

function buildCombatantCard(c, isActive) {
  const card = document.createElement('div');
  card.className = 'combatant-card' + (isActive ? ' active-turn' : '');
  card.dataset.id = c.id;
  card.draggable = true;
  card.style.backgroundColor = c.card_color || '#2a2a40';

  const hpPct  = c.max_hp > 0 ? Math.max(0, (c.current_hp / c.max_hp) * 100) : 0;
  const hpCls  = hpPct > 50 ? 'hp-full' : hpPct > 25 ? 'hp-mid' : 'hp-low';
  const hpSat  = c.max_hp > 0 ? Math.max(0, Math.min(1, (c.current_hp / c.max_hp) * 2)) : 1;
  const isPcOrNpc = c.combatant_type === 'PC' || c.combatant_type === 'NPC';

  const imgX     = c.image_x     ?? 50;
  const imgY     = c.image_y     ?? 50;
  const imgScale = c.image_scale ?? 100;

  // Portrait
  const portraitHTML = c.image_url
    ? `<img class="card-portrait" src="${esc(c.image_url)}" alt="${esc(c.name)}"
            style="object-position:${imgX}% ${imgY}%;transform:scale(${imgScale/100});transform-origin:${imgX}% ${imgY}%;filter:saturate(${hpSat})"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      + `<div class="card-portrait-placeholder" style="display:none">${initials(c.name)}</div>`
    : `<div class="card-portrait-placeholder">${initials(c.name)}</div>`;

  // Conditions
  const condBadges = c.conditions.map(cond => {
    const label = formatConditionLabel(cond);
    return `<span class="condition-badge${cond.condition_name === 'Exhaustion' ? ' exhaust' : ''}"
                  data-cond="${esc(cond.condition_name)}" title="Click to remove">${esc(label)}</span>`;
  }).join('');

  // Visibility toggles
  card.innerHTML = `
    <div class="card-top">
      ${portraitHTML}
      <div class="card-meta">
        <input class="card-name-input" type="text" value="${esc(c.name)}" maxlength="100">
        <div class="card-sub">
          <span>${esc(c.combatant_type)}</span>
          <span>Init: ${c.initiative}</span>
          ${isActive ? '<span style="color:var(--gold);font-weight:700">▶ Active</span>' : ''}
        </div>
      </div>
      <input type="color" class="card-color-picker" value="${esc(c.card_color || '#2a2a40')}" title="Card color">
      <button class="card-delete btn-icon" title="Delete">×</button>
    </div>

    ${c.combatant_type !== 'Layer Action' ? `
    <div class="card-hp">
      <label>HP</label>
      <input class="hp-input" type="number" name="current_hp" value="${c.current_hp}" min="0" max="${c.max_hp * 2}">
      <span class="hp-sep">/</span>
      <input class="hp-input" type="number" name="max_hp" value="${c.max_hp}" min="1">
      <label style="margin-left:6px">Tmp</label>
      <input class="hp-input" type="number" name="temp_hp" value="${c.temp_hp}" min="0">
    </div>` : ''}

    <div class="card-conditions-row">
      ${condBadges}
      <button class="add-cond-btn">+ Cond</button>
    </div>

    <div class="card-visibility">
      <button class="vis-btn ${c.show_name ? 'on' : ''}" data-vis="show_name" title="Show name to players">Name</button>
      <button class="vis-btn ${c.show_hp   ? 'on' : ''}" data-vis="show_hp"   title="Show HP to players">HP</button>
      <button class="vis-btn ${c.show_conditions ? 'on' : ''}" data-vis="show_conditions" title="Show conditions to players">Cond</button>
      ${isPcOrNpc ? `<button class="vis-btn ${c.show_death_saves ? 'on' : ''}" data-vis="show_death_saves" title="Show death saves to players">DS</button>` : ''}
    </div>

    <button class="vis-btn hide-players-btn ${!c.is_visible ? 'hidden-all' : ''}" data-vis="is_visible" title="Toggle whether this combatant is visible to players">
      ${c.is_visible ? 'Visible to Players' : 'Hidden from Players'}
    </button>

    ${c.combatant_type !== 'Layer Action' ? `
    <div class="hp-bar-track" style="margin-top:6px">
      <div class="hp-bar-fill ${hpCls}" style="width:${hpPct}%"></div>
    </div>` : ''}

    ${isPcOrNpc && c.current_hp <= 0 ? `
    <div class="card-death-saves">
      <div class="death-saves-row fails">
        <span class="death-saves-label">Fails</span>
        <input type="checkbox" class="death-fail" ${(c.death_save_fails ?? 0) >= 1 ? 'checked' : ''}>
        <input type="checkbox" class="death-fail" ${(c.death_save_fails ?? 0) >= 2 ? 'checked' : ''}>
        <input type="checkbox" class="death-fail" ${(c.death_save_fails ?? 0) >= 3 ? 'checked' : ''}>
      </div>
      <div class="death-saves-row successes">
        <span class="death-saves-label">Successes</span>
        <input type="checkbox" class="death-success" ${(c.death_save_successes ?? 0) >= 1 ? 'checked' : ''}>
        <input type="checkbox" class="death-success" ${(c.death_save_successes ?? 0) >= 2 ? 'checked' : ''}>
        <input type="checkbox" class="death-success" ${(c.death_save_successes ?? 0) >= 3 ? 'checked' : ''}>
      </div>
    </div>` : ''}

    <details class="card-crop-details">
      <summary>Image</summary>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
        <input type="url" class="image-url-input" placeholder="Image URL…" value="${esc(c.image_url || '')}">
        ${c.image_url ? `
        <div class="card-crop-controls">
          <label>H <input type="range" class="crop-x" min="0" max="100" value="${imgX}"></label>
          <label>V <input type="range" class="crop-y" min="0" max="100" value="${imgY}"></label>
          <label>Zoom <input type="range" class="crop-scale" min="10" max="100" value="${imgScale}"></label>
        </div>` : ''}
      </div>
    </details>

    <details class="card-layer-action-details">
      <summary>Notes</summary>
      <textarea class="layer-action-text" placeholder="Notes…" rows="2">${esc(c.layer_action || layerActionNotes.get(c.id) || '')}</textarea>
    </details>
  `;

  // ── Events ──────────────────────────────────────────────────────────────────

  // Delete
  card.querySelector('.card-delete').addEventListener('click', () => {
    if (confirm(`Delete "${c.name}"?`)) send({ type: 'delete_combatant', data: { id: c.id } });
  });

  // Card color picker – update background live, persist on change
  const colorPicker = card.querySelector('.card-color-picker');
  const applyColorPickerOutline = col => {
    const r = parseInt(col.slice(1, 3), 16);
    const g = parseInt(col.slice(3, 5), 16);
    const b = parseInt(col.slice(5, 7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    colorPicker.style.outline = `2px solid ${lum > 0.45 ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.6)'}`;
    colorPicker.style.outlineOffset = '1px';
  };
  applyColorPickerOutline(colorPicker.value);
  colorPicker.addEventListener('input', () => {
    card.style.backgroundColor = colorPicker.value;
    applyColorPickerOutline(colorPicker.value);
  });
  colorPicker.addEventListener('change', () => {
    send({ type: 'update_card_color', data: { id: c.id, card_color: colorPicker.value } });
  });
  colorPicker.addEventListener('mousedown', e => { e.stopPropagation(); card.draggable = false; });
  colorPicker.addEventListener('mouseup', () => { card.draggable = true; });

  // Name input – commit on blur/Enter
  const nameInput = card.querySelector('.card-name-input');
  if (nameInput) {
    nameInput.addEventListener('change', () => {
      const newName = nameInput.value.trim();
      if (!newName) { nameInput.value = c.name; return; }
      send({ type: 'update_name', data: { id: c.id, name: newName } });
    });
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); });
    nameInput.addEventListener('mousedown', e => e.stopPropagation());
  }

  // HP inputs (send on change = when field is blurred with a different value)
  const hpInputs = card.querySelectorAll('.hp-input');
  hpInputs.forEach(input => {
    input.addEventListener('change', () => {
      send({
        type: 'update_hp',
        data: {
          id:         c.id,
          current_hp: parseInt(card.querySelector('[name=current_hp]').value) || 0,
          max_hp:     parseInt(card.querySelector('[name=max_hp]').value)     || 1,
          temp_hp:    parseInt(card.querySelector('[name=temp_hp]').value)    || 0,
        },
      });
    });
    // Prevent clicks inside inputs from triggering drag
    input.addEventListener('mousedown', e => e.stopPropagation());
  });

  // Condition remove on badge click
  card.querySelectorAll('.condition-badge').forEach(badge => {
    badge.addEventListener('click', () => {
      const condName = badge.dataset.cond;
      if (confirm(`Remove ${condName} from ${c.name}?`)) {
        send({ type: 'toggle_condition', data: { combatant_id: c.id, condition_name: condName } });
      }
    });
  });

  // Open condition dialog
  card.querySelector('.add-cond-btn').addEventListener('click', e => {
    e.stopPropagation();
    openConditionDialog(c.id, c.name, c.conditions);
  });

  // Visibility toggles
  card.querySelectorAll('.vis-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const field = btn.dataset.vis;
      // Build current visibility from the card's current button states
      const getVis = key => card.querySelector(`[data-vis="${key}"]`)?.classList.contains('on') ?? false;
      const getShown = () => !card.querySelector('[data-vis="is_visible"]').classList.contains('hidden-all');

      let show_name        = getVis('show_name');
      let show_hp          = getVis('show_hp');
      let show_conditions  = getVis('show_conditions');
      let show_death_saves = getVis('show_death_saves');
      let is_visible       = getShown();

      if (field === 'show_name')         show_name        = !show_name;
      else if (field === 'show_hp')      show_hp          = !show_hp;
      else if (field === 'show_conditions') show_conditions = !show_conditions;
      else if (field === 'show_death_saves') show_death_saves = !show_death_saves;
      else if (field === 'is_visible')   is_visible       = !is_visible;

      send({ type: 'update_visibility', data: { id: c.id, show_name, show_hp, show_conditions, is_visible, show_death_saves } });
    });
  });

  // Death saving throw checkboxes (PC/NPC only, shown when HP ≤ 0)
  if (isPcOrNpc && c.current_hp <= 0) {
    const failBoxes    = [...card.querySelectorAll('.death-fail')];
    const successBoxes = [...card.querySelectorAll('.death-success')];

    const handleFails = () => {
      const fails = failBoxes.filter(cb => cb.checked).length;
      if (fails >= 3) {
        // 3rd fail → Dead condition + reset saves
        const alreadyDead = c.conditions.some(cond => cond.condition_name === 'Dead');
        if (!alreadyDead) {
          send({ type: 'toggle_condition', data: { combatant_id: c.id, condition_name: 'Dead' } });
        }
        send({ type: 'update_death_saves', data: { id: c.id, fails: 0, successes: 0 } });
      } else {
        const successes = successBoxes.filter(cb => cb.checked).length;
        send({ type: 'update_death_saves', data: { id: c.id, fails, successes } });
      }
    };

    const handleSuccesses = () => {
      const successes = successBoxes.filter(cb => cb.checked).length;
      if (successes >= 3) {
        // 3rd success → stabilize at 1 HP (server resets saves automatically)
        send({
          type: 'update_hp',
          data: {
            id: c.id,
            current_hp: 1,
            max_hp: parseInt(card.querySelector('[name=max_hp]').value) || c.max_hp,
            temp_hp: parseInt(card.querySelector('[name=temp_hp]').value) || 0,
          },
        });
      } else {
        const fails = failBoxes.filter(cb => cb.checked).length;
        send({ type: 'update_death_saves', data: { id: c.id, fails, successes } });
      }
    };

    failBoxes.forEach(cb => {
      cb.addEventListener('change', handleFails);
      cb.addEventListener('mousedown', e => e.stopPropagation());
    });
    successBoxes.forEach(cb => {
      cb.addEventListener('change', handleSuccesses);
      cb.addEventListener('mousedown', e => e.stopPropagation());
    });
  }

  // Drag-and-drop reorder
  card.addEventListener('dragstart', e => {
    if (!card.draggable) { e.preventDefault(); return; }
    dragSrcId = c.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    card.draggable = true; // restore in case it was disabled by slider
    card.classList.remove('dragging');
    document.querySelectorAll('.combatant-card').forEach(el => el.classList.remove('drag-over'));
  });
  card.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragSrcId !== c.id) card.classList.add('drag-over');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', e => {
    e.preventDefault();
    card.classList.remove('drag-over');
    if (dragSrcId == null || dragSrcId === c.id) return;

    const cards     = [...document.querySelectorAll('.combatant-card')];
    const orderedIds = cards.map(el => parseInt(el.dataset.id));
    const srcIdx    = orderedIds.indexOf(dragSrcId);
    const dstIdx    = orderedIds.indexOf(c.id);
    if (srcIdx === -1 || dstIdx === -1) return;

    orderedIds.splice(srcIdx, 1);
    orderedIds.splice(dstIdx, 0, dragSrcId);
    dragSrcId = null;
    send({ type: 'reorder', data: { orderedIds } });
  });

  // Image section – open state and URL input
  const imageDetails = card.querySelector('.card-crop-details');
  if (imageDetails) {
    if (expandedCropIds.has(c.id)) imageDetails.open = true;
    imageDetails.addEventListener('toggle', () => {
      if (imageDetails.open) expandedCropIds.add(c.id);
      else expandedCropIds.delete(c.id);
    });
  }

  const imageUrlInput = card.querySelector('.image-url-input');
  if (imageUrlInput) {
    let imageUrlTimer = null;
    imageUrlInput.addEventListener('input', () => {
      clearTimeout(imageUrlTimer);
      imageUrlTimer = setTimeout(() => {
        send({ type: 'update_image_url', data: { id: c.id, image_url: imageUrlInput.value.trim() } });
      }, 600);
    });
    imageUrlInput.addEventListener('mousedown', e => e.stopPropagation());
  }

  // Image crop/zoom sliders – live preview on input, send on change (pointer up)
  const cropX    = card.querySelector('.crop-x');
  const cropY    = card.querySelector('.crop-y');
  const cropScale = card.querySelector('.crop-scale');
  const portrait  = card.querySelector('.card-portrait');

  if (cropX && cropY) {
    const updatePreview = () => {
      if (portrait) {
        const x = cropX.value, y = cropY.value;
        const s = cropScale ? cropScale.value / 100 : 1;
        portrait.style.objectPosition = `${x}% ${y}%`;
        portrait.style.transform = `scale(${s})`;
        portrait.style.transformOrigin = `${x}% ${y}%`;
      }
    };
    const sendCrop = () => {
      send({
        type: 'update_image_position',
        data: {
          id:          c.id,
          image_x:     parseInt(cropX.value),
          image_y:     parseInt(cropY.value),
          image_scale: cropScale ? parseInt(cropScale.value) : 100,
        },
      });
    };

    // Debounce live sends to avoid flooding the server while dragging
    let sendCropTimer = null;
    const sendCropLive = () => { clearTimeout(sendCropTimer); sendCropTimer = setTimeout(sendCrop, 60); };

    cropX.addEventListener('input', () => { updatePreview(); sendCropLive(); });
    cropY.addEventListener('input', () => { updatePreview(); sendCropLive(); });
    if (cropScale) cropScale.addEventListener('input', () => { updatePreview(); sendCropLive(); });

    // Also send on pointer-up to guarantee the final value is committed
    cropX.addEventListener('change', sendCrop);
    cropY.addEventListener('change', sendCrop);
    if (cropScale) cropScale.addEventListener('change', sendCrop);

    // Disable card drag while using sliders, restore on release
    [cropX, cropY, cropScale].filter(Boolean).forEach(el => {
      el.addEventListener('mousedown', e => { e.stopPropagation(); card.draggable = false; });
      el.addEventListener('mouseup', () => { card.draggable = true; });
    });
  }

  // Layer action section – preserve open state and notes content across re-renders
  const layerDetails = card.querySelector('.card-layer-action-details');
  if (layerDetails) {
    if (expandedLayerActionIds.has(c.id)) layerDetails.open = true;
    layerDetails.addEventListener('toggle', () => {
      if (layerDetails.open) expandedLayerActionIds.add(c.id);
      else expandedLayerActionIds.delete(c.id);
    });
    const layerText = layerDetails.querySelector('.layer-action-text');
    if (layerText) {
      let layerSendTimer = null;
      layerText.addEventListener('input', () => {
        layerActionNotes.set(c.id, layerText.value);
        // Keep spotlight notes textarea in sync if this combatant is currently active
        const noteEl = document.getElementById('spotlight-notes');
        if (noteEl && noteEl.dataset.notesFor === String(c.id)) {
          noteEl.value = layerText.value;
        }
        clearTimeout(layerSendTimer);
        layerSendTimer = setTimeout(() => {
          send({ type: 'update_layer_action', data: { id: c.id, layer_action: layerText.value } });
        }, 400);
      });
      layerText.addEventListener('mousedown', e => { e.stopPropagation(); card.draggable = false; });
      layerText.addEventListener('mouseup', () => { card.draggable = true; });
    }
  }

  return card;
}

// ── Spotlight Panel ────────────────────────────────────────────────────────────
function renderSpotlight() {
  const panel = document.getElementById('spotlight-panel');
  if (!state.combatants.length) {
    panel.innerHTML = `<div class="spotlight-empty">Add combatants and begin your encounter.</div>`;
    return;
  }

  const idx  = state.current_turn_index % state.combatants.length;
  const cur  = state.combatants[idx];
  const next = state.combatants[(idx + 1) % state.combatants.length];

  const hpPct = cur.max_hp > 0 ? Math.max(0, Math.min(100, (cur.current_hp / cur.max_hp) * 100)) : 0;
  const hpCls = hpPct > 50 ? 'hp-full' : hpPct > 25 ? 'hp-mid' : 'hp-low';

  const condHtml = cur.conditions.map(cond =>
    `<span class="spotlight-cond-badge ${cond.condition_name === 'Exhaustion' ? 'exhaust' : ''}">${esc(formatConditionLabel(cond))}</span>`
  ).join('');

  // Snapshot current spotlight notes value before rebuilding (preserves typing in progress)
  const existingSpotNotes = document.getElementById('spotlight-notes');
  if (existingSpotNotes && existingSpotNotes.dataset.notesFor === String(cur.id)) {
    layerActionNotes.set(cur.id, existingSpotNotes.value);
  }
  const notesVal = layerActionNotes.get(cur.id) ?? cur.layer_action ?? '';

  const sImgX = cur.image_x ?? 50, sImgY = cur.image_y ?? 50, sImgScale = cur.image_scale ?? 100;
  const imgHtml = cur.image_url
    ? `<img class="spotlight-image" src="${esc(cur.image_url)}" alt="${esc(cur.name)}"
            style="object-position:${sImgX}% ${sImgY}%;transform:scale(${sImgScale/100});transform-origin:${sImgX}% ${sImgY}%"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
       <div class="spotlight-placeholder" style="display:none">${esc(cur.name)}</div>`
    : `<div class="spotlight-placeholder">${esc(cur.name)}</div>`;

  const nextImgHtml = next && next.image_url
    ? `<img class="up-next-portrait" src="${esc(next.image_url)}"
            style="object-position:${next.image_x ?? 50}% ${next.image_y ?? 50}%"
            alt="" onerror="this.style.display='none'">`
    : '';

  panel.innerHTML = `
    <div class="spotlight-card">
      <div class="spotlight-image-wrap">${imgHtml}</div>
      <div class="spotlight-body">
        <div class="spotlight-name">${esc(cur.name)}</div>
        <div class="spotlight-type">${esc(cur.combatant_type)}</div>
        ${cur.combatant_type !== 'Layer Action' ? `
        <div class="hp-bar-wrap">
          <div class="hp-bar-label">
            <span>HP</span>
            <span>${cur.current_hp}${cur.temp_hp > 0 ? ' + ' + cur.temp_hp + ' tmp' : ''} / ${cur.max_hp}</span>
          </div>
          <div class="hp-bar-track">
            <div class="hp-bar-fill ${hpCls}" style="width:${hpPct}%"></div>
          </div>
        </div>` : ''}
        <div class="spotlight-conditions">${condHtml || '<span style="color:var(--text-muted);font-size:13px">No conditions</span>'}</div>
      </div>
    </div>
    <textarea id="spotlight-notes" class="spotlight-notes" data-notes-for="${cur.id}" placeholder="Notes…">${esc(notesVal)}</textarea>
    ${state.combatants.length > 1 ? `
    <div class="up-next-card">
      <span class="up-next-label">Up Next:</span>
      ${nextImgHtml}
      <span class="up-next-name">${esc(next.name)}</span>
      <span style="color:var(--text-muted);font-size:12px">${esc(next.combatant_type)}</span>
    </div>` : ''}
  `;

  // Spotlight notes textarea – bidirectional sync with card textarea
  const spotNotes = document.getElementById('spotlight-notes');
  if (spotNotes) {
    let spotNoteTimer = null;
    spotNotes.addEventListener('input', () => {
      layerActionNotes.set(cur.id, spotNotes.value);
      // Sync to the card's Notes textarea if it's in the DOM
      const cardEl = document.querySelector(`.combatant-card[data-id="${cur.id}"]`);
      if (cardEl) {
        const cardTextarea = cardEl.querySelector('.layer-action-text');
        if (cardTextarea) cardTextarea.value = spotNotes.value;
      }
      clearTimeout(spotNoteTimer);
      spotNoteTimer = setTimeout(() => {
        send({ type: 'update_layer_action', data: { id: cur.id, layer_action: spotNotes.value } });
      }, 400);
    });
    spotNotes.addEventListener('mousedown', e => e.stopPropagation());
  }
}

// ── Condition Dialog ───────────────────────────────────────────────────────────
function setupConditionDialog() {
  const dialog = document.getElementById('condition-dialog');

  document.getElementById('cond-dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

  // Rounds quick buttons
  document.querySelectorAll('.rounds-quick button').forEach(btn => {
    btn.addEventListener('click', () => applyConditionWithRounds(btn.dataset.rounds ? parseInt(btn.dataset.rounds) : null));
  });

  // Custom rounds apply
  document.getElementById('rounds-custom-apply').addEventListener('click', () => {
    const v = parseInt(document.getElementById('rounds-custom-input').value);
    applyConditionWithRounds(v > 0 ? v : null);
  });

  // Exhaustion remove
  document.getElementById('exhaust-remove').addEventListener('click', () => {
    send({ type: 'update_exhaustion', data: { combatant_id: condDialogCombatantId, level: 0 } });
    dialog.close();
  });

  // Exhaustion level buttons
  document.querySelectorAll('.exhaust-level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const level = parseInt(btn.dataset.level);
      send({ type: 'update_exhaustion', data: { combatant_id: condDialogCombatantId, level } });
      renderConditionGrid(); // refresh to show active level
    });
  });
}

function openConditionDialog(combatantId, combatantName, conditions) {
  condDialogCombatantId = combatantId;
  condDialogPendingCondition = null;
  document.getElementById('cond-dialog-name').textContent = combatantName;
  document.getElementById('rounds-form').classList.add('hidden');
  document.getElementById('exhaustion-picker').classList.add('hidden');
  renderConditionGrid(conditions);
  document.getElementById('condition-dialog').showModal();
}

function renderConditionGrid(conditions) {
  // Use current state if conditions not passed
  if (!conditions && state) {
    const c = state.combatants.find(c => c.id === condDialogCombatantId);
    conditions = c ? c.conditions : [];
  }
  conditions = conditions || [];

  const grid = document.getElementById('conditions-grid');
  grid.innerHTML = '';

  CONDITIONS.forEach(condName => {
    const existing = conditions.find(c => c.condition_name === condName);
    const btn = document.createElement('button');
    btn.className = 'cond-pick-btn' + (existing ? ' active' : '') + (condName === 'Exhaustion' ? ' exhaust-btn' : '');

    if (condName === 'Exhaustion') {
      btn.textContent = existing ? `Exhaustion (Lvl ${existing.exhaustion_level})` : 'Exhaustion';
      btn.addEventListener('click', () => showExhaustionPicker(existing ? existing.exhaustion_level : 0));
    } else {
      btn.textContent = condName;
      if (existing) {
        // Remove on click
        btn.addEventListener('click', () => {
          if (confirm(`Remove ${condName}?`)) {
            send({ type: 'toggle_condition', data: { combatant_id: condDialogCombatantId, condition_name: condName } });
            document.getElementById('rounds-form').classList.add('hidden');
          }
        });
      } else {
        // Show rounds form
        btn.addEventListener('click', () => showRoundsForm(condName));
      }
    }

    grid.appendChild(btn);
  });
}

function showRoundsForm(condName) {
  condDialogPendingCondition = condName;
  document.getElementById('exhaustion-picker').classList.add('hidden');
  document.getElementById('rounds-cond-name').textContent = condName;
  document.getElementById('rounds-custom-input').value = '';
  document.getElementById('rounds-form').classList.remove('hidden');
}

function applyConditionWithRounds(rounds) {
  if (!condDialogPendingCondition) return;
  send({
    type: 'toggle_condition',
    data: {
      combatant_id:   condDialogCombatantId,
      condition_name: condDialogPendingCondition,
      rounds:         rounds,
    },
  });
  document.getElementById('rounds-form').classList.add('hidden');
  condDialogPendingCondition = null;
}

function showExhaustionPicker(currentLevel) {
  document.getElementById('rounds-form').classList.add('hidden');
  document.getElementById('exhaustion-picker').classList.remove('hidden');
  document.querySelectorAll('.exhaust-level-btn').forEach(btn => {
    const lvl = parseInt(btn.dataset.level);
    btn.classList.toggle('active', lvl === currentLevel);
  });
  document.getElementById('exhaust-remove').classList.toggle('hidden', currentLevel === 0);
}

// ── Banner Notification ────────────────────────────────────────────────────────
function showBanner(msg) {
  const el = document.getElementById('condition-banner');
  el.textContent = msg;
  el.classList.remove('hidden', 'fade-out');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.classList.add('hidden'), 600);
  }, 4000);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function initials(name) {
  return esc((name || '?').trim().substring(0, 2).toUpperCase());
}

function formatConditionLabel(cond) {
  if (cond.condition_name === 'Exhaustion') {
    return `Exhaustion (Level ${cond.exhaustion_level})`;
  }
  if (cond.rounds_remaining != null) {
    const r = cond.rounds_remaining;
    return `${cond.condition_name}: ${r} ${r === 1 ? 'Round' : 'Rounds'} Remaining`;
  }
  return cond.condition_name;
}
