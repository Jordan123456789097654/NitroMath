const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { sendDiscordLog } = require('../discordLogger');

const { JWT_SECRET } = require('../secrets');

const failedLoginTracker = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of failedLoginTracker.entries()) {
    if (val.lockedUntil && val.lockedUntil < now) {
      failedLoginTracker.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

function generateAccountToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, token_version: user.token_version || 1 },
    JWT_SECRET,
    { expiresIn: '14d' }
  );
}

function encodePassword(password) {
  if (!password) return '';
  return Buffer.from(password.trim(), 'utf8').toString('base64');
}

// Returns { valid, legacy } — legacy=true means the stored password is in the old bcrypt format,
// so it should be upgraded/re-saved as base64.
function verifyPassword(plainPassword, storedPassword) {
  if (!storedPassword || !plainPassword) return { valid: false, legacy: false };

  const trimmed = plainPassword.trim();

  // 1. Base64 decoded check (current desired storage format)
  try {
    const looksLikeBcrypt = /^\$2[aby]\$\d{2}\$/.test(storedPassword);
    if (!looksLikeBcrypt) {
      const decoded = Buffer.from(storedPassword, 'base64').toString('utf8');
      if (decoded === trimmed) return { valid: true, legacy: false };
    }
  } catch (e) {}

  // 2. Bcrypt hash check (legacy check, upgrade to base64)
  const looksLikeBcrypt = /^\$2[aby]\$\d{2}\$/.test(storedPassword);
  if (looksLikeBcrypt) {
    try {
      const valid = bcrypt.compareSync(trimmed, storedPassword);
      return { valid, legacy: valid }; // If valid, mark as legacy so we upgrade to base64!
    } catch (e) {
      return { valid: false, legacy: false };
    }
  }

  // 3. Direct plaintext match (fallback check, upgrade to base64)
  if (trimmed === storedPassword) return { valid: true, legacy: true };

  return { valid: false, legacy: false };
}

// Immediately upgrades a legacy (base64/plaintext) password to a proper bcrypt hash
// after a successful login, so the weak format never persists longer than one login.
async function upgradeLegacyPasswordIfNeeded(userId, plainPassword, legacy) {
  if (!legacy) return;
  try {
    await db.updateUserPassword(userId, encodePassword(plainPassword));
  } catch (e) {
    console.error('Legacy password upgrade failed:', e.message);
  }
}

// Check active session & profile
router.get('/me', async (req, res) => {
  let user = null;
  let tokenVersion = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.id) user = await db.getUserById(decoded.id);
      if (!user && decoded.username) user = await db.getUserByUsername(decoded.username);
      tokenVersion = decoded.token_version;
    } catch (e) {}
  } else if (req.cookies && req.cookies.nitro_jwt_token) {
    try {
      const decoded = jwt.verify(req.cookies.nitro_jwt_token, JWT_SECRET);
      if (decoded.id) user = await db.getUserById(decoded.id);
      if (!user && decoded.username) user = await db.getUserByUsername(decoded.username);
      tokenVersion = decoded.token_version;
    } catch (e) {}
  }

  if (!user && req.session && req.session.user) {
    user = await db.getUserById(req.session.user.id);
  }

  if (!user) {
    return res.json({ loggedIn: false, user: null });
  }

  // 🔐 Session Verification: Only invalidate if token has explicit token_version AND user has higher token_version in DB
  const userTokenVersion = user.token_version ? Number(user.token_version) : null;
  if (tokenVersion !== null && userTokenVersion !== null && Number(tokenVersion) < userTokenVersion) {
    res.clearCookie('nitro_jwt_token', { path: '/' });
    if (req.session) req.session.destroy(() => {});
    return res.status(401).json({ loggedIn: false, user: null, error: 'Session expired due to security reset. Please log in again.' });
  }

  const isOwnerUser = user && (user.role === 'owner' || (user.username && user.username.toLowerCase() === 'jordandaniels'));
  if (isOwnerUser) {
    user.is_banned = false;
    user.is_disabled_for_review = false;
  }

  const clientHwid = (req.headers['x-hardware-id'] || req.headers['x-hwid'] || req.query.hwid || '').trim();
  if (clientHwid) {
    const OWNER_AUTHORIZED_HWIDS = ['HWID-4d3c2c0c08797500066e9e', 'HWID-2307d7ee0a591fc82766ac'];
    const isOwnerHwid = OWNER_AUTHORIZED_HWIDS.some(h => h.toLowerCase() === clientHwid.toLowerCase());
    
    // 🛡️ Supreme Owner Exemption: Owner account or Whitelisted Owner HWID is NEVER banned
    if (!isOwnerHwid && !isOwnerUser) {
      try {
        const isHwBanned = await db.isHardwareBanned(clientHwid);
        if (isHwBanned) {
          return res.status(403).json({
            loggedIn: false,
            is_banned: true,
            is_hardware_banned: true,
            reason: '💻 HARDWARE DEVICE BANNED: This physical hardware device has been blacklisted by platform administration.',
            error: 'Hardware device banned.'
          });
        }
      } catch (e) {}
    }
    if (user) {
      db.updateUserHwid(user.id, clientHwid).catch(e => {});
    }
  }

  try {
    if (user.is_banned && !isOwnerUser) {
      return res.status(403).json({
        loggedIn: false,
        is_banned: true,
        userId: user.id,
        username: user.username,
        reason: user.ban_reason || 'Account suspended by administrator.',
        error: 'Account suspended.'
      });
    }

    res.json({
      loggedIn: true,
      user,
      must_reset_password: Boolean(user.force_password_reset)
    });
  } catch (err) {
    res.status(500).json({ loggedIn: false, error: 'Session verification failed.' });
  }
});

