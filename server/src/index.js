require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

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
app.use(express.json({ limit: '5mb' })); // base64 зураг байршуулахад хэрэг

// REST Routes
app.use('/auth', authRoutes);
app.use('/rooms', roomRoutes);
app.use('/stats', statsRoutes);
app.use('/social', socialRoutes);

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'WC3/DotA Platform Server ажиллаж байна' });
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
    socket.data.username = username;
    socket.data.userId = String(userId || '');
    onlineUsers.set(socket.id, { username, userId: socket.data.userId });
    if (socket.data.userId) {
      userSockets.set(socket.data.userId, socket.id);
      // Хувийн мэдэгдэл хүлээн авахад хэрэглэгчийн өрөөнд нэгдэнэ
      socket.join(`user:${socket.data.userId}`);
    }
    io.emit('lobby:online_users', [...onlineUsers.values()]);
    console.log(`[Socket] ${username} онлайн (нийт: ${onlineUsers.size})`);
  });

  // Нийтийн лобби чат (бүх хэрэглэгчид харна)
  socket.on('lobby:chat', ({ username, text }) => {
    if (!text?.trim()) return;
    const msg = { username, text: text.trim(), time: new Date().toISOString() };
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
    if (!text?.trim()) return;
    const msg = { username, text: text.trim(), time: new Date().toISOString() };
    io.to(roomId).emit('chat:message', msg);
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
