const express = require('express');
const authMW  = require('../middleware/auth');

let db;
try { db = require('../config/db'); } catch { db = null; }

async function dbOk() {
  if (!db) return false;
  try { await db.query('SELECT 1'); return true; } catch { return false; }
}

// In-memory fallback
let memStreamers = [];
let memNextId    = 1;

const router = express.Router();

// DB table үүсгэх
(async () => {
  if (!await dbOk()) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS streamers (
      id                SERIAL PRIMARY KEY,
      name              VARCHAR(100) NOT NULL,
      platform          VARCHAR(50) NOT NULL,
      channel_url       TEXT NOT NULL,
      description       VARCHAR(200),
      added_by_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
      added_by_username VARCHAR(255) NOT NULL,
      created_at        TIMESTAMP DEFAULT NOW()
    )
  `).catch(e => console.error('[Migration] streamers:', e.message));
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS streamers_channel_url_unique
    ON streamers (LOWER(channel_url))
  `).catch(e => console.error('[Migration] streamers unique idx:', e.message));
})();

// URL validation — зөвхөн http/https холбоос
function isValidUrl(url) {
  return /^https?:\/\/.+/i.test(url.trim());
}

// Platform detect
function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('twitch.tv')) return 'Twitch';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
  if (u.includes('facebook.com') || u.includes('fb.gg')) return 'Facebook';
  if (u.includes('kick.com')) return 'Kick';
  if (u.includes('tiktok.com')) return 'TikTok';
  return 'Other';
}

// ── GET / — бүх streamer авах ─────────────────────────────
router.get('/', async (req, res) => {
  let streamers;
  if (await dbOk()) {
    try {
      const { rows } = await db.query('SELECT * FROM streamers ORDER BY created_at DESC');
      streamers = rows;
    } catch (e) { console.error(e); streamers = [...memStreamers].reverse(); }
  } else {
    streamers = [...memStreamers].reverse();
  }
  res.json(streamers);
});

