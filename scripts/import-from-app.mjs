// Seed YOUR OWN guild as a tenant from the desktop app's data, so the bot
// owner doesn't need the web pairing flow. Run on the PC that has Raidar:
//
//   node scripts/import-from-app.mjs <DISCORD_GUILD_ID>
//
// Reads src-tauri/rustplus.config.json (FCM credentials) + the most recent
// server_profiles row from src-tauri/rustoverlay.db and writes them into
// discord-bot/data/tenants.json under the given guild id. Ship data/tenants.json
// to the VM (or run this there).
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

const guildId = process.argv[2];
if (!guildId) {
  console.error('Usage: node scripts/import-from-app.mjs <DISCORD_GUILD_ID>');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = join(__dirname, '..');
const SRC_TAURI = join(BOT_DIR, '..', 'src-tauri');
const dataDir = join(BOT_DIR, 'data');
const tenantsPath = join(dataDir, 'tenants.json');

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

// 1) Credentials from the app's rustplus.config.json
let credentials = null;
const fcmSrc = join(SRC_TAURI, 'rustplus.config.json');
if (existsSync(fcmSrc)) {
  const cfg = JSON.parse(readFileSync(fcmSrc, 'utf8'));
  credentials = {
    fcm_credentials: cfg.fcm_credentials,
    expo_push_token: cfg.expo_push_token,
    rustplus_auth_token: cfg.rustplus_auth_token,
    steamId: null,
  };
  console.log('✓ Loaded FCM credentials from the app.');
} else {
  console.warn('! rustplus.config.json not found.');
}

// 2) Server profile from the app DB (BigInt for the 64-bit player_id)
let server = null;
const dbPath = join(SRC_TAURI, 'rustoverlay.db');
if (existsSync(dbPath)) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.defaultSafeIntegers(true);
  const row = db.prepare('SELECT ip, port, player_id, player_token, server_name FROM server_profiles ORDER BY last_connected DESC LIMIT 1').get();
  db.close();
  if (row) {
    server = {
      ip: String(row.ip),
      port: Number(row.port),
      playerId: row.player_id.toString(),
      playerToken: Number(row.player_token),
      name: String(row.server_name || ''),
    };
    console.log(`✓ Loaded server: ${server.name || server.ip}:${server.port}`);
  }
} else {
  console.warn('! rustoverlay.db not found.');
}

// 3) Merge into tenants.json under the guild id
let tenants = {};
if (existsSync(tenantsPath)) {
  try { tenants = JSON.parse(readFileSync(tenantsPath, 'utf8')) || {}; } catch { /* ignore */ }
}
const existing = tenants[guildId] || { credentials: null, server: null, devices: [], notifyChannelId: null, controlRoleId: null, allowedUserIds: [] };
tenants[guildId] = { ...existing, credentials: credentials || existing.credentials, server: server || existing.server };
writeFileSync(tenantsPath, JSON.stringify(tenants, null, 2), 'utf8');

console.log(`✓ Seeded tenant ${guildId} in data/tenants.json.`);
