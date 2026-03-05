'use strict';

const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// ─── Database Setup ───────────────────────────────────────────────────────────
if (!fs.existsSync('./db')) fs.mkdirSync('./db');

const db = new DatabaseSync('./db/dnd.db');

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    dm_user_id INTEGER NOT NULL REFERENCES users(id),
    current_turn_index INTEGER DEFAULT 0,
    current_round INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS combatants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    show_name INTEGER DEFAULT 1,
    show_hp INTEGER DEFAULT 0,
    show_conditions INTEGER DEFAULT 1,
    is_visible INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS combatant_conditions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    combatant_id INTEGER NOT NULL REFERENCES combatants(id) ON DELETE CASCADE,
    condition_name TEXT NOT NULL,
    exhaustion_level INTEGER DEFAULT 0,
    rounds_remaining INTEGER DEFAULT NULL
  );
`);

// Migrations for existing DBs (ignore error if column already exists)
try { db.exec('ALTER TABLE combatants ADD COLUMN image_x INTEGER DEFAULT 50'); } catch {}
try { db.exec('ALTER TABLE combatants ADD COLUMN image_y INTEGER DEFAULT 50'); } catch {}
try { db.exec('ALTER TABLE combatants ADD COLUMN image_scale INTEGER DEFAULT 100'); } catch {}
try { db.exec("ALTER TABLE combatants ADD COLUMN layer_action TEXT DEFAULT ''"); } catch {}
// Enable conditions visible by default for any combatants still on the old default
try { db.exec('UPDATE combatants SET show_conditions = 1 WHERE show_conditions = 0'); } catch {}
// Room background image
try { db.exec("ALTER TABLE rooms ADD COLUMN bg_image_url TEXT DEFAULT ''"); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN bg_image_x INTEGER DEFAULT 50'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN bg_image_y INTEGER DEFAULT 50'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN bg_image_scale INTEGER DEFAULT 100'); } catch {}

// ─── Prepared Statements ──────────────────────────────────────────────────────
const q = {
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  createUser:        db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)'),

  getRoomsByDm:   db.prepare('SELECT * FROM rooms WHERE dm_user_id = ? ORDER BY created_at DESC'),
  getRoomByCode:  db.prepare('SELECT * FROM rooms WHERE code = ?'),
  createRoom:     db.prepare('INSERT INTO rooms (code, name, dm_user_id) VALUES (?, ?, ?)'),
  deleteRoom:     db.prepare('DELETE FROM rooms WHERE code = ? AND dm_user_id = ?'),
  updateRoomTurn: db.prepare('UPDATE rooms SET current_turn_index = ?, current_round = ? WHERE id = ?'),
  resetRoom:      db.prepare('UPDATE rooms SET current_turn_index = 0, current_round = 1 WHERE id = ?'),

  getCombatantsByRoom: db.prepare('SELECT * FROM combatants WHERE room_id = ? ORDER BY sort_order, id'),
  getCombatantById:    db.prepare('SELECT * FROM combatants WHERE id = ?'),
  maxSortOrder:        db.prepare('SELECT MAX(sort_order) as m FROM combatants WHERE room_id = ?'),
  insertCombatant:     db.prepare(`
    INSERT INTO combatants (room_id, name, combatant_type, initiative, sort_order, max_hp, current_hp, image_url, card_color, image_x, image_y, image_scale, is_visible, layer_action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateRoomBgImage:   db.prepare('UPDATE rooms SET bg_image_url = ?, bg_image_x = ?, bg_image_y = ?, bg_image_scale = ? WHERE id = ?'),
  updateLayerAction:   db.prepare('UPDATE combatants SET layer_action = ? WHERE id = ?'),
  updateCardColor:     db.prepare('UPDATE combatants SET card_color = ? WHERE id = ?'),
  updateImageUrl:      db.prepare('UPDATE combatants SET image_url = ? WHERE id = ?'),
  deleteCombatant:       db.prepare('DELETE FROM combatants WHERE id = ? AND room_id = ?'),
  updateHp:              db.prepare('UPDATE combatants SET current_hp = ?, temp_hp = ?, max_hp = ? WHERE id = ?'),
  updateVisibility:      db.prepare('UPDATE combatants SET show_name = ?, show_hp = ?, show_conditions = ?, is_visible = ? WHERE id = ?'),
  updateSortOrder:       db.prepare('UPDATE combatants SET sort_order = ? WHERE id = ?'),
  updateImagePosition:   db.prepare('UPDATE combatants SET image_x = ?, image_y = ?, image_scale = ? WHERE id = ?'),

  getConditions:             db.prepare('SELECT * FROM combatant_conditions WHERE combatant_id = ?'),
  getCondition:              db.prepare('SELECT * FROM combatant_conditions WHERE combatant_id = ? AND condition_name = ?'),
  insertCondition:           db.prepare('INSERT INTO combatant_conditions (combatant_id, condition_name, exhaustion_level, rounds_remaining) VALUES (?, ?, ?, ?)'),
  deleteCondition:           db.prepare('DELETE FROM combatant_conditions WHERE combatant_id = ? AND condition_name = ?'),
  updateExhaustion:          db.prepare('UPDATE combatant_conditions SET exhaustion_level = ? WHERE combatant_id = ? AND condition_name = ?'),
  decrementRounds:           db.prepare('UPDATE combatant_conditions SET rounds_remaining = rounds_remaining - 1 WHERE combatant_id = ? AND rounds_remaining IS NOT NULL'),
  getExpiredConditions:      db.prepare('SELECT * FROM combatant_conditions WHERE combatant_id = ? AND rounds_remaining IS NOT NULL AND rounds_remaining <= 0'),
  deleteExpiredConditions:   db.prepare('DELETE FROM combatant_conditions WHERE combatant_id = ? AND rounds_remaining IS NOT NULL AND rounds_remaining <= 0'),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (q.getRoomByCode.get(code));
  return code;
}

