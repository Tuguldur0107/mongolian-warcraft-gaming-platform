# Mongolian Warcraft Gaming Platform — Сайжруулалтын Prompt-ууд

Доорх prompt бүрийг **тус тусад нь** шинэ conversation дээр ажиллуулна.
Дарааллаар нь хийх нь зүйтэй (1-р prompt → 2 → 3 → ...).

---

## PROMPT 1: Security & Socket Authentication (Аюулгүй байдал)

```
Энэ Mongolian Warcraft Gaming Platform төслийн аюулгүй байдлыг сайжруулах хэрэгтэй. Доорх ажлуудыг хий:

## 1. Socket.io JWT Authentication нэмэх
Одоо Socket.io дээр ямар ч authentication байхгүй — хэн ч lobby:register event-ээр дурын username/userId илгээж бусдыг дүр эсгэж болно.

Шийдэл:
- server/src/index.js файлд Socket.io middleware нэмж, холбогдох үед JWT token шалгах:
  ```js
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
  ```
- lobby:register event-д socket.user-аас username, userId авах (client-ээс ирсэн утгыг хэрэглэхгүй)
- private:message, chat:message зэрэг бүх event-д socket.user ашиглах
- Client талд (client/src/renderer/app.js) connectSocket() функцэд token дамжуулах:
  ```js
  socket = io(SERVER, {
    transports: ['websocket'],
    auth: { token: currentUser?.token }
  });
  ```
- client/src/services/api.js-аас token авч socket-д дамжуулах

## 2. Тоглоомын үр дүн (game result) хамгаалалт
Одоо POST /stats/result endpoint-д хэн ч дурын үр дүн бичих боломжтой. Энэ нь leaderboard-г manipulate хийх боломж олгоно.

Шийдэл — server/src/routes/stats.js файлд:
- optionalAuth-г authMiddleware (strict) болгох
- Тухайн хэрэглэгч тухайн room-д байгаа эсэхийг шалгах:
  ```js
  if (room_id) {
    const membership = await db.query(
      'SELECT 1 FROM room_players WHERE room_id=$1 AND user_id=$2',
      [room_id, req.user.id]
    );
    if (!membership.rows[0]) return res.status(403).json({ error: 'Энэ өрөөний гишүүн биш байна' });

    const room = await db.query('SELECT host_id, status FROM rooms WHERE id=$1', [room_id]);
    if (String(room.rows[0]?.host_id) !== String(req.user.id))
      return res.status(403).json({ error: 'Зөвхөн өрөөний эзэн үр дүн бичих эрхтэй' });
    if (room.rows[0]?.status !== 'playing')
      return res.status(400).json({ error: 'Тоглолт эхлээгүй өрөөнд үр дүн бичих боломжгүй' });
  }
  ```
- Нэг room-д хоёр удаа result бичихээс хамгаалах (status='done' бол reject)

## 3. Rooms endpoint-д strict auth шаардах
Одоо server/src/routes/rooms.js файлд бүх endpoint optionalAuth ашиглаж байгаа — id:0 хэрэглэгч өрөө үүсгэж болно.

Шийдэл:
- POST /, POST /:id/join, POST /:id/leave, DELETE /:id, POST /:id/start, POST /:id/kick — эдгээрийг бүгдийг authMiddleware (strict) болгох
- GET / (жагсаалт), GET /mine — эдгээрийг optionalAuth-аар үлдээж болно

## 4. Чат мессеж XSS хамгаалалт
server/src/index.js дахь chat event-д HTML escape нэмэх:
```js
function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
```
lobby:chat, chat:message, private:message бүрийн text утгад escapeHtml() хэрэглэх.

## 5. Socket.io rate limiting
Нэг хэрэглэгч секундэд хэт олон мессеж илгээхээс хамгаалах:
- Socket бүрт lastMessageTime хадгалж, 500ms-ээс бага зайтай мессеж хаах
- 1 минутад 30-аас олон мессеж илгээвэл 30 секунд хаах

Чухал: Одоо байгаа бүх функционалыг эвдэхгүй байхад анхаарна уу. Тест хийж болох газар console.log нэмж тест хийнэ үү.
```

---

## PROMPT 2: Chat & Messaging System (Чат систем)

