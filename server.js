const express = require('express');
const sqlite3 = require('better-sqlite3');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
const db = new sqlite3('license.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key_value   TEXT UNIQUE NOT NULL,
    max_devices INTEGER NOT NULL DEFAULT 1,
    duration_h  INTEGER NOT NULL DEFAULT 24,
    note        TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at  DATETIME,
    is_active   INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS activations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key_value    TEXT NOT NULL,
    device_id    TEXT NOT NULL,
    device_name  TEXT,
    activated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen    DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(key_value, device_id)
  );
`);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function generateKey(prefix = 'GAME') {
  const part = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${part()}-${part()}-${part()}`;
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-secret-change-me';

function authAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── /connect — endpoint cho libkeydockguard.so ───────────────────────────────
// App gửi POST với params: game=, user_key=, serial=
// Trả về JSON: { active: true/false, status: "...", facts: "..." }
app.post('/connect', (req, res) => {
  const user_key = req.body.user_key || req.query.user_key;
  const serial   = req.body.serial   || req.query.serial;
  const game     = req.body.game     || req.query.game;

  if (!user_key) {
    return res.json({ active: false, status: 'Login rejected.', facts: '' });
  }

  const keyRow = db.prepare('SELECT * FROM keys WHERE key_value = ?').get(user_key);

  if (!keyRow || !keyRow.is_active) {
    return res.json({ active: false, status: 'Login rejected.', facts: '' });
  }

  if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
    return res.json({ active: false, status: 'Login rejected.', facts: '' });
  }

  // Kiểm tra hoặc thêm device
  const existing = db.prepare(
    'SELECT * FROM activations WHERE key_value = ? AND device_id = ?'
  ).get(user_key, serial || 'unknown');

  if (existing) {
    const activatedAt = new Date(existing.activated_at);
    const expireTime  = new Date(activatedAt.getTime() + keyRow.duration_h * 3600 * 1000);
    if (expireTime < new Date()) {
      return res.json({ active: false, status: 'Login rejected.', facts: '' });
    }
    db.prepare('UPDATE activations SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(existing.id);
    return res.json({ active: true, status: 'authorized', facts: game || '' });
  }

  // Device mới
  const deviceCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM activations WHERE key_value = ?'
  ).get(user_key).cnt;

  if (deviceCount >= keyRow.max_devices) {
    return res.json({ active: false, status: 'Login rejected.', facts: '' });
  }

  db.prepare(
    'INSERT INTO activations (key_value, device_id, device_name) VALUES (?, ?, ?)'
  ).run(user_key, serial || 'unknown', 'Android');

  return res.json({ active: true, status: 'authorized', facts: game || '' });
});

// ─── CLIENT API (game gọi) ────────────────────────────────────────────────────

app.post('/api/activate', (req, res) => {
  const { key, device_id, device_name } = req.body;
  if (!key || !device_id) return res.status(400).json({ error: 'Missing key or device_id' });

  const keyRow = db.prepare('SELECT * FROM keys WHERE key_value = ?').get(key);
  if (!keyRow) return res.status(404).json({ error: 'Key không tồn tại' });
  if (!keyRow.is_active) return res.status(403).json({ error: 'Key đã bị vô hiệu hoá' });

  if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
    return res.status(403).json({ error: 'Key đã hết hạn' });
  }

  const existing = db.prepare(
    'SELECT * FROM activations WHERE key_value = ? AND device_id = ?'
  ).get(key, device_id);

  if (existing) {
    db.prepare('UPDATE activations SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(existing.id);
    const activatedAt = new Date(existing.activated_at);
    const expireTime  = new Date(activatedAt.getTime() + keyRow.duration_h * 3600 * 1000);
    const now = new Date();
    if (expireTime < now) {
      return res.status(403).json({ error: `Phiên ${keyRow.duration_h}h của thiết bị này đã hết` });
    }
    return res.json({ success: true, message: 'Thiết bị đã được xác thực', expires_at: expireTime.toISOString(), remaining_ms: expireTime - now });
  }

  const deviceCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM activations WHERE key_value = ?'
  ).get(key).cnt;

  if (deviceCount >= keyRow.max_devices) {
    return res.status(403).json({ error: `Key này chỉ cho phép tối đa ${keyRow.max_devices} thiết bị` });
  }

  db.prepare(
    'INSERT INTO activations (key_value, device_id, device_name) VALUES (?, ?, ?)'
  ).run(key, device_id, device_name || 'Unknown');

  const expireTime = new Date(Date.now() + keyRow.duration_h * 3600 * 1000);
  return res.json({ success: true, message: 'Kích hoạt thành công!', expires_at: expireTime.toISOString(), remaining_ms: expireTime - Date.now() });
});

app.post('/api/check', (req, res) => {
  const { key, device_id } = req.body;
  if (!key || !device_id) return res.status(400).json({ valid: false, error: 'Missing params' });

  const keyRow = db.prepare('SELECT * FROM keys WHERE key_value = ?').get(key);
  if (!keyRow || !keyRow.is_active) return res.json({ valid: false, error: 'Key không hợp lệ' });

  if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
    return res.json({ valid: false, error: 'Key đã hết hạn' });
  }

  const activation = db.prepare(
    'SELECT * FROM activations WHERE key_value = ? AND device_id = ?'
  ).get(key, device_id);

  if (!activation) return res.json({ valid: false, error: 'Thiết bị chưa được kích hoạt' });

  const activatedAt = new Date(activation.activated_at);
  const expireTime  = new Date(activatedAt.getTime() + keyRow.duration_h * 3600 * 1000);

  if (expireTime < new Date()) {
    return res.json({ valid: false, error: `Phiên ${keyRow.duration_h}h đã hết` });
  }

  db.prepare('UPDATE activations SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(activation.id);
  return res.json({ valid: true, expires_at: expireTime.toISOString(), remaining_ms: expireTime - Date.now() });
});

// ─── ADMIN API ────────────────────────────────────────────────────────────────

app.post('/admin/keys', authAdmin, (req, res) => {
  const { max_devices = 1, duration_h = 24, note = '', count = 1, prefix = 'GAME', expires_at } = req.body;
  const created = [];
  for (let i = 0; i < Math.min(count, 100); i++) {
    const key = generateKey(prefix);
    db.prepare(
      'INSERT INTO keys (key_value, max_devices, duration_h, note, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(key, max_devices, duration_h, note, expires_at || null);
    created.push(key);
  }
  res.json({ success: true, keys: created });
});

app.get('/admin/keys', authAdmin, (req, res) => {
  const keys = db.prepare(`
    SELECT k.*,
      (SELECT COUNT(*) FROM activations a WHERE a.key_value = k.key_value) as device_count
    FROM keys k ORDER BY k.created_at DESC
  `).all();
  res.json(keys);
});

app.delete('/admin/keys/:key', authAdmin, (req, res) => {
  db.prepare('UPDATE keys SET is_active = 0 WHERE key_value = ?').run(req.params.key);
  res.json({ success: true });
});

app.get('/admin/keys/:key/devices', authAdmin, (req, res) => {
  const devices = db.prepare(
    'SELECT * FROM activations WHERE key_value = ? ORDER BY activated_at DESC'
  ).all(req.params.key);
  res.json(devices);
});

app.delete('/admin/activations/:key/:device_id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM activations WHERE key_value = ? AND device_id = ?')
    .run(req.params.key, req.params.device_id);
  res.json({ success: true });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ License server running on port ${PORT}`));
