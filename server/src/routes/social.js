const express = require('express');
const authMW  = require('../middleware/auth');

let db;
try { db = require('../config/db'); } catch { db = null; }

async function dbOk() {
  if (!db) return false;
  try { await db.query('SELECT 1'); return true; } catch { return false; }
}

const router = express.Router();
let _io = null;

// ── In-memory stores ────────────────────────────────────────
// String(userId) → Set of String(friendId)  (хоёр талдаа хадгална)
const memFriends = new Map();
// String(receiverId) → Map of String(senderId) → { id, username, avatar_url }
const memPendingReceived = new Map();
// String(userId) → Set of String(blockedUserId)
const memBlocked = new Map();

function getSet(map, key) {
  if (!map.has(String(key))) map.set(String(key), new Set());
  return map.get(String(key));
}
function getMap(map, key) {
  if (!map.has(String(key))) map.set(String(key), new Map());
  return map.get(String(key));
}

function areFriends(id1, id2) {
  return getSet(memFriends, id1).has(String(id2));
}
function isBlocked(userId, targetId) {
  return getSet(memBlocked, userId).has(String(targetId));
}

// ── DB хүснэгт автоматаар үүсгэх ───────────────────────────
async function initTables() {
  if (!await dbOk()) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS friendships (
        id           SERIAL PRIMARY KEY,
        requester_id INTEGER NOT NULL,
        receiver_id  INTEGER NOT NULL,
        status       VARCHAR(20) DEFAULT 'pending',
        created_at   TIMESTAMP DEFAULT NOW(),
        UNIQUE(requester_id, receiver_id)
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS blocked_users (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER NOT NULL,
        blocked_user_id INTEGER NOT NULL,
        created_at      TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, blocked_user_id)
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id          SERIAL PRIMARY KEY,
        sender_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        text        TEXT NOT NULL,
        is_read     BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id), created_at DESC)
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_unread
        ON messages(receiver_id, is_read) WHERE is_read = FALSE
    `);
  } catch (e) { console.error('[Social] Хүснэгт үүсгэхэд алдаа:', e.message); }
}
initTables();

// ── io тохируулах (index.js-аас дуудагдана) ────────────────
function setIO(io) { _io = io; }

// ── Хэрэглэгч хаасан эсэх шалгах (index.js ашиглана) ────────
function isUserBlocked(receiverId, senderId) {
  return getSet(memBlocked, receiverId).has(String(senderId));
}

// ── GET /social/friends — Найзуудын жагсаалт ───────────────
router.get('/friends', authMW, async (req, res) => {
  const myId = req.user.id;
  if (await dbOk()) {
    try {
      const r = await db.query(`
        SELECT u.id, u.username, u.avatar_url
        FROM friendships f
        JOIN users u ON (
          CASE WHEN f.requester_id=$1 THEN f.receiver_id ELSE f.requester_id END = u.id
        )
        WHERE (f.requester_id=$1 OR f.receiver_id=$1) AND f.status='accepted'
        ORDER BY u.username
      `, [myId]);
      return res.json(r.rows);
    } catch (e) { console.error(e); }
  }
  const ids = [...getSet(memFriends, myId)];
  res.json(ids.map(id => ({ id: parseInt(id), username: `Хэрэглэгч#${id}`, avatar_url: null })));
});

// ── GET /social/pending — Хүлээгдэж буй найз хүсэлтүүд ─────
router.get('/pending', authMW, async (req, res) => {
  const myId = req.user.id;
  if (await dbOk()) {
    try {
      const r = await db.query(`
        SELECT u.id, u.username, u.avatar_url, f.created_at
        FROM friendships f
        JOIN users u ON f.requester_id = u.id
        WHERE f.receiver_id=$1 AND f.status='pending'
        ORDER BY f.created_at DESC
      `, [myId]);
      return res.json(r.rows);
    } catch (e) { console.error(e); }
  }
  const pending = getMap(memPendingReceived, myId);
  res.json([...pending.values()]);
});

