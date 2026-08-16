const express = require('express');
const authMW = require('../middleware/auth');

let db;
try { db = require('../config/db'); } catch { db = null; }

const router = express.Router();

async function dbOk() {
  if (!db) return false;
  try { await db.query('SELECT 1'); return true; } catch { return false; }
}

// WarKey desktop апп нээлттэй байх хугацаанд тогтмол дуудна. Токеныг баталгаажуулж,
// хэрэглэгчийг бүртгэн last_seen-ийг шинэчилнэ. Зөвхөн Discord-той акаунт бүртгэгдэнэ.
router.post('/heartbeat', authMW, async (req, res) => {
  const version = String(req.body?.version || '').trim().slice(0, 50) || null;

  if (!req.user?.discord_id) {
    return res.status(400).json({ error: 'Discord login required' });
  }
  if (!(await dbOk())) {
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  // Хориглосон хэрэглэгч бол апп ашиглах боломжгүй — бүртгэхгүй, тусгай хариу буцаана.
  try {
    const banned = await db.query('SELECT 1 FROM warkey_bans WHERE discord_id = $1', [String(req.user.discord_id)]);
    if (banned.rows.length > 0) {
      return res.status(403).json({ error: 'banned' });
    }
  } catch (e) {
    console.error('[WarKey] ban check:', e.message);
  }

  try {
    await db.query(
      `INSERT INTO warkey_users (discord_id, username, version, first_seen, last_seen)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (discord_id) DO UPDATE SET
         username  = COALESCE(EXCLUDED.username, warkey_users.username),
         version   = COALESCE(EXCLUDED.version, warkey_users.version),
         last_seen = NOW()`,
      [String(req.user.discord_id), req.user.username || null, version]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[WarKey] heartbeat:', e.message);
    res.status(500).json({ error: 'Failed to record heartbeat' });
  }
});

// Апп эхлэхэд токен хүчинтэй эсэхийг шалгах хөнгөн endpoint.
router.get('/me', authMW, (req, res) => {
  if (!req.user?.discord_id) {
    return res.status(400).json({ error: 'Discord login required' });
  }
  res.json({ discord_id: req.user.discord_id, username: req.user.username });
});

module.exports = router;
