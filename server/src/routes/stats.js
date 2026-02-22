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

// Тоглогчийн статистик харах
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
    } catch (err) {
      console.error(err);
    }
  }
  // DB байхгүй үед
  res.status(404).json({ error: 'Тоглогч олдсонгүй (DB холбогдоогүй)' });
});

// Шилдэг тоглогчид (Top 10)
router.get('/ranking', async (req, res) => {
  if (await dbAvailable()) {
    try {
      const result = await db.query(`
        SELECT id, username, avatar_url, wins, losses,
          CASE WHEN (wins + losses) > 0
            THEN ROUND((wins::DECIMAL / (wins + losses)) * 100, 1)
            ELSE 0
          END AS winrate
        FROM users
        ORDER BY wins DESC
        LIMIT 10
      `);
      return res.json(result.rows);
    } catch (err) {
      console.error(err);
    }
  }
  // DB байхгүй үед хоосон жагсаалт буцаана
  res.json([]);
});

// Replay parse хийсний дараа үр дүн хадгалах
router.post('/result', auth.optional, async (req, res) => {
  const { room_id, winner_team, duration_minutes, replay_path, players } = req.body;

  if (!winner_team || !players) {
    return res.status(400).json({ error: 'Мэдээлэл дутуу байна' });
  }

  try {
    // Үр дүн хадгалах
    const resultRow = await db.query(
      `INSERT INTO game_results (room_id, winner_team, duration_minutes, replay_path)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [room_id || null, winner_team, duration_minutes, replay_path]
    );

    // Тоглогчдын win/loss шинэчлэх
    for (const player of players) {
      const column = player.team === winner_team ? 'wins' : 'losses';
      await db.query(
        `UPDATE users SET ${column} = ${column} + 1 WHERE discord_id = $1`,
        [player.discord_id]
      );
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