function buildRoomState(room, role) {
  const combatants = q.getCombatantsByRoom.all(room.id).map(c => {
    c.conditions = q.getConditions.all(c.id);
    return c;
  });

  let visible = combatants;
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
      }));
  }

  return {
    id: room.id,
    code: room.code,
    name: room.name,
    current_turn_index: room.current_turn_index,
    current_round: room.current_round,
    bg_image_url:   room.bg_image_url   || '',
    bg_image_x:     room.bg_image_x     ?? 50,
    bg_image_y:     room.bg_image_y     ?? 50,
    bg_image_scale: room.bg_image_scale ?? 100,
    combatants: visible,
  };
}

function broadcastRoom(roomCode, wss) {
  const room = q.getRoomByCode.get(roomCode);
  if (!room) return;
  const dmState     = buildRoomState(room, 'dm');
  const playerState = buildRoomState(room, 'player');

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

const sessionParser = session({
  secret: process.env.SESSION_SECRET || ('dnd-tracker-' + Math.random().toString(36)),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: isProd, httpOnly: true, sameSite: 'lax' },
});

app.use(express.json());
app.use(sessionParser);
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: 'Username must be 2–20 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const hash = await bcrypt.hash(password, 10);
    q.createUser.run(username.trim(), hash);
    const user = q.getUserByUsername.get(username.trim());
    req.session.userId   = user.id;
    req.session.username = user.username;
    res.json({ success: true, username: user.username });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already taken' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password, rememberMe } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = q.getUserByUsername.get(username.trim());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  if (rememberMe) req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
  req.session.userId   = user.id;
  req.session.username = user.username;
  res.json({ success: true, username: user.username });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  res.json({ authenticated: true, username: req.session.username, userId: req.session.userId });
});

// ─── Room Routes ──────────────────────────────────────────────────────────────
app.get('/api/rooms', requireAuth, (req, res) => {
  res.json(q.getRoomsByDm.all(req.session.userId));
});

app.post('/api/rooms', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Room name required' });
  const code = generateCode();
  q.createRoom.run(code, name.trim(), req.session.userId);
  res.json(q.getRoomByCode.get(code));
});

app.delete('/api/rooms/:code', requireAuth, (req, res) => {
  const result = q.deleteRoom.run(req.params.code.toUpperCase(), req.session.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Room not found' });
  res.json({ success: true });
});

// Public endpoint: player joins by code to get initial state
app.get('/api/rooms/:code/state', (req, res) => {
  const room = q.getRoomByCode.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(buildRoomState(room, 'player'));
});

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  sessionParser(req, {}, () => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
});

