'use strict';
require('dotenv').config();
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

function list(v) {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  root: ROOT,
  dataDir: DATA_DIR,

  // Discord
  token: process.env.DISCORD_TOKEN || '',
  clientId: process.env.DISCORD_CLIENT_ID || '',
  guildId: process.env.DISCORD_GUILD_ID || '', // optional: register cmds to one guild for testing
  // Owner's guild — owner-only commands register ONLY here so other servers never see them.
  ownerGuildId: process.env.DISCORD_OWNER_GUILD_ID || '1515105400284774661',

  // Default permission fallbacks (per-guild values override these)
  controlRoleId: process.env.CONTROL_ROLE_ID || '',
  allowedUserIds: list(process.env.ALLOWED_USER_IDS),

  // Pairing web server (Steam login → FCM credentials)
  pairingPort: parseInt(process.env.PAIRING_PORT || '3000', 10),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''), // e.g. https://bot.example.com

  paths: {
    tenants: path.join(DATA_DIR, 'tenants.json'),
  },
};

function assertReady() {
  if (!config.token) throw new Error('Missing DISCORD_TOKEN. Set it in discord-bot/.env');
}

function assertDeployReady() {
  const missing = [];
  if (!config.token) missing.push('DISCORD_TOKEN');
  if (!config.clientId) missing.push('DISCORD_CLIENT_ID');
  if (missing.length) throw new Error(`Missing required env: ${missing.join(', ')}. Fill them in discord-bot/.env`);
}

module.exports = { config, assertReady, assertDeployReady };
