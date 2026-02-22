require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

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

// ── Socket.io — Чат & өрөөний event ─────────────────────
// roomId → Set of usernames
const roomMembers = {};
// socketId → { username, userId } (лобби дахь онлайн тоглогчид)
const onlineUsers = new Map();
// String(userId) → socketId (private мессеж илгээхэд хэрэг)
const userSockets = new Map();

io.on('connection', (socket) => {
  console.log(`[Socket] холбогдлоо: ${socket.id}`);

  // Лоббид бүртгүүлэх (апп нээгдэхэд дуудагдана)
  socket.on('lobby:register', ({ username, userId }) => {
    if (!username || typeof username !== 'string') return;
    const safeName = username.trim().slice(0, 32);
    const safeId   = String(userId || '').slice(0, 32);
    socket.data.username = safeName;
    socket.data.userId   = safeId;
    onlineUsers.set(socket.id, { username: safeName, userId: safeId });
    if (safeId) {
      userSockets.set(safeId, socket.id);
      socket.join(`user:${safeId}`);
    }
    io.emit('lobby:online_users', [...onlineUsers.values()]);
    console.log(`[Socket] ${safeName} онлайн (нийт: ${onlineUsers.size})`);
  });

  // Нийтийн лобби чат (бүх хэрэглэгчид харна)
  socket.on('lobby:chat', ({ username, text }) => {
    if (!text?.trim() || !username) return;
    const msg = {
      username: String(username).trim().slice(0, 32),
      text: text.trim().slice(0, 500),
      time: new Date().toISOString(),
    };
    io.emit('lobby:chat', msg);
  });

  // Хувийн мессеж (private message)
  socket.on('private:message', ({ toUserId, text }) => {
    if (!text?.trim()) return;
    const { username, userId } = socket.data;
    // Хүлээн авагч илгээгчийг хаасан эсэх шалгах
    if (socialRoutes.isUserBlocked(String(toUserId), String(userId))) return;
    const msg = {
      fromUsername: username,
      fromUserId: userId,
      text: text.trim(),
      time: new Date().toISOString(),
    };
    const toSocketId = userSockets.get(String(toUserId));
    if (toSocketId) {
      io.to(toSocketId).emit('private:message', msg);
    }
    // Илгээгчид баталгаа буцаах
    socket.emit('private:sent', { ...msg, toUserId: String(toUserId) });
  });

  // Өрөөнд нэгдэх
  socket.on('room:join', ({ roomId, username }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    if (username) socket.data.username = username;

    if (!roomMembers[roomId]) roomMembers[roomId] = new Set();
    roomMembers[roomId].add(socket.data.username || username);

    // Бусдад мэдэгдэх
    socket.to(roomId).emit('room:user_joined', { username: socket.data.username || username });
    // Өрөөний гишүүдийн жагсаалт илгээх
    io.to(roomId).emit('room:members', [...roomMembers[roomId]]);

    console.log(`[Socket] ${socket.data.username} → өрөө ${roomId}`);
  });

  // Өрөөний чат мессеж
  socket.on('chat:message', ({ roomId, username, text }) => {
    if (!text?.trim() || !roomId) return;
    const msg = {
      username: String(username || socket.data.username || 'Тоглогч').trim().slice(0, 32),
      text: text.trim().slice(0, 500),
      time: new Date().toISOString(),
    };
    io.to(String(roomId)).emit('chat:message', msg);
  });

  // Өрөөнөөс гарах
  socket.on('room:leave', ({ roomId, username }) => {
    socket.leave(roomId);
    socket.data.roomId = null;
    if (roomMembers[roomId]) {
      roomMembers[roomId].delete(username);
      io.to(roomId).emit('room:user_left', { username });
      io.to(roomId).emit('room:members', [...roomMembers[roomId]]);
    }
  });

  // Унтрах үед
  socket.on('disconnect', () => {
    const { roomId, username, userId } = socket.data;
    if (roomId && username && roomMembers[roomId]) {
      roomMembers[roomId].delete(username);
      io.to(roomId).emit('room:user_left', { username });
      io.to(roomId).emit('room:members', [...roomMembers[roomId]]);
    }
    onlineUsers.delete(socket.id);
    if (userId) userSockets.delete(userId);
    io.emit('lobby:online_users', [...onlineUsers.values()]);
    console.log(`[Socket] салгагдлаа: ${socket.id}`);
  });
});

// ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Server http://localhost:${PORT} дээр ажиллаж байна`);
});
