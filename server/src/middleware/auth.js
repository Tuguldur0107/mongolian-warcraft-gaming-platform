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
      req.user = { id: 1, discord_id: '000', username: 'Тоглогч' };
    }
  } else {
    req.user = { id: 1, discord_id: '000', username: 'Тоглогч' };
  }
  next();
}

module.exports = authMiddleware;
module.exports.optional = optionalAuth;