// ── POST / — streamer нэмэх ──────────────────────────────
router.post('/', authMW, async (req, res) => {
  const { name, channel_url, description } = req.body;
  if (!name?.trim())
    return res.status(400).json({ error: 'Стримерийн нэр оруулна уу' });
  if (!channel_url || !isValidUrl(channel_url))
    return res.status(400).json({ error: 'Зөв URL холбоос оруулна уу' });

  const userId   = req.user.id;
  const username = req.user.username;
  const safeName = name.trim().slice(0, 100);
  const safeUrl  = channel_url.trim();
  const desc     = description?.trim().slice(0, 200) || null;
  const platform = detectPlatform(safeUrl);

  if (await dbOk()) {
    try {
      const dup = await db.query(
        'SELECT id FROM streamers WHERE LOWER(channel_url) = LOWER($1)', [safeUrl]
      );
      if (dup.rows.length)
        return res.status(409).json({ error: 'Энэ суваг аль хэдийн нэмэгдсэн байна' });

      const { rows } = await db.query(
        `INSERT INTO streamers (name, platform, channel_url, description, added_by_id, added_by_username)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [safeName, platform, safeUrl, desc, userId, username]
      );
      return res.status(201).json(rows[0]);
    } catch (e) { console.error(e); }
  }
  // In-memory
  if (memStreamers.some(s => s.channel_url.toLowerCase() === safeUrl.toLowerCase()))
    return res.status(409).json({ error: 'Энэ суваг аль хэдийн нэмэгдсэн байна' });

  const entry = {
    id: memNextId++, name: safeName, platform, channel_url: safeUrl,
    description: desc, added_by_id: userId, added_by_username: username,
    created_at: new Date().toISOString(),
  };
  memStreamers.push(entry);
  res.status(201).json(entry);
});

// ── PATCH /:id — өөрийнхийг засах ────────────────────────
router.patch('/:id', authMW, async (req, res) => {
  const id     = parseInt(req.params.id);
  const userId = req.user.id;
  const { name, channel_url, description } = req.body;

  if (name !== undefined && !name?.trim())
    return res.status(400).json({ error: 'Стримерийн нэр оруулна уу' });
  if (channel_url !== undefined && !isValidUrl(channel_url))
    return res.status(400).json({ error: 'Зөв URL холбоос оруулна уу' });

  const safeName = name?.trim().slice(0, 100);
  const safeUrl  = channel_url?.trim();
  const desc     = description?.trim().slice(0, 200) ?? undefined;
  const platform = safeUrl ? detectPlatform(safeUrl) : undefined;

  if (await dbOk()) {
    try {
      const { rows: existing } = await db.query('SELECT added_by_id FROM streamers WHERE id=$1', [id]);
      if (!existing.length) return res.status(404).json({ error: 'Олдсонгүй' });
      if (existing[0].added_by_id !== userId)
        return res.status(403).json({ error: 'Зөвхөн өөрийн оруулсан стримерийг засаж болно' });

      if (safeUrl) {
        const dup = await db.query(
          'SELECT id FROM streamers WHERE LOWER(channel_url)=LOWER($1) AND id<>$2', [safeUrl, id]);
        if (dup.rows.length)
          return res.status(409).json({ error: 'Энэ суваг аль хэдийн бүртгэлтэй байна' });
      }

      const fields = [];
      const vals   = [];
      let   idx    = 1;
      if (safeName !== undefined) { fields.push(`name=$${idx++}`);        vals.push(safeName); }
      if (safeUrl  !== undefined) { fields.push(`channel_url=$${idx++}`); vals.push(safeUrl); }
      if (platform !== undefined) { fields.push(`platform=$${idx++}`);    vals.push(platform); }
      if (desc     !== undefined) { fields.push(`description=$${idx++}`); vals.push(desc); }
      if (!fields.length) return res.status(400).json({ error: 'Өөрчлөх утга байхгүй' });

      vals.push(id);
      const { rows } = await db.query(
        `UPDATE streamers SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`, vals);
      return res.json(rows[0]);
    } catch (e) { console.error(e); }
  }
  // In-memory
  const entry = memStreamers.find(s => s.id === id);
  if (!entry) return res.status(404).json({ error: 'Олдсонгүй' });
  if (entry.added_by_id !== userId)
    return res.status(403).json({ error: 'Зөвхөн өөрийн оруулсан стримерийг засаж болно' });
  if (safeUrl && memStreamers.some(s => s.id !== id && s.channel_url.toLowerCase() === safeUrl.toLowerCase()))
    return res.status(409).json({ error: 'Энэ суваг аль хэдийн бүртгэлтэй байна' });
  if (safeName !== undefined) entry.name        = safeName;
  if (safeUrl  !== undefined) { entry.channel_url = safeUrl; entry.platform = detectPlatform(safeUrl); }
  if (desc     !== undefined) entry.description = desc;
  res.json(entry);
});

// ── DELETE /:id — өөрийнхийг устгах ──────────────────────
router.delete('/:id', authMW, async (req, res) => {
  const id     = parseInt(req.params.id);
  const userId = req.user.id;

  if (await dbOk()) {
    try {
      const { rows } = await db.query('SELECT added_by_id FROM streamers WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Олдсонгүй' });
      if (rows[0].added_by_id !== userId)
        return res.status(403).json({ error: 'Зөвхөн өөрийн оруулсан стримерийг устгаж болно' });
      await db.query('DELETE FROM streamers WHERE id=$1', [id]);
      return res.json({ ok: true });
    } catch (e) { console.error(e); }
  }
  const idx = memStreamers.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Олдсонгүй' });
  if (memStreamers[idx].added_by_id !== userId)
    return res.status(403).json({ error: 'Зөвхөн өөрийн оруулсан стримерийг устгаж болно' });
  memStreamers.splice(idx, 1);
  res.json({ ok: true });
});

module.exports = router;
