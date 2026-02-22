const express = require('express');
const bcrypt  = require('bcrypt');
const auth    = require('../middleware/auth');
const optAuth = auth.optional;
const strictAuth = auth; // strict — token заавал шаардана

let db;
try { db = require('../config/db'); } catch { db = null; }

async function dbOk() {
  if (!db) return false;
  try { await db.query('SELECT 1'); return true; } catch { return false; }
}

const router = express.Router();

// ── In-memory room store ──────────────────────────────────
// id → { id, name, host_id, host_name, max_players, game_type, status,
//         has_password, password_hash, players: Map<userId, username> }
const memRooms = new Map();
let memNextId  = 1;

// socket.io instance-г routes-д ашиглахын тулд
let _io = null;
function setIO(io) { _io = io; }

function emitRoomsUpdated() {
  if (_io) _io.emit('rooms:updated');
}

function roomToPublic(r) {
  const members = [...r.players.entries()].map(([id, name]) => ({ id: String(id), name }));
  return {
    id:           r.id,
    name:         r.name,
    host_id:      String(r.host_id),
    host_name:    r.host_name,
    max_players:  r.max_players,
    game_type:    r.game_type,
    status:       r.status,
    has_password: r.has_password,
    player_count: r.players.size,
    members,
  };
}

// Хэрэглэгч аль өрөөнд байгааг хайх (in-memory)
function findUserRoom(userId) {
  const uid = String(userId);
  for (const r of memRooms.values()) {
    if ([...r.players.keys()].map(String).includes(uid)) return r;
  }
  return null;
}

// ── GET /rooms — бүх өрөө ────────────────────────────────
router.get('/', optAuth, async (req, res) => {
  if (await dbOk()) {
    try {
      const r = await db.query(`
        SELECT r.id, r.name, r.host_id, u.username AS host_name,
          r.max_players, r.game_type, r.status, r.has_password,
          COUNT(rp.user_id) AS player_count,
          JSON_AGG(JSON_BUILD_OBJECT('id', u2.id::text, 'name', u2.username)
            ORDER BY rp.joined_at) FILTER (WHERE u2.username IS NOT NULL) AS members
        FROM rooms r
        JOIN users u ON r.host_id = u.id
        LEFT JOIN room_players rp ON r.id = rp.room_id
        LEFT JOIN users u2 ON rp.user_id = u2.id
        WHERE r.status IN ('waiting','playing')
        GROUP BY r.id, u.username
        ORDER BY r.created_at DESC
      `);
      return res.json(r.rows.map(row => ({ ...row, members: row.members || [] })));
    } catch (e) { console.error(e); }
  }
  res.json([...memRooms.values()].filter(r => r.status !== 'done').map(roomToPublic));
});

// ── GET /rooms/mine — өөрийн өрөө ────────────────────────
router.get('/mine', optAuth, async (req, res) => {
  if (await dbOk()) {
    try {
      const r = await db.query(`
        SELECT r.id, r.name, r.host_id, u.username AS host_name,
          r.max_players, r.game_type, r.status, r.has_password,
          COUNT(rp2.user_id) AS player_count,
          JSON_AGG(JSON_BUILD_OBJECT('id', u2.id::text, 'name', u2.username)
            ORDER BY rp2.joined_at) FILTER (WHERE u2.username IS NOT NULL) AS members
        FROM rooms r
        JOIN users u ON r.host_id = u.id
        JOIN room_players rp ON r.id = rp.room_id AND rp.user_id = $1
        LEFT JOIN room_players rp2 ON r.id = rp2.room_id
        LEFT JOIN users u2 ON rp2.user_id = u2.id
        WHERE r.status IN ('waiting','playing')
        GROUP BY r.id, u.username
        LIMIT 1
      `, [req.user.id]);
      return res.json(r.rows[0] ? { ...r.rows[0], members: r.rows[0].members || [] } : null);
    } catch (e) { console.error(e); }
  }
  const room = findUserRoom(req.user.id);
  res.json(room ? roomToPublic(room) : null);
});

