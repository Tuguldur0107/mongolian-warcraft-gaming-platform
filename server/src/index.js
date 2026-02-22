require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const authRoutes   = require('./routes/auth');
const roomRoutes   = require('./routes/rooms');
const statsRoutes  = require('./routes/stats');
const socialRoutes = require('./routes/social');
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

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Mongolian Warcraft Gaming Platform Server ажиллаж байна' });
});

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
    roomMembers[roomId].add(username);

    // Онлайн статус шинэчлэх
    if (onlineUsers.has(socket.id)) {
      onlineUsers.set(socket.id, { username, userId, status: 'in_room' });
      io.emit('lobby:online_users', [...onlineUsers.values()]);
    }

    socket.to(roomId).emit('room:user_joined', { username });
    io.to(roomId).emit('room:members', [...roomMembers[roomId]]);
    // Өрөөний чатын түүх илгээх (хожуу нэгдсэн тоглогчид)
    socket.emit('room:history', roomMessages[roomId] || []);
    console.log(`[Socket] ${username} → өрөө ${roomId}`);
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
    if (roomId && username && roomMembers[roomId]) {
      roomMembers[roomId].delete(username);
      io.to(roomId).emit('room:user_left', { username });
      io.to(roomId).emit('room:members', [...roomMembers[roomId]]);
    }
    onlineUsers.delete(socket.id);
    if (userId) userSockets.delete(userId);
    io.emit('lobby:online_users', [...onlineUsers.values()]);
    console.log(`[Socket] салгагдлаа: ${socket.id} (${username})`);
  });
});

// ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Server http://localhost:${PORT} дээр ажиллаж байна`);
});
