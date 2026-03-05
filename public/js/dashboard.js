'use strict';
(async () => {
  const me = await fetch('/api/auth/me').then(r => r.json());
  if (!me.authenticated) { location.href = '/'; return; }

  document.getElementById('username-display').textContent = me.username;

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/';
  });

  // ── Load Rooms ─────────────────────────────────────────────────────────────
  async function loadRooms() {
    const rooms = await fetch('/api/rooms').then(r => r.json());
    const grid  = document.getElementById('rooms-grid');
    const empty = document.getElementById('empty-msg');

    grid.innerHTML = '';

    if (!rooms.length) {
      empty.textContent = 'No encounters yet. Create one above!';
      grid.appendChild(empty);
      return;
    }

    rooms.forEach(room => {
      const card = document.createElement('div');
      card.className = 'room-card';
      card.innerHTML = `
        <div class="room-card-name">${esc(room.name)}</div>
        <div class="room-card-code">${esc(room.code)}</div>
        <div style="font-size:12px;color:var(--text-muted)">Created ${fmtDate(room.created_at)}</div>
        <div class="room-card-actions">
          <button class="btn-enter" data-code="${esc(room.code)}">⚔️ Open Combat</button>
          <button class="btn-copy" data-code="${esc(room.code)}" title="Copy player link">🔗</button>
          <button class="btn-delete btn-danger" data-code="${esc(room.code)}" title="Delete encounter">🗑</button>
        </div>
      `;
      grid.appendChild(card);
    });

    grid.querySelectorAll('.btn-enter').forEach(btn => {
      btn.addEventListener('click', () => {
        location.href = `/combat.html?room=${btn.dataset.code}`;
      });
    });

    grid.querySelectorAll('.btn-copy').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = `${location.origin}/player.html?room=${btn.dataset.code}`;
        navigator.clipboard.writeText(url).then(() => {
          btn.textContent = '✓';
          setTimeout(() => { btn.textContent = '🔗'; }, 2000);
        });
      });
    });

    grid.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this encounter? This cannot be undone.')) return;
        await fetch(`/api/rooms/${btn.dataset.code}`, { method: 'DELETE' });
        loadRooms();
      });
    });
  }

  // ── Create Room ────────────────────────────────────────────────────────────
  document.getElementById('create-room-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').trim();
    if (!name) return;
    const res  = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      e.target.reset();
      loadRooms();
    }
  });

  loadRooms();

  // ── Helpers ────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmtDate(str) {
    if (!str) return '';
    const d = new Date(str);
    return isNaN(d) ? str : d.toLocaleDateString();
  }
})();
