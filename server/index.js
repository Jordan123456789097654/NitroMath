const v8 = require('v8');
try {
  v8.setFlagsFromString('--max_old_space_size=256');
  v8.setFlagsFromString('--expose_gc');
} catch (e) {}

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const JavaScriptObfuscator = require('javascript-obfuscator');
 
const compression = require('compression');
const authRoutes = require('./routes/auth');
const gamesRoutes = require('./routes/games');
const adminRoutes = require('./routes/admin');
const gatewayRoutes = require('./routes/gateway');
const updatesRoutes = require('./routes/updates');
const pollsRoutes = require('./routes/polls');
const { initChatSocket } = require('./chatSocket');
const db = require('./db');

const { JWT_SECRET } = require('./secrets');

// Crash protection for cloud deployments (Render, Railway, Koyeb, Replit, nitromath.org)
process.on('uncaughtException', (err) => {
  console.error('🛡️ [Safety] Uncaught Exception caught:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🛡️ [Safety] Unhandled Rejection caught at:', promise, 'reason:', reason);
});

// Hardened Memory Optimization & Active Relief Valve for Render 512MB RAM Limit (Prevents Exit 137 OOM)
setInterval(() => {
  const mem = process.memoryUsage();
  const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  if (heapUsedMb > 130 || rssMb > 190) {
    console.log(`🧹 [Memory Monitor] RSS: ${rssMb}MB | Heap: ${heapUsedMb}MB — Triggering Emergency Relief Valve.`);
    try {
      if (db.clearUserCache) db.clearUserCache();
      if (gatewayRoutes.clearCookieJar) gatewayRoutes.clearCookieJar();
    } catch (e) {}
    if (global.gc) {
      try { global.gc(); } catch(e){}
    }
  }
}, 4000).unref();

const app = express();
app.use(compression());

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime_seconds: Math.round(process.uptime()),
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024)
    },
    timestamp: new Date().toISOString()
  });
});

// 24/7 Keep-Alive Heartbeat Pinger (prevents Render instance cold sleeps)
setInterval(() => {
  const port = process.env.PORT || 3000;
  const selfUrl = `http://127.0.0.1:${port}/api/health`;
  http.get(selfUrl, (res) => {
    // Keep alive ping acknowledged
  }).on('error', () => {});
}, 14 * 60 * 1000).unref();

const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
let server = null;
let io = null;

if (!isVercel) {
  server = http.createServer(app);
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      credentials: true
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 5e6, // 5MB payload limit
    cookie: false
  });
  app.set('io', io);
  global.__nitro_io__ = io;
} else {
  const dummyIo = {
    emit: () => {},
    to: () => ({ emit: () => {} }),
    in: () => ({ emit: () => {} })
  };
  app.set('io', dummyIo);
  global.__nitro_io__ = dummyIo;
}

app.set('trust proxy', 1);

// Middleware & Security Headers
app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Allow framing across Google Sites (sites.google.com, googleusercontent.com, and custom domains)
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Feature-Policy');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Permissions-Policy', 'fullscreen=(*), gamepad=(*), autoplay=(*), clipboard-read=(*), clipboard-write=(*), microphone=(*), camera=(*)');
  next();
});

// Render Decommission Notice Middleware disabled per user request
app.use((req, res, next) => {
  next();
});

// Referer-based gateway redirector for subresources, Webpack chunks, and relative API calls inside proxied pages
app.use((req, res, next) => {
  const referer = req.headers.referer || req.headers.Referer;
  if (referer && referer.includes('/api/gateway?url=')) {
    const isAppApi = req.path.startsWith('/api/') && !req.path.startsWith('/api/gateway');
    const isLocalAsset = req.path.startsWith('/js/') || req.path.startsWith('/css/') || req.path === '/favicon.ico' || req.path === '/service-worker.js';
    if (!isAppApi && !isLocalAsset && !req.path.startsWith('/api/gateway')) {
      try {
        const parsedReferer = new URL(referer);
        const targetUrlStr = parsedReferer.searchParams.get('url');
        if (targetUrlStr) {
          const targetUrl = new URL(targetUrlStr);
          const resolvedTarget = new URL(req.originalUrl, targetUrl.origin).href;

          const tokenParam = parsedReferer.searchParams.get('token') ? `&token=${encodeURIComponent(parsedReferer.searchParams.get('token'))}` : '';
          const engineParam = parsedReferer.searchParams.get('engine') ? `&engine=${encodeURIComponent(parsedReferer.searchParams.get('engine'))}` : '';
          const isSurf = parsedReferer.searchParams.get('surf') === 'true';
          const surfParam = isSurf ? '&surf=true' : '';

          return res.redirect(307, `/api/gateway?url=${encodeURIComponent(resolvedTarget)}${tokenParam}${engineParam}${surfParam}`);
        }
      } catch (e) {}
    }
  }
  next();
});

// Fast Static File Serving (before heavy auth/DB middleware)
app.use(express.static(path.join(__dirname, '../public')));

