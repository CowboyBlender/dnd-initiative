'use strict';

const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const path = require('path');

// ─── Database Setup ───────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      dm_user_id INTEGER NOT NULL REFERENCES users(id),
      current_turn_index INTEGER DEFAULT 0,
      current_round INTEGER DEFAULT 1,
      bg_image_url TEXT DEFAULT '',
      bg_image_x INTEGER DEFAULT 50,
      bg_image_y INTEGER DEFAULT 50,
      bg_image_scale INTEGER DEFAULT 100,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS combatants (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      combatant_type TEXT DEFAULT 'Monster',
      initiative INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      max_hp INTEGER DEFAULT 10,
      current_hp INTEGER DEFAULT 10,
      temp_hp INTEGER DEFAULT 0,
      image_url TEXT DEFAULT '',
      image_x INTEGER DEFAULT 50,
      image_y INTEGER DEFAULT 50,
      image_scale INTEGER DEFAULT 100,
      card_color TEXT DEFAULT '#2d2d44',
      layer_action TEXT DEFAULT '',
      show_name BOOLEAN DEFAULT TRUE,
      show_hp BOOLEAN DEFAULT FALSE,
      show_conditions BOOLEAN DEFAULT TRUE,
      is_visible BOOLEAN DEFAULT TRUE,
      death_save_fails INTEGER DEFAULT 0,
      death_save_successes INTEGER DEFAULT 0,
      show_death_saves BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS combatant_conditions (
      id SERIAL PRIMARY KEY,
      combatant_id INTEGER NOT NULL REFERENCES combatants(id) ON DELETE CASCADE,
      condition_name TEXT NOT NULL,
      exhaustion_level INTEGER DEFAULT 0,
      rounds_remaining INTEGER DEFAULT NULL
    );
  `);

  // Migrations for existing DBs (ADD COLUMN IF NOT EXISTS is idempotent in PostgreSQL)
  await pool.query('ALTER TABLE combatants ADD COLUMN IF NOT EXISTS death_save_fails INTEGER DEFAULT 0');
  await pool.query('ALTER TABLE combatants ADD COLUMN IF NOT EXISTS death_save_successes INTEGER DEFAULT 0');
  await pool.query('ALTER TABLE combatants ADD COLUMN IF NOT EXISTS show_death_saves BOOLEAN DEFAULT TRUE');

  // Session store table (connect-pg-simple schema)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid  VARCHAR   NOT NULL COLLATE "default",
      sess JSON      NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
    );
    CREATE INDEX IF NOT EXISTS idx_session_expire ON user_sessions (expire);
  `);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  while (true) {
    const code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const { rows } = await pool.query('SELECT id FROM rooms WHERE code = $1', [code]);
    if (rows.length === 0) return code;
  }
}

