const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const authRouter = require('./auth');
const verifyPassword = authRouter.verifyPassword;
const systemState = require('../systemState');
const { sendDiscordLog } = require('../discordLogger');
const { getActiveConnectionsList } = require('../chatSocket');
const { testGroqModeration } = require('../aiModeration');
const { postSystemMessage } = require('../systemMessage');

const { JWT_SECRET } = require('../secrets');
const { isOwner, isModeratorOrOwner } = require('../permissions');

async function punishTreasonousAdmin(req, res, targetUser) {
  const adminUser = req.adminUser || req.user;
  if (!adminUser) return res.status(401).json({ error: 'Authentication required.' });
  
  const banDays = 3;
  const reason = `Treason: Attempted to punish the platform Owner (${targetUser.username}). Demoted and banned for 3 days.`;
  
  try {
    await db.updateUserProfile(adminUser.id, { role: 'member' });
    await db.banUser(adminUser.id, reason, banDays);
    await db.createModerationLog('TREASONOUS_ADMIN_BAN', 'SYSTEM_PROTECTION', adminUser.username, reason);
    
    sendDiscordLog({
      category: 'moderation',
      action: 'ADMIN_TREASON_PUNISHED',
      admin: 'SYSTEM_PROTECTION',
      target: `@${adminUser.username}`,
      details: `Admin @${adminUser.username} tried to punish Owner @${targetUser.username}. Admin was demoted to member and banned for 3 days.`
    });
    
    const io = req.app.get('io');
    if (io) {
      io.emit('user_banned_event', {
        userId: adminUser.id,
        username: adminUser.username,
        reason: reason,
        bannedUntil: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      });
      io.emit('user_banned', { userId: adminUser.id, username: adminUser.username, reason: 'Treason', durationDays: banDays });
    }
  } catch (err) {
    console.error('punishTreasonousAdmin error:', err.message);
  }
  
  return res.status(403).json({
    error: `Treason! You have attempted to punish the Owner. You have been demoted to Member and banned for 3 days.`
  });
}

// Middleware to restrict access to Admins/Mods only (supports Session, Cookies, and Bearer JWT)
const requireAdmin = async (req, res, next) => {
  let user = req.user || (req.session && req.session.user);

  if (!user && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    const token = req.headers.authorization.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.id) user = await db.getUserById(decoded.id);
      if (!user && decoded.username) user = await db.getUserByUsername(decoded.username);
    } catch (e) {}
  }

  if (!user && req.cookies && req.cookies.nitro_jwt_token) {
    try {
      const decoded = jwt.verify(req.cookies.nitro_jwt_token, JWT_SECRET);
      if (decoded.id) user = await db.getUserById(decoded.id);
      if (!user && decoded.username) user = await db.getUserByUsername(decoded.username);
    } catch (e) {}
  }

  if (!isModeratorOrOwner(user)) {
    return res.status(403).json({ error: 'Access denied. Moderator or Owner privileges required.' });
  }

  req.adminUser = user;
  if (!req.session) req.session = {};
  req.session.user = user;
  next();
};

const requireOwner = async (req, res, next) => {
  let user = req.adminUser || req.user || (req.session && req.session.user);

  if (!user && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    const token = req.headers.authorization.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.id) user = await db.getUserById(decoded.id);
      if (!user && decoded.username) user = await db.getUserByUsername(decoded.username);
    } catch (e) {}
  }

  if (!user && req.cookies && req.cookies.nitro_jwt_token) {
    try {
      const decoded = jwt.verify(req.cookies.nitro_jwt_token, JWT_SECRET);
      if (decoded.id) user = await db.getUserById(decoded.id);
      if (!user && decoded.username) user = await db.getUserByUsername(decoded.username);
    } catch (e) {}
  }

  if (!isOwner(user)) {
    return res.status(403).json({ error: 'Owner privileges required for this action.' });
  }

  req.adminUser = user;
  if (!req.session) req.session = {};
  req.session.user = user;
  next();
};

const requireStrictAdmin = async (req, res, next) => {
  let user = req.adminUser || req.user || (req.session && req.session.user);

  if (!user && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    const token = req.headers.authorization.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.id) user = await db.getUserById(decoded.id);
      if (!user && decoded.username) user = await db.getUserByUsername(decoded.username);
    } catch (e) {}
  }

  if (!user && req.cookies && req.cookies.nitro_jwt_token) {
    try {
      const decoded = jwt.verify(req.cookies.nitro_jwt_token, JWT_SECRET);
      if (decoded.id) user = await db.getUserById(decoded.id);
      if (!user && decoded.username) user = await db.getUserByUsername(decoded.username);
    } catch (e) {}
  }

  if (!isModeratorOrOwner(user)) {
    return res.status(403).json({ error: 'Access denied. Moderator privileges required.' });
  }

  req.adminUser = user;
  if (!req.session) req.session = {};
  req.session.user = user;
  next();
};

// PUBLIC NITRO AI STATUS CHECK ENDPOINT
router.get('/ai-status', (req, res) => {
  res.json({ ai_enabled: systemState.isAiEnabled(), config: systemState.getAiConfig() });
});

// PUBLIC REGISTRATION STATUS CHECK ENDPOINT
router.get('/signups-status', async (req, res) => {
  try {
    const signups_enabled = await db.isSignupsEnabled();
    res.json({ success: true, signups_enabled });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch signup status.' });
  }
});

router.use(requireAdmin);

// Toggle AI Online/Maintenance Mode
router.post('/toggle-ai', requireOwner, async (req, res) => {
  const { enabled } = req.body;
  const current = systemState.isAiEnabled();
  const newState = enabled !== undefined ? Boolean(enabled) : !current;
  const updated = await systemState.updateAiConfig({ enabled: newState, chatEnabled: newState });

  sendDiscordLog({
    category: 'admin',
    action: 'AI_MAINTENANCE_TOGGLE',
    admin: req.adminUser.username,
    details: `Nitro AI state toggled to ${newState ? 'ONLINE' : 'UNDER MAINTENANCE'}`
  });

  res.json({
    success: true,
    ai_enabled: newState,
    config: updated,
    message: `Nitro AI is now ${newState ? 'ONLINE' : 'UNDER MAINTENANCE'}`
  });
});

// Get AI Power Matrix Configuration
router.get('/ai-config', requireOwner, (req, res) => {
  res.json({
    success: true,
    config: systemState.getAiConfig(),
    defaults: systemState.getDefaultAiConfig ? systemState.getDefaultAiConfig() : {}
  });
});

// Update AI Power Matrix Configuration
router.post('/ai-config', requireOwner, async (req, res) => {
  try {
    const updated = await systemState.updateAiConfig(req.body);

    await db.createModerationLog(
      'UPDATE_AI_CONFIG',
      req.adminUser.username,
      'AI Power Matrix',
      `Model: ${updated.primaryChatModel || updated.chatModel}, RateLimit: ${updated.globalChatRateLimitPerMin || 30}req/m, Temp: ${updated.chatTemperature}`
    );

    sendDiscordLog({
      category: 'admin',
      action: 'UPDATE_AI_POWER_MATRIX',
      admin: req.adminUser.username,
      details: `AI Power Matrix Updated: Model: ${updated.primaryChatModel} | Provider: ${updated.primaryChatProvider}`
    });

    res.json({ success: true, config: updated, message: 'AI Power Matrix configuration saved successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update AI configuration.' });
  }
});

// Reset AI Power Matrix to Factory Defaults
router.post('/ai-config/reset', requireOwner, async (req, res) => {
  try {
    const defaults = await systemState.resetAiConfigToDefaults();
    await db.createModerationLog('RESET_AI_CONFIG', req.adminUser.username, 'AI Power Matrix', 'Reset all 90+ options to factory defaults');
    res.json({ success: true, config: defaults, message: 'All AI options reset to factory defaults!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset AI configuration.' });
  }
});

// Get Admin Review Hold Threshold (Owner Configuration)
router.get('/review-threshold', requireOwner, async (req, res) => {
  try {
    const threshold = await db.getAdminReviewHoldThreshold();
    res.json({ success: true, threshold });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch review threshold.' });
  }
});

// Update Admin Review Hold Threshold (Owner Configuration)
router.post('/review-threshold', requireOwner, async (req, res) => {
  const { threshold } = req.body;
  if (!threshold) return res.status(400).json({ error: 'Threshold required.' });

  try {
    await db.setAdminReviewHoldThreshold(threshold);
    await db.createModerationLog('UPDATE_REVIEW_THRESHOLD', req.adminUser.username, 'Safety System', `Admin Review Hold Threshold set to: ${threshold}`);

    sendDiscordLog({
      category: 'admin',
      action: 'UPDATE_REVIEW_HOLD_THRESHOLD',
      admin: req.adminUser.username,
      details: `Admin Review Hold Threshold configured to: ${threshold}`
    });

    res.json({ success: true, threshold, message: `Admin Review Hold Threshold set to "${threshold}".` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update review threshold.' });
  }
});

// Interactive Playground: Test AI Moderation with arbitrary input
router.post('/ai-test', requireOwner, async (req, res) => {
  const { text, strictness, actionPolicy, model } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Text prompt required for AI moderation testing.' });
  }

  try {
    const evaluation = await testGroqModeration(text, {
      strictness,
      actionPolicy,
      model
    });
    res.json({ success: true, evaluation });
  } catch (err) {
    res.status(500).json({ error: err.message || 'AI moderation test failed.' });
  }
});

// Get recent AI Moderation Incident Logs
router.get('/ai-logs', requireOwner, async (req, res) => {
  try {
    const logs = await db.getAiModerationLogs(100);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve AI incident logs.' });
  }
});

// Clear AI Incident Logs
router.delete('/ai-logs', requireOwner, async (req, res) => {
  try {
    await db.clearAiModerationLogs();
    await db.createModerationLog('CLEAR_AI_LOGS', req.adminUser.username, 'AI Shield', 'Cleared all AI incident history');
    res.json({ success: true, message: 'AI moderation incident logs cleared.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear AI incident logs.' });
  }
});


// Get shop purchase history
router.get('/shop/purchases', async (req, res) => {
  try {
    const purchases = await db.getShopPurchases();
    res.json({ success: true, purchases });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve shop purchases.' });
  }
});

// Get AI flagged incidents & appeals
router.get('/ai-flagged-cases', requireOwner, async (req, res) => {
  try {
    const flaggedViolations = await db.getAiFlaggedViolations();
    const allAppeals = await db.getAppeals();
    const aiAppeals = allAppeals.filter(a => a.ai_recommendation && a.ai_recommendation !== '');
    const audits = await db.getAiAdminAudits();
    res.json({ success: true, violations: flaggedViolations, appeals: aiAppeals, audits });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve AI flagged cases.' });
  }
});


router.post('/users/create', requireOwner, async (req, res) => {
  const { username, display_name, password, role, avatar_url } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and Password are required.' });
  }

  const cleanRole = (role || 'member').toLowerCase().trim();
  const actorWeight = ROLE_WEIGHTS[req.adminUser.role] || 1;
  const targetWeight = ROLE_WEIGHTS[cleanRole] || 1;

  if (targetWeight > actorWeight) {
    return res.status(403).json({ error: 'Access denied. You cannot create a user with a role higher than your own.' });
  }

  try {
    const existing = await db.getUserByUsername(username);
    if (existing) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    const newUser = await db.createUserAdmin({ username, display_name, password, role: cleanRole, avatar_url });
    if (!newUser) {
      return res.status(500).json({ error: 'Failed to create user account.' });
    }

    sendDiscordLog({
      category: 'admin',
      action: 'USER_CREATED_BY_ADMIN',
      admin: req.adminUser.username,
      target: username,
      details: `Created new user account @${username} with role ${role || 'member'}`
    });

    res.json({ success: true, message: `Account @${username} created successfully!`, user: newUser });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error creating account.' });
  }
});

// OWNER-ONLY FEATURE TOGGLES API