```
Энэ Mongolian Warcraft Gaming Platform төслийн чат системийг сайжруулах хэрэгтэй. Доорх ажлуудыг хий:

## 1. Хувийн мессеж (DM) серверт хадгалах
Одоо хувийн мессежүүд зөвхөн socket event-ээр дамждаг, хадгалагддаггүй. Програм хаагаад дахин нээхэд бүх мессеж алга болдог.

### Database schema (server/src/db/schema.sql-д нэмэх):
```sql
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(receiver_id, is_read) WHERE is_read = FALSE;
```

### Server API endpoints (server/src/routes/social.js-д нэмэх):
- `GET /social/messages/:userId` — Тодорхой хэрэглэгчтэй харилцсан мессежийн түүх (сүүлийн 50, pagination дэмжих: ?before=messageId)
- `GET /social/unread` — Уншаагүй мессежийн тоо (хэрэглэгч бүрээр group)
- `POST /social/messages/read` — Мессежийг уншсанаар тэмдэглэх { fromUserId }

### Server socket handler шинэчлэх (server/src/index.js):
- private:message event дотор мессежийг DB-д хадгалах:
  ```js
  socket.on('private:message', async ({ toUserId, text }) => {
    if (!text?.trim()) return;
    const { username, userId } = socket.user; // socket.user JWT-аас
    if (socialRoutes.isUserBlocked(String(toUserId), String(userId))) return;

    // DB-д хадгалах
    try {
      await db.query(
        'INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1, $2, $3)',
        [userId, toUserId, escapeHtml(text.trim())]
      );
    } catch (e) { console.error(e); }

    // Socket-ээр илгээх (одоогийн логик)
    const msg = { fromUsername: username, fromUserId: userId, text: escapeHtml(text.trim()), time: new Date().toISOString() };
    const toSocketId = userSockets.get(String(toUserId));
    if (toSocketId) io.to(toSocketId).emit('private:message', msg);
    socket.emit('private:sent', { ...msg, toUserId: String(toUserId) });
  });
  ```

### Client UI шинэчлэх (client/src/renderer/app.js):
- DM modal нээхэд тухайн хэрэглэгчтэй харилцсан сүүлийн 50 мессежийг API-аас татах
- Scroll дээш хийхэд хуучин мессежүүд ачаалах (infinite scroll)
- Мессеж уншсан тэмдэглэгээ нэмэх (DM modal нээхэд POST /social/messages/read дуудах)
- Уншаагүй мессежийн badge тоог серверээс авах (апп нээгдэхэд GET /social/unread)

## 2. Lobby чатын түүх (сүүлийн 50)
Шинэ хэрэглэгч нэвтрэхэд lobby чат хоосон байдаг.

### Шийдэл:
- server/src/index.js-д lobby мессежийг массивт хадгалах (сүүлийн 100):
  ```js
  const lobbyHistory = [];
  const LOBBY_HISTORY_MAX = 100;
  ```
- lobby:chat event дотор lobbyHistory-д push хийх (LOBBY_HISTORY_MAX хэтэрвэл shift)
- Socket холбогдоход lobby:history event илгээх:
  ```js
  socket.emit('lobby:history', lobbyHistory.slice(-50));
  ```
- Client талд lobby:history event хүлээн авч renderлэх

## 3. Room чатын түүх
Өрөөнд хожуу нэгдсэн тоглогч өмнөх чатыг харж чаддаггүй.

### Шийдэл:
- server/src/index.js-д roomMessages объект нэмэх:
  ```js
  const roomMessages = {}; // roomId → [{username, text, time}, ...]
  ```
- chat:message event-д roomMessages-д хадгалах (өрөө бүрд max 100)
- room:join event-д өрөөний чат түүхийг илгээх:
  ```js
  socket.emit('room:history', roomMessages[roomId] || []);
  ```
- Client room page-д room:history event хүлээж авах

## 4. Typing indicator (бичиж байна гэдгийг харуулах)
- Client: input дээр keypress бүрт "typing" event илгээх (debounce 2 секунд)
- Server: typing event-г зорилтот хэрэглэгч рүү forward хийх
- Client: "Бичиж байна..." текст харуулах (2 секунд idle болвол нуух)

Чухал: Бүх өөрчлөлт одоо байгаа функционалыг эвдэхгүй байх ёстой.
```

---

## PROMPT 3: Social System Improvements (Нийгмийн систем)

