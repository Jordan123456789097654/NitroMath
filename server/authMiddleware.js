const jwt = require('jsonwebtoken');
const db = require('./db');
const { JWT_SECRET } = require('./secrets');

/**
 * Extract authenticated user from headers, cookies, query parameter, or session
 */
async function getAuthUser(req) {
  if (req.user) return req.user;
  let user = null;
  let token = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.cookies && req.cookies.nitro_jwt_token) {
    token = req.cookies.nitro_jwt_token;
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.id) user = await db.getUserById(decoded.id);
    } catch (e) {}
  }

  if (!user && req.session && req.session.user) {
    try {
      user = await db.getUserById(req.session.user.id);
    } catch (e) {}
  }

  return user;
}

/**
 * Express middleware for authentication with automatic guest fallback
 */
const authMiddleware = async (req, res, next) => {
  try {
    const user = await getAuthUser(req);
    if (user) {
      req.user = user;
    } else {
      req.user = {
        id: 'guest_' + Math.random().toString(36).substring(2, 9),
        username: (req.session && req.session.user && req.session.user.username) || (req.body && req.body.username) || 'Guest_' + Math.floor(Math.random() * 1000)
      };
    }
    next();
  } catch (err) {
    next();
  }
};

module.exports = {
  getAuthUser,
  authMiddleware
};
