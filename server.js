const express = require('express');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-secret-change-me';
const isPostgres = !!process.env.DATABASE_URL;

let db;
let pool = null;

// ─── DATABASE INIT ────────────────────────────────────────────────────────────
async function initDB() {
  if (isPostgres) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS keys (
        id          SERIAL PRIMARY KEY,
        key_value   TEXT UNIQUE NOT NULL,
        max_devices INTEGER NOT NULL DEFAULT 1,
        duration_h  INTEGER NOT NULL DEFAULT 24,
        note        TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        expires_at  TIMESTAMPTZ,
        is_active   INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS activations (
        id           SERIAL PRIMARY KEY,
        key_value    TEXT NOT NULL,
        device_id    TEXT NOT NULL,
        device_name  TEXT,
        activated_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(key_value, device_id)
      );
    `);
    console.log('✅ Connected to PostgreSQL (persistent)');
  } else {
    const sqlite3 = require('better-sqlite3');
    const sqlite = new sqlite3('license.db');
    db = sqlite;
    sqlite.exec(`
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
    console.log('✅ Using SQLite (local only)');
  }
}

// Helper chạy query đồng nhất (Postgres + SQLite)
async function q(sql, params = []) {
  if (isPostgres) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    return await pool.query(pgSql, params);
  } else {
    const stmt = db.prepare(sql);
    if (sql.trim().toUpperCase().startsWith('SELECT')) {
      if (params.length === 0 && sql.toLowerCase().includes('order by')) {
        return { rows: stmt.all() };
      }
      const row = stmt.get(...params);
      if (row && (sql.includes('COUNT(*)') || Object.keys(row).length > 0)) {
        // Nếu là count hoặc single row
        if (sql.toUpperCase().includes('COUNT(*)')) {
          return { rows: [row] };
        }
        // Thử all trước nếu có nhiều
        try {
          const all = stmt.all(...params);
          return { rows: all };
        } catch {
          return { rows: row ? [row] : [] };
        }
      }
      return { rows: row ? [row] : [] };
    } else {
      stmt.run(...params);
      return { rows: [] };
    }
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function generateKey(prefix = 'GAME') {
  const part = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${part()}-${part()}-${part()}`;
}

function authAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── CLIENT API ───────────────────────────────────────────────────────────────

app.post('/api/activate', async (req, res) => {
  try {
    const { key, device_id, device_name } = req.body;
    if (!key || !device_id) return res.status(400).json({ error: 'Missing key or device_id' });

    const keyRes = await q('SELECT * FROM keys WHERE key_value = ?', [key]);
    const keyRow = keyRes.rows[0];
    if (!keyRow) return res.status(404).json({ error: 'Key không tồn tại' });
    if (!keyRow.is_active) return res.status(403).json({ error: 'Key đã bị vô hiệu hoá' });

    if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
      return res.status(403).json({ error: 'Key đã hết hạn' });
    }

    const existRes = await q('SELECT * FROM activations WHERE key_value = ? AND device_id = ?', [key, device_id]);
    const existing = existRes.rows[0];

    if (existing) {
      await q('UPDATE activations SET last_seen = CURRENT_TIMESTAMP WHERE id = ?', [existing.id]);

      const activatedAt = new Date(existing.activated_at);
      const expireTime = new Date(activatedAt.getTime() + keyRow.duration_h * 3600 * 1000);
      if (expireTime < new Date()) {
        return res.status(403).json({ error: `Phiên ${keyRow.duration_h}h của thiết bị này đã hết` });
      }
      return res.json({
        success: true,
        message: 'Thiết bị đã được xác thực',
        expires_at: expireTime.toISOString(),
        remaining_ms: expireTime - Date.now()
      });
    }

    const countRes = await q('SELECT COUNT(*) as cnt FROM activations WHERE key_value = ?', [key]);
    const deviceCount = parseInt(countRes.rows[0].cnt || countRes.rows[0].count || 0, 10);

    if (deviceCount >= keyRow.max_devices) {
      return res.status(403).json({ error: `Key này chỉ cho phép tối đa ${keyRow.max_devices} thiết bị` });
    }

    await q('INSERT INTO activations (key_value, device_id, device_name) VALUES (?, ?, ?)',
      [key, device_id, device_name || 'Unknown']);

    const expireTime = new Date(Date.now() + keyRow.duration_h * 3600 * 1000);
    return res.json({
      success: true,
      message: 'Kích hoạt thành công!',
      expires_at: expireTime.toISOString(),
      remaining_ms: expireTime - Date.now()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/check', async (req, res) => {
  try {
    const { key, device_id } = req.body;
    if (!key || !device_id) return res.status(400).json({ valid: false, error: 'Missing params' });

    const keyRes = await q('SELECT * FROM keys WHERE key_value = ?', [key]);
    const keyRow = keyRes.rows[0];
    if (!keyRow || !keyRow.is_active) return res.json({ valid: false, error: 'Key không hợp lệ' });

    if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
      return res.json({ valid: false, error: 'Key đã hết hạn' });
    }

    const actRes = await q('SELECT * FROM activations WHERE key_value = ? AND device_id = ?', [key, device_id]);
    const activation = actRes.rows[0];
    if (!activation) return res.json({ valid: false, error: 'Thiết bị chưa được kích hoạt' });

    const activatedAt = new Date(activation.activated_at);
    const expireTime = new Date(activatedAt.getTime() + keyRow.duration_h * 3600 * 1000);

    if (expireTime < new Date()) {
      return res.json({ valid: false, error: `Phiên ${keyRow.duration_h}h đã hết` });
    }

    await q('UPDATE activations SET last_seen = CURRENT_TIMESTAMP WHERE id = ?', [activation.id]);

    return res.json({
      valid: true,
      expires_at: expireTime.toISOString(),
      remaining_ms: expireTime - Date.now()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ valid: false, error: 'Server error' });
  }
});

// ─── ADMIN API ────────────────────────────────────────────────────────────────

app.post('/admin/keys', authAdmin, async (req, res) => {
  try {
    const { max_devices = 1, duration_h = 24, note = '', count = 1, prefix = 'GAME', expires_at } = req.body;
    const created = [];

    for (let i = 0; i < Math.min(count, 100); i++) {
      const key = generateKey(prefix);
      await q(
        'INSERT INTO keys (key_value, max_devices, duration_h, note, expires_at) VALUES (?, ?, ?, ?, ?)',
        [key, max_devices, duration_h, note, expires_at || null]
      );
      created.push(key);
    }
    res.json({ success: true, keys: created });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/admin/keys', authAdmin, async (req, res) => {
  try {
    const resq = await q(`
      SELECT k.*,
        (SELECT COUNT(*) FROM activations a WHERE a.key_value = k.key_value) as device_count
      FROM keys k ORDER BY k.created_at DESC
    `);
    res.json(resq.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/admin/keys/:key', authAdmin, async (req, res) => {
  try {
    await q('UPDATE keys SET is_active = 0 WHERE key_value = ?', [req.params.key]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/admin/keys/:key/devices', authAdmin, async (req, res) => {
  try {
    const resq = await q('SELECT * FROM activations WHERE key_value = ? ORDER BY activated_at DESC', [req.params.key]);
    res.json(resq.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/admin/activations/:key/:device_id', authAdmin, async (req, res) => {
  try {
    await q('DELETE FROM activations WHERE key_value = ? AND device_id = ?', [req.params.key, req.params.device_id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ License server running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