```
Энэ Mongolian Warcraft Gaming Platform төслийн social/нийгмийн системийг сайжруулах хэрэгтэй. Доорх ажлуудыг хий:

## 1. Хэрэглэгч хайх (User Search)
Одоо хэрэглэгч хайх боломж байхгүй — найз нэмэхийн тулд тухайн хүн заавал онлайн байх ёстой.

### Server endpoint нэмэх (server/src/routes/social.js):
```js
// GET /social/search?q=username — Хэрэглэгч хайх
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
```

### Client IPC handler нэмэх (client/src/main.js):
```js
ipcMain.handle('social:search', async (_, query) => {
  const res = await apiService.searchUsers(query);
  return res;
});
```

### Client API service (client/src/services/api.js):
```js
async searchUsers(query) {
  const { data } = await axios.get(`${SERVER_URL}/social/search`, {
    params: { q: query },
    headers: authHeader()
  });
  return data;
}
```

### Client preload.js-д нэмэх:
```js
searchUsers: (query) => ipcRenderer.invoke('social:search', query),
```

### Client UI (client/src/renderer/app.js):
- Chat tab-ын Online хэсэгт search input нэмэх
- Input дээр бичихэд 500ms debounce-тэй хайлт хийх
- Хайлтын үр дүнд: username, avatar, "Найз нэмэх" товч харуулах
- Хоосон үр дүнд "Олдсонгүй" текст

### Client UI (client/src/renderer/index.html):
Chat tab-ын Online sub-tab дотор search input нэмэх:
```html
<div class="search-box" style="padding: 8px;">
  <input type="text" id="user-search-input" placeholder="Хэрэглэгч хайх..."
    style="width:100%; padding:8px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg-secondary); color:var(--text-primary);">
</div>
<div id="user-search-results"></div>
```

## 2. Хэрэглэгчийн онлайн статус сайжруулах
Одоо зөвхөн online/offline байдаг. Тоглоом тоглож байна, Өрөөнд байна гэсэн статус нэмэх.

### Server (server/src/index.js):
- onlineUsers Map-д status нэмэх: { username, userId, status: 'online' | 'in_room' | 'in_game' }
- room:join event-д status='in_room' болгох
- room:started event-д status='in_game' болгох
- room:leave event-д status='online' болгох
- lobby:online_users event-д status мэдээлэл оруулах

### Client (client/src/renderer/app.js):
- Online хэрэглэгчийн жагсаалтад статус badge нэмэх:
  - 🟢 Онлайн
  - 🟡 Өрөөнд байна
  - 🔴 Тоглож байна

## 3. Найзын жагсаалтаас шууд өрөөнд урих
- Найзын хажууд "Урих" товч нэмэх (зөвхөн та өрөөнд байгаа үед харагдана)
- Дарахад тухайн найз руу socket event илгээх: room:invite
- Найз уригдсан мэдэгдэл хүлээн авч, "Нэгдэх" / "Татгалзах" сонголт харуулах

### Server (server/src/index.js):
```js
socket.on('room:invite', ({ toUserId, roomId, roomName }) => {
  const toSocketId = userSockets.get(String(toUserId));
  if (toSocketId) {
    io.to(toSocketId).emit('room:invited', {
      fromUsername: socket.user.username,
      fromUserId: socket.user.id,
      roomId,
      roomName
    });
  }
});
```

### Client:
- room:invited event хүлээн авч notification popup харуулах
- "Нэгдэх" дарахад rooms:join IPC дуудах

## 4. Найз онлайн/офлайн мэдэгдэл
- Найз онлайн болоход toast notification харуулах
- lobby:online_users event-д шинэ/хуучин жагсаалт харьцуулж, найзын статус өөрчлөгдсөн эсэхийг шалгах

Чухал: Бүх өөрчлөлт одоо байгаа функционалыг эвдэхгүй байх ёстой.
```

---

## PROMPT 4: Rooms & Game Management (Өрөө & Тоглоомын удирдлага)

