require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const authRoutes          = require('./routes/auth');
const roomRoutes          = require('./routes/rooms');
const statsRoutes         = require('./routes/stats');
const socialRoutes        = require('./routes/social');
const discordServerRoutes = require('./routes/discord_servers');
const { setIO } = roomRoutes;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json({ limit: '5mb' }));

// Rate limiting — auth endpoint brute force хамгаалалт
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 20,                   // 15 минутад 20 оролдлого
  message: { error: 'Хэт олон оролдлого. 15 минутын дараа дахин оролдоно уу.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/auth/login', authLimiter);
app.use('/auth/register', authLimiter); // base64 зураг байршуулахад хэрэг

// REST Routes
app.use('/auth', authRoutes);
app.use('/rooms', roomRoutes);
app.use('/stats', statsRoutes);
app.use('/social', socialRoutes);
app.use('/discord-servers', discordServerRoutes);

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Mongolian Warcraft Gaming Platform Server ажиллаж байна' });
});

// ── Глобал ZeroTier сүлжээ автомат үүсгэх ────────────────
let _globalZtNetwork = process.env.ZEROTIER_DEFAULT_NETWORK || null;

async function ensureGlobalZtNetwork() {
  if (_globalZtNetwork) return _globalZtNetwork;
  const token = process.env.ZEROTIER_API_TOKEN;
  if (!token) return null;
  try {
    const axios = require('axios');
    const { data } = await axios.post('https://api.zerotier.com/api/v1/network', {
      config: {
        name: 'WC3-Platform-Global',
        private: false,
        enableBroadcast: true,
        v4AssignMode: { zt: true },
        ipAssignmentPools: [{ ipRangeStart: '10.147.20.1', ipRangeEnd: '10.147.20.254' }],
        routes: [{ target: '10.147.20.0/24' }],
      },
    }, { headers: { Authorization: `token ${token}` } });
    _globalZtNetwork = data.id;
    process.env.ZEROTIER_DEFAULT_NETWORK = data.id; // rooms.js-д ашиглагдана
    console.log(`[ZeroTier] Глобал network үүслээ: ${data.id}`);
    console.log(`[ZeroTier] ⚠ Railway-д ZEROTIER_DEFAULT_NETWORK=${data.id} тохируулна уу!`);
    return data.id;
  } catch (e) {
    console.error('[ZeroTier] Глобал network үүсгэж чадсангүй:', e.message);
    return null;
  }
}

// Серверт эхлэхдээ глобал network бэлдэх
ensureGlobalZtNetwork();

// Глобал тохиргоо (auth шаардахгүй)
app.get('/config', async (req, res) => {
  const networkId = _globalZtNetwork || await ensureGlobalZtNetwork();
  res.json({ zerotierNetworkId: networkId });
});

