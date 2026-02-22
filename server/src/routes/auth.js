const express = require('express');
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcrypt');
const crypto  = require('crypto');
const authMW  = require('../middleware/auth');

let db;
try { db = require('../config/db'); } catch { db = null; }

async function dbOk() {
  if (!db) return false;
  try { await db.query('SELECT 1'); return true; } catch { return false; }
}

const router = express.Router();

// ── In-memory user store (DB байхгүй үед) ───────────────
// id → { id, username, email, password_hash, discord_id, avatar_url, wins, losses }
const memUsers = new Map();
let memNextId = 1;

function memFindByEmail(email) {
  for (const u of memUsers.values()) if (u.email === email) return u;
  return null;
}
function memFindByDiscord(discord_id) {
  for (const u of memUsers.values()) if (u.discord_id === discord_id) return u;
  return null;
}
function memFindById(id) { return memUsers.get(id); }

// ── QR / polling ─────────────────────────────────────────
const pendingTokens = new Map();

function makeJWT(user) {
  return jwt.sign(
    { id: user.id, discord_id: user.discord_id || null, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ── Бүртгэл (email + нууц үг) ────────────────────────────
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Бүх талбарыг бөглөнө үү' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Нууц үг хамгийн багадаа 6 тэмдэгт байна' });

  const hash = await bcrypt.hash(password, 10);

  if (await dbOk()) {
    try {
      const exists = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      if (exists.rows[0]) return res.status(409).json({ error: 'Энэ имэйл бүртгэлтэй байна' });
      const r = await db.query(
        `INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3) RETURNING *`,
        [username, email, hash]
      );
      return res.status(201).json({ token: makeJWT(r.rows[0]), user: r.rows[0] });
    } catch (e) { console.error(e); }
  }
  // In-memory fallback
  if (memFindByEmail(email)) return res.status(409).json({ error: 'Энэ имэйл бүртгэлтэй байна' });
  const user = { id: memNextId++, username, email, password_hash: hash, discord_id: null, avatar_url: null, wins: 0, losses: 0 };
  memUsers.set(user.id, user);
  res.status(201).json({ token: makeJWT(user), user: { id: user.id, username, email, avatar_url: null } });
});

// ── Нэвтрэх (email + нууц үг) ────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Имэйл, нууц үгээ оруулна уу' });

  if (await dbOk()) {
    try {
      const r = await db.query('SELECT * FROM users WHERE email = $1', [email]);
      const user = r.rows[0];
      if (!user || !user.password_hash) return res.status(401).json({ error: 'Имэйл эсвэл нууц үг буруу' });
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Имэйл эсвэл нууц үг буруу' });
      return res.json({ token: makeJWT(user), user });
    } catch (e) { console.error(e); }
  }
  // In-memory fallback
  const user = memFindByEmail(email);
  if (!user) return res.status(401).json({ error: 'Имэйл эсвэл нууц үг буруу' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Имэйл эсвэл нууц үг буруу' });
  res.json({ token: makeJWT(user), user: { id: user.id, username: user.username, email: user.email, avatar_url: user.avatar_url } });
});

