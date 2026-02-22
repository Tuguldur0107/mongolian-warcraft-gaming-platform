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

// ── Discord Invite Metadata Cache (5 min TTL) ──────────
const inviteCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function extractInviteCode(url) {
  const m = url.match(/(?:discord\.gg|discord\.com\/invite)\/([\w-]+)/);
  return m ? m[1] : null;
}

async function fetchInviteMeta(inviteCode) {
  if (!inviteCode) return null;
  const cached = inviteCache.get(`invite:${inviteCode}`);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  try {
    const res = await fetch(
      `https://discord.com/api/v10/invites/${encodeURIComponent(inviteCode)}?with_counts=true`
    );
    if (!res.ok) return null;
    const json = await res.json();
    const guild = json.guild;
    if (!guild) return null;
    const data = {
      guild_id: guild.id,
      guild_name: guild.name,
      guild_icon: guild.icon,
      member_count: json.approximate_member_count || 0,
      presence_count: json.approximate_presence_count || 0,
    };
    inviteCache.set(`invite:${inviteCode}`, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

// Widget API fallback — guild_id-аар instant_invite авах оролдлого
async function fetchWidgetInvite(guildId) {
  if (!guildId) return null;
  const cached = inviteCache.get(`widget:${guildId}`);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  try {
    const res = await fetch(`https://discord.com/api/guilds/${encodeURIComponent(guildId)}/widget.json`);
    if (!res.ok) return null;
    const json = await res.json();
    const data = {
      guild_id: json.id,
      guild_name: json.name,
      instant_invite: json.instant_invite || null,
      presence_count: json.presence_count || 0,
    };
    inviteCache.set(`widget:${guildId}`, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

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
  // guild_id, guild_icon баганууд нэмэх
  await db.query(`ALTER TABLE discord_servers ADD COLUMN IF NOT EXISTS guild_id VARCHAR(30)`)
    .catch(e => console.error('[Migration] guild_id col:', e.message));
  await db.query(`ALTER TABLE discord_servers ADD COLUMN IF NOT EXISTS guild_icon VARCHAR(100)`)
    .catch(e => console.error('[Migration] guild_icon col:', e.message));
})();

// ── GET / — бүх серверийг авах (+ Discord metadata) ──────
router.get('/', async (req, res) => {
  let servers;
  if (await dbOk()) {
    try {
      const { rows } = await db.query(
        'SELECT * FROM discord_servers ORDER BY created_at DESC'
      );
      servers = rows;
    } catch (e) { console.error(e); servers = [...memServers].reverse(); }
  } else {
    servers = [...memServers].reverse();
  }

  // Enrich with Discord invite metadata (parallel)
  const useDb = await dbOk();
  const enriched = await Promise.all(servers.map(async (s) => {
    const code = extractInviteCode(s.invite_url);
    let meta = await fetchInviteMeta(code);
    let invite_expired = false;

    if (!meta && s.guild_id) {
      // Invite хүчингүй болсон — widget API-аар шинэ invite олох оролдлого
      invite_expired = true;
      const widget = await fetchWidgetInvite(s.guild_id);
      if (widget?.instant_invite) {
        // Шинэ invite олдлоо — DB-д шинэчлэх
        if (useDb) {
          db.query('UPDATE discord_servers SET invite_url=$1 WHERE id=$2', [widget.instant_invite, s.id]).catch(() => {});
        } else {
          const mem = memServers.find(m => m.id === s.id);
          if (mem) mem.invite_url = widget.instant_invite;
        }
        s.invite_url = widget.instant_invite;
        invite_expired = false;
        // Шинэ invite code-оор metadata дахин татах
        const newCode = extractInviteCode(widget.instant_invite);
        meta = await fetchInviteMeta(newCode);
      }
      // Widget-аас icon, нэр авах боломжгүй ч DB-д хадгалсан мэдээлэл ашиглана
      if (!meta && s.guild_id) {
        meta = {
          guild_id: s.guild_id,
          guild_name: null,
          guild_icon: s.guild_icon || null,
          member_count: 0,
          presence_count: 0,
        };
      }
    }

    // DB-д guild_id хадгалаагүй бөгөөд metadata-аас олдвол шинэчлэх
    if (meta && !s.guild_id && meta.guild_id && useDb) {
      db.query('UPDATE discord_servers SET guild_id=$1, guild_icon=$2 WHERE id=$3',
        [meta.guild_id, meta.guild_icon, s.id]).catch(() => {});
    }

    return { ...s, discord_meta: meta || null, invite_expired };
  }));
  res.json(enriched);
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

  // Invite metadata татаж guild_id авах
  const inviteCode = extractInviteCode(safeUrl);
  const meta = await fetchInviteMeta(inviteCode);
  const guildId   = meta?.guild_id || null;
  const guildIcon = meta?.guild_icon || null;

  if (await dbOk()) {
    try {
      // Давхардсан холбоос шалгах (invite_url эсвэл guild_id-аар)
      const dup = await db.query(
        `SELECT id FROM discord_servers WHERE LOWER(invite_url) = LOWER($1)${guildId ? ' OR guild_id = $2' : ''}`,
        guildId ? [safeUrl, guildId] : [safeUrl]
      );
      if (dup.rows.length)
        return res.status(409).json({ error: 'Энэ Discord сервер аль хэдийн нэмэгдсэн байна' });

      const { rows } = await db.query(
        `INSERT INTO discord_servers (name, invite_url, description, added_by_id, added_by_username, guild_id, guild_icon)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [safeName, safeUrl, desc, userId, username, guildId, guildIcon]
      );
      return res.status(201).json(rows[0]);
    } catch (e) { console.error(e); }
  }
  // In-memory давхардал шалгах
  if (memServers.some(s => s.invite_url.toLowerCase() === safeUrl.toLowerCase()
    || (guildId && s.guild_id === guildId)))
    return res.status(409).json({ error: 'Энэ Discord сервер аль хэдийн нэмэгдсэн байна' });

  const entry = {
    id: memNextId++, name: safeName, invite_url: safeUrl,
    description: desc, added_by_id: userId, added_by_username: username,
    guild_id: guildId, guild_icon: guildIcon,
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
      // Invite URL өөрчлөгдвөл guild_id/icon шинэчлэх
      if (safeUrl) {
        const newMeta = await fetchInviteMeta(extractInviteCode(safeUrl));
        if (newMeta) {
          fields.push(`guild_id=$${idx++}`);   vals.push(newMeta.guild_id);
          fields.push(`guild_icon=$${idx++}`);  vals.push(newMeta.guild_icon);
        }
      }
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