async function buildRoomState(room, role) {
  const { rows: combatants } = await pool.query(
    'SELECT * FROM combatants WHERE room_id = $1 ORDER BY sort_order, id',
    [room.id]
  );

  for (const c of combatants) {
    const { rows } = await pool.query(
      'SELECT * FROM combatant_conditions WHERE combatant_id = $1',
      [c.id]
    );
    c.conditions = rows;
  }

  let visible = combatants;
  let returnTurnIndex = room.current_turn_index;
  if (role === 'player') {
    visible = combatants
      .filter(c => c.is_visible)
      .map(c => ({
        id: c.id,
        sort_order: c.sort_order,
        combatant_type: c.combatant_type,
        image_url: c.image_url,
        image_x:     c.image_x     ?? 50,
        image_y:     c.image_y     ?? 50,
        image_scale: c.image_scale ?? 100,
        card_color: c.card_color,
        name: c.show_name ? c.name : '???',
        show_name: c.show_name,
        show_hp: c.show_hp,
        show_conditions: c.show_conditions,
        max_hp:     c.show_hp ? c.max_hp     : null,
        current_hp: c.show_hp ? c.current_hp : null,
        temp_hp:    c.show_hp ? c.temp_hp    : null,
        conditions: c.show_conditions ? c.conditions : [],
        saturation: c.max_hp > 0 ? Math.max(0, Math.min(1, (c.current_hp / c.max_hp) * 2)) : 1,
        show_death_saves: c.show_death_saves,
        death_save_fails:     (c.current_hp <= 0 && c.show_death_saves) ? (c.death_save_fails     ?? 0) : null,
        death_save_successes: (c.current_hp <= 0 && c.show_death_saves) ? (c.death_save_successes ?? 0) : null,
      }));

    // Remap current_turn_index to the visible list.
    // If the active combatant is hidden, hold on the last visible combatant
    // before it so the player spotlight doesn't jump ahead.
    if (combatants.length > 0 && visible.length > 0) {
      const activeIdx = room.current_turn_index % combatants.length;
      const active = combatants[activeIdx];
      if (active && active.is_visible) {
        returnTurnIndex = visible.findIndex(v => v.id === active.id);
        if (returnTurnIndex === -1) returnTurnIndex = 0;
      } else {
        // Walk backwards through the full list to find the last visible combatant
        returnTurnIndex = 0;
        for (let i = 1; i < combatants.length; i++) {
          const prev = combatants[(activeIdx - i + combatants.length) % combatants.length];
          if (prev && prev.is_visible) {
            const vi = visible.findIndex(v => v.id === prev.id);
            if (vi !== -1) { returnTurnIndex = vi; break; }
          }
        }
      }
    } else {
      returnTurnIndex = 0;
    }
  }

  return {
    id: room.id,
    code: room.code,
    name: room.name,
    current_turn_index: returnTurnIndex,
    current_round: room.current_round,
    bg_image_url:   room.bg_image_url   || '',
    bg_image_x:     room.bg_image_x     ?? 50,
    bg_image_y:     room.bg_image_y     ?? 50,
    bg_image_scale: room.bg_image_scale ?? 100,
    combatants: visible,
  };
}

async function broadcastRoom(roomCode, wss) {
  const { rows } = await pool.query('SELECT * FROM rooms WHERE code = $1', [roomCode]);
  const room = rows[0];
  if (!room) return;
  const dmState     = await buildRoomState(room, 'dm');
  const playerState = await buildRoomState(room, 'player');

  wss.clients.forEach(client => {
    if (client.readyState === 1 && client.roomCode === roomCode) {
      const payload = client.isDM ? dmState : playerState;
      client.send(JSON.stringify({ type: 'state_update', data: payload }));
    }
  });
}

function notifyRoom(roomCode, wss, message) {
  const str = JSON.stringify(message);
  wss.clients.forEach(c => {
    if (c.readyState === 1 && c.roomCode === roomCode) c.send(str);
  });
}

// ─── Express + Session ────────────────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);

// Trust Railway's reverse proxy so secure cookies and req.ip work correctly
app.set('trust proxy', 1);

const isProd = process.env.NODE_ENV === 'production';
app.use(morgan(isProd ? 'combined' : 'dev'));

const sessionParser = session({
  store: new pgSession({
    pool,
    tableName: 'user_sessions',
  }),
  secret: process.env.SESSION_SECRET || ('dnd-tracker-' + Math.random().toString(36)),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: isProd, httpOnly: true, sameSite: 'lax' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this IP, please try again later.' },
});

app.use(express.json());
app.use(sessionParser);
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: 'Username must be 2–20 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING *',
      [username.trim(), hash]
    );
    const user = rows[0];
    req.session.userId   = user.id;
    req.session.username = user.username;
    res.json({ success: true, username: user.username });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Username already taken' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password, rememberMe } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    if (rememberMe) req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
    req.session.userId   = user.id;
    req.session.username = user.username;
    res.json({ success: true, username: user.username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  res.json({ authenticated: true, username: req.session.username, userId: req.session.userId });
});