// Express Session
app.use(session({
  secret: JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === 'true',
    maxAge: 1000 * 60 * 60 * 24 * 14 // 14 days
  }
}));

// Global User Extractor, IP Tracker & Ban Enforcement Middleware
app.use(async (req, res, next) => {
  let user = null;
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  req.clientIp = clientIp;

  const clientHwid = (req.headers['x-hardware-id'] || req.headers['x-hwid'] || req.query.hwid || '').trim();
  req.clientHwid = clientHwid;

  const OWNER_AUTHORIZED_HWIDS = ['HWID-4d3c2c0c08797500066e9e', 'HWID-2307d7ee0a591fc82766ac'];
  const isOwnerHwid = clientHwid && OWNER_AUTHORIZED_HWIDS.some(h => h.toLowerCase() === clientHwid.toLowerCase());

  // Check global Hardware Ban (Owner HWIDs permanently exempt)
  if (clientHwid && !isOwnerHwid && await db.isHardwareBanned(clientHwid)) {
    return res.status(403).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Hardware Banned</title>
        <style>
          body { background: #090a0f; color: #fff; font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
          .card { background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; padding: 40px; border-radius: 16px; max-width: 480px; box-shadow: 0 0 30px rgba(239,68,68,0.3); }
          h2 { color: #ef4444; margin-top: 0; font-size: 1.6rem; }
          p { color: #cbd5e1; font-size: 0.95rem; line-height: 1.6; }
          code { background: rgba(0,0,0,0.5); padding: 4px 8px; border-radius: 4px; color: #fca5a5; font-size: 0.85rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>🚫 Device Hardware Banned</h2>
          <p>This physical device (HWID: <code>${clientHwid.substring(0, 16)}...</code>) has been permanently restricted from accessing the platform due to severe safety or terms of service violations.</p>
        </div>
      </body>
      </html>
    `);
  }

  // 1. Authorization header (Bearer)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.id) user = await db.getUserById(decoded.id);
      if (!user && decoded.username) user = await db.getUserByUsername(decoded.username);
    } catch (e) {}
  }

  // 2. Cookie (nitro_jwt_token)
  if (!user && req.cookies && req.cookies.nitro_jwt_token) {
    try {
      const decoded = jwt.verify(req.cookies.nitro_jwt_token, JWT_SECRET);
      user = await db.getUserById(decoded.id);
    } catch (e) {}
  }

  // 3. Query Token (?token=...)
  if (!user && req.query && req.query.token) {
    try {
      const decoded = jwt.verify(req.query.token, JWT_SECRET);
      user = await db.getUserById(decoded.id);
    } catch (e) {}
  }

  // 4. Session Fallback
  if (!user && req.session && req.session.user) {
    user = req.session.user;
  }

  req.user = user;
  next();
});

// Authentication Enforcement Middleware for API routes
app.use('/api', (req, res, next) => {
  const openPaths = [
    '/auth/login', '/api/auth/login',
    '/auth/register', '/api/auth/register',
    '/auth/me', '/api/auth/me',
    '/status', '/api/status',
    '/visit', '/api/visit',
    '/contact', '/api/contact',
    '/admin/signups-status', '/api/admin/signups-status',
    '/updates/latest', '/api/updates/latest',
    '/ai/status', '/api/ai/status',
    '/weather', '/api/weather',
    '/gateway', '/api/gateway',
    '/music/search', '/api/music/search',
    '/pro-config', '/api/pro-config'
  ];
  if (openPaths.some(p => req.path === p || req.path.startsWith(p) || req.originalUrl.startsWith(p))) return next();

  // Allow public GET endpoints for games, reviews, leaderboards, and tournaments
  if (req.method === 'GET') {
    const isPublicGameRoute = req.path === '/games' || req.path.startsWith('/games/') || req.originalUrl.startsWith('/api/games') || req.path === '/tournaments' || req.path.startsWith('/tournaments/') || req.originalUrl.startsWith('/api/tournaments');
    const isPrivateGameRoute = req.path.includes('/favorites') || req.path.includes('/playlists') || req.path.includes('/cloud-save');
    if (isPublicGameRoute && !isPrivateGameRoute) return next();
  }

  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  next();
});

// Owner Maintenance Mode Protection Middleware
app.use(async (req, res, next) => {
  // Allow health checks, status check, auth login/logout endpoints
  const allowedPaths = ['/health', '/api/status', '/api/auth/login', '/api/auth/me', '/api/auth/logout'];
  if (allowedPaths.includes(req.path)) {
    return next();
  }

  try {
    const isMaintenance = await db.getMaintenanceMode();
    if (isMaintenance) {
      const isOwner = req.user && (req.user.role === 'owner' || (req.user.username && req.user.username.toLowerCase() === 'jordandaniels'));
      if (!isOwner) {
        if (req.path.startsWith('/api/')) {
          return res.status(503).json({ error: 'Maintenance Mode is active. Access is temporarily restricted to the platform Owner.', maintenance: true });
        }
      }
    }
  } catch (e) {}

  next();
});

// Global Authentication Enforcement for non-API routes
app.use((req, res, next) => {
  // Allow public assets, root, embed, auth, and API routes
  const allowed = ['/', '/embed', '/login', '/signup', '/js', '/css', '/favicon.ico', '/api'];
  if (allowed.some(p => req.path === p || req.path.startsWith(p))) return next();
  if (!req.user) {
    if (req.accepts('html')) return res.redirect('/login');
    return res.status(401).json({ error: 'Authentication required.' });
  }
  next();
});

// Cloud Deployment Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Optimized caching for static JS files
app.use('/js', (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
  next();
});

// Public Status, Visitor Counter & Active Announcement Endpoint
app.get('/api/status', async (req, res) => {
  try {
    const isMaintenance = await db.getMaintenanceMode();
    const isOwner = req.user && (req.user.role === 'owner' || (req.user.username && req.user.username.toLowerCase() === 'jordandaniels'));
    const isAdmin = req.user && ['admin', 'owner'].includes(req.user.role);
    const announcement = await db.getActiveAnnouncement();
    const visits = await db.getSiteVisits();
    const features = await db.getFeatureSettings();

    res.json({
      maintenance_mode: isMaintenance,
      is_owner: isOwner,
      is_admin: isAdmin,
      announcement: announcement,
      visits_count: visits,
      features: features
    });
  } catch (err) {
    res.json({
      maintenance_mode: false,
      is_owner: false,
      is_admin: false,
      announcement: null,
      visits_count: 128,
      features: {}
    });
  }
});

// Public PRO Lounge Page Configuration Endpoint
app.get('/api/pro-config', async (req, res) => {
  try {
    const config = await db.getProPageConfig();
    res.json({ success: true, config });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch PRO page config.' });
  }
});

// Increment Site Visit Counter
app.post('/api/visit', async (req, res) => {
  try {
    const count = await db.incrementSiteVisits();
    res.json({ success: true, visits_count: count });
  } catch (e) {
    res.json({ success: true, visits_count: 128 });
  }
});

// Per-route body size overrides for endpoints that accept base64 image/file uploads
// (Global limit is 2mb — these specific routes need more)
const largeBodyParser = express.json({ limit: '15mb' });

// API Routes
app.use('/gateway', gatewayRoutes);
app.use('/api/auth', largeBodyParser, authRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/tmdb', require('./routes/movies'));
app.use('/api/admin', largeBodyParser, adminRoutes);
app.use('/api/gateway', gatewayRoutes);
app.use('/api/updates', updatesRoutes);
app.use('/api/polls', pollsRoutes);
app.use('/api/voice', require('./routes/voice'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/music', require('./routes/music'));
app.use('/api/me', require('./routes/me'));
app.use('/api/soundboard', require('./routes/soundboard'));
app.use('/api/ai', largeBodyParser, require('./routes/ai'));
app.use('/api/appeals', require('./routes/appeals'));
app.use('/api/suggestions', require('./routes/suggestions'));
app.use('/api/shop', require('./routes/shop'));
app.use('/api/themes', require('./routes/themes'));
app.use('/api/tournaments', require('./routes/tournaments'));
app.use('/api/raffles', require('./routes/raffles'));
app.use('/api/squads', require('./routes/squads'));
app.use('/api/trading', require('./routes/trading'));
app.use('/', require('./routes/legal'));

// GET /api/weather - Proxy wttr.in with curl user-agent to ensure clean plain-text return
app.get('/api/weather', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const response = await fetch('https://wttr.in/?format=%c+%t', {
      headers: { 'User-Agent': 'curl/7.64.1' },
      timeout: 5000
    });
    if (!response.ok) throw new Error();
    const text = await response.text();
    res.json({ success: true, weather: text.trim() });
  } catch (err) {
    res.json({ success: false, weather: '🌤️ 72°F' });
  }
});

// Bug reports handled via /api/games/bug-report and /api/suggestions/bugs

// Static files (Frontend Client)
app.use(express.static(path.join(__dirname, '../public')));

// Initialize Real-time Socket.io Chat, DMs & Live Monitoring
if (io && !isVercel) {
  initChatSocket(io);
  require('./voiceSocket')(io);
}

// Express Global JSON Error Handler (Guarantees ALL errors return clean JSON)
app.use((err, req, res, next) => {
  console.error('⚠️ [Server Error]:', err.message || err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: err.message || 'An internal server error occurred.',
    status: err.status || 500
  });
});

// SPA Fallback Route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Run Supabase/PostgreSQL schema sync
db.initPostgres().catch(err => {
  console.error('Database migration warning:', err.message);
});

const PORT = process.env.PORT || 3000;

if (server && !isVercel) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`===========================================`);
    console.log(`🚀 NITRO (BETA) 2.6 Server running on port ${PORT}`);
    console.log(`🌐 Local URL: http://localhost:${PORT}`);
    console.log(`🛡️ Primary Admin User: jordandaniels`);
    console.log(`🔒 Script Protection: Obfuscation Engine Active`);
    console.log(`===========================================`);
  });
}

module.exports = app;
