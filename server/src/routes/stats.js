const express = require('express');
const axios = require('axios');
const auth = require('../middleware/auth');

let db;
try { db = require('../config/db'); } catch { db = null; }

async function dbAvailable() {
  if (!db) return false;
  try { await db.query('SELECT 1'); return true; } catch { return false; }
}

const router = express.Router();

// RZR Bot-руу үр дүн илгээх
async function notifyRZRBot(payload) {
  const rzrUrl = process.env.RZR_BOT_URL;
  const secret = process.env.WEBHOOK_SECRET;
  if (!rzrUrl) return;

  try {
    await axios.post(`${rzrUrl}/api/game_result`, payload, {
      headers: { 'X-Secret': secret || '' },
      timeout: 10000,
    });
    console.log('RZR Bot-д мэдэгдэл илгээгдлээ');
  } catch (err) {
    console.error('RZR Bot мэдэгдэл алдаа:', err.message);
  }
}

// Тоглогчийн статистик — discord_id-гаар
router.get('/player/:discord_id', async (req, res) => {
  const { discord_id } = req.params;
  if (await dbAvailable()) {
    try {
      const result = await db.query(
        'SELECT id, username, avatar_url, wins, losses, created_at FROM users WHERE discord_id = $1',
        [discord_id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Тоглогч олдсонгүй' });
      const user = result.rows[0];
      const total = user.wins + user.losses;
      const winrate = total > 0 ? ((user.wins / total) * 100).toFixed(1) : 0;
      return res.json({ ...user, total_games: total, winrate: `${winrate}%` });
    } catch (err) { console.error(err); }
  }
  res.status(404).json({ error: 'Тоглогч олдсонгүй (DB холбогдоогүй)' });
});

// Тоглогчийн статистик — user_id-гаар
router.get('/player/id/:userId', async (req, res) => {
  const { userId } = req.params;
  if (await dbAvailable()) {
    try {
      const result = await db.query(
        'SELECT id, username, avatar_url, wins, losses, created_at FROM users WHERE id = $1',
        [userId]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Тоглогч олдсонгүй' });
      const user = result.rows[0];
      const total = user.wins + user.losses;
      const winrate = total > 0 ? ((user.wins / total) * 100).toFixed(1) : 0;
      return res.json({ ...user, total_games: total, winrate: `${winrate}%` });
    } catch (err) { console.error(err); }
  }
  res.status(404).json({ error: 'Тоглогч олдсонгүй' });
});

// Тоглоомын түүх
router.get('/history/:userId', async (req, res) => {
  const { userId } = req.params;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;

  if (await dbAvailable()) {
    try {
      // game_players table байгаа эсэх шалгах
      const tableCheck = await db.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name='game_players'`
      );
      if (!tableCheck.rows[0]) return res.json({ games: [], total: 0, page: 1, totalPages: 0 });

      const result = await db.query(`
        SELECT gr.id, gr.winner_team, gr.duration_minutes, gr.played_at,
          gp.team, gp.is_winner,
          r.name AS room_name, r.game_type
        FROM game_players gp
        JOIN game_results gr ON gp.game_result_id = gr.id
        LEFT JOIN rooms r ON gr.room_id = r.id
        WHERE gp.user_id = $1
        ORDER BY gr.played_at DESC
        LIMIT $2 OFFSET $3
      `, [userId, limit, offset]);

      const countResult = await db.query(
        'SELECT COUNT(*) FROM game_players WHERE user_id = $1', [userId]
      );
      return res.json({
        games: result.rows,
        total: parseInt(countResult.rows[0].count),
        page,
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
      });
    } catch (err) { console.error(err); }
  }
  res.json({ games: [], total: 0, page: 1, totalPages: 0 });
});

// Шилдэг тоглогчид (pagination + sort)
router.get('/ranking', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const sortBy = req.query.sort || 'wins';

  const allowedSorts = {
    wins:        'wins DESC',
    winrate:     'CASE WHEN (wins+losses)>0 THEN wins::DECIMAL/(wins+losses) ELSE 0 END DESC',
    total_games: '(wins+losses) DESC',
  };
  const orderClause = allowedSorts[sortBy] || allowedSorts.wins;

  if (await dbAvailable()) {
    try {
      const result = await db.query(`
        SELECT id, username, avatar_url, wins, losses,
          CASE WHEN (wins+losses)>0
            THEN ROUND((wins::DECIMAL/(wins+losses))*100, 1)
            ELSE 0
          END AS winrate
        FROM users
        WHERE (wins + losses) > 0
        ORDER BY ${orderClause}
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      const countResult = await db.query(
        'SELECT COUNT(*) FROM users WHERE (wins+losses) > 0'
      );

      return res.json({
        players:    result.rows,
        total:      parseInt(countResult.rows[0].count),
        page,
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
      });
    } catch (err) { console.error(err); }
  }
  res.json({ players: [], total: 0, page: 1, totalPages: 0 });
});

// Replay parse хийсний дараа үр дүн хадгалах (зөвхөн өрөөний эзэн)
router.post('/result', auth, async (req, res) => {
  const { room_id, winner_team, duration_minutes, replay_path, players } = req.body;

  if (!winner_team || !Array.isArray(players) || players.length === 0) {
    return res.status(400).json({ error: 'Мэдээлэл дутуу байна' });
  }
  if (![1, 2].includes(Number(winner_team))) {
    return res.status(400).json({ error: 'winner_team 1 эсвэл 2 байх ёстой' });
  }

  // room_id байгаа бол room membership болон host шалгах
  if (room_id) {
    try {
      // Тухайн хэрэглэгч өрөөний гишүүн эсэх
      const membership = await db.query(
        'SELECT 1 FROM room_players WHERE room_id=$1 AND user_id=$2',
        [room_id, req.user.id]
      );
      if (!membership.rows[0])
        return res.status(403).json({ error: 'Энэ өрөөний гишүүн биш байна' });

      // Зөвхөн эзэн үр дүн бичих эрхтэй
      const room = await db.query('SELECT host_id, status FROM rooms WHERE id=$1', [room_id]);
      if (!room.rows[0])
        return res.status(404).json({ error: 'Өрөө олдсонгүй' });
      if (String(room.rows[0].host_id) !== String(req.user.id))
        return res.status(403).json({ error: 'Зөвхөн өрөөний эзэн үр дүн бичих эрхтэй' });
      if (room.rows[0].status !== 'playing')
        return res.status(400).json({ error: 'Тоглолт эхлээгүй өрөөнд үр дүн бичих боломжгүй' });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Серверийн алдаа' });
    }
  }

  try {
    // Үр дүн хадгалах
    const resultRow = await db.query(
      `INSERT INTO game_results (room_id, winner_team, duration_minutes, replay_path)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [room_id || null, winner_team, duration_minutes, replay_path]
    );

    // Тоглогчдын win/loss шинэчлэх + game_players-д бичих
    const ALLOWED_COLUMNS = ['wins', 'losses'];
    const gameResultId = resultRow.rows[0].id;
    for (const player of players) {
      const isWinner = Number(player.team) === Number(winner_team);
      const column   = isWinner ? 'wins' : 'losses';
      if (!ALLOWED_COLUMNS.includes(column)) continue;

      let resolvedUserId = player.user_id || null;

      if (resolvedUserId) {
        await db.query(
          `UPDATE users SET ${column} = ${column} + 1 WHERE id = $1`,
          [resolvedUserId]
        );
      } else if (player.discord_id && typeof player.discord_id === 'string') {
        const uRow = await db.query(
          `UPDATE users SET ${column} = ${column} + 1 WHERE discord_id = $1 RETURNING id`,
          [player.discord_id]
        );
        resolvedUserId = uRow.rows[0]?.id || null;
      }

      // game_players-д хадгалах (user_id байгаа бол)
      if (resolvedUserId) {
        await db.query(
          `INSERT INTO game_players (game_result_id, user_id, team, is_winner)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [gameResultId, resolvedUserId, player.team, isWinner]
        );
      }
    }

    // Өрөөний статус дуусгах
    if (room_id) {
      await db.query("UPDATE rooms SET status = 'done' WHERE id = $1", [room_id]);
    }

    // RZR Bot-д мэдэгдэх (оноо шинэчлэх + Discord нийтлэх)
    await notifyRZRBot({ winner_team, duration_minutes, players });

    res.status(201).json({
      message: 'Үр дүн хадгалагдлаа',
      result: resultRow.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Серверийн алдаа' });
  }
});

module.exports = router;