// ── POST /social/friend/request — Найз хүсэлт илгээх ───────
router.post('/friend/request', authMW, async (req, res) => {
  const myId   = req.user.id;
  const { toUserId } = req.body;
  if (!toUserId) return res.status(400).json({ error: 'toUserId шаардлагатай' });
  if (String(toUserId) === String(myId)) return res.status(400).json({ error: 'Өөртөө найз хүсэлт илгээх боломжгүй' });

  if (await dbOk()) {
    try {
      const exists = await db.query(
        `SELECT id, status FROM friendships WHERE (requester_id=$1 AND receiver_id=$2) OR (requester_id=$2 AND receiver_id=$1)`,
        [myId, toUserId]
      );
      if (exists.rows[0]) {
        if (exists.rows[0].status === 'accepted') return res.status(409).json({ error: 'Та нар аль хэдийн найз байна' });
        return res.status(409).json({ error: 'Хүсэлт аль хэдийн илгээгдсэн байна' });
      }
      const userRow = await db.query('SELECT username, avatar_url FROM users WHERE id=$1', [myId]);
      await db.query(
        `INSERT INTO friendships (requester_id, receiver_id, status) VALUES ($1,$2,'pending')`,
        [myId, toUserId]
      );
      // Socket мэдэгдэл
      if (_io) {
        _io.to(`user:${toUserId}`).emit('friend:request', {
          fromUserId: myId,
          fromUsername: userRow.rows[0]?.username || req.user.username,
          fromAvatarUrl: userRow.rows[0]?.avatar_url || req.user.avatar_url,
        });
      }
      return res.json({ ok: true });
    } catch (e) { console.error(e); }
  }

  if (areFriends(myId, toUserId)) return res.status(409).json({ error: 'Та нар аль хэдийн найз байна' });
  const pending = getMap(memPendingReceived, toUserId);
  if (pending.has(String(myId))) return res.status(409).json({ error: 'Хүсэлт аль хэдийн илгээгдсэн байна' });
  pending.set(String(myId), { id: myId, username: req.user.username, avatar_url: req.user.avatar_url || null });
  if (_io) {
    _io.to(`user:${toUserId}`).emit('friend:request', {
      fromUserId: myId,
      fromUsername: req.user.username,
      fromAvatarUrl: req.user.avatar_url || null,
    });
  }
  res.json({ ok: true });
});

// ── POST /social/friend/accept — Найз хүсэлт зөвшөөрөх ─────
router.post('/friend/accept', authMW, async (req, res) => {
  const myId = req.user.id;
  const { fromUserId } = req.body;
  if (!fromUserId) return res.status(400).json({ error: 'fromUserId шаардлагатай' });

  if (await dbOk()) {
    try {
      const r = await db.query(
        `UPDATE friendships SET status='accepted' WHERE requester_id=$1 AND receiver_id=$2 AND status='pending' RETURNING id`,
        [fromUserId, myId]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'Хүсэлт олдсонгүй' });
      if (_io) {
        _io.to(`user:${fromUserId}`).emit('friend:accepted', {
          byUserId: myId,
          byUsername: req.user.username,
        });
      }
      return res.json({ ok: true });
    } catch (e) { console.error(e); }
  }

  const pending = getMap(memPendingReceived, myId);
  if (!pending.has(String(fromUserId))) return res.status(404).json({ error: 'Хүсэлт олдсонгүй' });
  pending.delete(String(fromUserId));
  getSet(memFriends, myId).add(String(fromUserId));
  getSet(memFriends, fromUserId).add(String(myId));
  if (_io) {
    _io.to(`user:${fromUserId}`).emit('friend:accepted', {
      byUserId: myId,
      byUsername: req.user.username,
    });
  }
  res.json({ ok: true });
});

// ── POST /social/friend/decline — Найз хүсэлт татгалзах ────
router.post('/friend/decline', authMW, async (req, res) => {
  const myId = req.user.id;
  const { fromUserId } = req.body;
  if (!fromUserId) return res.status(400).json({ error: 'fromUserId шаардлагатай' });

  if (await dbOk()) {
    try {
      await db.query(
        `DELETE FROM friendships WHERE requester_id=$1 AND receiver_id=$2 AND status='pending'`,
        [fromUserId, myId]
      );
      return res.json({ ok: true });
    } catch (e) { console.error(e); }
  }

  getMap(memPendingReceived, myId).delete(String(fromUserId));
  res.json({ ok: true });
});

// ── POST /social/friend/remove — Найзаас хасах ─────────────
router.post('/friend/remove', authMW, async (req, res) => {
  const myId = req.user.id;
  const { friendId } = req.body;
  if (!friendId) return res.status(400).json({ error: 'friendId шаардлагатай' });

  if (await dbOk()) {
    try {
      await db.query(
        `DELETE FROM friendships WHERE (requester_id=$1 AND receiver_id=$2) OR (requester_id=$2 AND receiver_id=$1)`,
        [myId, friendId]
      );
      return res.json({ ok: true });
    } catch (e) { console.error(e); }
  }

  getSet(memFriends, myId).delete(String(friendId));
  getSet(memFriends, friendId).delete(String(myId));
  res.json({ ok: true });
});