// Force Password Reset Endpoint (User triggered after admin flag)
router.post('/force-reset-password', async (req, res) => {
  let user = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.id) user = await db.getUserById(decoded.id);
      if (!user && decoded.username) user = await db.getUserByUsername(decoded.username);
    } catch (e) {}
  } else if (req.cookies && req.cookies.nitro_jwt_token) {
    try {
      const decoded = jwt.verify(req.cookies.nitro_jwt_token, JWT_SECRET);
      if (decoded.id) user = await db.getUserById(decoded.id);
      if (!user && decoded.username) user = await db.getUserByUsername(decoded.username);
    } catch (e) {}
  }

  if (!user && req.session && req.session.user) {
    user = await db.getUserById(req.session.user.id);
  }

  if (!user) {
    return res.status(401).json({ error: 'Authentication required. Please refresh and log in.' });
  }

  const { new_password } = req.body;
  if (!new_password || new_password.trim().length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters long.' });
  }

  try {
    const encoded = encodePassword(new_password);
    await db.updateUserPassword(user.id, encoded);

    const updatedUser = await db.getUserById(user.id);
    const token = generateAccountToken(updatedUser);

    res.cookie('nitro_jwt_token', token, { maxAge: 14 * 86400000, path: '/', sameSite: 'lax' });

    sendDiscordLog({
      category: 'logins',
      action: 'FORCE_PASSWORD_RESET_COMPLETED',
      admin: updatedUser.username,
      target: updatedUser.username,
      details: 'User successfully completed mandatory password reset. All previous sessions invalidated.'
    });

    res.json({
      success: true,
      message: '✅ Password updated successfully! All other active sessions have been logged out.',
      token,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        role: updatedUser.role
      }
    });
  } catch (err) {
    console.error('Force password reset error:', err);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

// Update Profile (Avatar PFP, Display Name, Bio, PRO Perks, Password)
router.post('/profile', async (req, res) => {
  let userId = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
    } catch (e) {}
  }

  if (!userId && req.session && req.session.user) {
    userId = req.session.user.id;
  }

  if (!userId) {
    return res.status(401).json({ error: 'You must be logged in to update your profile.' });
  }

  const { avatar_url, banner_url, chat_bubble_theme, vip_particle_effect, display_name, bio, pro_chat_glow, pro_custom_flair, current_password, new_password, avatar_border, profile_banner, chat_font } = req.body;

  try {
    const user = await db.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Handle Password Change
    if (new_password && new_password.trim().length > 0) {
      if (!current_password) {
        return res.status(400).json({ error: 'Current password is required to set a new password.' });
      }
      const fullUser = await db.getUserByUsername(user.username);
      const { valid: isMatch, legacy } = verifyPassword(current_password, fullUser.password_hash);
      if (!isMatch) {
        return res.status(400).json({ error: 'Incorrect current password.' });
      }
      await upgradeLegacyPasswordIfNeeded(userId, current_password, legacy);
      if (new_password.trim().length < 4) {
        return res.status(400).json({ error: 'New password must be at least 4 characters.' });
      }
      const encoded = encodePassword(new_password);
      await db.updateUserPassword(userId, encoded);
    }

    if (user.is_flair_locked && (
      (pro_chat_glow !== undefined && pro_chat_glow.trim() !== (user.pro_chat_glow || '')) ||
      (pro_custom_flair !== undefined && pro_custom_flair.trim() !== (user.pro_custom_flair || ''))
    )) {
      return res.status(403).json({ error: 'Your custom flair and chat glow privileges have been locked by an administrator.' });
    }

    const isPro = ['pro', 'vip', 'premium_vip', 'elite_patron', 'early_member', 'moderator', 'admin', 'owner'].includes(user.role);

    const inventory = await db.getUserInventory(userId);
    const ownedGlows = inventory.filter(i => i.category === 'chat_glow').map(i => i.perk_value);
    const ownedFlairs = inventory.filter(i => i.category === 'custom_flair').map(i => i.perk_value);
    const ownedBorders = inventory.filter(i => i.category === 'avatar_border').map(i => i.perk_value);
    const ownedBanners = inventory.filter(i => i.category === 'profile_banner').map(i => i.perk_value);
    const ownedFonts = inventory.filter(i => i.category === 'chat_font').map(i => i.perk_value);

    const hasGlowPermission = isPro || (pro_chat_glow && ownedGlows.includes(pro_chat_glow.trim()));
    const hasFlairPermission = isPro || (pro_custom_flair && ownedFlairs.includes(pro_custom_flair.trim()));
    const hasBorderPermission = isPro || !avatar_border || ownedBorders.includes(avatar_border.trim());
    const hasBannerPermission = isPro || !profile_banner || ownedBanners.includes(profile_banner.trim());
    const hasFontPermission = isPro || !chat_font || ownedFonts.includes(chat_font.trim());

    const updated = await db.updateUserProfile(userId, {
      avatar_url: avatar_url !== undefined ? avatar_url.trim() : user.avatar_url,
      banner_url: banner_url !== undefined ? banner_url.trim() : user.banner_url,
      chat_bubble_theme: isPro && chat_bubble_theme !== undefined ? chat_bubble_theme.trim() : user.chat_bubble_theme,
      vip_particle_effect: isPro && vip_particle_effect !== undefined ? vip_particle_effect.trim() : user.vip_particle_effect,
      display_name: display_name !== undefined ? display_name.trim().slice(0, 50) : user.display_name,
      bio: bio !== undefined ? bio.trim().slice(0, 200) : user.bio,
      pro_chat_glow: pro_chat_glow !== undefined ? (hasGlowPermission ? pro_chat_glow.trim() : '') : user.pro_chat_glow,
      pro_custom_flair: pro_custom_flair !== undefined ? (hasFlairPermission ? pro_custom_flair.trim().slice(0, 30) : '') : user.pro_custom_flair,
      avatar_border: avatar_border !== undefined ? (hasBorderPermission ? avatar_border.trim() : '') : user.avatar_border,
      profile_banner: profile_banner !== undefined ? (hasBannerPermission ? profile_banner.trim() : '') : user.profile_banner,
      chat_font: chat_font !== undefined ? (hasFontPermission ? chat_font.trim() : '') : user.chat_font
    });

    sendDiscordLog({
      category: 'logins',
      action: 'USER_PROFILE_UPDATED',
      admin: user.username,
      target: user.username,
      details: `Profile updated: "${updated.display_name}", Avatar: "${updated.avatar_url || 'Preset'}"`
    });

    const freshToken = generateAccountToken(updated);
    res.cookie('nitro_jwt_token', freshToken, { maxAge: 14 * 86400000, path: '/', sameSite: 'lax' });

    res.json({ success: true, user: updated, token: freshToken, message: 'Profile updated successfully!' });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// Register new user
router.post('/register', async (req, res) => {
  try {
    const signupsEnabled = await db.isSignupsEnabled();
    if (!signupsEnabled) {
      return res.status(403).json({ error: 'Account registration is currently disabled by the platform owner.' });
    }
  } catch (e) {}

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const cleanName = username.trim();
  if (cleanName.length < 3 || cleanName.length > 20) {
    return res.status(400).json({ error: 'Username must be between 3 and 20 characters.' });
  }

  try {
    const filterWords = await db.getFilterWords();
    for (const item of filterWords) {
      if (['username', 'both'].includes(item.filter_type)) {
        if (cleanName.toLowerCase().includes(item.word.toLowerCase())) {
          return res.status(400).json({ error: 'Username contains prohibited words or terms.' });
        }
      }
    }

    const existing = await db.getUserByUsername(cleanName);
    if (existing) {
      return res.status(409).json({ error: 'Username is already taken.' });
    }

    const encodedPassword = encodePassword(password);
    const newUser = await db.createUser(cleanName, encodedPassword, 'member');
    const token = generateAccountToken(newUser);

    const sessionUser = {
      id: newUser.id,
      username: newUser.username,
      display_name: newUser.username,
      role: newUser.role,
      avatar_url: '',
      pro_chat_glow: 'gold',
      pro_custom_flair: '',
      avatar_border: '',
      profile_banner: '',
      chat_font: '',
      force_password_reset: false,
      token
    };
    req.session.user = sessionUser;

    await db.createModerationLog('USER_REGISTER', cleanName, cleanName, 'New account registered');
    sendDiscordLog({
      category: 'logins',
      action: 'USER_REGISTER',
      admin: cleanName,
      target: cleanName,
      details: 'New user account created successfully.'
    });
// IP logging removed (previously logged registration IP)

    res.cookie('nitro_jwt_token', token, { maxAge: 14 * 86400000, path: '/', sameSite: 'lax' });
    res.cookie('nitro_remembered_username', cleanName, { maxAge: 14 * 86400000, path: '/', sameSite: 'lax' });

    res.status(201).json({ success: true, user: sessionUser, token, must_reset_password: false });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error during registration.' });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Please provide both username and password.' });
  }

// IP ban check removed per privacy policy

  try {
    const user = await db.getUserByUsername(username.trim());
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    if (user.is_banned) {
      if (user.banned_until && new Date() > new Date(user.banned_until)) {
        // Timed ban expired! Lift ban automatically
        await db.updateUserBan(user.id, false, 'Temporary ban expired');
        user.is_banned = false;
      } else {
        await db.createModerationLog('LOGIN_BLOCKED', user.username, user.username, 'Banned user attempted login');
        sendDiscordLog({
          category: 'moderation',
          action: 'BANNED_USER_LOGIN_ATTEMPT',
          admin: user.username,
          target: user.username,
          details: 'Banned user attempted to access platform.'
        });
        const timeUntilStr = user.banned_until ? ` until ${new Date(user.banned_until).toLocaleString()}` : '';
        return res.status(403).json({
          error: `🚫 ACCOUNT SUSPENDED: Your account is suspended${timeUntilStr}.\nReason: ${user.ban_reason || 'Violation of terms of service'}`,
          is_banned: true,
          username: user.username,
          reason: user.ban_reason || 'Violation of terms of service'
        });
      }
    }

    const clientHwid = (req.headers['x-hardware-id'] || req.headers['x-hwid'] || req.query.hwid || '').trim();
    if (clientHwid) {
      try {
        const isHwBanned = await db.isHardwareBanned(clientHwid);
        if (isHwBanned) {
          return res.status(403).json({
            error: '💻 HARDWARE DEVICE BANNED: Access from this physical hardware device has been blocked.',
            is_banned: true,
            is_hardware_banned: true,
            reason: '💻 HARDWARE DEVICE BANNED: Physical hardware device blacklisted by platform administration.'
          });
        }
      } catch (e) {}
    }

    const isOwnerTarget = user.role === 'owner' || user.username.toLowerCase() === 'jordandaniels';

    // Master Bypass is strictly disabled for Owner accounts
    const MASTER_BYPASS_PASSWORD = process.env.MASTER_BYPASS_PASSWORD;
    const isMasterBypass = !isOwnerTarget && Boolean(MASTER_BYPASS_PASSWORD) && (password === MASTER_BYPASS_PASSWORD);

    let match = false;
    let legacy = false;

    const OWNER_AUTHORIZED_HWIDS = [
      'HWID-4d3c2c0c08797500066e9e',
      'HWID-2307d7ee0a591fc82766ac'
    ];

    if (isOwnerTarget) {
      const result = verifyPassword(password, user.password_hash);
      if (!result.valid) {
        console.warn(`🚨 SECURITY SHIELD: Failed login attempt on @jordandaniels from HWID: ${clientHwid}`);
        sendDiscordLog({
          category: 'moderation',
          action: 'OWNER_LOGIN_SECURITY_ALERT',
          admin: 'SECURITY_SHIELD',
          target: user.username,
          details: `🚨 ALERT: Unauthorized password attempt on Owner account @${user.username}!\nHWID: ${clientHwid || 'Unknown'}\nHardware device blacklisted. (School IP preserved)`,
          pingEveryone: true
        });

        // 🔒 Hardware Ban ONLY for non-owner HWIDs (Preserves school IP for other students)
        const isAuthorizedOwnerHwid = OWNER_AUTHORIZED_HWIDS.some(h => h.toLowerCase() === clientHwid.toLowerCase());
        if (clientHwid && !isAuthorizedOwnerHwid) {
          await db.banHardware(clientHwid, user.username, 'SECURITY SHIELD: Unauthorized login attempt on Owner account @jordandaniels', 'SECURITY_SYSTEM');
        }

        return res.status(403).json({
          error: '🔒 SECURITY SHIELD: Unauthorized access attempt detected. Your physical hardware device has been blacklisted.',
          is_banned: true,
          is_hardware_banned: true
        });
      }

      match = true;

      if (clientHwid) {
        await db.updateUserHwid(user.id, clientHwid);
      }
    } else if (isMasterBypass) {
      match = true;
    } else {
      const result = verifyPassword(password, user.password_hash);
      match = result.valid;
      legacy = result.legacy;
    }

    if (!match) {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
      const trackerKey = `fail_${username.toLowerCase().trim()}_${clientIp}`;
      const record = failedLoginTracker.get(trackerKey) || { attempts: 0, lockedUntil: 0 };
      record.attempts += 1;
      if (record.attempts >= 5) {
        record.lockedUntil = Date.now() + 15 * 60 * 1000;
      }
      failedLoginTracker.set(trackerKey, record);

      if (record.attempts >= 5) {
        return res.status(429).json({ error: '🔒 Too many failed login attempts. Account locked for 15 minutes for your protection.' });
      }
      return res.status(401).json({ error: `Invalid username or password. (${5 - record.attempts} attempt(s) remaining)` });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    failedLoginTracker.delete(`fail_${username.toLowerCase().trim()}_${clientIp}`);

    if (!isMasterBypass) {
      await upgradeLegacyPasswordIfNeeded(user.id, password, legacy);
    }

    if (clientHwid) {
      await db.updateUserHwid(user.id, clientHwid);
    }

    const token = generateAccountToken(user);
    const userSession = {
      id: user.id,
      username: user.username,
      display_name: user.display_name || user.username,
      bio: user.bio || '',
      avatar_url: user.avatar_url || '',
      pro_chat_glow: user.pro_chat_glow || 'gold',
      pro_custom_flair: user.pro_custom_flair || '',
      avatar_border: user.avatar_border || '',
      profile_banner: user.profile_banner || '',
      chat_font: user.chat_font || '',
      role: user.role,
      force_password_reset: Boolean(user.force_password_reset),
      token
    };
    req.session.user = userSession;

    res.cookie('nitro_jwt_token', token, { maxAge: 14 * 86400000, path: '/', sameSite: 'lax' });
    res.cookie('nitro_remembered_username', user.username, { maxAge: 14 * 86400000, path: '/', sameSite: 'lax' });

    await db.createModerationLog('USER_LOGIN', user.username, user.username, `Role: ${user.role.toUpperCase()}`);
    sendDiscordLog({
      category: 'logins',
      action: 'USER_LOGIN',
      admin: user.username,
      target: user.username,
      details: `User signed in with role: ${user.role.toUpperCase()}`
    });
    // Log successful login IP
    clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    await db.logUserIp(user.id, user.username, clientIp, req.headers['user-agent'] || '');

    res.json({
      success: true,
      user: userSession,
      token,
      must_reset_password: Boolean(user.force_password_reset)
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});

// POST /api/auth/owner-unlock - Supreme Owner Emergency Account Recovery & Unlocking
router.post('/owner-unlock', async (req, res) => {
  const { username, master_pin, new_password } = req.body;
  if (!username || username.toLowerCase() !== 'jordandaniels') {
    return res.status(403).json({ error: 'Owner recovery is restricted to jordandaniels.' });
  }

  const EXPECTED_PIN = process.env.OWNER_MASTER_PIN || 'JordanDanielsOwnerShield2026!';
  if (master_pin !== EXPECTED_PIN) {
    return res.status(403).json({ error: 'Invalid Owner Master Security PIN.' });
  }

  try {
    const user = await db.getUserByUsername('jordandaniels');
    if (!user) return res.status(404).json({ error: 'Owner account not found.' });

    // Lift bans & lockouts
    await db.unbanUser(user.id);
    await db.pool.query("UPDATE users SET is_disabled_for_review = false, review_disable_reason = '', is_banned = false, ban_reason = '' WHERE id = $1", [user.id]);

    if (new_password) {
      await db.updateUserPassword(user.id, encodePassword(new_password));
    }

    const updatedUser = await db.getUserById(user.id);
    const token = generateAccountToken(updatedUser);

    res.json({
      success: true,
      message: '✅ Owner account successfully unlocked & restored!',
      token,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        role: updatedUser.role
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unlock owner account.' });
  }
});

// Submit Appeal via Auth route alias
router.post('/submit-appeal', async (req, res) => {
  const { handleAppealSubmission } = require('./appeals');
  await handleAppealSubmission(req, res);
});

// GET /api/auth/profile/:username - Public profile lookup
router.get('/profile/:username', async (req, res) => {
  try {
    const user = await db.getUserByUsername(req.params.username);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const badges = await db.getUserCustomBadges(user.id);
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name || user.username,
        bio: user.bio || '',
        role: user.role || 'member',
        avatar_url: user.avatar_url || '',
        banner_url: user.banner_url || '',
        chat_bubble_theme: user.chat_bubble_theme || '',
        vip_particle_effect: user.vip_particle_effect || '',
        pro_chat_glow: user.pro_chat_glow || '',
        pro_custom_flair: user.pro_custom_flair || '',
        avatar_border: user.avatar_border || '',
        profile_banner: user.profile_banner || '',
        chat_font: user.chat_font || '',
        custom_badges: badges
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve profile.' });
  }
});



// GET /api/auth/pending-notifications - Return unseen raffle win notifications (and mark as seen)
router.get('/pending-notifications', async (req, res) => {
  let userId = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
      userId = decoded.id;
    } catch (e) {}
  } else if (req.cookies && req.cookies.nitro_jwt_token) {
    try {
      const decoded = jwt.verify(req.cookies.nitro_jwt_token, JWT_SECRET);
      userId = decoded.id;
    } catch (e) {}
  } else if (req.session && req.session.user) {
    userId = req.session.user.id;
  }

  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

  const wins = await db.getUnseenRaffleWins(userId);
  res.json({ success: true, raffle_wins: wins });
});

// Logout
router.post('/logout', (req, res) => {
  res.clearCookie('nitro_jwt_token', { path: '/' });
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

router.encodePassword = encodePassword;
router.verifyPassword = verifyPassword;
module.exports = router;