wss.on('connection', (ws, req) => {
  const url      = new URL(req.url, 'http://localhost');
  const roomCode = (url.searchParams.get('room') || '').toUpperCase();
  const role     = url.searchParams.get('role');

  const room = q.getRoomByCode.get(roomCode);
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

  // Send initial state
  const state = buildRoomState(room, ws.isDM ? 'dm' : 'player');
  ws.send(JSON.stringify({ type: 'state_update', data: state }));

  ws.on('message', raw => {
    if (!ws.isDM) return; // players are read-only

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, data } = msg;

    // Always refetch room so current_turn_index is fresh
    const r = q.getRoomByCode.get(roomCode);
    if (!r) return;

    // ── add_combatant ──────────────────────────────────────────────────────
    if (type === 'add_combatant') {
      const { name, combatant_type, initiative, max_hp, image_url, card_color } = data;
      if (!name || !name.trim()) return;
      const row = q.maxSortOrder.get(r.id);
      const nextOrder = (row && row.m != null) ? row.m + 1 : 0;
      const hp = Math.max(1, parseInt(max_hp) || 1);
      const isVisible = data.is_visible === false || data.is_visible === 0 ? 0 : 1;
      q.insertCombatant.run(
        r.id, name.trim(), combatant_type || 'Monster',
        parseInt(initiative) || 0, nextOrder,
        hp, hp,
        image_url || '', card_color || '#2d2d44',
        parseInt(data.image_x) || 50, parseInt(data.image_y) || 50,
        Math.max(10, Math.min(100, parseInt(data.image_scale) || 100)),
        isVisible,
        (data.layer_action || '').substring(0, 500)
      );
      // Re-sort all combatants by initiative descending so the new entry slots in correctly
      q.getCombatantsByRoom.all(r.id)
        .sort((a, b) => b.initiative - a.initiative)
        .forEach((c, idx) => q.updateSortOrder.run(idx, c.id));
      broadcastRoom(roomCode, wss);
      return;
    }

    // ── update_hp ──────────────────────────────────────────────────────────
    if (type === 'update_hp') {
      const { id, current_hp, max_hp, temp_hp } = data;
      const c = q.getCombatantById.get(id);
      if (!c || c.room_id !== r.id) return;
      q.updateHp.run(
        parseInt(current_hp) ?? c.current_hp,
        Math.max(0, parseInt(temp_hp) || 0),
        Math.max(1, parseInt(max_hp) || 1),
        id
      );
      broadcastRoom(roomCode, wss);
      return;
    }

    // ── update_visibility ──────────────────────────────────────────────────
    if (type === 'update_visibility') {
      const { id, show_name, show_hp, show_conditions, is_visible } = data;
      const c = q.getCombatantById.get(id);
      if (!c || c.room_id !== r.id) return;
      q.updateVisibility.run(
        show_name       ? 1 : 0,
        show_hp         ? 1 : 0,
        show_conditions ? 1 : 0,
        is_visible      ? 1 : 0,
        id
      );
      broadcastRoom(roomCode, wss);
      return;
    }

    // ── update_layer_action ────────────────────────────────────────────────
    if (type === 'update_layer_action') {
      const { id, layer_action } = data;
      const c = q.getCombatantById.get(id);
      if (!c || c.room_id !== r.id) return;
      q.updateLayerAction.run((layer_action || '').substring(0, 500), id);
      broadcastRoom(roomCode, wss);
      return;
    }

    // ── update_image_url ───────────────────────────────────────────────────
    if (type === 'update_image_url') {
      const { id, image_url } = data;
      const c = q.getCombatantById.get(id);
      if (!c || c.room_id !== r.id) return;
      q.updateImageUrl.run((image_url || '').substring(0, 500), id);
      broadcastRoom(roomCode, wss);
      return;
    }

    // ── update_card_color ──────────────────────────────────────────────────
    if (type === 'update_card_color') {
      const { id, card_color } = data;
      const c = q.getCombatantById.get(id);
      if (!c || c.room_id !== r.id) return;
      // Validate: must be a hex color string
      if (typeof card_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(card_color)) {
        q.updateCardColor.run(card_color, id);
        broadcastRoom(roomCode, wss);
      }
      return;
    }

    // ── delete_combatant ───────────────────────────────────────────────────
    if (type === 'delete_combatant') {
      const { id } = data;
      q.deleteCombatant.run(id, r.id);
      // If deleted combatant was before/at current turn, adjust index
      const remaining = q.getCombatantsByRoom.all(r.id);
      if (remaining.length > 0 && r.current_turn_index >= remaining.length) {
        q.updateRoomTurn.run(0, r.current_round, r.id);
      }
      broadcastRoom(roomCode, wss);
      return;
    }

    // ── reorder ────────────────────────────────────────────────────────────
    if (type === 'reorder') {
      const { orderedIds } = data;
      if (!Array.isArray(orderedIds)) return;
      orderedIds.forEach((id, idx) => q.updateSortOrder.run(idx, id));
      broadcastRoom(roomCode, wss);
      return;
    }

    // ── toggle_condition ───────────────────────────────────────────────────
    if (type === 'toggle_condition') {
      const { combatant_id, condition_name, exhaustion_level, rounds } = data;
      const c = q.getCombatantById.get(combatant_id);
      if (!c || c.room_id !== r.id) return;

      const existing = q.getCondition.get(combatant_id, condition_name);
      if (existing) {
        q.deleteCondition.run(combatant_id, condition_name);
      } else {
        q.insertCondition.run(
          combatant_id, condition_name,
          parseInt(exhaustion_level) || 0,
          rounds != null ? parseInt(rounds) : null
        );
      }
      broadcastRoom(roomCode, wss);
      return;
    }

    // ── update_exhaustion ──────────────────────────────────────────────────
    if (type === 'update_exhaustion') {
      const { combatant_id, level } = data;
      const c = q.getCombatantById.get(combatant_id);
      if (!c || c.room_id !== r.id) return;

      if (level === 0) {
        q.deleteCondition.run(combatant_id, 'Exhaustion');
      } else {
        const ex = q.getCondition.get(combatant_id, 'Exhaustion');
        if (ex) {
          q.updateExhaustion.run(parseInt(level), combatant_id, 'Exhaustion');
        } else {
          q.insertCondition.run(combatant_id, 'Exhaustion', parseInt(level), null);
        }
      }
      broadcastRoom(roomCode, wss);
      return;
    }

    // ── next_turn ──────────────────────────────────────────────────────────
    if (type === 'next_turn') {
      const combatants = q.getCombatantsByRoom.all(r.id);
      if (combatants.length === 0) return;

      const cur = combatants[r.current_turn_index % combatants.length];

      // Decrement and expire conditions on the combatant whose turn just ended
      q.decrementRounds.run(cur.id);
      const expired = q.getExpiredConditions.all(cur.id);
      q.deleteExpiredConditions.run(cur.id);

      // Advance turn
      let newIdx = r.current_turn_index + 1;
      let newRound = r.current_round;
      if (newIdx >= combatants.length) { newIdx = 0; newRound++; }
      q.updateRoomTurn.run(newIdx, newRound, r.id);

      broadcastRoom(roomCode, wss);

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
      const combatants = q.getCombatantsByRoom.all(r.id);
      if (combatants.length === 0) return;

      let newIdx = r.current_turn_index - 1;
      let newRound = r.current_round;
      if (newIdx < 0) { newIdx = combatants.length - 1; newRound = Math.max(1, newRound - 1); }
      q.updateRoomTurn.run(newIdx, newRound, r.id);
      broadcastRoom(roomCode, wss);
      return;
    }

    // ── update_image_position ──────────────────────────────────────────────
    if (type === 'update_image_position') {
      const { id, image_x, image_y, image_scale } = data;
      const c = q.getCombatantById.get(id);
      if (!c || c.room_id !== r.id) return;
      q.updateImagePosition.run(
        Math.max(0, Math.min(100, parseInt(image_x) ?? 50)),
        Math.max(0, Math.min(100, parseInt(image_y) ?? 50)),
        Math.max(10, Math.min(100, parseInt(image_scale) ?? 100)),
        id
      );
      broadcastRoom(roomCode, wss);
      return;
    }

    // ── update_bg_image ────────────────────────────────────────────────────
    if (type === 'update_bg_image') {
      const { bg_image_url, bg_image_x, bg_image_y, bg_image_scale } = data;
      q.updateRoomBgImage.run(
        (bg_image_url || '').substring(0, 500),
        Math.max(0, Math.min(100, parseInt(bg_image_x) || 50)),
        Math.max(0, Math.min(100, parseInt(bg_image_y) || 50)),
        Math.max(50, Math.min(300, parseInt(bg_image_scale) || 100)),
        r.id
      );
      broadcastRoom(roomCode, wss);
      return;
    }

    // ── reset_combat ───────────────────────────────────────────────────────
    if (type === 'reset_combat') {
      q.resetRoom.run(r.id);
      broadcastRoom(roomCode, wss);
      return;
    }
  });

  ws.on('error', err => console.error('WS error:', err.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\u{1F3B2} D&D Initiative Tracker → http://localhost:${PORT}`);
});