// ─── Room Routes ──────────────────────────────────────────────────────────────
app.get('/api/rooms', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM rooms WHERE dm_user_id = $1 ORDER BY created_at DESC',
      [req.session.userId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/rooms', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Room name required' });
  try {
    const code = await generateCode();
    const { rows } = await pool.query(
      'INSERT INTO rooms (code, name, dm_user_id) VALUES ($1, $2, $3) RETURNING *',
      [code, name.trim(), req.session.userId]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/rooms/:code', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM rooms WHERE code = $1 AND dm_user_id = $2',
      [req.params.code.toUpperCase(), req.session.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Room not found' });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public endpoint: player joins by code to get initial state
app.get('/api/rooms/:code/state', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rooms WHERE code = $1', [req.params.code.toUpperCase()]);
    const room = rows[0];
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json(await buildRoomState(room, 'player'));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

// Heartbeat: ping every 20s, terminate silently dropped connections
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 20_000);
wss.on('close', () => clearInterval(heartbeat));

httpServer.on('upgrade', (req, socket, head) => {
  sessionParser(req, {}, () => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
});

wss.on('connection', async (ws, req) => {
  const url      = new URL(req.url, 'http://localhost');
  const roomCode = (url.searchParams.get('room') || '').toUpperCase();
  const role     = url.searchParams.get('role');

  const { rows } = await pool.query('SELECT * FROM rooms WHERE code = $1', [roomCode]);
  const room = rows[0];
  if (!room) { ws.close(1008, 'Room not found'); return; }

  if (role === 'dm') {
    if (!req.session.userId || req.session.userId !== room.dm_user_id) {
      ws.close(1008, 'Not authorised as DM');
      return;
    }
    ws.isDM = true;
  } else {
    ws.isDM = false;
  }

  ws.roomCode = roomCode;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Send initial state
  const state = await buildRoomState(room, ws.isDM ? 'dm' : 'player');
  ws.send(JSON.stringify({ type: 'state_update', data: state }));

  ws.on('message', async raw => {
    if (!ws.isDM) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, data } = msg;

    try {
      // Always refetch room so current_turn_index is fresh
      const { rows: rrows } = await pool.query('SELECT * FROM rooms WHERE code = $1', [roomCode]);
      const r = rrows[0];
      if (!r) return;

      // ── add_combatant ──────────────────────────────────────────────────────
      if (type === 'add_combatant') {
        const { name, combatant_type, initiative, max_hp, image_url, card_color } = data;
        if (!name || !name.trim()) return;

        const { rows: maxRows } = await pool.query(
          'SELECT MAX(sort_order) as m FROM combatants WHERE room_id = $1', [r.id]
        );
        const nextOrder = (maxRows[0].m != null) ? maxRows[0].m + 1 : 0;
        const hp = Math.max(1, parseInt(max_hp) || 1);
        const isVisible = !(data.is_visible === false || data.is_visible === 0);

        await pool.query(`
          INSERT INTO combatants
            (room_id, name, combatant_type, initiative, sort_order, max_hp, current_hp,
             image_url, card_color, image_x, image_y, image_scale, is_visible, layer_action)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            r.id, name.trim(), combatant_type || 'Monster',
            parseInt(initiative) || 0, nextOrder, hp, hp,
            image_url || '', card_color || '#2d2d44',
            parseInt(data.image_x) || 50, parseInt(data.image_y) || 50,
            Math.max(10, Math.min(100, parseInt(data.image_scale) || 100)),
            isVisible,
            (data.layer_action || '').substring(0, 500),
          ]
        );

        // Re-sort all combatants by initiative descending
        const { rows: all } = await pool.query(
          'SELECT id FROM combatants WHERE room_id = $1 ORDER BY initiative DESC, id', [r.id]
        );
        await Promise.all(all.map((c, i) =>
          pool.query('UPDATE combatants SET sort_order = $1 WHERE id = $2', [i, c.id])
        ));

        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── update_hp ──────────────────────────────────────────────────────────
      if (type === 'update_hp') {
        const { id, current_hp, max_hp, temp_hp } = data;
        const { rows: crow } = await pool.query('SELECT * FROM combatants WHERE id = $1', [id]);
        const c = crow[0];
        if (!c || c.room_id !== r.id) return;
        const newHp = parseInt(current_hp) ?? c.current_hp;
        await pool.query(
          'UPDATE combatants SET current_hp=$1, temp_hp=$2, max_hp=$3 WHERE id=$4',
          [
            newHp,
            Math.max(0, parseInt(temp_hp) || 0),
            Math.max(1, parseInt(max_hp) || 1),
            id,
          ]
        );
        // If HP is restored above 0, reset death saves and remove Dead condition
        if (newHp > 0) {
          await pool.query('UPDATE combatants SET death_save_fails=0, death_save_successes=0 WHERE id=$1', [id]);
          await pool.query('DELETE FROM combatant_conditions WHERE combatant_id=$1 AND condition_name=$2', [id, 'Dead']);
        }
        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── update_visibility ──────────────────────────────────────────────────
      if (type === 'update_visibility') {
        const { id, show_name, show_hp, show_conditions, is_visible, show_death_saves } = data;
        const { rows: crow } = await pool.query('SELECT room_id FROM combatants WHERE id = $1', [id]);
        if (!crow[0] || crow[0].room_id !== r.id) return;
        await pool.query(
          'UPDATE combatants SET show_name=$1, show_hp=$2, show_conditions=$3, is_visible=$4, show_death_saves=$5 WHERE id=$6',
          [!!show_name, !!show_hp, !!show_conditions, !!is_visible, show_death_saves !== undefined ? !!show_death_saves : true, id]
        );
        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── update_layer_action ────────────────────────────────────────────────
      if (type === 'update_layer_action') {
        const { id, layer_action } = data;
        const { rows: crow } = await pool.query('SELECT room_id FROM combatants WHERE id = $1', [id]);
        if (!crow[0] || crow[0].room_id !== r.id) return;
        await pool.query('UPDATE combatants SET layer_action=$1 WHERE id=$2',
          [(layer_action || '').substring(0, 500), id]);
        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── update_image_url ───────────────────────────────────────────────────
      if (type === 'update_image_url') {
        const { id, image_url } = data;
        const { rows: crow } = await pool.query('SELECT room_id FROM combatants WHERE id = $1', [id]);
        if (!crow[0] || crow[0].room_id !== r.id) return;
        await pool.query('UPDATE combatants SET image_url=$1 WHERE id=$2',
          [(image_url || '').substring(0, 500), id]);
        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── update_death_saves ────────────────────────────────────────────────
      if (type === 'update_death_saves') {
        const { id, fails, successes } = data;
        const { rows: crow } = await pool.query('SELECT room_id FROM combatants WHERE id=$1', [id]);
        if (!crow[0] || crow[0].room_id !== r.id) return;
        await pool.query(
          'UPDATE combatants SET death_save_fails=$1, death_save_successes=$2 WHERE id=$3',
          [Math.max(0, Math.min(3, parseInt(fails) || 0)), Math.max(0, Math.min(3, parseInt(successes) || 0)), id]
        );
        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── update_name ───────────────────────────────────────────────────────
      if (type === 'update_name') {
        const { id, name } = data;
        if (!name || !name.trim()) return;
        const { rows: crow } = await pool.query('SELECT room_id FROM combatants WHERE id=$1', [id]);
        if (!crow[0] || crow[0].room_id !== r.id) return;
        await pool.query('UPDATE combatants SET name=$1 WHERE id=$2', [name.trim().substring(0, 100), id]);
        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── clone_combatant ───────────────────────────────────────────────────
      if (type === 'clone_combatant') {
        const { id } = data;
        const { rows: crow } = await pool.query('SELECT * FROM combatants WHERE id=$1', [id]);
        if (!crow[0] || crow[0].room_id !== r.id) return;
        const src = crow[0];

        const { rows: maxRows } = await pool.query(
          'SELECT MAX(sort_order) as m FROM combatants WHERE room_id=$1', [r.id]
        );
        const nextOrder = (maxRows[0].m != null) ? maxRows[0].m + 1 : 0;

        await pool.query(`
          INSERT INTO combatants
            (room_id, name, combatant_type, initiative, sort_order,
             max_hp, current_hp, temp_hp, image_url, card_color,
             image_x, image_y, image_scale, is_visible, layer_action,
             show_name, show_hp, show_conditions, show_death_saves)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            r.id, (src.name + ' (Copy)').substring(0, 100), src.combatant_type,
            src.initiative, nextOrder,
            src.max_hp, src.max_hp, 0, src.image_url, src.card_color,
            src.image_x, src.image_y, src.image_scale, src.is_visible, src.layer_action,
            src.show_name, src.show_hp, src.show_conditions, src.show_death_saves,
          ]
        );

        const { rows: all } = await pool.query(
          'SELECT id FROM combatants WHERE room_id=$1 ORDER BY initiative DESC, id', [r.id]
        );
        await Promise.all(all.map((c, i) =>
          pool.query('UPDATE combatants SET sort_order=$1 WHERE id=$2', [i, c.id])
        ));

        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── update_card_color ──────────────────────────────────────────────────
      if (type === 'update_card_color') {
        const { id, card_color } = data;
        const { rows: crow } = await pool.query('SELECT room_id FROM combatants WHERE id = $1', [id]);
        if (!crow[0] || crow[0].room_id !== r.id) return;
        if (typeof card_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(card_color)) {
          await pool.query('UPDATE combatants SET card_color=$1 WHERE id=$2', [card_color, id]);
          await broadcastRoom(roomCode, wss);
        }
        return;
      }

      // ── delete_combatant ───────────────────────────────────────────────────
      if (type === 'delete_combatant') {
        const { id } = data;
        await pool.query('DELETE FROM combatants WHERE id=$1 AND room_id=$2', [id, r.id]);
        const { rows: remaining } = await pool.query(
          'SELECT id FROM combatants WHERE room_id=$1', [r.id]
        );
        if (remaining.length > 0 && r.current_turn_index >= remaining.length) {
          await pool.query('UPDATE rooms SET current_turn_index=0 WHERE id=$1', [r.id]);
        }
        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── reorder ────────────────────────────────────────────────────────────
      if (type === 'reorder') {
        const { orderedIds } = data;
        if (!Array.isArray(orderedIds)) return;
        await Promise.all(orderedIds.map((id, i) =>
          pool.query('UPDATE combatants SET sort_order=$1 WHERE id=$2', [i, id])
        ));
        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── toggle_condition ───────────────────────────────────────────────────
      if (type === 'toggle_condition') {
        const { combatant_id, condition_name, exhaustion_level, rounds } = data;
        const { rows: crow } = await pool.query('SELECT room_id FROM combatants WHERE id=$1', [combatant_id]);
        if (!crow[0] || crow[0].room_id !== r.id) return;

        const { rows: existing } = await pool.query(
          'SELECT id FROM combatant_conditions WHERE combatant_id=$1 AND condition_name=$2',
          [combatant_id, condition_name]
        );
        if (existing.length > 0) {
          await pool.query(
            'DELETE FROM combatant_conditions WHERE combatant_id=$1 AND condition_name=$2',
            [combatant_id, condition_name]
          );
        } else {
          await pool.query(
            'INSERT INTO combatant_conditions (combatant_id, condition_name, exhaustion_level, rounds_remaining) VALUES ($1,$2,$3,$4)',
            [combatant_id, condition_name, parseInt(exhaustion_level) || 0, rounds != null ? parseInt(rounds) : null]
          );
        }
        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── update_exhaustion ──────────────────────────────────────────────────
      if (type === 'update_exhaustion') {
        const { combatant_id, level } = data;
        const { rows: crow } = await pool.query('SELECT room_id FROM combatants WHERE id=$1', [combatant_id]);
        if (!crow[0] || crow[0].room_id !== r.id) return;

        if (level === 0) {
          await pool.query(
            'DELETE FROM combatant_conditions WHERE combatant_id=$1 AND condition_name=$2',
            [combatant_id, 'Exhaustion']
          );
        } else {
          const { rows: ex } = await pool.query(
            'SELECT id FROM combatant_conditions WHERE combatant_id=$1 AND condition_name=$2',
            [combatant_id, 'Exhaustion']
          );
          if (ex.length > 0) {
            await pool.query(
              'UPDATE combatant_conditions SET exhaustion_level=$1 WHERE combatant_id=$2 AND condition_name=$3',
              [parseInt(level), combatant_id, 'Exhaustion']
            );
          } else {
            await pool.query(
              'INSERT INTO combatant_conditions (combatant_id, condition_name, exhaustion_level, rounds_remaining) VALUES ($1,$2,$3,NULL)',
              [combatant_id, 'Exhaustion', parseInt(level)]
            );
          }
        }
        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── next_turn ──────────────────────────────────────────────────────────
      if (type === 'next_turn') {
        const { rows: combatants } = await pool.query(
          'SELECT * FROM combatants WHERE room_id=$1 ORDER BY sort_order, id', [r.id]
        );
        if (combatants.length === 0) return;

        const cur = combatants[r.current_turn_index % combatants.length];

        // Decrement rounds on the combatant whose turn just ended
        await pool.query(
          'UPDATE combatant_conditions SET rounds_remaining = rounds_remaining - 1 WHERE combatant_id=$1 AND rounds_remaining IS NOT NULL',
          [cur.id]
        );

        // Collect and delete expired conditions
        const { rows: expired } = await pool.query(
          'SELECT * FROM combatant_conditions WHERE combatant_id=$1 AND rounds_remaining IS NOT NULL AND rounds_remaining <= 0',
          [cur.id]
        );
        await pool.query(
          'DELETE FROM combatant_conditions WHERE combatant_id=$1 AND rounds_remaining IS NOT NULL AND rounds_remaining <= 0',
          [cur.id]
        );

        // Advance turn
        let newIdx = r.current_turn_index + 1;
        let newRound = r.current_round;
        if (newIdx >= combatants.length) { newIdx = 0; newRound++; }
        await pool.query(
          'UPDATE rooms SET current_turn_index=$1, current_round=$2 WHERE id=$3',
          [newIdx, newRound, r.id]
        );

        await broadcastRoom(roomCode, wss);

        // Notify about expired conditions
        expired.forEach(cond => {
          notifyRoom(roomCode, wss, {
            type: 'condition_expired',
            data: { combatantId: cur.id, combatantName: cur.name, conditionName: cond.condition_name },
          });
        });
        return;
      }

      // ── prev_turn ──────────────────────────────────────────────────────────
      if (type === 'prev_turn') {
        const { rows: combatants } = await pool.query(
          'SELECT id FROM combatants WHERE room_id=$1 ORDER BY sort_order, id', [r.id]
        );
        if (combatants.length === 0) return;

        let newIdx = r.current_turn_index - 1;
        let newRound = r.current_round;
        if (newIdx < 0) { newIdx = combatants.length - 1; newRound = Math.max(1, newRound - 1); }
        await pool.query(
          'UPDATE rooms SET current_turn_index=$1, current_round=$2 WHERE id=$3',
          [newIdx, newRound, r.id]
        );
        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── update_image_position ──────────────────────────────────────────────
      if (type === 'update_image_position') {
        const { id, image_x, image_y, image_scale } = data;
        const { rows: crow } = await pool.query('SELECT room_id FROM combatants WHERE id=$1', [id]);
        if (!crow[0] || crow[0].room_id !== r.id) return;
        await pool.query(
          'UPDATE combatants SET image_x=$1, image_y=$2, image_scale=$3 WHERE id=$4',
          [
            Math.max(0, Math.min(100, parseInt(image_x) ?? 50)),
            Math.max(0, Math.min(100, parseInt(image_y) ?? 50)),
            Math.max(10, Math.min(100, parseInt(image_scale) ?? 100)),
            id,
          ]
        );
        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── update_bg_image ────────────────────────────────────────────────────
      if (type === 'update_bg_image') {
        const { bg_image_url, bg_image_x, bg_image_y, bg_image_scale } = data;
        await pool.query(
          'UPDATE rooms SET bg_image_url=$1, bg_image_x=$2, bg_image_y=$3, bg_image_scale=$4 WHERE id=$5',
          [
            (bg_image_url || '').substring(0, 500),
            Math.max(0, Math.min(100, parseInt(bg_image_x) || 50)),
            Math.max(0, Math.min(100, parseInt(bg_image_y) || 50)),
            Math.max(50, Math.min(300, parseInt(bg_image_scale) || 100)),
            r.id,
          ]
        );
        await broadcastRoom(roomCode, wss);
        return;
      }

      // ── reset_combat ───────────────────────────────────────────────────────
      if (type === 'reset_combat') {
        await pool.query('UPDATE rooms SET current_turn_index=0, current_round=1 WHERE id=$1', [r.id]);
        await broadcastRoom(roomCode, wss);
        return;
      }
    } catch (err) {
      console.error('WS handler error:', err);
    }
  });

  ws.on('error', err => console.error('WS error:', err.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`🎲 Soju Turn Tracker listening on port ${PORT}`);
    });

    process.on('SIGTERM', () => {
      console.log('SIGTERM received — shutting down gracefully');
      wss.clients.forEach(client => client.close(1001, 'Server shutting down'));
      httpServer.close(() => {
        pool.end(() => process.exit(0));
      });
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