// ── POST /rooms — шинэ өрөө үүсгэх ──────────────────────
router.post('/', strictAuth, async (req, res) => {
  const { name, max_players = 10, game_type = '', password } = req.body;
  if (!name) return res.status(400).json({ error: 'Өрөөний нэр шаардлагатай' });
  if (!game_type) return res.status(400).json({ error: 'Тоглоомын төрөл шаардлагатай' });

  const has_password  = !!(password?.length);
  const password_hash = has_password ? await bcrypt.hash(password, 8) : null;
  const hostName      = req.user.username || 'Тоглогч';
  const userId        = req.user.id;

  if (await dbOk()) {
    try {
      // Аль хэдийн өрөөнд байгаа эсэх шалгах
      const existing = await db.query(
        `SELECT r.id FROM rooms r
         JOIN room_players rp ON r.id = rp.room_id
         WHERE rp.user_id = $1 AND r.status IN ('waiting','playing') LIMIT 1`,
        [userId]
      );
      if (existing.rows[0])
        return res.status(409).json({ error: 'Та аль хэдийн өрөөнд байна. Эхлээд гарна уу.' });

      const r = await db.query(
        `INSERT INTO rooms (name, host_id, max_players, game_type, has_password, password_hash)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [name, userId, max_players, game_type, has_password, password_hash]
      );
      const room = r.rows[0];
      await db.query('INSERT INTO room_players (room_id, user_id) VALUES ($1,$2)', [room.id, userId]);
      emitRoomsUpdated();
      return res.status(201).json({ ...room, host_name: hostName, members: [{ id: String(userId), name: hostName }], player_count: 1 });
    } catch (e) { console.error(e); }
  }

  // In-memory: аль хэдийн өрөөнд байгаа эсэх
  if (findUserRoom(userId))
    return res.status(409).json({ error: 'Та аль хэдийн өрөөнд байна. Эхлээд гарна уу.' });

  const room = {
    id: String(memNextId++), name,
    host_id: userId, host_name: hostName,
    max_players, game_type, status: 'waiting',
    has_password, password_hash,
    players: new Map([[userId, hostName]]),
  };
  memRooms.set(room.id, room);
  emitRoomsUpdated();
  res.status(201).json(roomToPublic(room));
});

// ── POST /rooms/:id/join ──────────────────────────────────
router.post('/:id/join', strictAuth, async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  const userId = req.user.id;

  if (await dbOk()) {
    try {
      // Аль хэдийн өрөөнд байгаа эсэх
      const already = await db.query(
        `SELECT r.id FROM rooms r
         JOIN room_players rp ON r.id = rp.room_id
         WHERE rp.user_id = $1 AND r.status IN ('waiting','playing') LIMIT 1`,
        [userId]
      );
      if (already.rows[0]) {
        // Яг тэр өрөөнд аль хэдийн байгаа → амжилт буцаана (idempotent)
        if (String(already.rows[0].id) === String(id)) {
          const rr2 = await db.query('SELECT * FROM rooms WHERE id=$1', [id]);
          return res.json({ message: 'Өрөөнд нэгдлээ', room: rr2.rows[0] });
        }
        // Өөр өрөөнд байна → автоматаар гарч, шинэ өрөөнд нэгдэнэ
        const oldId = already.rows[0].id;
        await db.query('DELETE FROM room_players WHERE room_id=$1 AND user_id=$2', [oldId, userId]);
        const oldRoom = await db.query('SELECT host_id FROM rooms WHERE id=$1', [oldId]);
        if (String(oldRoom.rows[0]?.host_id) === String(userId)) {
          await db.query('DELETE FROM rooms WHERE id=$1', [oldId]);
          if (_io) _io.to(String(oldId)).emit('room:closed', { reason: 'Өрөөний эзэн гарлаа' });
        }
        emitRoomsUpdated();
      }

      const rr = await db.query('SELECT * FROM rooms WHERE id = $1', [id]);
      const room = rr.rows[0];
      if (!room)                  return res.status(404).json({ error: 'Өрөө олдсонгүй' });
      if (room.status === 'done') return res.status(400).json({ error: 'Өрөө дууссан байна' });
      if (room.has_password) {
        if (!password)            return res.status(403).json({ error: 'Нууц үг шаардлагатай', need_password: true });
        const ok = await bcrypt.compare(password, room.password_hash);
        if (!ok)                  return res.status(403).json({ error: 'Нууц үг буруу' });
      }
      const cnt = await db.query('SELECT COUNT(*) FROM room_players WHERE room_id=$1', [id]);
      if (parseInt(cnt.rows[0].count) >= room.max_players)
        return res.status(400).json({ error: 'Өрөө дүүрсэн байна' });
      await db.query('INSERT INTO room_players (room_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, userId]);
      emitRoomsUpdated();
      return res.json({ message: 'Өрөөнд нэгдлээ', room });
    } catch (e) {
      console.error('[Join]', e);
      return res.status(500).json({ error: 'Серверийн алдаа гарлаа' });
    }
  }

  // In-memory
  if (findUserRoom(userId))
    return res.status(409).json({ error: 'Та аль хэдийн өрөөнд байна. Эхлээд гарна уу.' });

  const room = memRooms.get(id);
  if (!room) return res.status(404).json({ error: 'Өрөө олдсонгүй' });
  if (room.has_password) {
    if (!password) return res.status(403).json({ error: 'Нууц үг шаардлагатай', need_password: true });
    const ok = await bcrypt.compare(password, room.password_hash);
    if (!ok) return res.status(403).json({ error: 'Нууц үг буруу' });
  }
  if (room.players.size >= room.max_players)
    return res.status(400).json({ error: 'Өрөө дүүрсэн байна' });
  room.players.set(userId, req.user.username || 'Тоглогч');
  res.json({ message: 'Өрөөнд нэгдлээ', room: roomToPublic(room) });
});

// ── POST /rooms/:id/leave ─────────────────────────────────
router.post('/:id/leave', strictAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  if (await dbOk()) {
    try {
      await db.query('DELETE FROM room_players WHERE room_id=$1 AND user_id=$2', [id, userId]);
      const rr = await db.query('SELECT * FROM rooms WHERE id=$1', [id]);
      if (rr.rows[0]?.host_id === userId || String(rr.rows[0]?.host_id) === String(userId)) {
        await db.query('DELETE FROM rooms WHERE id=$1', [id]);
        if (_io) _io.to(id).emit('room:closed', { reason: 'Өрөөний эзэн гарлаа' });
        emitRoomsUpdated();
        return res.json({ message: 'Өрөө устгагдлаа' });
      }
      emitRoomsUpdated();
      return res.json({ message: 'Өрөөнөөс гарлаа' });
    } catch (e) { console.error(e); }
  }
  const room = memRooms.get(id);
  if (room) {
    room.players.delete(userId);
    if (String(room.host_id) === String(userId)) {
      memRooms.delete(id);
      if (_io) _io.to(id).emit('room:closed', { reason: 'Өрөөний эзэн гарлаа' });
    }
  }
  res.json({ message: 'Өрөөнөөс гарлаа' });
});

// ── DELETE /rooms/:id — өрөөг хаах (эзэн л хийж болно) ──
router.delete('/:id', strictAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  if (await dbOk()) {
    try {
      const rr = await db.query('SELECT host_id FROM rooms WHERE id=$1', [id]);
      if (!rr.rows[0]) return res.status(404).json({ error: 'Өрөө олдсонгүй' });
      if (String(rr.rows[0].host_id) !== String(userId))
        return res.status(403).json({ error: 'Зөвхөн өрөөний эзэн хаах эрхтэй' });
      await db.query('DELETE FROM rooms WHERE id=$1', [id]);
      if (_io) _io.to(id).emit('room:closed', { reason: 'Өрөөний эзэн өрөөг хаалаа' });
      emitRoomsUpdated();
      return res.json({ message: 'Өрөө хаагдлаа' });
    } catch (e) { console.error(e); }
  }
  const room = memRooms.get(id);
  if (!room) return res.status(404).json({ error: 'Өрөө олдсонгүй' });
  if (String(room.host_id) !== String(userId))
    return res.status(403).json({ error: 'Зөвхөн өрөөний эзэн хаах эрхтэй' });
  memRooms.delete(id);
  if (_io) _io.to(id).emit('room:closed', { reason: 'Өрөөний эзэн өрөөг хаалаа' });
  res.json({ message: 'Өрөө хаагдлаа' });
});

// ── POST /rooms/:id/kick/:userId — тоглогч kick ──────────
router.post('/:id/kick/:targetId', strictAuth, async (req, res) => {
  const { id, targetId } = req.params;
  const userId = req.user.id;

  if (await dbOk()) {
    try {
      const rr = await db.query('SELECT host_id FROM rooms WHERE id=$1', [id]);
      if (!rr.rows[0]) return res.status(404).json({ error: 'Өрөө олдсонгүй' });
      if (String(rr.rows[0].host_id) !== String(userId))
        return res.status(403).json({ error: 'Зөвхөн өрөөний эзэн kick хийж болно' });
      if (String(targetId) === String(userId))
        return res.status(400).json({ error: 'Өөрийгөө kick хийж болохгүй' });
      await db.query('DELETE FROM room_players WHERE room_id=$1 AND user_id=$2', [id, targetId]);
      if (_io) _io.to(id).emit('room:kicked', { userId: String(targetId) });
      return res.json({ message: 'Тоглогч гаргагдлаа' });
    } catch (e) { console.error(e); }
  }
  const room = memRooms.get(id);
  if (!room) return res.status(404).json({ error: 'Өрөө олдсонгүй' });
  if (String(room.host_id) !== String(userId))
    return res.status(403).json({ error: 'Зөвхөн өрөөний эзэн kick хийж болно' });
  room.players.delete(targetId);
  if (_io) _io.to(id).emit('room:kicked', { userId: String(targetId) });
  res.json({ message: 'Тоглогч гаргагдлаа' });
});

// ── POST /rooms/:id/start ─────────────────────────────────
router.post('/:id/start', strictAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  if (await dbOk()) {
    try {
      await db.query("UPDATE rooms SET status='playing' WHERE id=$1 AND host_id=$2", [id, userId]);
      if (_io) _io.to(id).emit('room:started');
      emitRoomsUpdated();
      return res.json({ message: 'Тоглолт эхэллээ' });
    } catch (e) { console.error(e); }
  }
  const room = memRooms.get(id);
  if (room && String(room.host_id) === String(userId)) {
    room.status = 'playing';
    if (_io) _io.to(id).emit('room:started');
  }
  res.json({ message: 'Тоглолт эхэллээ' });
});

// ── PATCH /rooms/:id — Өрөөний тохиргоо засах (эзэн) ────
router.patch('/:id', strictAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const { name, max_players, password } = req.body;

  if (await dbOk()) {
    try {
      const rr = await db.query('SELECT host_id FROM rooms WHERE id=$1', [id]);
      if (!rr.rows[0]) return res.status(404).json({ error: 'Өрөө олдсонгүй' });
      if (String(rr.rows[0].host_id) !== String(userId))
        return res.status(403).json({ error: 'Зөвхөн өрөөний эзэн тохиргоо өөрчилж болно' });

      const updates = [];
      const params  = [];
      if (name && name.trim()) {
        params.push(name.trim()); updates.push(`name=$${params.length}`);
      }
      if (max_players && Number.isInteger(Number(max_players)) && Number(max_players) > 0) {
        params.push(Number(max_players)); updates.push(`max_players=$${params.length}`);
      }
      if (password !== undefined) {
        if (password === null || password === '') {
          updates.push('has_password=FALSE', 'password_hash=NULL');
        } else {
          const hash = await bcrypt.hash(password, 8);
          params.push(true, hash);
          updates.push(`has_password=$${params.length - 1}`, `password_hash=$${params.length}`);
        }
      }
      if (updates.length > 0) {
        params.push(id);
        await db.query(`UPDATE rooms SET ${updates.join(',')} WHERE id=$${params.length}`, params);
      }
      const updated = await db.query('SELECT * FROM rooms WHERE id=$1', [id]);
      if (_io) _io.to(id).emit('room:updated', updated.rows[0]);
      return res.json({ ok: true, room: updated.rows[0] });
    } catch (e) { console.error(e); }
  }
  // In-memory fallback
  const room = memRooms.get(id);
  if (!room) return res.status(404).json({ error: 'Өрөө олдсонгүй' });
  if (String(room.host_id) !== String(userId)) return res.status(403).json({ error: 'Зөвхөн эзэн өөрчилж болно' });
  if (name) room.name = name.trim();
  if (max_players) room.max_players = Number(max_players);
  if (_io) _io.to(id).emit('room:updated', roomToPublic(room));
  res.json({ ok: true, room: roomToPublic(room) });
});

// ── POST /rooms/quickmatch ────────────────────────────────
router.post('/quickmatch', strictAuth, async (req, res) => {
  const { game_type } = req.body;
  if (!game_type) return res.status(400).json({ error: 'game_type шаардлагатай' });
  const userId   = req.user.id;
  const hostName = req.user.username || 'Тоглогч';

  if (await dbOk()) {
    try {
      // Тухайн game_type-тай, нууц үггүй, waiting, дүүрээгүй өрөө хайх
      const available = await db.query(`
        SELECT r.id, COUNT(rp.user_id) AS player_count
        FROM rooms r
        LEFT JOIN room_players rp ON r.id = rp.room_id
        WHERE r.status='waiting' AND r.has_password=FALSE AND r.game_type=$1
        GROUP BY r.id
        HAVING COUNT(rp.user_id) < r.max_players
        ORDER BY player_count DESC
        LIMIT 1
      `, [game_type]);

      if (available.rows[0]) {
        const roomId = available.rows[0].id;
        await db.query('INSERT INTO room_players (room_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [roomId, userId]);
        const rr = await db.query(`
          SELECT r.id, r.name, r.host_id, u.username AS host_name,
            r.max_players, r.game_type, r.status, r.has_password,
            COUNT(rp.user_id) AS player_count,
            JSON_AGG(JSON_BUILD_OBJECT('id', u2.id::text, 'name', u2.username)
              ORDER BY rp.joined_at) FILTER (WHERE u2.username IS NOT NULL) AS members
          FROM rooms r JOIN users u ON r.host_id=u.id
          LEFT JOIN room_players rp ON r.id=rp.room_id
          LEFT JOIN users u2 ON rp.user_id=u2.id
          WHERE r.id=$1 GROUP BY r.id, u.username
        `, [roomId]);
        return res.json({ joined: true, room: { ...rr.rows[0], members: rr.rows[0].members || [] } });
      }

      // Шинэ өрөө үүсгэх
      const qname = `Quick Match #${Math.floor(Math.random() * 9000) + 1000}`;
      const r = await db.query(
        `INSERT INTO rooms (name, host_id, max_players, game_type, has_password) VALUES ($1,$2,10,$3,FALSE) RETURNING *`,
        [qname, userId, game_type]
      );
      const room = r.rows[0];
      await db.query('INSERT INTO room_players (room_id, user_id) VALUES ($1,$2)', [room.id, userId]);
      return res.status(201).json({ joined: false, room: { ...room, host_name: hostName, members: [{ id: String(userId), name: hostName }], player_count: 1 } });
    } catch (e) { console.error(e); return res.status(500).json({ error: 'Серверийн алдаа' }); }
  }
  res.status(503).json({ error: 'DB байхгүй' });
});

// ── PATCH /rooms/:id/team — Баг солих ────────────────────
router.patch('/:id/team', strictAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const team   = Number(req.body.team);
  if (![1, 2].includes(team)) return res.status(400).json({ error: 'team 1 эсвэл 2 байх ёстой' });

  if (await dbOk()) {
    try {
      const rr = await db.query('SELECT max_players FROM rooms WHERE id=$1', [id]);
      if (!rr.rows[0]) return res.status(404).json({ error: 'Өрөө олдсонгүй' });
      // Тухайн багийн гишүүний тоо шалгах
      const cnt = await db.query(
        'SELECT COUNT(*) FROM room_players WHERE room_id=$1 AND team=$2',
        [id, team]
      );
      const max = Math.ceil(rr.rows[0].max_players / 2);
      if (parseInt(cnt.rows[0].count) >= max)
        return res.status(400).json({ error: 'Баг дүүрсэн байна' });
      await db.query('UPDATE room_players SET team=$1 WHERE room_id=$2 AND user_id=$3', [team, id, userId]);
      if (_io) _io.to(id).emit('room:team_changed', { userId: String(userId), team });
      return res.json({ ok: true, team });
    } catch (e) { console.error(e); }
  }
  res.json({ ok: true });
});

module.exports = router;
module.exports.setIO = setIO;