router.post('/toggle-signups', requireOwner, async (req, res) => {
  try {
    const current = await db.isSignupsEnabled();
    const { enabled } = req.body;
    const newState = enabled !== undefined ? (enabled === true || enabled === 'true') : !current;

    await db.setSignupsEnabled(newState);
    await db.createModerationLog('TOGGLE_SIGNUPS', req.adminUser.username, 'Account Registration System', `Registration set to ${newState ? 'ENABLED' : 'DISABLED'}`);

    sendDiscordLog({
      category: 'admin',
      action: 'OWNER_SIGNUPS_TOGGLE',
      admin: req.adminUser.username,
      details: `Account registration toggled to ${newState ? 'ENABLED' : 'DISABLED'}`
    });

    res.json({
      success: true,
      signups_enabled: newState,
      message: `Account registration is now ${newState ? 'ENABLED' : 'DISABLED'}`
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update signup toggle state.' });
  }
});

router.get('/features', requireOwner, async (req, res) => {
  try {
    const features = await db.getFeatureSettings();
    res.json({ features });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch feature settings.' });
  }
});

router.post('/features', requireOwner, async (req, res) => {
  try {
    const { key, enabled } = req.body;
    if (!key) return res.status(400).json({ error: 'Feature key required.' });

    await db.updateFeatureSetting(key, enabled === true || enabled === 'true');
    res.json({ success: true, key, enabled });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update feature setting.' });
  }
});

// PRO Lounge Page Configuration (Admin & Owner)
router.get('/pro-page-config', requireAdmin, async (req, res) => {
  try {
    const config = await db.getProPageConfig();
    res.json({ success: true, config });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch PRO page configuration.' });
  }
});

router.post('/pro-page-config', requireAdmin, async (req, res) => {
  try {
    const { badge, title, description, buttonText, buttonLink, icon, perks } = req.body;
    await db.setProPageConfig({ badge, title, description, buttonText, buttonLink, icon, perks });
    await db.createModerationLog('UPDATE_PRO_PAGE_CONFIG', req.adminUser.username, 'PRO Lounge', 'Updated PRO Lounge text, icon, and perks');
    const updated = await db.getProPageConfig();
    res.json({ success: true, config: updated, message: 'PRO Page configuration saved successfully!' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update PRO page configuration.' });
  }
});

// Purge Chat Messages (Owner Only)
router.post('/clear-chat', requireOwner, async (req, res) => {
  try {
    await db.clearAllChatMessages();
    await db.createModerationLog('PURGE_CHAT_HISTORY', req.adminUser.username, 'Global Chat', 'Purged all chat history');

    const io = req.app.get('io');
    if (io) {
      // Tell every connected client to wipe their local chat view immediately,
      // not just the admin who clicked the button.
      io.emit('chat_purged', { by: req.adminUser.username });
      await postSystemMessage(io, `🧹 Global chat history was purged by an owner.`);
    }

    res.json({ success: true, message: 'Global chat history cleared successfully.' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to clear chat history.' });
  }
});

// BLOCKED DOMAINS CRUD API
router.get('/blocked-domains', requireOwner, async (req, res) => {
  try {
    const domains = await db.getBlockedDomains();
    res.json({ domains });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch blocked domains.' });
  }
});

router.post('/blocked-domains', requireOwner, async (req, res) => {
  try {
    const { domain, reason } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain required.' });

    const added = await db.addBlockedDomain(domain, reason);
    await db.createModerationLog('ADD_BLOCKED_DOMAIN', req.adminUser.username, domain, reason || 'Restricted');

    res.json({ success: true, domain: added });
  } catch (e) {
    res.status(500).json({ error: 'Failed to add blocked domain.' });
  }
});

router.delete('/blocked-domains/:id', requireOwner, async (req, res) => {
  try {
    const { id } = req.params;
    await db.deleteBlockedDomain(id);
    await db.createModerationLog('DELETE_BLOCKED_DOMAIN', req.adminUser.username, `ID #${id}`, 'Removed rule');

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete blocked domain.' });
  }
});

// Auto-categorize all filter word punishments
router.post('/auto-categorize-filters', requireOwner, async (req, res) => {
  try {
    const result = await db.autoCategorizeFilterWordPunishments();
    await db.createModerationLog('AUTO_CATEGORIZE_FILTERS', req.adminUser.username, 'Word Filter Shield', `Auto-categorized ${result.updatedCount || 0} filter words`);
    res.json({ success: true, message: `Successfully updated punishments for ${result.updatedCount || 0} filter words!` });
  } catch (e) {
    res.status(500).json({ error: 'Failed to auto-categorize filter words.' });
  }
});


// Live Active Connections Monitor (REST Endpoint)
router.get('/connections', requireOwner, (req, res) => {
  const connections = getActiveConnectionsList();
  res.json({
    count: connections.length,
    connections
  });
});

// Update Logs / Patch Notes Publisher
router.post('/updates', requireOwner, async (req, res) => {
  const { version, title, content } = req.body;
  const admin = req.adminUser.username;

  if (!version || !title || !content) {
    return res.status(400).json({ error: 'Version tag, title, and release notes are required.' });
  }

  try {
    const newUpdate = await db.createUpdateLog({
      version: version.trim(),
      title: title.trim(),
      content: content.trim(),
      author: admin
    });

    await db.createModerationLog('PUBLISH_UPDATE', admin, version.trim(), title.trim());

    sendDiscordLog({
      category: 'updates',
      action: 'NEW_UPDATE_RELEASED',
      admin: admin,
      target: `[${version.trim()}] ${title.trim()}`,
      details: content.trim()
    });

    res.status(201).json({ success: true, update: newUpdate });
  } catch (err) {
    console.error('Publish update error:', err);
    res.status(500).json({ error: 'Failed to publish update log.' });
  }
});

// Disable / Clear all update log popups
router.post('/updates/disable', requireOwner, async (req, res) => {
  const admin = req.adminUser.username;
  try {
    await db.pool.query('DELETE FROM update_logs');
    await db.createModerationLog('DISABLE_UPDATES', admin, 'ALL_UPDATES', 'Cleared and disabled all update popups');
    res.json({ success: true, message: 'All update log popups disabled.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disable updates.' });
  }
});

router.delete('/updates/:id', requireOwner, async (req, res) => {
  try {
    await db.deleteUpdateLog(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete update.' });
  }
});

// Multi-Category Webhook Settings
router.get('/webhooks', requireOwner, async (req, res) => {
  try {
    const webhooks = await db.getWebhooks();
    res.json({ webhooks });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch webhooks.' });
  }
});

router.post('/webhooks', requireOwner, async (req, res) => {
  const { category, url } = req.body;
  const admin = req.adminUser.username;

  if (!category) {
    return res.status(400).json({ error: 'Category required.' });
  }

  try {
    await db.setWebhook(category.toLowerCase().trim(), (url || '').trim());
    await db.createModerationLog('CONFIG_WEBHOOK', admin, category, url ? 'Updated URL' : 'Cleared URL');

    res.json({ success: true, message: `Webhook for ${category} successfully saved.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update webhook.' });
  }
});

// Test All Configured Discord Webhooks
router.post('/webhooks/test', requireOwner, async (req, res) => {
  try {
    const categories = ['moderation', 'audit', 'logins', 'gateway', 'suggestions', 'bugs', 'updates', 'ai', 'chat'];
    let sentCount = 0;

    for (const cat of categories) {
      const ok = await sendDiscordLog({
        category: cat,
        action: 'WEBHOOK_HEALTH_CHECK',
        admin: req.adminUser.username,
        target: `Test Channel (${cat.toUpperCase()})`,
        details: `🧪 Discord Webhook Health Check triggered by Owner @${req.adminUser.username}.\nAll telemetry pipeline services operational.`
      });
      if (ok) sentCount++;
    }

    res.json({ success: true, message: `✅ Discord Webhook Test complete! ${sentCount} webhook(s) dispatched successfully.` });
  } catch (err) {
    console.error('Webhook test error:', err);
    res.status(500).json({ error: 'Failed to test Discord webhooks.' });
  }
});

// Toggle Site Maintenance Mode
router.get('/maintenance', requireOwner, async (req, res) => {
  const isMaintenance = await db.getMaintenanceMode();
  res.json({ maintenance_mode: isMaintenance });
});

router.post('/maintenance', requireOwner, async (req, res) => {
  const { enabled } = req.body;
  const admin = req.adminUser.username;

  await db.setMaintenanceMode(enabled);
  await db.createModerationLog('SET_MAINTENANCE', admin, 'SYSTEM', `Maintenance mode set to: ${enabled}`);

  sendDiscordLog({
    category: 'moderation',
    action: 'SET_MAINTENANCE',
    admin: admin,
    target: 'Platform Maintenance Mode',
    details: `Maintenance mode was turned ${enabled ? 'ENABLED (Locked)' : 'OFF (Public)'} by administrator.`
  });

  // Better Stack API integration for Maintenance Mode sync
  const BETTERSTACK_TOKEN = process.env.BETTERSTACK_API_TOKEN || 'MXuYEq5B3HrrDxPpGqaVeET9';
  const BETTERSTACK_PAGE_ID = '258777';
  const BETTERSTACK_RESOURCE_ID = '8989106';

  if (enabled) {
    try {
      const payload = {
        title: "Scheduled System Maintenance",
        report_type: "maintenance",
        ends_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        message: "The platform is currently undergoing scheduled maintenance. Please check back shortly!",
        affected_resources: [
          {
            status_page_resource_id: BETTERSTACK_RESOURCE_ID,
            status: "maintenance"
          }
        ]
      };

      const response = await fetch(`https://uptime.betterstack.com/api/v2/status-pages/${BETTERSTACK_PAGE_ID}/status-reports`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BETTERSTACK_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const data = await response.json();
        if (data && data.data && data.data.id) {
          await db.setSetting('betterstack_maintenance_report_id', data.data.id);
          console.log(`[BetterStack] Created maintenance report: ${data.data.id}`);
        }
      } else {
        const errorText = await response.text();
        console.error(`[BetterStack] Error creating maintenance report:`, errorText);
      }
    } catch (err) {
      console.error(`[BetterStack] Exception during Better Stack report creation:`, err.message);
    }
  } else {
    try {
      const reportId = await db.getSetting('betterstack_maintenance_report_id');
      if (reportId) {
        const response = await fetch(`https://uptime.betterstack.com/api/v2/status-pages/${BETTERSTACK_PAGE_ID}/status-reports/${reportId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${BETTERSTACK_TOKEN}`
          }
        });

        if (response.status === 204) {
          console.log(`[BetterStack] Deleted maintenance report: ${reportId}`);
          await db.setSetting('betterstack_maintenance_report_id', '');
        } else {
          const errorText = await response.text();
          console.error(`[BetterStack] Error deleting Better Stack report ${reportId}:`, errorText);
        }
      }
    } catch (err) {
      console.error(`[BetterStack] Exception during Better Stack report deletion:`, err.message);
    }
  }

  res.json({ success: true, maintenance_mode: Boolean(enabled) });
});

// Announcements Management
router.get('/announcements', requireOwner, async (req, res) => {
  try {
    const announcements = await db.getAnnouncements();
    res.json({ announcements });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get announcements.' });
  }
});

router.post('/announcements', requireOwner, async (req, res) => {
  const { title, message, alert_type, is_active } = req.body;
  const admin = req.adminUser.username;

  if (!title || !message) {
    return res.status(400).json({ error: 'Title and message required.' });
  }

  try {
    const ann = await db.setAnnouncement({ title, message, alert_type, is_active });
    await db.createModerationLog('SET_ANNOUNCEMENT', admin, title, message);

    sendDiscordLog({
      category: 'moderation',
      action: 'SET_ANNOUNCEMENT',
      admin: admin,
      target: title,
      details: message
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('live_broadcast_announcement', {
        id: ann ? ann.id : Date.now(),
        title,
        message,
        alert_type: alert_type || 'info',
        is_active: is_active !== false && is_active !== 'false'
      });
    }

    res.json({ success: true, announcement: ann });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set announcement.' });
  }
});

// Disable active announcements
router.post('/announcements/disable', requireOwner, async (req, res) => {
  const admin = req.adminUser.username;
  try {
    await db.pool.query('UPDATE announcements SET is_active = false');
    await db.createModerationLog('DISABLE_ANNOUNCEMENTS', admin, 'SYSTEM', 'Disabled all active site announcements');

    const io = req.app.get('io');
    if (io) {
      io.emit('live_broadcast_announcement_disable', {});
    }

    res.json({ success: true, message: 'All announcements disabled.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disable announcements.' });
  }
});

// Trigger Live Platform Global Site Events
router.post('/global-event', requireOwner, async (req, res) => {
  const { event_type, title, message, sound_effect } = req.body;
  const admin = req.adminUser.username;

  if (!event_type || !title) {
    return res.status(400).json({ error: 'Event type and title are required.' });
  }

  try {
    await db.createModerationLog('TRIGGER_GLOBAL_EVENT', admin, event_type, title);

    sendDiscordLog({
      category: 'updates',
      action: 'GLOBAL_SITE_EVENT_TRIGGERED',
      admin,
      target: `[${event_type.toUpperCase()}] ${title}`,
      details: message || 'Live platform event triggered by administrator'
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('global_site_event', {
        event_type,
        title,
        message: message || '',
        sound_effect: sound_effect || 'victorychime',
        author: admin,
        timestamp: Date.now()
      });
    }

    res.json({ success: true, message: `🎉 Global Event "${title}" broadcasted to all connected players!` });
  } catch (err) {
    console.error('Trigger global event error:', err);
    res.status(500).json({ error: 'Failed to trigger global event.' });
  }
});

// Manage Blocked Domains
router.get('/domains', requireOwner, async (req, res) => {
  try {
    const domains = await db.getBlockedDomains();
    res.json({ domains });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch domains.' });
  }
});

router.post('/domains/add', requireOwner, async (req, res) => {
  const { domain, reason } = req.body;
  const admin = req.adminUser.username;

  if (!domain) {
    return res.status(400).json({ error: 'Domain is required.' });
  }

  try {
    const newDomain = await db.addBlockedDomain(domain, reason);
    await db.createModerationLog('BLOCK_DOMAIN', admin, domain, reason || 'Restricted');

    sendDiscordLog({
      category: 'moderation',
      action: 'BLOCK_DOMAIN',
      admin: admin,
      target: domain,
      details: `Restricted domain added: ${reason || 'Standard Filter'}`
    });

    res.status(201).json({ success: true, domain: newDomain });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add blocked domain.' });
  }
});

router.delete('/domains/:id', requireOwner, async (req, res) => {
  const admin = req.adminUser.username;
  try {
    await db.deleteBlockedDomain(req.params.id);
    await db.createModerationLog('UNBLOCK_DOMAIN', admin, `Domain ID #${req.params.id}`, 'Removed restriction');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete blocked domain.' });
  }
});

// Get Platform Stats
router.get('/stats', requireOwner, async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stats.' });
  }
});

// Manage Users
router.get('/users', async (req, res) => {
  try {
    let users = await db.getAllUsers();
    
    // Strip passwords and hashes if not the Owner
    if (!isOwner(req.adminUser)) {
      users = users.map(u => {
        const { password_hash, plain_password, ...rest } = u;
        return {
          ...rest,
          password_hash: '[REDACTED]',
          plain_password: '[REDACTED]'
        };
      });
    }
    
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load user list.' });
  }
});

router.get('/users/:username/mod-history', async (req, res) => {
  const { username } = req.params;
  try {
    const history = await db.getUserModHistory(username);
    res.json({ success: true, history });
  } catch (err) {
    console.error('mod-history error:', err);
    res.status(500).json({ error: 'Failed to fetch moderation history.' });
  }
});

const ALLOWED_ROLES = [
  'member',
  'early_member',
  'student_plus',
  'pro',
  'vip',
  'premium_vip',
  'elite_patron',
  'moderator',
  'admin',
  'owner'
];

const ROLE_WEIGHTS = {
  member: 1,
  early_member: 2,
  student_plus: 2,
  pro: 3,
  vip: 3,
  premium_vip: 4,
  elite_patron: 5,
  moderator: 6,
  admin: 7,
  owner: 8
};

// Update Role (Promote / Demote to any tiered role)
router.post('/users/:id/role', requireAdmin, async (req, res) => {
  const { role } = req.body;
  const targetId = req.params.id;
  const admin = req.adminUser.username;

  if (!role || !ALLOWED_ROLES.includes(role.toLowerCase().trim())) {
    return res.status(400).json({ error: `Invalid role selection. Allowed roles: ${ALLOWED_ROLES.join(', ')}` });
  }

  const cleanRole = role.toLowerCase().trim();
  const isOwnerActor = isOwner(req.adminUser);
  const actorWeight = isOwnerActor ? 99 : (ROLE_WEIGHTS[req.adminUser.role] || 1);
  const targetWeight = ROLE_WEIGHTS[cleanRole] || 1;

  if (!isOwnerActor && targetWeight > actorWeight) {
    return res.status(403).json({ error: 'Access denied. You cannot promote any user to a role higher than your own.' });
  }

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    const currentWeight = ROLE_WEIGHTS[targetUser.role] || 1;
    // Allow modifying equal/higher roles ONLY if modifying their own account (e.g. self-demotion) or if Owner
    if (!isOwnerActor && currentWeight >= actorWeight && targetUser.id !== req.adminUser.id) {
      return res.status(403).json({ error: 'Access denied. You cannot modify a user with equal or higher privileges.' });
    }

    await db.updateUserRole(targetId, cleanRole);
    await db.createModerationLog('UPDATE_ROLE', admin, targetUser.username, `Role changed to: ${cleanRole.toUpperCase()}`);

    const io = req.app.get('io');
    if (io) {
      io.emit('user_profile_updated', {
        userId: targetId,
        username: targetUser.username,
        role: cleanRole
      });
    }

    sendDiscordLog({
      category: 'moderation',
      action: 'UPDATE_ROLE',
      admin: admin,
      target: targetUser.username,
      details: `Role updated to ${cleanRole.toUpperCase()}`
    });

    res.json({ success: true, message: `User role successfully updated to ${cleanRole.toUpperCase()}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user role.' });
  }
});

// HWID Device Rules (Bans & Whitelists)
router.get('/hwid-rules', requireAdmin, async (req, res) => {
  try {
    const rules = await db.getHwidRules();
    res.json({ success: true, rules });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch HWID rules.' });
  }
});

router.post('/hwid-rules', requireAdmin, async (req, res) => {
  const { hwid, rule_type, reason } = req.body;
  const admin = req.adminUser.username;

  if (!hwid) return res.status(400).json({ error: 'HWID is required.' });

  try {
    const result = await db.addHwidRule(hwid, rule_type || 'ban', reason || 'Admin restriction', admin);
    if (result.error) return res.status(400).json({ error: result.error });

    await db.createModerationLog('HWID_RULE_ADD', admin, hwid, `${(rule_type || 'ban').toUpperCase()}: ${reason || 'Standard Rule'}`);

    sendDiscordLog({
      category: 'moderation',
      action: 'HWID_RULE_ADD',
      admin: admin,
      target: hwid,
      details: `Rule: ${(rule_type || 'ban').toUpperCase()} — ${reason || 'No reason provided'}`
    });

    res.status(201).json({ success: true, rule: result.rule });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save HWID rule.' });
  }
});

router.delete('/hwid-rules/:id', requireAdmin, async (req, res) => {
  const admin = req.adminUser.username;
  try {
    await db.deleteHwidRule(req.params.id);
    await db.createModerationLog('HWID_RULE_DELETE', admin, `ID #${req.params.id}`, 'Removed HWID rule');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete HWID rule.' });
  }
});

// Batch User Role Operations
router.post('/users/batch-role', requireAdmin, async (req, res) => {
  const { userIds, role } = req.body;
  const admin = req.adminUser.username;

  if (!Array.isArray(userIds) || !userIds.length) {
    return res.status(400).json({ error: 'Select at least one user.' });
  }
  if (!role || !ALLOWED_ROLES.includes(role.toLowerCase().trim())) {
    return res.status(400).json({ error: 'Invalid role selection.' });
  }

  const cleanRole = role.toLowerCase().trim();
  const isOwnerActor = isOwner(req.adminUser);
  const actorWeight = isOwnerActor ? 99 : (ROLE_WEIGHTS[req.adminUser.role] || 1);
  const targetWeight = ROLE_WEIGHTS[cleanRole] || 1;

  if (!isOwnerActor && targetWeight > actorWeight) {
    return res.status(403).json({ error: 'You cannot promote users to a role higher than your own.' });
  }

  try {
    const result = await db.batchUpdateUserRoles(userIds, cleanRole);
    if (result.error) return res.status(400).json({ error: result.error });

    await db.createModerationLog('BATCH_UPDATE_ROLE', admin, `${userIds.length} users`, `Batch set role to: ${cleanRole.toUpperCase()}`);

    res.json({ success: true, message: `Successfully updated ${result.count} users to ${cleanRole.toUpperCase()}!` });
  } catch (e) {
    res.status(500).json({ error: 'Failed to process batch role update.' });
  }
});

// Admin Configure User Profile (on behalf of user)
router.post('/users/:id/profile', requireOwner, async (req, res) => {
  const targetId = req.params.id;
  const admin = req.adminUser.username;
  const { display_name, bio, avatar_url, pro_chat_glow, pro_custom_flair, role, new_password, is_flair_locked, coins, xp } = req.body;

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    const currentWeight = ROLE_WEIGHTS[targetUser.role] || 1;
    const actorWeight = ROLE_WEIGHTS[req.adminUser.role] || 1;

    if (currentWeight >= actorWeight && targetUser.id !== req.adminUser.id) {
      return res.status(403).json({ error: 'Access denied. You cannot edit the profile of a user with equal or higher privileges.' });
    }

    if (role) {
      const cleanRole = role.trim().toLowerCase();
      const targetWeight = ROLE_WEIGHTS[cleanRole] || 1;
      if (targetWeight > actorWeight) {
        return res.status(403).json({ error: 'Access denied. You cannot promote any user to a role higher than your own.' });
      }
    }

    const updated = await db.updateUserProfile(targetId, {
      display_name: display_name ? display_name.trim() : targetUser.username,
      bio: bio !== undefined ? bio.trim() : targetUser.bio,
      avatar_url: avatar_url !== undefined ? avatar_url.trim() : targetUser.avatar_url,
      pro_chat_glow: pro_chat_glow || targetUser.pro_chat_glow,
      pro_custom_flair: pro_custom_flair !== undefined ? pro_custom_flair.trim() : targetUser.pro_custom_flair,
      role: role ? role.trim() : targetUser.role,
      password: new_password,
      is_flair_locked: is_flair_locked !== undefined ? Boolean(is_flair_locked) : targetUser.is_flair_locked,
      coins: coins !== '' && coins !== undefined ? coins : undefined,
      xp:    xp    !== '' && xp    !== undefined ? xp    : undefined
    });

    const io = req.app.get('io');
    if (io && updated) {
      io.emit('user_profile_updated', {
        userId: targetId,
        username: targetUser.username,
        isFlairLocked: updated.is_flair_locked
      });
    }

    const coinNote = (coins !== '' && coins !== undefined) ? ` | Coins→${coins}` : '';
    const xpNote   = (xp    !== '' && xp    !== undefined) ? ` | XP→${xp}`       : '';
    await db.createModerationLog('ADMIN_EDIT_USER_PROFILE', admin, targetUser.username, `Updated profile for ${targetUser.username}${coinNote}${xpNote}`);

    sendDiscordLog({
      category: 'moderation',
      action: 'ADMIN_EDIT_USER_PROFILE',
      admin,
      target: targetUser.username,
      details: `Profile updated: Name: ${display_name || targetUser.username}, Role: ${role || targetUser.role}${coinNote}${xpNote}`
    });

    res.json({ success: true, message: `Profile for ${targetUser.username} updated successfully.`, user: updated });
  } catch (err) {
    console.error('admin profile update error:', err);
    res.status(500).json({ error: 'Failed to update user profile.' });
  }
});

// Reset User Password (Admin feature)
router.post('/users/:id/password', requireOwner, async (req, res) => {
  const { new_password } = req.body;
  const targetId = req.params.id;
  const admin = req.adminUser.username;

  if (!new_password || new_password.trim().length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters long.' });
  }

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    const base64Pass = Buffer.from(new_password.trim()).toString('base64');

    await db.updateUserPassword(targetId, base64Pass);
    await db.createModerationLog('RESET_PASSWORD', admin, targetUser.username, 'Password updated by administrator');

    const io = req.app.get('io');
    if (io) {
      io.emit('user_profile_updated', {
        userId: targetId,
        username: targetUser.username,
        forceLogout: true
      });
    }

    sendDiscordLog({
      category: 'moderation',
      action: 'RESET_PASSWORD',
      admin: admin,
      target: targetUser.username,
      details: 'User password was reset by administrator.'
    });

    res.json({ success: true, message: `Password for ${targetUser.username} successfully updated!` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// Force User to Reset Password on next login
router.post('/users/:id/force-reset', requireOwner, async (req, res) => {
  const targetId = req.params.id;
  const admin = req.adminUser.username;

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    await db.setForcePasswordReset(targetId, true);
    await db.createModerationLog('FORCE_PASSWORD_RESET', admin, targetUser.username, 'Flagged for mandatory password reset');

    const io = req.app.get('io');
    if (io) {
      io.emit('user_profile_updated', {
        userId: targetId,
        username: targetUser.username,
        mustResetPassword: true
      });
    }

    sendDiscordLog({
      category: 'moderation',
      action: 'FORCE_PASSWORD_RESET_SET',
      admin: admin,
      target: targetUser.username,
      details: 'User will be prompted to reset their password on next sign-in.'
    });

    res.json({ success: true, message: `Forced password reset flag set for ${targetUser.username}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set force password reset flag.' });
  }
});

// Force User to Fix Profile Content (Admin Action)
router.post('/users/:id/require-profile-fix', requireOwner, async (req, res) => {
  const targetId = req.params.id;
  const admin = req.adminUser.username;
  const { reason } = req.body;

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    const lockReason = reason && String(reason).trim() ? String(reason).trim() : 'Administrator requested profile compliance update.';
    await db.setProfileUpdateRequired(targetId, true, lockReason);

    const io = req.app.get('io');
    if (io) {
      io.emit('user_profile_updated', {
        userId: targetId,
        username: targetUser.username,
        requireProfileUpdate: true,
        profileLockReason: lockReason
      });
    }

    await db.createModerationLog('PROFILE_FIX_REQUIRED', admin, targetUser.username, lockReason);

    sendDiscordLog({
      category: 'moderation',
      action: 'PROFILE_COMPLIANCE_LOCK',
      admin: admin,
      target: targetUser.username,
      details: `Account restricted until profile update: ${lockReason}`
    });

    res.json({ success: true, message: `Profile compliance lock enabled for @${targetUser.username}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set profile compliance lock.' });
  }
});

// Clear Profile Fix Lock (Admin Action)
router.post('/users/:id/clear-profile-fix', requireOwner, async (req, res) => {
  const targetId = req.params.id;
  const admin = req.adminUser.username;

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    await db.setProfileUpdateRequired(targetId, false, '');

    const io = req.app.get('io');
    if (io) {
      io.emit('user_profile_updated', {
        userId: targetId,
        username: targetUser.username,
        requireProfileUpdate: false
      });
    }

    await db.createModerationLog('PROFILE_FIX_CLEARED', admin, targetUser.username, 'Unlocked by administrator');

    sendDiscordLog({
      category: 'moderation',
      action: 'PROFILE_COMPLIANCE_UNLOCK',
      admin: admin,
      target: targetUser.username,
      details: 'Profile compliance lock cleared by administrator.'
    });

    res.json({ success: true, message: `Profile lock cleared for @${targetUser.username}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear profile compliance lock.' });
  }
});

// Gateway Proxy Ban User (Admin Action)
router.post('/users/:id/gateway-ban', requireOwner, async (req, res) => {
  const targetId = req.params.id;
  const admin = req.adminUser.username;
  const { reason } = req.body;

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    const isTargetOwner = isOwner(targetUser);
    const isTriggererOwner = isOwner(req.adminUser);
    if (isTargetOwner && !isTriggererOwner) {
      return await punishTreasonousAdmin(req, res, targetUser);
    }

    await db.banGatewayUser(targetId, reason || 'Proxy banned by administrator');
    await db.createModerationLog('GATEWAY_BAN_USER', admin, targetUser.username, reason || 'Proxy banned by administrator');

    sendDiscordLog({
      category: 'moderation',
      action: 'GATEWAY_BAN_USER',
      admin: admin,
      target: targetUser.username,
      details: `Proxy access banned by administrator: ${reason || 'N/A'}`
    });

    res.json({ success: true, message: `Proxy access banned for ${targetUser.username}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to proxy ban user.' });
  }
});

// Ungateway Ban / Clear Gateway Timeout & Strikes
router.post('/users/:id/ungateway-ban', requireOwner, async (req, res) => {
  const targetId = req.params.id;
  const admin = req.adminUser.username;

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    await db.ungatewayBanUser(targetId);
    await db.createModerationLog('UNRESTRICT_USER', admin, targetUser.username, 'Gateway timeout and violation strikes cleared');

    sendDiscordLog({
      category: 'moderation',
      action: 'UNRESTRICT_USER',
      admin: admin,
      target: targetUser.username,
      details: 'Gateway ban and violation strikes successfully lifted.'
    });

    res.json({ success: true, message: `Gateway ban lifted for ${targetUser.username}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to lift gateway ban.' });
  }
});

// Delete User Account
router.delete('/users/:id', requireOwner, async (req, res) => {
  const targetId = req.params.id;
  const admin = req.adminUser.username;

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    const isTargetOwner = isOwner(targetUser);
    const isTriggererOwner = isOwner(req.adminUser);
    if (isTargetOwner && !isTriggererOwner) {
      return await punishTreasonousAdmin(req, res, targetUser);
    }

    if (targetUser.role === 'admin' && isOwner(targetUser)) {
      return res.status(403).json({ error: 'Cannot delete primary platform administrator account.' });
    }

    await db.deleteUser(targetId);
    await db.createModerationLog('DELETE_USER', admin, targetUser.username, 'Account deleted permanently');

    sendDiscordLog({
      category: 'moderation',
      action: 'DELETE_USER',
      admin: admin,
      target: targetUser.username,
      details: 'Account and associated messages were permanently deleted.'
    });

    res.json({ success: true, message: `Account ${targetUser.username} deleted.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

// Toggle User Shadowban State (Restricted to Owners)
router.post('/users/:id/shadowban', requireOwner, async (req, res) => {
  const targetId = req.params.id;
  const { is_shadowbanned } = req.body;
  const admin = req.adminUser.username;

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    const isTargetOwner = isOwner(targetUser);
    const isTriggererOwner = isOwner(req.adminUser);
    if (isTargetOwner && !isTriggererOwner) {
      return await punishTreasonousAdmin(req, res, targetUser);
    }

    const shouldShadow = is_shadowbanned === true || is_shadowbanned === 'true';
    await db.shadowbanUser(targetId, shouldShadow);
    
    await db.createModerationLog(
      shouldShadow ? 'SHADOWBAN_USER' : 'UNSHADOWBAN_USER',
      admin,
      targetUser.username,
      shouldShadow ? 'Silently shadowbanned user' : 'Shadowban lifted'
    );

    res.json({
      success: true,
      message: shouldShadow
        ? `Silently shadowbanned user ${targetUser.username}.`
        : `Lifted shadowban for user ${targetUser.username}.`
    });
  } catch (err) {
    console.error('Shadowban API error:', err);
    res.status(500).json({ error: 'Failed to process shadowban action.' });
  }
});

// Ban / Unban User (Full Platform Account Ban with Duration Support)
router.post('/users/:id/ban', requireOwner, async (req, res) => {
  const { is_banned, reason, durationHours } = req.body;
  const targetId = req.params.id;
  const admin = req.adminUser.username;

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    const isTargetOwner = isOwner(targetUser);
    const isTriggererOwner = isOwner(req.adminUser);
    if (isTargetOwner && !isTriggererOwner) {
      return await punishTreasonousAdmin(req, res, targetUser);
    }

    if (['admin', 'owner'].includes(targetUser.role) && req.adminUser.role !== 'owner') {
      return res.status(403).json({ error: 'Cannot ban an administrator or owner.' });
    }

    const shouldBan = is_banned === true || is_banned === 'true';
    let bannedUntil = null;
    let durationText = 'Permanently';

    if (shouldBan && durationHours && Number(durationHours) > 0) {
      const hours = Number(durationHours);
      bannedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
      durationText = `for ${hours} hour(s) (until ${bannedUntil.toLocaleString()})`;
    }

    const banReason = reason || 'Violation of platform guidelines';
    const durationDays = durationHours ? Math.ceil(Number(durationHours) / 24) : 0;
    
    if (shouldBan) {
      await db.banUser(targetId, banReason, durationDays);
    } else {
      await db.unbanUser(targetId);
    }

    const actionName = shouldBan ? 'BAN_USER' : 'UNBAN_USER';
    const logDetails = shouldBan ? `${banReason} [Banned ${durationText}]` : 'Ban lifted';

    await db.createModerationLog(actionName, admin, targetUser.username, logDetails);

    sendDiscordLog({
      category: 'moderation',
      action: actionName,
      admin: admin,
      target: targetUser.username,
      details: logDetails
    });

    if (shouldBan) {
      const io = req.app.get('io');
      if (io) {
        io.emit('user_banned_event', { userId: targetId, username: targetUser.username, reason: banReason, bannedUntil });
      }
    }

    res.json({ success: true, is_banned: shouldBan, reason: banReason, bannedUntil });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update ban status.' });
  }
});

// Mute User (Duration in minutes)
router.post('/users/:id/mute', requireOwner, async (req, res) => {
  const targetId = req.params.id;
  const admin = req.adminUser.username;
  const { durationMinutes = 15, reason = 'Muted by admin' } = req.body;

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    const isTargetOwner = isOwner(targetUser);
    const isTriggererOwner = isOwner(req.adminUser);
    if (isTargetOwner && !isTriggererOwner) {
      return await punishTreasonousAdmin(req, res, targetUser);
    }

    if (['admin', 'owner'].includes(targetUser.role) && req.adminUser.role !== 'owner') {
      return res.status(403).json({ error: 'Cannot mute an administrator or owner.' });
    }

    const mins = Number(durationMinutes) || 15;
    const mutedUntil = await db.muteUser(targetId, mins);

    await db.createModerationLog('MUTE_USER', admin, targetUser.username, `Muted for ${mins}m: ${reason}`);

    sendDiscordLog({
      category: 'moderation',
      action: 'MUTE_USER',
      admin,
      target: targetUser.username,
      details: `User muted for ${mins} minutes: ${reason}`
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('user_muted', { username: targetUser.username, durationMinutes: mins, mutedUntil });
    }

    res.json({ success: true, message: `@${targetUser.username} muted for ${mins} minutes.`, mutedUntil });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mute user.' });
  }
});

// Unmute User
router.post('/users/:id/unmute', requireOwner, async (req, res) => {
  const targetId = req.params.id;
  const admin = req.adminUser.username;

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    await db.unmuteUser(targetId);
    await db.createModerationLog('UNMUTE_USER', admin, targetUser.username, 'Chat mute lifted by admin');

    sendDiscordLog({
      category: 'moderation',
      action: 'UNMUTE_USER',
      admin,
      target: targetUser.username,
      details: 'User chat mute lifted by administrator.'
    });

    res.json({ success: true, message: `Chat mute lifted for @${targetUser.username}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unmute user.' });
  }
});

// Gateway Ban / Restrict Gateway Access Only (with Duration Support)
router.post('/users/:id/gateway-ban', requireOwner, async (req, res) => {
  const { is_gateway_banned, reason, durationHours } = req.body;
  const targetId = req.params.id;
  const admin = req.adminUser.username;

  try {
    const targetUser = await db.getUserById(targetId);
    if (!targetUser) return res.status(404).json({ error: 'User not found.' });

    const gatewayReason = reason || 'Gateway browsing restricted by administrator';
    const result = await db.updateUserGatewayBan(targetId, is_gateway_banned, gatewayReason, durationHours);
    const actionName = is_gateway_banned ? 'GATEWAY_RESTRICT_USER' : 'UNRESTRICT_USER_USER';
    const durLabel = (is_gateway_banned && durationHours > 0) ? ` for ${durationHours} hours` : '';
    await db.createModerationLog(actionName, admin, targetUser.username, `${gatewayReason}${durLabel}`);

    sendDiscordLog({
      category: 'moderation',
      action: actionName,
      admin: admin,
      target: targetUser.username,
      details: `${gatewayReason}${durLabel}`
    });

    res.json({ success: true, is_gateway_banned: Boolean(is_gateway_banned), reason: gatewayReason, timeoutUntil: result?.timeoutUntil });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update gateway ban status.' });
  }
});

// Update Game Details
router.post('/games/:id/update', requireOwner, async (req, res) => {
  const gameId = req.params.id;
  const admin = req.adminUser.username;
  const { title, category, author, thumbnail_url, embed_type, embed_content, clicks, is_taken_down, takedown_reason } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Game title is required.' });
  }

  try {
    const updated = await db.updateGameDetails(gameId, {
      title: title.trim(),
      category: category || 'Action',
      author: author ? author.trim() : 'Studio',
      thumbnail_url: thumbnail_url ? thumbnail_url.trim() : '',
      embed_type: embed_type || 'iframe_url',
      embed_content: embed_content ? embed_content.trim() : '',
      clicks: clicks !== undefined ? parseInt(clicks, 10) : undefined,
      is_taken_down: is_taken_down !== undefined ? Boolean(is_taken_down) : false,
      takedown_reason: takedown_reason !== undefined ? String(takedown_reason).trim() : ''
    });

    await db.createModerationLog('UPDATE_GAME', admin, title.trim(), `Game #${gameId} updated by admin (Takedown: ${Boolean(is_taken_down)})`);
    res.json({ success: true, game: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update game.' });
  }
});

// Delete Game
router.delete('/games/:id', requireOwner, async (req, res) => {
  const admin = req.adminUser.username;
  try {
    await db.deleteGame(req.params.id);
    await db.createModerationLog('DELETE_GAME', admin, `Game ID #${req.params.id}`, 'Removed from catalog');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete game.' });
  }
});

// Clear Gateway Timeout for a user (admin)
router.post('/users/:id/clear-gateway', requireOwner, async (req, res) => {
  const targetId = req.params.id;
  const admin = req.adminUser.username;
  try {
    const success = await db.clearGatewayTimeout(targetId);
    if (success) {
      await db.createModerationLog('CLEAR_GATEWAY_TIMEOUT', admin, targetId, 'Gateway timeout cleared by admin');
      sendDiscordLog({
        category: 'moderation',
        action: 'CLEAR_GATEWAY_TIMEOUT',
        admin,
        target: `User ID ${targetId}`,
        details: 'Gateway timeout removed by administrator.'
      });
      res.json({ success: true, message: 'Gateway timeout cleared.' });
    } else {
      res.status(500).json({ error: 'Failed to clear gateway timeout.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Error clearing gateway timeout.' });
  }
});

// Filter Words
router.get('/filters', requireOwner, async (req, res) => {
  try {
    const filters = await db.getFilterWords();
    res.json({ filters });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get filters.' });
  }
});

router.post('/filters/add', requireOwner, async (req, res) => {
  const { word, filter_type = 'both', punishment = 'censor', reason = '' } = req.body;
  const admin = req.adminUser.username;

  if (!word || !word.trim()) return res.status(400).json({ error: 'Word or phrase is required.' });

  try {
    const filter = await db.addFilterWord(word.toLowerCase().trim(), filter_type, punishment, reason, admin);
    await db.createModerationLog('ADD_FILTER', admin, word, `Punishment: ${punishment} | Scope: ${filter_type}`);
    res.status(201).json({ success: true, filter });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add filter word.' });
  }
});

router.post('/filters/bulk', requireOwner, async (req, res) => {
  const { wordsText, words, filter_type = 'both', punishment = 'censor', reason = '' } = req.body;
  const admin = req.adminUser.username;

  let wordList = [];
  if (Array.isArray(words)) {
    wordList = words;
  } else if (typeof wordsText === 'string') {
    wordList = wordsText.split(/[\n,;]+/).map(w => w.trim()).filter(Boolean);
  }

  if (wordList.length === 0) {
    return res.status(400).json({ error: 'Please enter at least one word or phrase to mass block.' });
  }

  try {
    const result = await db.addFilterWordsBulk(wordList, filter_type, punishment, reason, admin);
    await db.createModerationLog('BULK_ADD_FILTERS', admin, `${result.count} words`, `Punishment: ${punishment} | Scope: ${filter_type}`);
    res.status(201).json({ success: true, count: result.count, message: `Successfully mass-blocked ${result.count} word(s)!` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mass block words.' });
  }
});

router.delete('/filters/:id', requireOwner, async (req, res) => {
  const admin = req.adminUser.username;
  try {
    await db.deleteFilterWord(req.params.id);
    await db.createModerationLog('DELETE_FILTER', admin, `Filter ID #${req.params.id}`, 'Removed filter rule');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete filter.' });
  }
});

// Update Filter Word & Punishment
router.post('/filters/:id/update', requireOwner, async (req, res) => {
  const targetId = req.params.id;
  const admin = req.adminUser.username;
  const { word, filter_type = 'both', punishment = 'censor', reason = '' } = req.body;

  try {
    const updated = await db.updateFilterWord(targetId, { word, filter_type, punishment, reason });
    if (!updated) return res.status(404).json({ error: 'Filter rule not found.' });

    await db.createModerationLog('UPDATE_FILTER', admin, updated.word, `Punishment: ${punishment} | Scope: ${filter_type}`);
    res.json({ success: true, filter: updated, message: `Filter rule for "${updated.word}" updated successfully!` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update filter rule.' });
  }
});

// Bulk Catalog Importer (JSON / CSV payload)
router.post('/games/bulk-import', requireOwner, async (req, res) => {
  const { games } = req.body;
  const admin = req.adminUser.username;

  if (!games || !Array.isArray(games) || games.length === 0) {
    return res.status(400).json({ error: 'Array of game objects required.' });
  }

  try {
    const importedCount = await db.bulkInsertGames(games, admin);
    await db.createModerationLog('BULK_IMPORT_GAMES', admin, 'Catalog', `Imported ${importedCount} items`);

    sendDiscordLog({
      category: 'updates',
      action: 'BULK_GAMES_IMPORTED',
      admin: admin,
      target: `${importedCount} Games`,
      details: `Bulk catalog importer completed successfully with ${importedCount} items.`
    });

    res.json({ success: true, count: importedCount, message: `Successfully imported ${importedCount} games!` });
  } catch (err) {
    console.error('Bulk import error:', err);
    res.status(500).json({ error: 'Failed to bulk import games.' });
  }
});

// Real-Time Activity Radar Stats
router.get('/radar-stats', requireOwner, async (req, res) => {
  try {
    const radar = await db.getActivityRadarStats();
    res.json({ success: true, radar });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch radar stats.' });
  }
});

// Searchable & Filtered Moderation Audit Logs
router.get('/logs', requireOwner, async (req, res) => {
  try {
    const { username, action, startDate, endDate } = req.query;
    if (username || action || startDate || endDate) {
      const logs = await db.getFilteredModerationLogs({ username, action, startDate, endDate });
      return res.json({ logs });
    }
    const logs = await db.getModerationLogs();
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load moderation logs.' });
  }
});

// Game Suggestions List
router.get('/suggestions', async (req, res) => {
  try {
    const suggestions = await db.getGameSuggestions();
    res.json({ success: true, suggestions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch game suggestions.' });
  }
});

// Approve Game Suggestion
router.post('/suggestions/:id/approve', async (req, res) => {
  const admin = req.adminUser.username;
  const suggestionId = req.params.id;

  try {
    const sug = await db.getGameSuggestionById(suggestionId);
    if (!sug) {
      return res.status(404).json({ error: 'Suggestion not found.' });
    }

    const category = sug.category || 'Action';
    const slug = sug.title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 80) + '-' + Date.now().toString().slice(-4);
    
    // Resolve URL from game_url, details, or description (supporting both old/new schemas & test payloads)
    let gameUrl = '';
    if (sug.game_url && sug.game_url.trim().startsWith('http')) {
      gameUrl = sug.game_url.trim();
    } else if (sug.details && sug.details.trim().startsWith('http')) {
      gameUrl = sug.details.trim();
    } else if (sug.description && sug.description.trim().startsWith('http')) {
      gameUrl = sug.description.trim();
    }

    const hasGameUrl = !!gameUrl;
    const hasEmbedContent = (sug.description && (sug.description.includes('<iframe') || sug.description.includes('<script'))) ||
                             (sug.details && (sug.details.includes('<iframe') || sug.details.includes('<script')));

    const embed_type = hasGameUrl ? 'iframe_url' : 'html_code';
    const embed_content = gameUrl || sug.description || sug.details || '';

    if (hasGameUrl || hasEmbedContent) {
      await db.pool.query(`
        INSERT INTO games (title, slug, author, thumbnail_url, embed_type, embed_content, is_vip, category, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8)
        ON CONFLICT (slug) DO UPDATE SET title = $1, embed_content = $6, category = $7
      `, [
        sug.title,
        slug,
        sug.username || 'Community',
        'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=400',
        embed_type,
        embed_content,
        category,
        admin
      ]);
    }

    await db.deleteGameSuggestion(suggestionId);
    await db.createModerationLog('APPROVE_SUGGESTION', admin, sug.title, `Moved suggestion #${suggestionId} to catalog`);

    sendDiscordLog({
      category: 'updates',
      action: 'SUGGESTION_APPROVED',
      admin,
      target: sug.title,
      details: `Suggestion approved and added to catalog category "${category}"`
    });

    res.json({ success: true, message: 'Suggestion approved and published successfully!' });
  } catch (err) {
    console.error('Approve suggestion error:', err);
    res.status(500).json({ error: 'Failed to approve suggestion.' });
  }
});

// Deny Game Suggestion
router.post('/suggestions/:id/deny', async (req, res) => {
  const admin = req.adminUser.username;
  const suggestionId = req.params.id;

  try {
    const sug = await db.getGameSuggestionById(suggestionId);
    if (!sug) {
      return res.status(404).json({ error: 'Suggestion not found.' });
    }

    await db.deleteGameSuggestion(suggestionId);
    await db.createModerationLog('DENY_SUGGESTION', admin, sug.title, `Removed suggestion #${suggestionId}`);

    sendDiscordLog({
      category: 'moderation',
      action: 'SUGGESTION_DENIED',
      admin,
      target: sug.title,
      details: `Suggestion #${suggestionId} denied and removed from queue`
    });
    
    res.json({ success: true, message: 'Suggestion denied successfully.' });
  } catch (err) {
    console.error('Deny suggestion error:', err);
    res.status(500).json({ error: 'Failed to deny suggestion.' });
  }
});

// List Bug Reports
router.get('/bugs', async (req, res) => {
  try {
    const reports = await db.getBugReports();
    res.json({ success: true, bugs: reports });
  } catch (err) {
    console.error('Fetch bug reports error:', err);
    res.status(500).json({ error: 'Failed to fetch bug reports.' });
  }
});

// Delete / Resolve Bug Report
router.post('/bugs/:id/delete', async (req, res) => {
  const admin = req.adminUser.username;
  const bugId = req.params.id;

  try {
    await db.deleteBugReport(bugId);
    await db.createModerationLog('RESOLVE_BUG', admin, `Bug #${bugId}`, `Removed bug report #${bugId}`);

    sendDiscordLog({
      category: 'moderation',
      action: 'BUG_REPORT_RESOLVED',
      admin,
      target: `Bug #${bugId}`,
      details: `Bug report #${bugId} resolved/deleted by administrator`
    });

    res.json({ success: true, message: 'Bug report marked as resolved/deleted.' });
  } catch (err) {
    console.error('Delete bug report error:', err);
    res.status(500).json({ error: 'Failed to delete bug report.' });
  }
});



// ==========================================
// 🛡️ PUNISHMENT APPEALS MANAGEMENT
// ==========================================

// Get all appeals (with optional status filter)
router.get('/appeals', async (req, res) => {
  try {
    const status = req.query.status || 'all';
    const appeals = await db.getAppeals(status);
    res.json({ success: true, appeals });
  } catch (err) {
    console.error('Get appeals error:', err);
    res.status(500).json({ error: 'Failed to fetch appeals.' });
  }
});

// Review appeal (Approve or Reject)
router.post('/appeals/:id/review', async (req, res) => {
  const admin = req.adminUser.username;
  const appealId = req.params.id;
  const { decision, adminNotes } = req.body; // decision: 'approved' | 'rejected'

  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be either "approved" or "rejected".' });
  }

  try {
    const appeal = await db.getAppealById(appealId);
    if (!appeal) {
      return res.status(404).json({ error: 'Appeal not found.' });
    }

    const updatedAppeal = await db.reviewAppeal(appealId, {
      status: decision,
      adminNotes: adminNotes || '',
      reviewedBy: admin
    });

    if (decision === 'approved') {
      // Find target user by ID or Username
      let targetUser = null;
      if (appeal.user_id) {
        targetUser = await db.getUserById(appeal.user_id);
      }
      if (!targetUser && appeal.username) {
        targetUser = await db.getUserByUsername(appeal.username);
      }

      const effectiveUserId = targetUser ? targetUser.id : appeal.user_id;

      if (effectiveUserId) {
        await db.unbanUser(effectiveUserId);
        await db.unmuteUser(effectiveUserId);
      }

      // Also ensure ban and mute are cleared by username in case IDs shifted
      if (appeal.username) {
        try {
          const { pool } = require('../db');
          await pool.query(`
            UPDATE users 
            SET is_banned = false, ban_reason = NULL, banned_until = NULL, muted_until = NULL,
                is_gateway_banned = false, gateway_timeout_until = NULL, gateway_violations_count = 0
            WHERE LOWER(username) = LOWER($1)
          `, [appeal.username.trim()]);
        } catch (e) {}
      }

      await db.createModerationLog('APPEAL_APPROVED', admin, appeal.username, `Punishment lifted. Admin notes: ${adminNotes || 'None'}`);

      sendDiscordLog({
        category: 'moderation',
        action: 'APPEAL_APPROVED',
        admin,
        target: `@${appeal.username}`,
        details: `Punishment appeal approved. ${appeal.punishment_type.toUpperCase()} lifted. Notes: ${adminNotes || 'None'}`
      });

      const io = req.app.get('io');
      if (io) {
        io.emit('appeal_status_updated', { appealId, username: appeal.username, status: 'approved' });
        io.emit('user_unbanned', { userId: effectiveUserId, username: appeal.username });
        io.emit('user_unmuted', { userId: effectiveUserId, username: appeal.username });
      }
    } else {
      await db.createModerationLog('APPEAL_REJECTED', admin, appeal.username, `Appeal rejected. Notes: ${adminNotes || 'None'}`);

      sendDiscordLog({
        category: 'moderation',
        action: 'APPEAL_REJECTED',
        admin,
        target: `@${appeal.username}`,
        details: `Punishment appeal rejected. ${appeal.punishment_type.toUpperCase()} maintained. Notes: ${adminNotes || 'None'}`
      });

      const io = req.app.get('io');
      if (io) {
        io.emit('appeal_status_updated', { appealId, username: appeal.username, status: 'rejected' });
      }
    }

    res.json({
      success: true,
      message: `Appeal #${appealId} successfully ${decision}.`,
      appeal: updatedAppeal
    });
  } catch (err) {
    console.error('Review appeal error:', err);
    res.status(500).json({ error: 'Failed to review appeal.' });
  }
});

// ADMIN LIST ALL SHOP ITEMS (includes items tucked inside sub-stores)
router.get('/shop/items/all', requireOwner, async (req, res) => {
  try {
    const items = await db.getAllShopItemsAdmin();
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch shop items.' });
  }
});

// ===== STORES (sub-shops opened from a "store front" item) =====

// ADMIN LIST STORES
router.get('/stores', requireOwner, async (req, res) => {
  try {
    const stores = await db.getStores();
    res.json({ success: true, stores });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stores.' });
  }
});

// ADMIN GET SINGLE STORE + ITS ITEMS
router.get('/stores/:id', requireOwner, async (req, res) => {
  try {
    const store = await db.getStoreById(req.params.id);
    if (!store) return res.status(404).json({ error: 'Store not found.' });
    const items = await db.getStoreItems(req.params.id);
    res.json({ success: true, store, items });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch store.' });
  }
});

// ADMIN CREATE STORE
router.post('/stores/create', requireOwner, async (req, res) => {
  const { name, description, image_url, banner_url, bg_color, accent_color, text_color, card_bg_color, button_label, bg_image_url, border_color, heading_color } = req.body;
  if (!name) return res.status(400).json({ error: 'Store name is required.' });

  try {
    const newStore = await db.createStore({ name, description: description || '', image_url: image_url || '', banner_url, bg_color, accent_color, text_color, card_bg_color, button_label, bg_image_url, border_color, heading_color });
    if (!newStore) return res.status(500).json({ error: 'Failed to create store.' });

    sendDiscordLog({
      category: 'admin',
      action: 'STORE_CREATED',
      admin: req.adminUser.username,
      target: name,
      details: `Created store "${name}"`
    });

    res.json({ success: true, message: `Store "${name}" created successfully!`, store: newStore });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error creating store.' });
  }
});

// ADMIN UPDATE STORE
router.post('/stores/:id/update', requireOwner, async (req, res) => {
  const storeId = req.params.id;
  const { name, description, image_url, is_active, banner_url, bg_color, accent_color, text_color, card_bg_color, button_label, bg_image_url, border_color, heading_color } = req.body;
  if (!name) return res.status(400).json({ error: 'Store name is required.' });

  try {
    const updated = await db.updateStore(storeId, { name, description: description || '', image_url: image_url || '', is_active, banner_url, bg_color, accent_color, text_color, card_bg_color, button_label, bg_image_url, border_color, heading_color });
    if (!updated) return res.status(500).json({ error: 'Failed to update store.' });

    sendDiscordLog({
      category: 'admin',
      action: 'STORE_UPDATED',
      admin: req.adminUser.username,
      target: name,
      details: `Updated store ID ${storeId}: "${name}"`
    });

    res.json({ success: true, message: `Store "${name}" updated successfully!`, store: updated });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error updating store.' });
  }
});

// ADMIN DELETE STORE
router.post('/stores/:id/delete', requireOwner, async (req, res) => {
  const storeId = req.params.id;
  try {
    const success = await db.deleteStore(storeId);
    if (!success) return res.status(500).json({ error: 'Failed to delete store.' });

    sendDiscordLog({
      category: 'admin',
      action: 'STORE_DELETED',
      admin: req.adminUser.username,
      target: `Store ID: ${storeId}`,
      details: `Deleted store ID ${storeId}. Its items were moved back to the main shop.`
    });

    res.json({ success: true, message: 'Store deleted. Its items were moved back to the main shop.' });
  } catch (err) {
    res.status(500).json({ error: 'Error deleting store.' });
  }
});

// ADMIN CREATE SHOP ITEM
router.post('/shop/create', requireOwner, async (req, res) => {
  const { name, description, price, category, perk_value, delivery_note, stock_count, image_url, is_repeatable, store_id, is_store_front, opens_store_id } = req.body;
  if (!name || !description || !price || !category) {
    return res.status(400).json({ error: 'Name, Description, Price, and Category are required.' });
  }

  try {
    const newItem = await db.createShopItem({
      name,
      description,
      price: parseInt(price, 10),
      category,
      perk_value: perk_value || '',
      delivery_note: delivery_note || '',
      stock_count: stock_count !== undefined ? parseInt(stock_count, 10) : -1,
      image_url: image_url || '',
      is_repeatable: Boolean(is_repeatable),
      store_id: store_id ? parseInt(store_id, 10) : null,
      is_store_front: Boolean(is_store_front),
      opens_store_id: opens_store_id ? parseInt(opens_store_id, 10) : null
    });

    if (!newItem) {
      return res.status(500).json({ error: 'Failed to create shop item.' });
    }

    sendDiscordLog({
      category: 'admin',
      action: 'SHOP_ITEM_CREATED',
      admin: req.adminUser.username,
      target: name,
      details: `Created shop item "${name}" in category "${category}" for 🪙 ${price} (Stock: ${newItem.stock_count})`
    });

    res.json({ success: true, message: `Shop item "${name}" created successfully!`, item: newItem });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error creating shop item.' });
  }
});

// ADMIN BULK CREATE SHOP ITEMS
router.post('/shop/bulk-create', requireOwner, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Valid array of items is required.' });
  }

  const created = [];
  try {
    for (const item of items) {
      const { name, description, price, category, perk_value, delivery_note, stock_count, image_url, is_repeatable } = item;
      if (!name || !description || price === undefined || !category) continue;

      const newItem = await db.createShopItem({
        name,
        description,
        price: parseInt(price, 10),
        category,
        perk_value: perk_value || '',
        delivery_note: delivery_note || '',
        stock_count: stock_count !== undefined ? parseInt(stock_count, 10) : -1,
        image_url: image_url || '',
        is_repeatable: Boolean(is_repeatable)
      });
      if (newItem) created.push(newItem);
    }

    sendDiscordLog({
      category: 'admin',
      action: 'SHOP_ITEMS_BULK_CREATED',
      admin: req.adminUser.username,
      details: `Bulk created ${created.length} shop items.`
    });

    res.json({ success: true, count: created.length, items: created });
  } catch (err) {
    res.status(500).json({ error: 'Failed to bulk create shop items.' });
  }
});

// ADMIN UPDATE SHOP ITEM
router.post('/shop/:id/update', requireOwner, async (req, res) => {
  const itemId = req.params.id;
  const { name, description, price, category, perk_value, delivery_note, stock_count, image_url, is_repeatable, store_id, is_store_front, opens_store_id } = req.body;
  if (!name || !description || price === undefined || !category) {
    return res.status(400).json({ error: 'Name, Description, Price, and Category are required.' });
  }

  try {
    const updated = await db.updateShopItem(itemId, {
      name,
      description,
      price: parseInt(price, 10),
      category,
      perk_value: perk_value || '',
      delivery_note: delivery_note || '',
      stock_count: stock_count !== undefined ? parseInt(stock_count, 10) : -1,
      image_url: image_url || '',
      is_repeatable: Boolean(is_repeatable),
      store_id: store_id ? parseInt(store_id, 10) : null,
      is_store_front: Boolean(is_store_front),
      opens_store_id: opens_store_id ? parseInt(opens_store_id, 10) : null
    });

    if (!updated) {
      return res.status(500).json({ error: 'Failed to update shop item.' });
    }

    sendDiscordLog({
      category: 'admin',
      action: 'SHOP_ITEM_UPDATED',
      admin: req.adminUser.username,
      target: name,
      details: `Updated shop item ID ${itemId}: "${name}" in category "${category}" for 🪙 ${price} (Stock: ${updated.stock_count})`
    });

    res.json({ success: true, message: `Shop item "${name}" updated successfully!`, item: updated });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error updating shop item.' });
  }
});

// ADMIN DELETE SHOP ITEM
router.post('/shop/:id/delete', requireOwner, async (req, res) => {
  const itemId = req.params.id;
  try {
    const success = await db.deleteShopItem(itemId);
    if (!success) {
      return res.status(500).json({ error: 'Failed to delete shop item.' });
    }

    sendDiscordLog({
      category: 'admin',
      action: 'SHOP_ITEM_DELETED',
      admin: req.adminUser.username,
      target: `Item ID: ${itemId}`,
      details: `Deleted shop item ID ${itemId}`
    });

    res.json({ success: true, message: 'Shop item deleted successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Error deleting shop item.' });
  }
});

// ADMIN CREATE QUEST
router.post('/quests/create', requireOwner, async (req, res) => {
  const { title, description, type, target_value, reward_coins, reward_xp } = req.body;
  if (!title || !description || !type || !target_value) {
    return res.status(400).json({ error: 'Title, Description, Type, and Target Value are required.' });
  }

  try {
    const newQuest = await db.createQuest({
      title,
      description,
      type,
      target_value: parseInt(target_value, 10),
      reward_coins: parseInt(reward_coins, 10) || 50,
      reward_xp: parseInt(reward_xp, 10) || 100
    });

    if (!newQuest) {
      return res.status(500).json({ error: 'Failed to create quest.' });
    }

    sendDiscordLog({
      category: 'admin',
      action: 'QUEST_CREATED',
      admin: req.adminUser.username,
      target: title,
      details: `Created quest "${title}" (Type: ${type}, Target: ${target_value})`
    });

    res.json({ success: true, message: `Quest "${title}" created successfully!`, quest: newQuest });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error creating quest.' });
  }
});

// ADMIN DELETE QUEST
router.post('/quests/:id/delete', requireOwner, async (req, res) => {
  const questId = req.params.id;
  try {
    const success = await db.deleteQuest(questId);
    if (!success) {
      return res.status(500).json({ error: 'Failed to delete quest.' });
    }

    sendDiscordLog({
      category: 'admin',
      action: 'QUEST_DELETED',
      admin: req.adminUser.username,
      target: `Quest ID: ${questId}`,
      details: `Deleted quest ID ${questId}`
    });

    res.json({ success: true, message: 'Quest deleted successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Error deleting quest.' });
  }
});

// ==========================================
// 🏆 TOURNAMENTS MANAGEMENT
// ==========================================

// Create new tournament
router.post('/tournaments', requireOwner, async (req, res) => {
  const admin = req.adminUser.username;
  const { gameId, title, description, rewardCoins, rewardXp, rewardFlair, rewardCustom, endAt } = req.body;

  if (!gameId || !title || !endAt) {
    return res.status(400).json({ error: 'Game ID, Title, and End Date/Time are required.' });
  }

  try {
    const tour = await db.createTournament({
      gameId: parseInt(gameId, 10),
      title: title.trim(),
      description: description || '',
      rewardCoins: parseInt(rewardCoins, 10) || 0,
      rewardXp: parseInt(rewardXp, 10) || 0,
      rewardFlair: rewardFlair || '',
      rewardCustom: rewardCustom || '',
      endAt
    });

    if (!tour) {
      return res.status(500).json({ error: 'Failed to create tournament in database.' });
    }

    await db.createModerationLog('CREATE_TOURNAMENT', admin, title, `Game ID: ${gameId}, Rewards: ${rewardCoins}c/${rewardXp}xp`);

    sendDiscordLog({
      category: 'updates',
      action: 'TOURNAMENT_CREATED',
      admin,
      target: title,
      details: `Created score tournament for game ID ${gameId}. Ends at ${endAt}`
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('tournament_created', { tournament: tour });
      await postSystemMessage(io, `🏆 A new High Score Tournament has started: ${title}! Submit your screenshot proof to win prizes! 🪙`);
    }

    res.json({ success: true, message: 'Tournament created successfully!', tournament: tour });
  } catch (err) {
    console.error('Create tournament error:', err);
    res.status(500).json({ error: 'Failed to create tournament.' });
  }
});

// List all pending tournament submissions
router.get('/tournaments/submissions', async (req, res) => {
  try {
    const subs = await db.getPendingSubmissions();
    res.json({ success: true, submissions: subs });
  } catch (err) {
    console.error('Fetch tournament submissions error:', err);
    res.status(500).json({ error: 'Failed to fetch pending submissions.' });
  }
});

// Review tournament submission (Approve / Reject)
router.post('/tournaments/submissions/:id/review', async (req, res) => {
  const admin = req.adminUser.username;
  const submissionId = parseInt(req.params.id, 10);
  const { decision, adminNotes } = req.body;

  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be approved or rejected.' });
  }

  try {
    const { pool } = require('../db');
    const checkSub = await pool.query('SELECT * FROM tournament_submissions WHERE id = $1', [submissionId]);
    const submission = checkSub.rows[0];
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found.' });
    }

    const updated = await db.reviewSubmission(submissionId, decision, admin, adminNotes);
    if (!updated) {
      return res.status(500).json({ error: 'Failed to update submission status.' });
    }

    await db.createModerationLog('REVIEW_TOURNAMENT_SUBMISSION', admin, submission.username, `Decision: ${decision}, Score: ${submission.score}`);

    sendDiscordLog({
      category: 'moderation',
      action: `TOURNAMENT_SUBMISSION_${decision.toUpperCase()}`,
      admin,
      target: `@${submission.username}`,
      details: `Submission #${submissionId} ${decision} by admin. Score: ${submission.score}`
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('tournament_submission_reviewed', {
        submissionId,
        tournamentId: submission.tournament_id,
        status: decision
      });

      if (decision === 'approved') {
        await postSystemMessage(io, `🎉 @${submission.username} had their score of ${submission.score} approved on the leaderboard!`);
      }
    }

    res.json({ success: true, message: `Submission successfully ${decision}!`, submission: updated });
  } catch (err) {
    console.error('Review submission error:', err);
    res.status(500).json({ error: 'Failed to review submission.' });
  }
});

// Close a tournament
router.post('/tournaments/:id/close', requireOwner, async (req, res) => {
  const admin = req.adminUser.username;
  const tournamentId = parseInt(req.params.id, 10);

  try {
    const closed = await db.closeTournament(tournamentId);
    if (!closed) {
      return res.status(404).json({ error: 'Tournament not found.' });
    }

    await db.createModerationLog('CLOSE_TOURNAMENT', admin, closed.title, `Tournament #${tournamentId} closed`);

    sendDiscordLog({
      category: 'updates',
      action: 'TOURNAMENT_CLOSED',
      admin,
      target: closed.title,
      details: `Closed tournament ID ${tournamentId}`
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('tournament_closed', { tournamentId });
      
      const topRows = await db.getTournamentLeaderboard(tournamentId);
      if (topRows && topRows.length > 0) {
        const winner = topRows[0];
        await postSystemMessage(io, `👑 Tournament Over! Congratulations to @${winner.username} for winning "${closed.title}" with a high score of ${winner.score}! 🏆`);
      }
    }

    res.json({ success: true, message: 'Tournament closed successfully.', tournament: closed });
  } catch (err) {
    console.error('Close tournament error:', err);
    res.status(500).json({ error: 'Failed to close tournament.' });
  }
});

// Create a new raffle
router.post('/raffles/create', requireOwner, async (req, res) => {
  const admin = req.adminUser.username;
  const { title, description, ticket_cost, max_tickets_per_user, ends_at } = req.body;

  if (!title || !ends_at) {
    return res.status(400).json({ error: 'Title and Ends At timestamp are required.' });
  }

  try {
    const raffle = await db.createRaffle({
      title,
      description,
      ticket_cost: parseInt(ticket_cost, 10) || 50,
      max_tickets_per_user: parseInt(max_tickets_per_user, 10) || -1,
      ends_at: new Date(ends_at)
    });

    if (!raffle) {
      return res.status(500).json({ error: 'Failed to create raffle.' });
    }

    await db.createModerationLog('CREATE_RAFFLE', admin, title, `Created raffle "${title}" ending at ${ends_at}`);

    sendDiscordLog({
      category: 'updates',
      action: 'RAFFLE_CREATED',
      admin,
      target: title,
      details: `Created raffle ID ${raffle.id} ending at ${ends_at}`
    });

    res.json({ success: true, raffle });
  } catch (err) {
    console.error('Create raffle error:', err);
    res.status(500).json({ error: 'Failed to create raffle.' });
  }
});

// Draw a winner for a raffle manually
router.post('/raffles/:id/draw', requireOwner, async (req, res) => {
  const admin = req.adminUser.username;
  const raffleId = parseInt(req.params.id, 10);

  try {
    const result = await db.drawRaffleWinner(raffleId);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    const raffleRes = await db.pool.query('SELECT title FROM raffles WHERE id = $1', [raffleId]);
    const raffleTitle = raffleRes.rows[0] ? raffleRes.rows[0].title : `Raffle #${raffleId}`;

    await db.createModerationLog('DRAW_RAFFLE', admin, raffleTitle, `Drew winner for raffle #${raffleId}`);

    // If there is a winner, emit a system message in the chat
    if (result.winner) {
      const io = req.app.get('io');
      if (io) {
        await postSystemMessage(io, `🎟️ Raffle Completed! Congratulations to @${result.winner.username} for winning the raffle: "${raffleTitle}"! 🎁`);
      }
    }

    res.json(result);
  } catch (err) {
    console.error('Draw raffle winner error:', err);
    res.status(500).json({ error: 'Failed to draw winner.' });
  }
});

// Delete a raffle
router.post('/raffles/:id/delete', requireOwner, async (req, res) => {
  const admin = req.adminUser.username;
  const raffleId = parseInt(req.params.id, 10);

  try {
    const deleted = await db.deleteRaffle(raffleId);
    if (!deleted) {
      return res.status(500).json({ error: 'Failed to delete raffle.' });
    }

    await db.createModerationLog('DELETE_RAFFLE', admin, `Raffle #${raffleId}`, `Deleted raffle #${raffleId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete raffle error:', err);
    res.status(500).json({ error: 'Failed to delete raffle.' });
  }
});

// ── Spin Wheel Admin CRUD ────────────────────────────────────────────────────

// GET /api/admin/spin-wheel/segments
router.get('/spin-wheel/segments', requireOwner, async (req, res) => {
  try {
    const segments = await db.getSpinWheelSegments();
    res.json({ success: true, segments });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch segments.' });
  }
});

// POST /api/admin/spin-wheel/segments/create
router.post('/spin-wheel/segments/create', requireOwner, async (req, res) => {
  const { label, coins, xp, color, probability, sort_order } = req.body;
  if (!label) return res.status(400).json({ error: 'Label is required.' });
  try {
    const seg = await db.createSpinWheelSegment({ label, coins: parseInt(coins)||0, xp: parseInt(xp)||0, color, probability: parseFloat(probability)||0.05, sort_order: parseInt(sort_order)||0 });
    if (!seg) return res.status(500).json({ error: 'Failed to create segment.' });
    sendDiscordLog({ category: 'admin', action: 'SPIN_SEGMENT_CREATED', admin: req.adminUser.username, details: `Created spin segment "${label}"` });
    res.json({ success: true, segment: seg });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create segment.' });
  }
});

// POST /api/admin/spin-wheel/segments/:id/update
router.post('/spin-wheel/segments/:id/update', requireOwner, async (req, res) => {
  const { label, coins, xp, color, probability, sort_order } = req.body;
  if (!label) return res.status(400).json({ error: 'Label is required.' });
  try {
    const seg = await db.updateSpinWheelSegment(req.params.id, { label, coins: parseInt(coins)||0, xp: parseInt(xp)||0, color, probability: parseFloat(probability)||0.05, sort_order: parseInt(sort_order)||0 });
    if (!seg) return res.status(500).json({ error: 'Failed to update segment.' });
    res.json({ success: true, segment: seg });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update segment.' });
  }
});

// POST /api/admin/spin-wheel/segments/:id/delete
router.post('/spin-wheel/segments/:id/delete', requireOwner, async (req, res) => {
  try {
    await db.deleteSpinWheelSegment(req.params.id);
    sendDiscordLog({ category: 'admin', action: 'SPIN_SEGMENT_DELETED', admin: req.adminUser.username, details: `Deleted spin segment #${req.params.id}` });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete segment.' });
  }
});

// GET /api/admin/promo-codes
router.get('/promo-codes', requireOwner, async (req, res) => {
  try {
    const codes = await db.getPromoCodes();
    res.json({ success: true, codes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch promo codes.' });
  }
});

// POST /api/admin/promo-codes
router.post('/promo-codes', requireOwner, async (req, res) => {
  const { code, reward_type, reward_value, max_uses, expires_at } = req.body;
  if (!code || !reward_type || reward_value === undefined) {
    return res.status(400).json({ error: 'Code, reward type, and reward value are required.' });
  }
  
  const allowedTypes = ['premium', 'coins', 'xp'];
  if (!allowedTypes.includes(reward_type)) {
    return res.status(400).json({ error: 'Invalid reward type. Choose premium, coins, or xp.' });
  }

  try {
    const cleanCode = String(code).trim().toUpperCase();
    const existing = await db.getPromoCodes();
    if (existing.some(c => c.code === cleanCode)) {
      return res.status(409).json({ error: 'Promo code already exists.' });
    }

    const newCode = await db.createPromoCode(cleanCode, reward_type, reward_value, max_uses, expires_at);
    
    sendDiscordLog({
      category: 'admin',
      action: 'PROMO_CODE_CREATED',
      admin: req.adminUser.username,
      details: `Created promo code "${cleanCode}" (Reward: ${reward_value} ${reward_type})`
    });

    res.json({ success: true, promo_code: newCode });
  } catch (err) {
    console.error('Create promo code error:', err);
    res.status(500).json({ error: 'Failed to create promo code.' });
  }
});

// DELETE /api/admin/promo-codes/:code
router.delete('/promo-codes/:code', requireOwner, async (req, res) => {
  const code = req.params.code;
  try {
    await db.deletePromoCode(code);
    
    sendDiscordLog({
      category: 'admin',
      action: 'PROMO_CODE_DELETED',
      admin: req.adminUser.username,
      details: `Deleted promo code "${code.toUpperCase()}"`
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete promo code.' });
  }
});

// GET /api/admin/promo-codes/redemptions
router.get('/promo-codes/redemptions', requireOwner, async (req, res) => {
  try {
    const redemptions = await db.getPromoCodeRedemptions();
    res.json({ success: true, redemptions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch redemptions.' });
  }
});

// POST /api/admin/promo-codes/bulk
router.post('/promo-codes/bulk', requireOwner, async (req, res) => {
  const { prefix, count, reward_type, reward_value, max_uses, expires_at } = req.body;
  const numCount = parseInt(count, 10) || 5;
  if (!reward_type || reward_value === undefined) {
    return res.status(400).json({ error: 'Reward type and reward value are required.' });
  }

  const allowedTypes = ['premium', 'coins', 'xp'];
  if (!allowedTypes.includes(reward_type)) {
    return res.status(400).json({ error: 'Invalid reward type. Choose premium, coins, or xp.' });
  }

  try {
    const generated = [];
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const existing = await db.getPromoCodes();
    const existingSet = new Set(existing.map(c => c.code));

    const cleanPrefix = (prefix || '').trim().toUpperCase();

    for (let i = 0; i < numCount; i++) {
      let code = '';
      let attempts = 0;
      do {
        let randPart = '';
        for (let j = 0; j < 8; j++) {
          randPart += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        code = cleanPrefix ? `${cleanPrefix}-${randPart.slice(0, 4)}-${randPart.slice(4)}` : `${randPart.slice(0, 4)}-${randPart.slice(4)}`;
        attempts++;
      } while ((existingSet.has(code) || generated.some(g => g.code === code)) && attempts < 100);

      const newCode = await db.createPromoCode(code, reward_type, reward_value, max_uses, expires_at);
      generated.push(newCode);
    }

    sendDiscordLog({
      category: 'admin',
      action: 'PROMO_CODES_BULK_CREATED',
      admin: req.adminUser.username,
      details: `Bulk created ${generated.length} promo codes (Reward: ${reward_value} ${reward_type})`
    });

    res.json({ success: true, codes: generated });
  } catch (err) {
    console.error('Bulk create promo codes error:', err);
    res.status(500).json({ error: 'Failed to bulk create promo codes.' });
  }
});

// POST /user-action - Dispatcher for user actions from admin/mod console (Restricted to Owners)
router.post('/user-action', requireOwner, async (req, res) => {
  const { userId, action } = req.body;
  const admin = req.adminUser.username;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required.' });
  }

  try {
    const targetUser = await db.getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (isOwner(targetUser) && !isOwner(req.adminUser)) {
      return await punishTreasonousAdmin(req, res, targetUser);
    }

    const io = req.app.get('io');

    if (action === 'ban') {
      const banDays = 3650; // Long-term ban
      const reason = 'Account suspended by owner via panel';
      await db.banUser(userId, reason, banDays);
      await db.createModerationLog('BAN_USER', admin, targetUser.username, reason);
      
      if (io) {
        io.emit('user_banned_event', {
          userId,
          username: targetUser.username,
          reason,
          bannedUntil: new Date(Date.now() + banDays * 24 * 60 * 60 * 1000)
        });
      }
      sendDiscordLog({
        category: 'moderation',
        action: 'BAN_USER',
        admin,
        target: targetUser.username,
        details: 'User was banned via admin action dispatch.'
      });
      return res.json({ success: true, message: `Banned user ${targetUser.username}.` });

    } else if (action === 'unban') {
      await db.unbanUser(userId);
      await db.createModerationLog('UNBAN_USER', admin, targetUser.username, 'Ban lifted');
      
      if (io) {
        io.emit('user_unbanned_event', { userId, username: targetUser.username });
      }
      sendDiscordLog({
        category: 'moderation',
        action: 'UNBAN_USER',
        admin,
        target: targetUser.username,
        details: 'User ban was lifted.'
      });
      return res.json({ success: true, message: `Unbanned user ${targetUser.username}.` });

    } else if (action === 'suspend') {
      await db.updateUserProfile(userId, { email_verified: 0 });
      await db.createModerationLog('SUSPEND_USER', admin, targetUser.username, 'Suspended verification');
      return res.json({ success: true, message: `Suspended email verification for ${targetUser.username}.` });

    } else if (action === 'verify_email') {
      await db.updateUserProfile(userId, { email_verified: 1 });
      await db.createModerationLog('VERIFY_EMAIL', admin, targetUser.username, 'Manual email verification');
      return res.json({ success: true, message: `Manually verified email for ${targetUser.username}.` });

    } else if (action === 'promote_admin' || action === 'promote_mod') {
      await db.updateUserRole(userId, 'moderator');
      await db.createModerationLog('UPDATE_ROLE', admin, targetUser.username, 'Promoted to Moderator');
      if (io) {
        io.emit('user_profile_updated', { userId, username: targetUser.username, role: 'moderator' });
      }
      return res.json({ success: true, message: `Promoted ${targetUser.username} to Moderator.` });

    } else if (action === 'staff') {
      await db.updateUserRole(userId, 'staff');
      await db.createModerationLog('UPDATE_ROLE', admin, targetUser.username, 'Promoted to Staff');
      if (io) {
        io.emit('user_profile_updated', { userId, username: targetUser.username, role: 'staff' });
      }
      return res.json({ success: true, message: `Promoted ${targetUser.username} to Staff.` });

    } else if (action === 'demote_admin') {
      await db.updateUserRole(userId, 'member');
      await db.createModerationLog('UPDATE_ROLE', admin, targetUser.username, 'Demoted to Member');
      if (io) {
        io.emit('user_profile_updated', { userId, username: targetUser.username, role: 'member' });
      }
      return res.json({ success: true, message: `Demoted ${targetUser.username} to Member.` });

    } else if (action === 'shadowban') {
      if (!isOwner(req.adminUser)) {
        return res.status(403).json({ error: 'Only the platform Owner can shadowban users.' });
      }
      await db.shadowbanUser(userId, true);
      await db.createModerationLog('SHADOWBAN_USER', admin, targetUser.username, 'Shadowbanned silently');
      return res.json({ success: true, message: `Silently shadowbanned user ${targetUser.username}.` });

    } else if (action === 'unshadowban') {
      if (!isOwner(req.adminUser)) {
        return res.status(403).json({ error: 'Only the platform Owner can lift shadowbans.' });
      }
      await db.shadowbanUser(userId, false);
      await db.createModerationLog('UNSHADOWBAN_USER', admin, targetUser.username, 'Shadowban lifted');
      return res.json({ success: true, message: `Lifted shadowban for user ${targetUser.username}.` });

    } else if (action === 'delete') {
      if (isOwner(targetUser)) {
        return res.status(403).json({ error: 'Cannot delete primary platform administrator account.' });
      }
      await db.deleteUser(userId);
      await db.createModerationLog('DELETE_USER', admin, targetUser.username, 'Account deleted permanently');
      sendDiscordLog({
        category: 'moderation',
        action: 'DELETE_USER',
        admin,
        target: targetUser.username,
        details: 'Account and associated messages were permanently deleted.'
      });
      return res.json({ success: true, message: `Account ${targetUser.username} deleted.` });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('user-action dispatch error:', err);
    res.status(500).json({ error: 'Failed to process user action.' });
  }
});

// GET /api/admin/badges - List all custom badges
router.get('/badges', async (req, res) => {
  try {
    const list = await db.getCustomBadges();
    res.json({ success: true, badges: list });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve badges.' });
  }
});

// POST /api/admin/badges/create - Create custom badge
router.post('/badges/create', async (req, res) => {
  const { badgeKey, title, description, icon } = req.body;
  if (!badgeKey || !title || !description || !icon) {
    return res.status(400).json({ error: 'All badge fields are required.' });
  }
  try {
    const badge = await db.createCustomBadge({ badgeKey, title, description, icon });
    if (!badge) return res.status(400).json({ error: 'Failed to create badge (badge key might already exist).' });
    
    await db.createModerationLog('CREATE_BADGE', req.adminUser.username, title, `Created custom badge key: ${badgeKey}`);
    res.json({ success: true, badge });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create badge.' });
  }
});

// POST /api/admin/badges/grant - Grant badge to user
router.post('/badges/grant', async (req, res) => {
  const { username, badgeKey } = req.body;
  if (!username || !badgeKey) {
    return res.status(400).json({ error: 'Username and badge key are required.' });
  }
  try {
    const user = await db.getUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    await db.grantUserBadge(user.id, badgeKey);
    await db.createModerationLog('GRANT_BADGE', req.adminUser.username, user.username, `Granted badge key: ${badgeKey}`);
    res.json({ success: true, message: `Successfully granted badge to ${user.username}!` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to grant badge.' });
  }
});

// DELETE /api/admin/badges/:key - Delete custom badge
router.delete('/badges/:key', async (req, res) => {
  const badgeKey = req.params.key;
  try {
    await db.deleteCustomBadge(badgeKey);
    await db.createModerationLog('DELETE_BADGE', req.adminUser.username, badgeKey, `Deleted custom badge key: ${badgeKey}`);
    res.json({ success: true, message: 'Badge deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete badge.' });
  }
});

// GET /api/admin/hardware-bans - List all hardware bans
router.get('/hardware-bans', async (req, res) => {
  try {
    const bans = await db.getBannedHardwareList();
    res.json({ success: true, bans });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch hardware bans.' });
  }
});

// POST /api/admin/hardware-ban - Issue hardware ban by HWID or username
router.post('/hardware-ban', async (req, res) => {
  const { hwid, username, reason } = req.body;
  try {
    let targetHwid = hwid;
    let targetUsername = username || '';

    if (!targetHwid && targetUsername) {
      const u = await db.getUserByUsername(targetUsername);
      if (u && u.last_hwid) {
        targetHwid = u.last_hwid;
      }
    }

    if (!targetHwid) {
      return res.status(400).json({ error: 'Hardware ID or valid user with recorded Hardware ID is required.' });
    }

    const banRecord = await db.banHardwareId(targetHwid, reason || 'Hardware Banned', req.adminUser.username, targetUsername);
    await db.createModerationLog('HARDWARE_BAN', req.adminUser.username, targetUsername || targetHwid, `Banned HWID: ${targetHwid}. Reason: ${reason || 'None'}`);

    res.json({ success: true, message: 'Hardware ban issued successfully!', ban: banRecord });
  } catch (err) {
    res.status(500).json({ error: 'Failed to issue hardware ban.' });
  }
});

// DELETE /api/admin/hardware-ban/:hwid - Revoke hardware ban
router.delete('/hardware-ban/:hwid', async (req, res) => {
  const targetHwid = req.params.hwid;
  try {
    await db.unbanHardwareId(targetHwid);
    await db.createModerationLog('HARDWARE_UNBAN', req.adminUser.username, targetHwid, `Revoked hardware ban for HWID: ${targetHwid}`);
    res.json({ success: true, message: 'Hardware ban revoked successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke hardware ban.' });
  }
});

// POST /api/admin/takedown - Execute instant DMCA/Content Takedown
router.post('/takedown', async (req, res) => {
  const { targetType, targetId, reason } = req.body;
  if (!targetType || !targetId) {
    return res.status(400).json({ error: 'Target type and target ID are required.' });
  }

  try {
    if (targetType === 'game') {
      await db.takedownGame(targetId, reason || 'DMCA / Content Safety Takedown');
      await db.createModerationLog('GAME_TAKEDOWN', req.adminUser.username, `Game ID ${targetId}`, reason || 'Takedown');
      return res.json({ success: true, message: `Game ID ${targetId} taken down successfully.` });
    } else if (targetType === 'domain') {
      await db.blockDomain(targetId, reason || 'Host Safety Takedown');
      await db.createModerationLog('DOMAIN_BLOCK', req.adminUser.username, targetId, reason || 'Takedown');
      return res.json({ success: true, message: `Domain "${targetId}" blocked from proxy gateway successfully.` });
    } else {
      return res.status(400).json({ error: 'Invalid target type.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to process takedown.' });
  }
});

// GET /api/admin/export-backup - 1-Click Export Site Configuration Backup JSON
router.get('/export-backup', async (req, res) => {
  try {
    const games = await db.getAllGames();
    const announcement = await db.getActiveAnnouncement();
    const features = await db.getFeatureSettings();
    const proConfig = await db.getProPageConfig();
    const hwidBans = await db.getBannedHardwareList();

    const backupData = {
      version: '3.0.0',
      exportedAt: new Date().toISOString(),
      exportedBy: req.adminUser.username,
      games: games || [],
      announcement: announcement || null,
      features: features || {},
      proConfig: proConfig || {},
      hwidBans: hwidBans || []
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=nitro_backup_${Date.now()}.json`);
    res.json(backupData);
  } catch (err) {
    console.error('export-backup error:', err);
    res.status(500).json({ error: 'Failed to generate site backup.' });
  }
});

// POST /api/admin/import-backup - 1-Click Import Site Backup JSON
router.post('/import-backup', async (req, res) => {
  const { backup } = req.body;
  if (!backup || typeof backup !== 'object') {
    return res.status(400).json({ error: 'Valid site backup JSON object is required.' });
  }

  try {
    let importedItemsCount = 0;
    if (Array.isArray(backup.games)) {
      for (const g of backup.games) {
        if (g.title && g.iframeUrl) {
          await db.saveGame(g);
          importedItemsCount++;
        }
      }
    }

    if (backup.announcement) {
      await db.updateActiveAnnouncement(backup.announcement.title, backup.announcement.message, backup.announcement.type);
    }

    await db.createModerationLog('IMPORT_BACKUP', req.adminUser.username, 'System', `Imported site backup created on ${backup.exportedAt || 'unknown'}`);
    res.json({ success: true, message: `✅ Site backup restored successfully! Processed ${importedItemsCount} catalog items.` });
  } catch (err) {
    console.error('import-backup error:', err);
    res.status(500).json({ error: 'Failed to restore site backup.' });
  }
});

module.exports = router;