```
Энэ Mongolian Warcraft Gaming Platform төслийн өрөө болон тоглоомын удирдлагыг сайжруулах хэрэгтэй. Доорх ажлуудыг хий:

## 1. Өрөөний тохиргоо засах боломж (host-д зориулж)
Одоо өрөө үүсгэсний дараа ямар ч тохиргоог өөрчлөх боломжгүй.

### Server endpoint нэмэх (server/src/routes/rooms.js):
```js
// PATCH /rooms/:id — Өрөөний тохиргоог шинэчлэх (зөвхөн host)
router.patch('/:id', auth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const { name, max_players, password } = req.body;

  // host эсэх шалгах
  // зөвшөөрөгдсөн field-үүдийг шинэчлэх
  // has_password, password_hash шинэчлэх (password=null бол нууц үг арилгах)
  // Тоглогчдод socket event: room:updated
});
```

### Client:
- Room page-д host-д зориулсан "⚙ Тохиргоо" товч
- Дарахад modal нээгдэж: нэр, хамгийн их тоглогч, нууц үг өөрчлөх боломж
- Хадгалахад PATCH /rooms/:id дуудах

## 2. Хурдан тоглолт (Quick Match) систем
Тоглогчид гараар өрөө хайж, сонгож, нэгдэх хэрэгцээгүйгээр нэг товчоор тоглолтод нэгдэх.

### Server (server/src/routes/rooms.js):
```js
// POST /rooms/quickmatch — Хүлээж буй өрөөнд автоматаар нэгдэх, байхгүй бол шинээр үүсгэх
router.post('/quickmatch', auth, async (req, res) => {
  const { game_type } = req.body;
  if (!game_type) return res.status(400).json({ error: 'game_type шаардлагатай' });

  // 1. Тухайн game_type-тай, нууц үггүй, waiting статустай, дүүрээгүй өрөө хайх
  // 2. Олдвол join хийх
  // 3. Олдохгүй бол шинэ өрөө үүсгэх ("Quick Match #" + random ID)
  // 4. Өрөөний мэдээлэл буцаах
});
```

### Client (client/src/renderer/app.js):
- Lobby tab-д "⚡ Хурдан тоглолт" товч нэмэх (room create товчны хажууд)
- Дарахад game_type сонгох dropdown гарч, сонговол quickmatch дуудах
- Амжилттай бол шууд room window нээх

## 3. Өрөөний баг хуваарилалт (Team Selection)
DotA тоглоомд 2 баг байдаг. Тоглогчид өрөөнд нэгдэхдээ багаа сонгох ёстой.

### Database schema өөрчлөлт (server/src/db/schema.sql):
```sql
ALTER TABLE room_players ADD COLUMN team INTEGER DEFAULT NULL; -- 1 эсвэл 2
```

### Server (server/src/routes/rooms.js):
- POST /:id/join-д team параметр хүлээн авах (optional)
- PATCH /:id/team — Баг солих endpoint:
  ```js
  router.patch('/:id/team', auth, async (req, res) => {
    const { team } = req.body; // 1 эсвэл 2
    // Баг дүүрэн эсэх шалгах (max_players / 2)
    // room_players.team шинэчлэх
    // Socket event: room:team_changed
  });
  ```
- GET / жагсаалтад members-д team мэдээлэл нэмэх

### Client Room page:
- Гишүүдийн жагсаалтыг 2 баг (Sentinel vs Scourge) болгон хуваах
- Тоглогч баг солих товч (↔)
- Host бусдын багийг солих боломж

## 4. Өрөөний auto-expire
Хэрэг болохоо больсон өрөөг автоматаар устгах.

### Server (server/src/index.js):
```js
// 2 цаг бүр хэрэглэгчгүй, хуучин өрөөг цэвэрлэх
setInterval(async () => {
  if (await dbOk()) {
    try {
      // 6 цагаас хуучин waiting өрөөг устгах
      await db.query("DELETE FROM rooms WHERE status='waiting' AND created_at < NOW() - INTERVAL '6 hours'");
      // 12 цагаас хуучин playing өрөөг done болгох
      await db.query("UPDATE rooms SET status='done' WHERE status='playing' AND created_at < NOW() - INTERVAL '12 hours'");
    } catch (e) { console.error(e); }
  }
}, 2 * 60 * 60 * 1000);
```

## 5. Өрөөний жагсаалт автоматаар шинэчлэгдэх
Одоо lobby-д өрөөний жагсаалт зөвхөн гараар refresh хийхэд шинэчлэгддэг.

### Server:
- Өрөө үүсэх, устах, тоглогч нэгдэх/гарах бүрт бүх client-д мэдэгдэл илгээх:
  ```js
  io.emit('rooms:updated');
  ```
- rooms.js route бүрийн эцэст io.emit('rooms:updated') нэмэх

### Client:
- rooms:updated event хүлээж, lobby tab идэвхтэй бол loadRooms() дуудах
- Debounce нэмж хэт олон refresh-ээс хамгаалах (2 секунд)

Чухал: Бүх өөрчлөлт одоо байгаа функционалыг эвдэхгүй байх ёстой.
```

