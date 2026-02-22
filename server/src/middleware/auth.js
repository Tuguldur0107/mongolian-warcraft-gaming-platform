const jwt = require('jsonwebtoken');

// Хатуу auth — token заавал шаардана
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token байхгүй байна' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token буруу эсвэл хугацаа дууссан' });
  }
}

// Зөөлөн auth — token байхгүй үед dev fallback хэрэглэгч ашиглана
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      // Token буруу — нэвтрээгүй хэрэглэгч (id:0 нь DB-д байхгүй)
      req.user = { id: 0, discord_id: null, username: 'Тоглогч' };
    }
  } else {
    req.user = { id: 0, discord_id: null, username: 'Тоглогч' };
  }
  next();
}

module.exports = authMiddleware;
module.exports.optional = optionalAuth;
