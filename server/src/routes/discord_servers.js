const express = require('express');
const authMW  = require('../middleware/auth');

let db;
try { db = require('../config/db'); } catch { db = null; }

async function dbOk() {
  if (!db) return false;
  try { await db.query('SELECT 1'); return true; } catch { return false; }
}

// In-memory fallback
let memServers = [];
let memNextId  = 1;

const router = express.Router();

// Discord урилгын холбоос шалгах
function isValidDiscordInvite(url) {
  return /^https?:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/.test(url.trim());
}

// DB тэблийг үүсгэх
(async () => {
  if (!await dbOk()) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS discord_servers (
      id                SERIAL PRIMARY KEY,
      name              VARCHAR(100) NOT NULL,
      invite_url        TEXT NOT NULL,
      description       VARCHAR(200),
      added_by_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
      added_by_username VARCHAR(255) NOT NULL,
      created_at        TIMESTAMP DEFAULT NOW()
    )
  `).catch(e => console.error('[Migration] discord_servers:', e.message));
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS discord_servers_invite_url_unique
    ON discord_servers (LOWER(invite_url))
  `).catch(e => console.error('[Migration] discord_servers unique idx:', e.message));
})();

// ── GET / — бүх серверийг авах ────────────────────────────
router.get('/', async (req, res) => {
  if (await dbOk()) {
    try {
      const { rows } = await db.query(
        'SELECT * FROM discord_servers ORDER BY created_at DESC'
      );
      return res.json(rows);
    } catch (e) { console.error(e); }
  }
  res.json([...memServers].reverse());
});

// ── POST / — сервер нэмэх (нэвтэрсэн хэрэглэгч) ─────────
router.post('/', authMW, async (req, res) => {
  const { name, invite_url, description } = req.body;
  if (!name?.trim())
    return res.status(400).json({ error: 'Серверийн нэр оруулна уу' });
  if (!invite_url || !isValidDiscordInvite(invite_url))
    return res.status(400).json({ error: 'Зөвхөн discord.gg эсвэл discord.com/invite холбоос оруулна уу' });

  const userId   = req.user.id;
  const username = req.user.username;
  const desc     = description?.trim().slice(0, 200) || null;
  const safeName = name.trim().slice(0, 100);
  const safeUrl  = invite_url.trim();

  if (await dbOk()) {
    try {
      // Давхардсан холбоос шалгах
      const dup = await db.query(
        'SELECT id FROM discord_servers WHERE LOWER(invite_url) = LOWER($1)',
        [safeUrl]
      );
      if (dup.rows.length)
        return res.status(409).json({ error: 'Энэ Discord сервер аль хэдийн нэмэгдсэн байна' });

      const { rows } = await db.query(
        `INSERT INTO discord_servers (name, invite_url, description, added_by_id, added_by_username)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [safeName, safeUrl, desc, userId, username]
      );
      return res.status(201).json(rows[0]);
    } catch (e) { console.error(e); }
  }
  // In-memory давхардал шалгах
  if (memServers.some(s => s.invite_url.toLowerCase() === safeUrl.toLowerCase()))
    return res.status(409).json({ error: 'Энэ Discord сервер аль хэдийн нэмэгдсэн байна' });

  const entry = {
    id: memNextId++, name: safeName, invite_url: safeUrl,
    description: desc, added_by_id: userId, added_by_username: username,
    created_at: new Date().toISOString(),
  };
  memServers.push(entry);
  res.status(201).json(entry);
});

// ── PATCH /:id — өөрийнхийг засах ────────────────────────
router.patch('/:id', authMW, async (req, res) => {
  const id     = parseInt(req.params.id);
  const userId = req.user.id;
  const { name, invite_url, description } = req.body;

  if (name !== undefined && !name?.trim())
    return res.status(400).json({ error: 'Серверийн нэр оруулна уу' });
  if (invite_url !== undefined && !isValidDiscordInvite(invite_url))
    return res.status(400).json({ error: 'Зөвхөн discord.gg эсвэл discord.com/invite холбоос оруулна уу' });

  const safeName = name?.trim().slice(0, 100);
  const safeUrl  = invite_url?.trim();
  const desc     = description?.trim().slice(0, 200) ?? undefined;

  if (await dbOk()) {
    try {
      const { rows: existing } = await db.query('SELECT added_by_id FROM discord_servers WHERE id=$1', [id]);
      if (!existing.length) return res.status(404).json({ error: 'Олдсонгүй' });
      if (existing[0].added_by_id !== userId)
        return res.status(403).json({ error: 'Зөвхөн өөрийн оруулсан серверийг засаж болно' });

      // Давхардал шалгах (өөрийнхөөс бусад)
      if (safeUrl) {
        const dup = await db.query(
          'SELECT id FROM discord_servers WHERE LOWER(invite_url)=LOWER($1) AND id<>$2', [safeUrl, id]);
        if (dup.rows.length)
          return res.status(409).json({ error: 'Энэ Discord холбоос аль хэдийн бүртгэлтэй байна' });
      }

      const fields = [];
      const vals   = [];
      let   idx    = 1;
      if (safeName !== undefined) { fields.push(`name=$${idx++}`);        vals.push(safeName); }
      if (safeUrl  !== undefined) { fields.push(`invite_url=$${idx++}`);  vals.push(safeUrl); }
      if (desc     !== undefined) { fields.push(`description=$${idx++}`); vals.push(desc); }
      if (!fields.length) return res.status(400).json({ error: 'Өөрчлөх утга байхгүй' });

      vals.push(id);
      const { rows } = await db.query(
        `UPDATE discord_servers SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`, vals);
      return res.json(rows[0]);
    } catch (e) { console.error(e); }
  }
  // In-memory
  const entry = memServers.find(s => s.id === id);
  if (!entry) return res.status(404).json({ error: 'Олдсонгүй' });
  if (entry.added_by_id !== userId)
    return res.status(403).json({ error: 'Зөвхөн өөрийн оруулсан серверийг засаж болно' });
  if (safeUrl && memServers.some(s => s.id !== id && s.invite_url.toLowerCase() === safeUrl.toLowerCase()))
    return res.status(409).json({ error: 'Энэ Discord холбоос аль хэдийн бүртгэлтэй байна' });
  if (safeName !== undefined) entry.name        = safeName;
  if (safeUrl  !== undefined) entry.invite_url  = safeUrl;
  if (desc     !== undefined) entry.description = desc;
  res.json(entry);
});

// ── DELETE /:id — өөрийнхийг устгах ──────────────────────
router.delete('/:id', authMW, async (req, res) => {
  const id     = parseInt(req.params.id);
  const userId = req.user.id;

  if (await dbOk()) {
    try {
      const { rows } = await db.query('SELECT added_by_id FROM discord_servers WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Олдсонгүй' });
      if (rows[0].added_by_id !== userId)
        return res.status(403).json({ error: 'Зөвхөн өөрийн оруулсан серверийг устгаж болно' });
      await db.query('DELETE FROM discord_servers WHERE id=$1', [id]);
      return res.json({ ok: true });
    } catch (e) { console.error(e); }
  }
  const idx = memServers.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Олдсонгүй' });
  if (memServers[idx].added_by_id !== userId)
    return res.status(403).json({ error: 'Зөвхөн өөрийн оруулсан серверийг устгаж болно' });
  memServers.splice(idx, 1);
  res.json({ ok: true });
});

module.exports = router;