---

## PROMPT 5: Stats & Ranking System (Статистик & Чансаа)

```
Энэ Mongolian Warcraft Gaming Platform төслийн статистик болон чансааны системийг сайжруулах хэрэгтэй. Доорх ажлуудыг хий:

## 1. Stats-ийг user_id-гаар ажиллуулах
Одоо server/src/routes/stats.js дээр тоглогчийн stats зөвхөн discord_id-гаар хайгддаг. Email-ээр бүртгүүлсэн хэрэглэгч Discord холбоогүй бол stats нь огт харагдахгүй.

### Шийдэл:
- GET /stats/player/:id endpoint нэмэх (id = user ID):
  ```js
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
  ```
- POST /stats/result дотор players массивд discord_id-н оронд user_id ашиглах боломж нэмэх:
  ```js
  for (const player of players) {
    const column = player.team === winner_team ? 'wins' : 'losses';
    if (player.user_id) {
      await db.query(`UPDATE users SET ${column} = ${column} + 1 WHERE id = $1`, [player.user_id]);
    } else if (player.discord_id) {
      await db.query(`UPDATE users SET ${column} = ${column} + 1 WHERE discord_id = $1`, [player.discord_id]);
    }
  }
  ```

## 2. Тоглоомын түүх (Game History)
Одоо game_results table-д тоглоомын үр дүн хадгалагддаг ч хэрэглэгч өөрийн тоглоомын түүхийг харах боломжгүй.

### Database schema нэмэх:
```sql
CREATE TABLE IF NOT EXISTS game_players (
  id SERIAL PRIMARY KEY,
  game_result_id INTEGER REFERENCES game_results(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  team INTEGER NOT NULL,
  is_winner BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_players_user ON game_players(user_id);
```

### Server endpoint нэмэх (server/src/routes/stats.js):
```js
// GET /stats/history/:userId — Тоглогчийн тоглоомын түүх
router.get('/history/:userId', async (req, res) => {
  const { userId } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  if (await dbAvailable()) {
    try {
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
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
      });
    } catch (err) { console.error(err); }
  }
  res.json({ games: [], total: 0, page: 1, totalPages: 0 });
});
```

### POST /stats/result-д game_players insert нэмэх:
Result хадгалахдаа game_players table-д тоглогч бүрийг insert хийх.

### Client Profile tab-д тоглоомын түүх нэмэх:
- Profile tab-д "Тоглоомын түүх" хэсэг нэмэх
- Хүснэгт: Огноо | Тоглоомын төрөл | Өрөөний нэр | Баг | Үр дүн | Хугацаа
- Pagination (хуудаслалт) нэмэх

## 3. Ranking сайжруулалт
Одоо leaderboard зөвхөн Top 10, зөвхөн wins-ээр эрэмбэлдэг.

### Server:
```js
// GET /stats/ranking сайжруулах
router.get('/ranking', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const sortBy = req.query.sort || 'wins'; // wins, winrate, total_games

  // sort validation
  const allowedSorts = {
    wins: 'wins DESC',
    winrate: 'CASE WHEN (wins+losses)>0 THEN wins::DECIMAL/(wins+losses) ELSE 0 END DESC',
    total_games: '(wins+losses) DESC'
  };
  const orderClause = allowedSorts[sortBy] || allowedSorts.wins;

  if (await dbAvailable()) {
    try {
      // Хамгийн багадаа 1 тоглоом тоглосон хэрэглэгчид
      const result = await db.query(`
        SELECT id, username, avatar_url, wins, losses,
          CASE WHEN (wins+losses)>0 THEN ROUND((wins::DECIMAL/(wins+losses))*100,1) ELSE 0 END AS winrate
        FROM users
        WHERE (wins + losses) > 0
        ORDER BY ${orderClause}
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      const countResult = await db.query(
        'SELECT COUNT(*) FROM users WHERE (wins+losses) > 0'
      );

      return res.json({
        players: result.rows,
        total: parseInt(countResult.rows[0].count),
        page,
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
      });
    } catch (err) { console.error(err); }
  }
  res.json({ players: [], total: 0, page: 1, totalPages: 0 });
});
```

### Client Ranking tab сайжруулалт:
- Pagination нэмэх (20 хэрэглэгч/хуудас)
- Sort сонголт: "Хожлоор" | "Хожлын хувиар" | "Нийт тоглолтоор"
- Хэрэглэгч дээр дарахад профайл popup нээх (stats, тоглоомын түүх)
- Өөрийн байршлыг тодруулах (highlight)

## 4. Profile хуудаснаас бусдын profile харах
- Ranking эсвэл Online жагсаалтаас хэрэглэгч дээр дарахад тухайн хэрэглэгчийн profile popup нээх
- Popup-д: avatar, username, wins/losses/winrate, сүүлийн 5 тоглоом, "Найз нэмэх" товч

Чухал: Бүх өөрчлөлт одоо байгаа функционалыг эвдэхгүй байх ёстой.
```

---

## PROMPT 6: Auth & User Management (Нэвтрэлт & Хэрэглэгч)

```
Энэ Mongolian Warcraft Gaming Platform төслийн нэвтрэлт болон хэрэглэгчийн удирдлагыг сайжруулах хэрэгтэй. Доорх ажлуудыг хий:

## 1. Нууц үг сэргээх (Password Reset) систем
Одоо хэрэглэгч нууц үгээ мартвал данс руугаа нэвтрэх боломжгүй.

Бид энгийн аргаар хийнэ — серверт reset token үүсгээд тухайн token-ийг хэрэглэгчид харуулна (email илгээх биш).

### Database (server/src/db/schema.sql):
```sql
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(64) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Server endpoints (server/src/routes/auth.js):
```js
const crypto = require('crypto');

// POST /auth/forgot-password — Reset token үүсгэх
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Имэйл оруулна уу' });

  if (await dbOk()) {
    try {
      const user = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      if (!user.rows[0]) return res.status(404).json({ error: 'Энэ имэйлтэй хэрэглэгч олдсонгүй' });

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 минут

      await db.query(
        'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [user.rows[0].id, token, expiresAt]
      );

      return res.json({ ok: true, resetToken: token, expiresIn: '30 минут' });
    } catch (e) { console.error(e); }
  }
  res.status(500).json({ error: 'Серверийн алдаа' });
});

// POST /auth/reset-password — Нууц үг шинэчлэх
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token болон шинэ нууц үг шаардлагатай' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Нууц үг хамгийн багадаа 6 тэмдэгт' });

  if (await dbOk()) {
    try {
      const r = await db.query(
        'SELECT * FROM password_resets WHERE token=$1 AND used=FALSE AND expires_at > NOW()',
        [token]
      );
      if (!r.rows[0]) return res.status(400).json({ error: 'Token буруу эсвэл хугацаа дууссан' });

      const hash = await bcrypt.hash(newPassword, 10);
      await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, r.rows[0].user_id]);
      await db.query('UPDATE password_resets SET used=TRUE WHERE id=$1', [r.rows[0].id]);

      return res.json({ ok: true });
    } catch (e) { console.error(e); }
  }
  res.status(500).json({ error: 'Серверийн алдаа' });
});
```

### Client:
- Login page-д "Нууц үгээ мартсан?" линк нэмэх
- Дарахад email input + "Код авах" товч
- Код ирэхэд шинэ form: "Код" input + "Шинэ нууц үг" input + "Шинэчлэх" товч
- Амжилттай бол login form руу буцах

## 2. Хэрэглэгчийн нэр (username) өөрчлөх
Одоо username зөвхөн бүртгэл үүсгэхэд тогтоогддог, дараа нь өөрчлөх боломжгүй.

### Server (server/src/routes/auth.js):
```js
// PUT /auth/username — Username өөрчлөх
router.put('/username', authMW, async (req, res) => {
  const { username } = req.body;
  if (!username || username.trim().length < 2 || username.trim().length > 20)
    return res.status(400).json({ error: 'Username 2-20 тэмдэгт байх ёстой' });

  const clean = username.trim();
  if (await dbOk()) {
    try {
      await db.query('UPDATE users SET username=$1 WHERE id=$2', [clean, req.user.id]);
      const user = { ...req.user, username: clean };
      return res.json({ ok: true, token: makeJWT(user), username: clean });
    } catch (e) { console.error(e); }
  }
  res.status(500).json({ error: 'Серверийн алдаа' });
});
```

### Client Profile tab:
- Username хажууд "✏️" засах товч
- Дарахад input болж хувирах, "Хадгалах" / "Цуцлах" товч
- Хадгалахад PUT /auth/username дуудах, шинэ JWT token хадгалах

## 3. Profile tab сайжруулалт
- Avatar дээр дарахад crop/resize боломж (энгийн canvas crop)
- Avatar хэмжээ validation: max 500KB (одоо 2MB)
- Нэвтэрсэн огноо, нийт тоглоомын тоо зэрэг мэдээлэл нэмэх
- Discord unlink товч нэмэх (discord_id=null болгох)

### Server (server/src/routes/auth.js):
```js
// PUT /auth/unlink-discord
router.put('/unlink-discord', authMW, async (req, res) => {
  if (await dbOk()) {
    try {
      // Нууц үг байгаа эсэх шалгах (Discord-ээр л нэвтэрдэг хэрэглэгч unlink хийвэл нэвтрэх боломжгүй болно)
      const user = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
      if (!user.rows[0]?.password_hash)
        return res.status(400).json({ error: 'Эхлээд нууц үг тохируулна уу. Discord-г салгасны дараа нэвтрэх аргагүй болно.' });

      await db.query('UPDATE users SET discord_id=NULL WHERE id=$1', [req.user.id]);
      return res.json({ ok: true });
    } catch (e) { console.error(e); }
  }
  res.status(500).json({ error: 'Серверийн алдаа' });
});
```

## 4. Connection status indicator
Хэрэглэгчид серверийн холболтын байдлыг мэдэх хэрэгтэй.

### Client (client/src/renderer/app.js):
```js
// Socket connection status tracking
socket.on('connect', () => {
  updateConnectionStatus('online');
});
socket.on('disconnect', () => {
  updateConnectionStatus('offline');
});
socket.on('reconnecting', () => {
  updateConnectionStatus('reconnecting');
});

