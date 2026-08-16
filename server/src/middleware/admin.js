const jwt = require('jsonwebtoken');

let db;
try { db = require('../config/db'); } catch { db = null; }

// Үндсэн (bootstrap) админууд — ADMIN_DISCORD_IDS env-ээс. Эдгээрийг dashboard-оос
// устгаж болохгүй; зөвхөн серверийн тохиргоогоор удирдана.
function adminDiscordIds() {
  return String(process.env.ADMIN_DISCORD_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isEnvAdmin(discordId) {
  if (!discordId) return false;
  return adminDiscordIds().includes(String(discordId));
}

// Динамик админууд — admin_whitelist хүснэгтээс (dashboard-оор нэмсэн).
async function isDbAdmin(discordId) {
  if (!db || !discordId) return false;
  try {
    const r = await db.query('SELECT 1 FROM admin_whitelist WHERE discord_id = $1', [String(discordId)]);
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

async function isAdminDiscordId(discordId) {
  if (isEnvAdmin(discordId)) return true;
  return isDbAdmin(discordId);
}

// JWT-г шалгаад, тухайн хэрэглэгчийн Discord ID env эсвэл DB whitelist-д байгаа эсэхийг шаардана.
async function adminMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  if (!(await isAdminDiscordId(payload.discord_id))) {
    // Өөрийнх нь Discord ID-г буцаана — анхны админ тохируулахад whitelist-д нэмэхэд хэрэгтэй
    // (хэрэглэгч аль хэдийн энэ ID-аар нэвтэрсэн тул нууц задрал биш).
    return res.status(403).json({ error: 'Admin access required', your_discord_id: payload.discord_id || null });
  }

  req.user = payload;
  next();
}

module.exports = adminMiddleware;
module.exports.isAdminDiscordId = isAdminDiscordId;
module.exports.isEnvAdmin = isEnvAdmin;
module.exports.adminDiscordIds = adminDiscordIds;
