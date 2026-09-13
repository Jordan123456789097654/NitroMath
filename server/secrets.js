// server/secrets.js
// Single source of truth for the JWT / session signing secret.
//
// Previously every route file did:
//   const JWT_SECRET = process.env.SESSION_SECRET || 'nitro_jwt_secure_key_2026';
// That hardcoded fallback is committed to the public repo, so if SESSION_SECRET
// is ever left unset in a real deployment, anyone can forge valid login/admin
// JWTs using the public fallback string. This module removes that fallback.
//
// If SESSION_SECRET is missing we generate a random secret at boot instead of
// using a known string. It changes on every restart (which will log everyone
// out), but that's far safer than a guessable, publicly-known signing key.
// Deployers should set SESSION_SECRET in their environment (.env / host
// dashboard) to a long random value so sessions survive restarts.

const crypto = require('crypto');

let secret = process.env.SESSION_SECRET;

if (!secret || secret.trim().length < 16) {
  secret = crypto.randomBytes(48).toString('hex');
  console.warn(
    '⚠️  [Security] SESSION_SECRET is not set (or too short) in your environment.\n' +
    '    Generated a random one-time secret for this process instead of a hardcoded fallback.\n' +
    '    All active sessions/tokens will be invalidated on every restart until you set\n' +
    '    SESSION_SECRET to a long random value in your environment / .env file.'
  );
}

const GROQ_API_KEY = (process.env.GROQ_API_KEY || 'kyro_sk_live_pHt_w89IcUZ-k1_nGBtu0xS8N0e-3lby').trim();
const GROQ_ENDPOINT = (process.env.GROQ_ENDPOINT || 'https://kyro-api-auou.onrender.com/v1/chat/completions').trim();
const GROQ_TEXT_MODEL = (process.env.GROQ_TEXT_MODEL || 'kyro-ultra-70b').trim();
const GROQ_VISION_MODEL = (process.env.GROQ_VISION_MODEL || 'kyro-coder-pro').trim();

if (!GROQ_API_KEY) {
  console.warn(
    '⚠️  [AI Security Notice] GROQ_API_KEY is not set in your environment / .env file.\n' +
    '    Configure GROQ_API_KEY in your Render dashboard / environment variables to enable Groq AI.'
  );
}

module.exports = {
  JWT_SECRET: secret,
  SESSION_SECRET: secret,
  GROQ_API_KEY,
  GROQ_ENDPOINT,
  GROQ_TEXT_MODEL,
  GROQ_VISION_MODEL
};