function updateConnectionStatus(status) {
  const indicator = document.getElementById('connection-status');
  if (!indicator) return;
  indicator.className = `connection-status ${status}`;
  indicator.textContent = {
    online: '🟢 Холбогдсон',
    offline: '🔴 Салгагдсан',
    reconnecting: '🟡 Дахин холбогдож байна...'
  }[status];
}
```

### Client (client/src/renderer/index.html):
Header-д нэмэх:
```html
<span id="connection-status" class="connection-status online">🟢 Холбогдсон</span>
```

### Client (client/src/renderer/styles.css):
```css
.connection-status {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 12px;
  background: var(--bg-secondary);
}
.connection-status.offline { color: #f04747; }
.connection-status.reconnecting { color: #faa61a; }
.connection-status.online { color: #43b581; }
```

## 5. Алдааны мессеж сайжруулалт
Одоо "ECONNREFUSED", "Network Error" гэх мэт техникийн мессежүүд шууд харагддаг.

### Client (client/src/services/api.js):
```js
function friendlyError(err) {
  if (!err.response) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')
      return 'Серверт холбогдох боломжгүй байна. Интернэт холболтоо шалгана уу.';
    if (err.code === 'ETIMEDOUT')
      return 'Серверээс хариу ирсэнгүй. Дахин оролдоно уу.';
    return 'Сүлжээний алдаа гарлаа. Интернэт холболтоо шалгана уу.';
  }
  return err.response.data?.error || err.response.data?.message || 'Алдаа гарлаа';
}
```
Бүх API дуудлагад friendlyError() хэрэглэх.

Чухал: Бүх өөрчлөлт одоо байгаа функционалыг эвдэхгүй байх ёстой.
```

---

## PROMPT 7: UI/UX Polish (Интерфейс сайжруулалт)

```
Энэ Mongolian Warcraft Gaming Platform-ын Electron desktop app-ын UI/UX-ийг сайжруулах хэрэгтэй. Доорх ажлуудыг хий:

## 1. Loading state, skeleton screens
Одоо data ачаалж байхад "Ачааллаж байна..." гэсэн текст л харагддаг.

### Шийдэл:
- Room list, ranking table, friends list-д skeleton loading animation нэмэх
- CSS-д skeleton class нэмэх:
```css
.skeleton {
  background: linear-gradient(90deg, var(--bg-secondary) 25%, var(--bg-tertiary) 50%, var(--bg-secondary) 75%);
  background-size: 200% 100%;
  animation: skeleton-loading 1.5s infinite;
  border-radius: 8px;
}
@keyframes skeleton-loading {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```
- Room list loading skeleton:
```js
function renderRoomsSkeleton() {
  return Array(3).fill('').map(() => `
    <div class="room-card skeleton" style="height:120px;margin-bottom:12px;"></div>
  `).join('');
}
```

## 2. Toast notification систем
Одоо alert() ашиглаж байгааг бүгдийг toast notification болгох.

### CSS (client/src/renderer/styles.css):
```css
.toast-container {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.toast {
  padding: 12px 20px;
  border-radius: 8px;
  color: white;
  font-size: 14px;
  animation: toast-in 0.3s ease, toast-out 0.3s ease 2.7s forwards;
  max-width: 350px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}
.toast.success { background: #43b581; }
.toast.error { background: #f04747; }
.toast.info { background: #5865f2; }
.toast.warning { background: #faa61a; color: #000; }
@keyframes toast-in { from { transform: translateX(100%); opacity:0; } to { transform: translateX(0); opacity:1; } }
@keyframes toast-out { from { opacity:1; } to { opacity:0; } }
```

### JS (client/src/renderer/app.js):
```js
function showToast(message, type = 'info', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}
```
- Бүх alert() дуудлагыг showToast() болгох
- Friend request хүлээн авахад showToast()
- Өрөө үүсгэхэд showToast('success')
- Алдаа гарахад showToast('error')

## 3. Товч дээрх loading state
Одоо зарим товчнууд дарахад loading indicator байхгүй, хэрэглэгч олон удаа дарж болно.

### Шийдэл:
```js
function withLoading(button, asyncFn) {
  return async (...args) => {
    if (button.disabled) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '⏳ ...';
    try {
      await asyncFn(...args);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  };
}
```
- Room create, join, leave, kick товчнуудад ашиглах
- Friend request, accept, decline товчнуудад ашиглах
- Login, register товчнуудад ашиглах (одоо хийгдсэн байгаа, давхардалгүй)

## 4. Confirmation modal
Одоо confirm() ашиглаж байгааг custom modal болгох.

### HTML (client/src/renderer/index.html):
```html
<div id="confirm-modal" class="modal-overlay" style="display:none;">
  <div class="modal-box" style="max-width:400px;">
    <h3 id="confirm-title">Баталгаажуулах</h3>
    <p id="confirm-message"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
      <button id="confirm-cancel" class="btn-secondary">Цуцлах</button>
      <button id="confirm-ok" class="btn-danger">Тийм</button>
    </div>
  </div>
</div>
```

### JS:
```js
function showConfirm(title, message) {
  return new Promise(resolve => {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-modal').style.display = 'flex';
    document.getElementById('confirm-ok').onclick = () => {
      document.getElementById('confirm-modal').style.display = 'none';
      resolve(true);
    };
    document.getElementById('confirm-cancel').onclick = () => {
      document.getElementById('confirm-modal').style.display = 'none';
      resolve(false);
    };
  });
}
```
- Өрөө хаах, найз устгах, хэрэглэгч блоклох дээр ашиглах

## 5. Responsive improvements
- Room card grid-ийг жижиг дэлгэцэнд 1 column болгох:
```css
@media (max-width: 900px) {
  .rooms-grid { grid-template-columns: 1fr; }
  .chat-layout { flex-direction: column; }
}
```
- Chat panel-ийн DM хэсгийг жижигрүүлж болохуйц болгох (resizable)

## 6. Keyboard shortcuts
- Ctrl+Enter: Мессеж илгээх (chat input дээр)
- Escape: Modal хаах
- Tab: Tab-ууд хооронд шилжих

Чухал: Бүх өөрчлөлт одоо байгаа функционалыг эвдэхгүй байх ёстой. CSS өөрчлөлтийг client/src/renderer/styles.css файлд нэмнэ.
```

---

## Ашиглах заавар

1. **Prompt 1 (Security)** — Хамгийн эхэнд хийх. Бусад prompt-ууд үүн дээр тулгуурлана.
2. **Prompt 2 (Chat)** — Security хийсний дараа. Socket auth-тай уялдана.
3. **Prompt 3 (Social)** — Chat-тай зэрэг хийж болно.
4. **Prompt 4 (Rooms)** — Security хийсний дараа хийх.
5. **Prompt 5 (Stats)** — Rooms-тай зэрэг хийж болно.
6. **Prompt 6 (Auth/UX)** — Дурын дарааллаар.
7. **Prompt 7 (UI/UX)** — Хамгийн сүүлд хийх (бусад feature-ууд бэлэн болсны дараа).

Prompt бүрийг шинэ Claude conversation дээр ажиллуулахдаа файлуудыг уншуулж эхлэх нь зүйтэй.