// ── POST /social/block — Хэрэглэгч хаах ────────────────────
router.post('/block', authMW, async (req, res) => {
  const myId = req.user.id;
  const { targetUserId } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId шаардлагатай' });

  if (await dbOk()) {
    try {
      await db.query(
        `DELETE FROM friendships WHERE (requester_id=$1 AND receiver_id=$2) OR (requester_id=$2 AND receiver_id=$1)`,
        [myId, targetUserId]
      );
      await db.query(
        `INSERT INTO blocked_users (user_id, blocked_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [myId, targetUserId]
      );
      return res.json({ ok: true });
    } catch (e) { console.error(e); }
  }

  // Найзлалт устгах
  getSet(memFriends, myId).delete(String(targetUserId));
  getSet(memFriends, targetUserId).delete(String(myId));
  getMap(memPendingReceived, myId).delete(String(targetUserId));
  getMap(memPendingReceived, targetUserId).delete(String(myId));
  getSet(memBlocked, myId).add(String(targetUserId));
  res.json({ ok: true });
});

// ── POST /social/unblock — Хаалтыг арилгах ─────────────────
router.post('/unblock', authMW, async (req, res) => {
  const myId = req.user.id;
  const { targetUserId } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId шаардлагатай' });

  if (await dbOk()) {
    try {
      await db.query(
        `DELETE FROM blocked_users WHERE user_id=$1 AND blocked_user_id=$2`,
        [myId, targetUserId]
      );
      return res.json({ ok: true });
    } catch (e) { console.error(e); }
  }

  getSet(memBlocked, myId).delete(String(targetUserId));
  res.json({ ok: true });
});

// ── GET /social/blocked — Хаасан хэрэглэгчдийн жагсаалт ───
router.get('/blocked', authMW, async (req, res) => {
  const myId = req.user.id;
  if (await dbOk()) {
    try {
      const r = await db.query(`
        SELECT u.id, u.username, u.avatar_url
        FROM blocked_users b
        JOIN users u ON b.blocked_user_id = u.id
        WHERE b.user_id=$1
        ORDER BY u.username
      `, [myId]);
      return res.json(r.rows);
    } catch (e) { console.error(e); }
  }
  const ids = [...getSet(memBlocked, myId)];
  res.json(ids.map(id => ({ id: parseInt(id), username: `Хэрэглэгч#${id}`, avatar_url: null })));
});

// ── GET /social/search — Хэрэглэгч хайх ───────────────────
router.get('/search', authMW, async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Хамгийн багадаа 2 тэмдэгт оруулна уу' });
  if (await dbOk()) {
    try {
      const r = await db.query(
        `SELECT id, username, avatar_url FROM users
         WHERE LOWER(username) LIKE LOWER($1) AND id != $2
         ORDER BY username LIMIT 20`,
        [`%${q.trim()}%`, req.user.id]
      );
      return res.json(r.rows);
    } catch (e) { console.error(e); }
  }
  res.json([]);
});

// ── GET /social/messages/:userId — DM түүх ─────────────────
router.get('/messages/:userId', authMW, async (req, res) => {
  const myId     = req.user.id;
  const otherId  = parseInt(req.params.userId);
  const before   = req.query.before ? parseInt(req.query.before) : null;
  if (!otherId) return res.status(400).json({ error: 'userId шаардлагатай' });

  if (await dbOk()) {
    try {
      const whereClause = before
        ? 'AND m.id < $3'
        : '';
      const params = before
        ? [myId, otherId, before]
        : [myId, otherId];
      const r = await db.query(`
        SELECT m.id, m.sender_id, m.receiver_id, m.text, m.is_read, m.created_at,
          u.username AS sender_username
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        WHERE (
          (m.sender_id=$1 AND m.receiver_id=$2) OR
          (m.sender_id=$2 AND m.receiver_id=$1)
        ) ${whereClause}
        ORDER BY m.created_at DESC
        LIMIT 50
      `, params);
      return res.json(r.rows.reverse()); // хуучнаас шинэ дараалал
    } catch (e) { console.error(e); }
  }
  res.json([]);
});

// ── GET /social/unread — Уншаагүй мессежийн тоо ────────────
router.get('/unread', authMW, async (req, res) => {
  const myId = req.user.id;
  if (await dbOk()) {
    try {
      const r = await db.query(`
        SELECT sender_id, COUNT(*) AS count
        FROM messages
        WHERE receiver_id=$1 AND is_read=FALSE
        GROUP BY sender_id
      `, [myId]);
      // { [senderId]: count } хэлбэрт хөрвүүлэх
      const result = {};
      r.rows.forEach(row => { result[String(row.sender_id)] = parseInt(row.count); });
      return res.json(result);
    } catch (e) { console.error(e); }
  }
  res.json({});
});

// ── POST /social/messages/read — Мессеж уншсан тэмдэглэх ───
router.post('/messages/read', authMW, async (req, res) => {
  const myId = req.user.id;
  const { fromUserId } = req.body;
  if (!fromUserId) return res.status(400).json({ error: 'fromUserId шаардлагатай' });

  if (await dbOk()) {
    try {
      await db.query(
        'UPDATE messages SET is_read=TRUE WHERE receiver_id=$1 AND sender_id=$2 AND is_read=FALSE',
        [myId, fromUserId]
      );
      return res.json({ ok: true });
    } catch (e) { console.error(e); }
  }
  res.json({ ok: true });
});

// ── saveMessage — index.js-аас дуудах helper ───────────────
async function saveMessage(senderId, receiverId, text) {
  if (!await dbOk()) return null;
  try {
    const r = await db.query(
      'INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1, $2, $3) RETURNING id, created_at',
      [senderId, receiverId, text]
    );
    return r.rows[0];
  } catch (e) {
    console.error('[saveMessage]', e.message);
    return null;
  }
}

module.exports = router;
module.exports.setIO         = setIO;
module.exports.isUserBlocked = isUserBlocked;
module.exports.saveMessage   = saveMessage;