// ── Discord OAuth2 эхлүүлэх ──────────────────────────────
router.get('/discord', (req, res) => {
  // state-д QR sessionId болон link userId хоёуланг encode хийнэ
  let stateVal = req.query.state || '';
  if (req.query.link) {
    // "link:userId" эсвэл "link:userId:qrState" хэлбэрт хадгалана
    stateVal = `link:${req.query.link}${stateVal ? ':' + stateVal : ''}`;
  }

  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify',
  });
  if (stateVal) params.set('state', stateVal);
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// ── Discord callback ──────────────────────────────────────
router.get('/discord/callback', async (req, res) => {
  const { code, state: rawState } = req.query;
  if (!code) return res.status(400).send('Code байхгүй байна');

  // state decode: "link:userId[:qrState]" эсвэл "qrState" эсвэл хоосон
  let link  = null;
  let state = rawState || '';
  if (rawState && rawState.startsWith('link:')) {
    const parts = rawState.slice(5).split(':');
    link  = parts[0];
    state = parts[1] || '';
  }

  try {
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  process.env.DISCORD_REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = tokenRes.data.access_token;
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const { id: discord_id, username, avatar } = userRes.data;
    const avatar_url = avatar ? `https://cdn.discordapp.com/avatars/${discord_id}/${avatar}.png` : null;

    let jwtToken;

    if (await dbOk()) {
      try {
        let userRow;
        if (link) {
          // Discord-г одоо байгаа хэрэглэгчтэй холбох
          await db.query(
            'UPDATE users SET discord_id = $1, avatar_url = COALESCE(avatar_url, $2) WHERE id = $3',
            [discord_id, avatar_url, link]
          );
          const r = await db.query('SELECT * FROM users WHERE id = $1', [link]);
          userRow = r.rows[0];
        } else {
          const r = await db.query(
            `INSERT INTO users (discord_id, username, avatar_url)
             VALUES ($1,$2,$3)
             ON CONFLICT (discord_id) DO UPDATE SET username=$2, avatar_url=$3
             RETURNING *`,
            [discord_id, username, avatar_url]
          );
          userRow = r.rows[0];
        }
        jwtToken = makeJWT(userRow);
      } catch (e) { console.error(e); }
    }

    if (!jwtToken) {
      // In-memory fallback
      let user;
      if (link) {
        user = memFindById(parseInt(link));
        if (user) { user.discord_id = discord_id; user.avatar_url = user.avatar_url || avatar_url; }
      } else {
        user = memFindByDiscord(discord_id);
        if (!user) {
          user = { id: memNextId++, username, email: null, password_hash: null, discord_id, avatar_url, wins: 0, losses: 0 };
          memUsers.set(user.id, user);
        } else {
          user.username = username; user.avatar_url = avatar_url;
        }
      }
      jwtToken = makeJWT(user || { id: discord_id, discord_id, username, avatar_url });
    }

    // QR flow
    if (state) {
      pendingTokens.set(state, jwtToken);
      setTimeout(() => pendingTokens.delete(state), 5 * 60 * 1000);
      return res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Нэвтэрлээ</title>
<style>body{font-family:sans-serif;background:#0d0d1a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px}h2{color:#43b581}p{color:#a0a0b0}</style>
</head><body><h2>✅ Амжилттай нэвтэрлээ!</h2><p>Апп руу буцаж байна...</p></body></html>`);
    }

    // Popup flow
    res.redirect(`wc3platform://auth?token=${jwtToken}`);
  } catch (err) {
    console.error('Discord auth алдаа:', err.response?.data || err.message);
    res.status(500).send(`Нэвтрэхэд алдаа гарлаа`);
  }
});

// ── QR polling ────────────────────────────────────────────
router.get('/poll/:sessionId', (req, res) => {
  const token = pendingTokens.get(req.params.sessionId);
  if (token) { pendingTokens.delete(req.params.sessionId); return res.json({ token }); }
  res.json({ token: null });
});

// ── Нууц үг солих (нэвтэрсэн байхад) ────────────────────
router.put('/password', authMW, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword)
    return res.status(400).json({ error: 'Бүх талбарыг бөглөнө үү' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'Шинэ нууц үг хамгийн багадаа 6 тэмдэгт байна' });

  if (await dbOk()) {
    try {
      const r = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
      const user = r.rows[0];
      if (!user || !user.password_hash)
        return res.status(400).json({ error: 'Нууц үгийн бүртгэл байхгүй (Discord-ээр нэвтэрсэн хэрэглэгч)' });
      const ok = await bcrypt.compare(oldPassword, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Хуучин нууц үг буруу байна' });
      const newHash = await bcrypt.hash(newPassword, 10);
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);
      return res.json({ ok: true });
    } catch (e) { console.error(e); }
  }
  // In-memory fallback
  const user = memFindById(req.user.id);
  if (!user || !user.password_hash)
    return res.status(400).json({ error: 'Нууц үгийн бүртгэл байхгүй' });
  const ok = await bcrypt.compare(oldPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Хуучин нууц үг буруу байна' });
  user.password_hash = await bcrypt.hash(newPassword, 10);
  res.json({ ok: true });
});

// ── Профайл зураг солих ───────────────────────────────────
router.put('/avatar', authMW, async (req, res) => {
  const { avatar_url } = req.body;
  if (!avatar_url) return res.status(400).json({ error: 'avatar_url шаардлагатай' });
  if (!avatar_url.startsWith('data:image/') && !avatar_url.startsWith('https://'))
    return res.status(400).json({ error: 'Зөвшөөрөгдөөгүй зургийн формат' });

  if (await dbOk()) {
    try {
      await db.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [avatar_url, req.user.id]);
      const updated = { ...req.user, avatar_url };
      return res.json({ ok: true, avatar_url, token: makeJWT(updated) });
    } catch (e) { console.error(e); }
  }
  const u = memFindById(req.user.id);
  if (u) u.avatar_url = avatar_url;
  const updated = { ...req.user, avatar_url };
  res.json({ ok: true, avatar_url, token: makeJWT(updated) });
});

// ── Нууц үг сэргээх — token үүсгэх ──────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Имэйл оруулна уу' });

  if (await dbOk()) {
    try {
      const user = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      if (!user.rows[0]) return res.status(404).json({ error: 'Энэ имэйлтэй хэрэглэгч олдсонгүй' });

      const token     = crypto.randomBytes(32).toString('hex');
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

// ── Нууц үг сэргээх — шинэ нууц үгтэй token ашиглах ────
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

// ── Username өөрчлөх ──────────────────────────────────────
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
  // In-memory fallback
  const u = memFindById(req.user.id);
  if (u) u.username = clean;
  return res.json({ ok: true, token: makeJWT({ ...req.user, username: clean }), username: clean });
});

// ── Discord холболт салгах ────────────────────────────────
router.put('/unlink-discord', authMW, async (req, res) => {
  if (await dbOk()) {
    try {
      const user = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
      if (!user.rows[0]?.password_hash)
        return res.status(400).json({ error: 'Эхлээд нууц үг тохируулна уу. Discord-г салгасны дараа нэвтрэх аргагүй болно.' });

      await db.query('UPDATE users SET discord_id=NULL WHERE id=$1', [req.user.id]);
      return res.json({ ok: true });
    } catch (e) { console.error(e); }
  }
  res.status(500).json({ error: 'Серверийн алдаа' });
});

// ── Өөрийн мэдээлэл ──────────────────────────────────────
router.get('/me', authMW, async (req, res) => {
  if (await dbOk()) {
    try {
      const r = await db.query('SELECT id,username,email,discord_id,avatar_url,wins,losses FROM users WHERE id=$1', [req.user.id]);
      if (r.rows[0]) return res.json(r.rows[0]);
    } catch {}
  }
  const u = memFindById(req.user.id);
  res.json(u ? { id: u.id, username: u.username, email: u.email, discord_id: u.discord_id, avatar_url: u.avatar_url, wins: u.wins||0, losses: u.losses||0 } : req.user);
});

module.exports = router;