// ── DB migration: бүх хүснэгтийг автоматаар үүсгэх ──────
let dbForMigration;
try { dbForMigration = require('./config/db'); } catch {}
if (dbForMigration) {
  // 1. Core tables — users хамгийн эхэнд (бусад нь FK references users)
  dbForMigration.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      discord_id    VARCHAR(255) UNIQUE,
      username      VARCHAR(255) NOT NULL,
      email         VARCHAR(255) UNIQUE,
      password_hash TEXT,
      avatar_url    TEXT,
      wins          INTEGER DEFAULT 0,
      losses        INTEGER DEFAULT 0,
      created_at    TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id);
    CREATE INDEX IF NOT EXISTS idx_users_wins       ON users(wins DESC);
  `).catch(e => console.error('[Migration] users table:', e.message));

  dbForMigration.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id                  SERIAL PRIMARY KEY,
      name                VARCHAR(255) NOT NULL,
      host_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
      zerotier_network_id VARCHAR(255),
      max_players         INTEGER DEFAULT 10,
      status              VARCHAR(50) DEFAULT 'waiting',
      game_type           VARCHAR(50) DEFAULT 'DotA',
      has_password        BOOLEAN DEFAULT FALSE,
      password_hash       TEXT,
      created_at          TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);
  `).catch(e => console.error('[Migration] rooms table:', e.message));

  dbForMigration.query(`
    CREATE TABLE IF NOT EXISTS room_players (
      room_id   INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
      team      INTEGER DEFAULT NULL,
      joined_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (room_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_room_players_user ON room_players(user_id);
    CREATE INDEX IF NOT EXISTS idx_room_players_room ON room_players(room_id);
  `).catch(e => console.error('[Migration] room_players table:', e.message));

  dbForMigration.query(`
    CREATE TABLE IF NOT EXISTS game_results (
      id               SERIAL PRIMARY KEY,
      room_id          INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
      winner_team      INTEGER NOT NULL,
      duration_minutes INTEGER,
      replay_path      TEXT,
      discord_posted   BOOLEAN DEFAULT FALSE,
      played_at        TIMESTAMP DEFAULT NOW()
    );
  `).catch(e => console.error('[Migration] game_results table:', e.message));

  dbForMigration.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      sender_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      text        TEXT NOT NULL,
      is_read     BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id), created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_unread
      ON messages(receiver_id, is_read) WHERE is_read = FALSE;
  `).catch(e => console.error('[Migration] messages table:', e.message));

  // 2. Dependent tables (users & game_results байх ёстой)
  dbForMigration.query(`
    CREATE TABLE IF NOT EXISTS game_players (
      id             SERIAL PRIMARY KEY,
      game_result_id INTEGER REFERENCES game_results(id) ON DELETE CASCADE,
      user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
      team           INTEGER NOT NULL,
      is_winner      BOOLEAN NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_game_players_user ON game_players(user_id);
  `).catch(e => console.error('[Migration] game_players table:', e.message));

  dbForMigration.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token      VARCHAR(64) UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `).catch(e => console.error('[Migration] password_resets table:', e.message));

  // 3. Column migrations (хэрэв байхгүй бол нэмэх)
  dbForMigration.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='room_players' AND column_name='team') THEN
        ALTER TABLE room_players ADD COLUMN team INTEGER DEFAULT NULL;
      END IF;
    END $$
  `).catch(e => console.error('[Migration] team column:', e.message));
}

// Rooms router-т io дамжуулах (kick/close event илгээхэд хэрэг)
setIO(io);
// Social router-т io дамжуулах (friend request мэдэгдэлд хэрэг)
socialRoutes.setIO(io);

// ── XSS хамгаалалт ───────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Socket rate limiting ──────────────────────────────────
function checkRateLimit(socket) {
  const now = Date.now();
  // 30 секундийн хоригтой эсэх
  if (socket.data.rateLimitUntil && now < socket.data.rateLimitUntil) {
    return true;
  }
  // 500ms cooldown
  if (socket.data.lastMessageTime && now - socket.data.lastMessageTime < 500) {
    return true;
  }
  // 1 минутад 30 мессеж хязгаар
  if (!socket.data.messageWindowStart || now - socket.data.messageWindowStart > 60000) {
    socket.data.messageCount = 0;
    socket.data.messageWindowStart = now;
  }
  socket.data.messageCount = (socket.data.messageCount || 0) + 1;
  if (socket.data.messageCount > 30) {
    socket.data.rateLimitUntil = now + 30000;
    socket.data.messageCount = 0;
    console.log(`[RateLimit] ${socket.user?.username || socket.id} хаагдлаа (30 секунд)`);
    return true;
  }
  socket.data.lastMessageTime = now;
  return false;
}

// ── Socket.io — Чат & өрөөний event ─────────────────────
// roomId → Set of usernames
const roomMembers = {};
// socketId → { username, userId, status } (лобби дахь онлайн тоглогчид)
const onlineUsers = new Map();
// String(userId) → socketId (private мессеж илгээхэд хэрэг)
const userSockets = new Map();
// Лобби чатын түүх (сүүлийн 100)
const lobbyHistory = [];
const LOBBY_HISTORY_MAX = 100;
// Өрөөний чатын түүх (roomId → [{username, text, time}, ...])
const roomMessages = {};
// Rejoin grace period: userId → { timer, roomId, username }
const disconnectTimers = {};
const REJOIN_GRACE_MS = 45000; // 45 секунд
// Тоглогчдын ZeroTier IP хадгалах (roomId → Map<userId, ztIp>)
const roomZtIps = {};

// ── Socket.io JWT middleware ──────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log(`[Socket] холбогдлоо: ${socket.id} (${socket.user?.username})`);

  // Лоббид бүртгүүлэх (апп нээгдэхэд дуудагдана)
  // JWT-ийн мэдээллийг ашиглана — client-ийн утгыг хэрэглэхгүй
  socket.on('lobby:register', () => {
    const username = socket.user.username;
    const userId   = String(socket.user.id);
    socket.data.username = username;
    socket.data.userId   = userId;
    onlineUsers.set(socket.id, { username, userId, status: 'online' });
    if (userId) {
      userSockets.set(userId, socket.id);
      socket.join(`user:${userId}`);
    }
    io.emit('lobby:online_users', [...onlineUsers.values()]);
    // Лобби чатын сүүлийн 50 мессеж илгээх
    socket.emit('lobby:history', lobbyHistory.slice(-50));
    console.log(`[Socket] ${username} онлайн (нийт: ${onlineUsers.size})`);
  });

  // Нийтийн лобби чат (бүх хэрэглэгчид харна)
  socket.on('lobby:chat', ({ text }) => {
    if (!text?.trim()) return;
    if (checkRateLimit(socket)) return;
    const msg = {
      username: socket.user.username,
      text: escapeHtml(text.trim().slice(0, 500)),
      time: new Date().toISOString(),
    };
    // Түүхэнд хадгалах
    lobbyHistory.push(msg);
    if (lobbyHistory.length > LOBBY_HISTORY_MAX) lobbyHistory.shift();
    io.emit('lobby:chat', msg);
  });

  // Хувийн мессеж (private message)
  socket.on('private:message', async ({ toUserId, text }) => {
    if (!text?.trim()) return;
    if (checkRateLimit(socket)) return;
    const userId   = String(socket.user.id);
    const username = socket.user.username;
    // Хүлээн авагч илгээгчийг хаасан эсэх шалгах
    if (socialRoutes.isUserBlocked(String(toUserId), userId)) return;
    const safeText = escapeHtml(text.trim());
    // DB-д хадгалах
    const saved = await socialRoutes.saveMessage(socket.user.id, toUserId, safeText);
    const msg = {
      fromUsername: username,
      fromUserId:   userId,
      text:         safeText,
      time:         saved?.created_at?.toISOString() || new Date().toISOString(),
      id:           saved?.id || null,
    };
    const toSocketId = userSockets.get(String(toUserId));
    if (toSocketId) {
      io.to(toSocketId).emit('private:message', msg);
    }
    // Илгээгчид баталгаа буцаах
    socket.emit('private:sent', { ...msg, toUserId: String(toUserId) });
  });

  // Өрөөнд нэгдэх
  socket.on('room:join', ({ roomId }) => {
    const username = socket.user.username;
    const userId   = String(socket.user.id);
    socket.join(roomId);
    socket.data.roomId   = roomId;
    socket.data.username = username;

    if (!roomMembers[roomId]) roomMembers[roomId] = new Set();

    // Хэрэв өөр өрөөний grace period байвал цуцлаад тэр өрөөнөөс гарна
    if (disconnectTimers[userId] && disconnectTimers[userId].roomId !== String(roomId)) {
      const prev = disconnectTimers[userId];
      clearTimeout(prev.timer);
      delete disconnectTimers[userId];
      if (roomMembers[prev.roomId]) {
        roomMembers[prev.roomId].delete(prev.username);
        io.to(prev.roomId).emit('room:user_left', { username: prev.username });
        io.to(prev.roomId).emit('room:members', [...roomMembers[prev.roomId]]);
      }
    }

    // Rejoin шалгах: grace period дотор буцаж ирсэн эсэх
    const isRejoin = !!(disconnectTimers[userId]?.roomId === String(roomId) && roomMembers[roomId].has(username));
    if (isRejoin) {
      clearTimeout(disconnectTimers[userId].timer);
      delete disconnectTimers[userId];
      socket.to(roomId).emit('room:user_rejoined', { username });
      console.log(`[Rejoin] ${username} дахин нэгдлээ → өрөө ${roomId}`);
    } else {
      roomMembers[roomId].add(username);
      socket.to(roomId).emit('room:user_joined', { username });
      console.log(`[Socket] ${username} → өрөө ${roomId}`);
    }

    // Онлайн статус шинэчлэх
    if (onlineUsers.has(socket.id)) {
      onlineUsers.set(socket.id, { username, userId, status: 'in_room' });
      io.emit('lobby:online_users', [...onlineUsers.values()]);
    }

    io.to(roomId).emit('room:members', [...roomMembers[roomId]]);
    // Өрөөний чатын түүх илгээх (хожуу нэгдсэн тоглогчид)
    socket.emit('room:history', roomMessages[roomId] || []);
  });

  // Өрөөний урилга
  socket.on('room:invite', ({ toUserId, roomId, roomName }) => {
    const toSocketId = userSockets.get(String(toUserId));
    if (toSocketId) {
      io.to(toSocketId).emit('room:invited', {
        fromUsername: socket.user.username,
        fromUserId:   String(socket.user.id),
        roomId,
        roomName,
      });
    }
  });

  // Өрөөний чат мессеж
  socket.on('chat:message', ({ roomId, text }) => {
    if (!text?.trim() || !roomId) return;
    if (checkRateLimit(socket)) return;
    const msg = {
      username: socket.user.username,
      text: escapeHtml(text.trim().slice(0, 500)),
      time: new Date().toISOString(),
    };
    // Өрөөний чат түүхэнд хадгалах (max 100)
    if (!roomMessages[roomId]) roomMessages[roomId] = [];
    roomMessages[roomId].push(msg);
    if (roomMessages[roomId].length > 100) roomMessages[roomId].shift();
    io.to(String(roomId)).emit('chat:message', msg);
  });

  // Host-ын IP хаягийг өрөөний тоглогчдод дамжуулах
  socket.on('room:host_ip', ({ roomId, ip }) => {
    if (!ip || !roomId) return;
    // Зөвхөн тухайн өрөөнд байгаа тоглогчдод broadcast
    socket.to(String(roomId)).emit('room:host_ip', {
      ip,
      hostUsername: socket.user.username,
      hostUserId: String(socket.user.id),
    });
  });

  // Тоглогчийн ZeroTier IP бүртгэх — relay-д хэрэгтэй
  socket.on('room:zt_ip', ({ roomId, ip }) => {
    if (!ip || !roomId) return;
    const userId = String(socket.user.id);
    if (!roomZtIps[roomId]) roomZtIps[roomId] = new Map();
    roomZtIps[roomId].set(userId, ip);
    // Өрөөний бүх тоглогчдод шинэчилсэн IP жагсаалт илгээх
    io.to(String(roomId)).emit('room:zt_ips', {
      ips: Object.fromEntries(roomZtIps[roomId]),
    });
    console.log(`[ZT-IP] ${socket.user.username} → ${ip} (room ${roomId})`);
  });

  // Host relay-д зориулсан тоглогчдын IP жагсаалт авах
  socket.on('room:get_zt_ips', ({ roomId }) => {
    if (!roomId) return;
    const ips = roomZtIps[roomId] ? Object.fromEntries(roomZtIps[roomId]) : {};
    socket.emit('room:zt_ips', { ips });
  });

  // Тоглолт эхлэхэд статус 'in_game' болгох
  socket.on('room:game_started', () => {
    const username = socket.user.username;
    const userId   = String(socket.user.id);
    if (onlineUsers.has(socket.id)) {
      onlineUsers.set(socket.id, { username, userId, status: 'in_game' });
      io.emit('lobby:online_users', [...onlineUsers.values()]);
    }
  });

  // Typing indicator (DM)
  socket.on('typing:start', ({ toUserId }) => {
    const toSocketId = userSockets.get(String(toUserId));
    if (toSocketId) {
      io.to(toSocketId).emit('typing:start', { fromUserId: String(socket.user.id), fromUsername: socket.user.username });
    }
  });

  socket.on('typing:stop', ({ toUserId }) => {
    const toSocketId = userSockets.get(String(toUserId));
    if (toSocketId) {
      io.to(toSocketId).emit('typing:stop', { fromUserId: String(socket.user.id) });
    }
  });

  // Өрөөнөөс гарах
  socket.on('room:leave', ({ roomId }) => {
    const username = socket.user.username;
    const userId   = String(socket.user.id);
    // Grace period байвал цуцлах (санаатай гарч байна)
    if (disconnectTimers[userId]) {
      clearTimeout(disconnectTimers[userId].timer);
      delete disconnectTimers[userId];
    }
    socket.leave(roomId);
    socket.data.roomId = null;
    if (roomMembers[roomId]) {
      roomMembers[roomId].delete(username);
      io.to(roomId).emit('room:user_left', { username });
      io.to(roomId).emit('room:members', [...roomMembers[roomId]]);
    }
    // Онлайн статус шинэчлэх
    if (onlineUsers.has(socket.id)) {
      onlineUsers.set(socket.id, { username, userId, status: 'online' });
      io.emit('lobby:online_users', [...onlineUsers.values()]);
    }
  });

  // Унтрах үед
  socket.on('disconnect', () => {
    const { roomId } = socket.data;
    const username = socket.user?.username || socket.data.username;
    const userId   = String(socket.user?.id || socket.data.userId || '');

    // Socket mapping-уудыг шууд устгах
    onlineUsers.delete(socket.id);
    if (userId) userSockets.delete(userId);
    io.emit('lobby:online_users', [...onlineUsers.values()]);

    // Өрөөнд байсан бол grace period эхлүүлэх
    if (roomId && username && roomMembers[roomId]) {
      // Өмнө нь grace period байсан бол цуцлах
      if (disconnectTimers[userId]) {
        clearTimeout(disconnectTimers[userId].timer);
      }
      // Бусдад мэдэгдэх: дахин холбогдохыг хүлээж байна
      io.to(roomId).emit('room:user_reconnecting', { username });

      // Grace period таймер
      disconnectTimers[userId] = {
        roomId: String(roomId),
        username,
        timer: setTimeout(async () => {
          delete disconnectTimers[userId];
          // Хугацаа дуусав — өрөөнөөс бүрмөсөн гарна
          if (roomMembers[roomId]) {
            roomMembers[roomId].delete(username);
            io.to(roomId).emit('room:user_left', { username });
            io.to(roomId).emit('room:members', [...roomMembers[roomId]]);
          }
          // Хост байсан бол DB-с өрөөг автоматаар устгах
          if (dbForMigration && userId) {
            try {
              const rr = await dbForMigration.query(
                `SELECT id, zerotier_network_id FROM rooms
                 WHERE host_id=$1 AND id=$2 AND status IN ('waiting','playing')`,
                [userId, roomId]
              );
              if (rr.rows[0]) {
                await dbForMigration.query('DELETE FROM rooms WHERE id=$1', [roomId]);
                io.to(roomId).emit('room:closed', { reason: 'Өрөөний эзэн гарлаа' });
                delete roomMessages[roomId];
                delete roomZtIps[roomId];
                io.emit('rooms:updated');
                console.log(`[AutoClose] Host timeout → room ${roomId} хаагдлаа`);
              }
            } catch (e) { console.error('[AutoClose]', e.message); }
          }
          console.log(`[Rejoin] ${username} grace period дууссан, өрөөнөөс гарлаа`);
        }, REJOIN_GRACE_MS),
      };
      console.log(`[Socket] салгагдлаа: ${socket.id} (${username}) — ${REJOIN_GRACE_MS / 1000}с grace period`);
    } else {
      console.log(`[Socket] салгагдлаа: ${socket.id} (${username})`);
    }
  });
});

// ── Өрөөний auto-expire (2 цаг тутам) ───────────────────
setInterval(async () => {
  if (!dbForMigration) return;
  try {
    await dbForMigration.query("DELETE FROM rooms WHERE status='waiting' AND created_at < NOW() - INTERVAL '6 hours'");
    await dbForMigration.query("UPDATE rooms SET status='done' WHERE status='playing' AND created_at < NOW() - INTERVAL '12 hours'");
    console.log('[AutoExpire] Хуучин өрөөнүүдийг цэвэрлэлээ');
  } catch (e) { console.error('[AutoExpire]', e.message); }
}, 2 * 60 * 60 * 1000);

// ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Server http://localhost:${PORT} дээр ажиллаж байна`);
});
