'use strict';
(async () => {
  // Redirect logged-in DMs straight to dashboard
  const me = await fetch('/api/auth/me').then(r => r.json());
  if (me.authenticated) { location.href = '/dashboard.html'; return; }

  const errorEl = document.getElementById('error-msg');

  function showError(msg) { errorEl.textContent = msg; }
  function clearError()    { errorEl.textContent = ''; }

  // ── Tab switching ──────────────────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      clearError();
    });
  });

  // ── Login ──────────────────────────────────────────────────────────────────
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    clearError();
    const fd = new FormData(e.target);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password'), rememberMe: fd.get('remember_me') === 'on' }),
    });
    const data = await res.json();
    if (!res.ok) { showError(data.error); return; }
    location.href = '/dashboard.html';
  });

  // ── Register ───────────────────────────────────────────────────────────────
  document.getElementById('register-form').addEventListener('submit', async e => {
    e.preventDefault();
    clearError();
    const fd = new FormData(e.target);
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
    });
    const data = await res.json();
    if (!res.ok) { showError(data.error); return; }
    location.href = '/dashboard.html';
  });

  // ── Join Room ──────────────────────────────────────────────────────────────
  document.getElementById('join-form').addEventListener('submit', async e => {
    e.preventDefault();
    clearError();
    const code = new FormData(e.target).get('code').toUpperCase().trim();
    if (code.length !== 6) { showError('Room codes are 6 characters.'); return; }
    // Verify the room exists
    const res = await fetch(`/api/rooms/${code}/state`);
    if (!res.ok) { showError('Room not found. Check the code and try again.'); return; }
    location.href = `/player.html?room=${code}`;
  });

  // Auto-uppercase room code input
  const codeInput = document.querySelector('#join-form input[name="code"]');
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase(); });
})();
