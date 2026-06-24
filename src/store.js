'use strict';
const fs = require('fs');
const { config } = require('./config');

/**
 * Durable key/value backing for the bot's tenant state.
 *
 * Two backends, selected automatically:
 *   • Postgres  — when DATABASE_URL is set (Heroku). The whole tenant map is
 *     stored as a single JSONB blob in a `bot_kv` row. Heroku's filesystem is
 *     ephemeral (wiped on every deploy + daily dyno restart), so file storage
 *     there would silently lose every guild's Rust+ credentials — Postgres makes
 *     it durable.
 *   • File       — when DATABASE_URL is absent (local dev / the legacy VM). Keeps
 *     the exact original behaviour: data/tenants.json on disk.
 *
 * The in-memory tenant object remains the single source of truth at runtime;
 * writes are persisted asynchronously (debounced) for the DB backend so the
 * synchronous tenants.js API is preserved unchanged.
 */

const DATABASE_URL = process.env.DATABASE_URL || '';
const KEY = 'tenants';

let pool = null;
if (DATABASE_URL) {
  // Lazy require so file-mode installs never need the pg native client present.
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Heroku Postgres mandates TLS but uses a self-signed chain.
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  pool.on('error', (e) => console.error('[store] pg pool error:', e.message));
}

async function init() {
  if (!pool) return;
  await pool.query('CREATE TABLE IF NOT EXISTS bot_kv (k text PRIMARY KEY, v jsonb NOT NULL)');
}

async function loadBlob() {
  if (pool) {
    const r = await pool.query('SELECT v FROM bot_kv WHERE k = $1', [KEY]);
    return (r.rows[0] && r.rows[0].v) || {};
  }
  try { return JSON.parse(fs.readFileSync(config.paths.tenants, 'utf8')) || {}; }
  catch { return {}; }
}

// ── Debounced async persistence (DB backend) ───────────────────────────────
let saveTimer = null;
let pendingBlob = null;

async function flushDb() {
  const data = pendingBlob;
  saveTimer = null;
  pendingBlob = null;
  if (data == null) return;
  try {
    await pool.query(
      'INSERT INTO bot_kv (k, v) VALUES ($1, $2::jsonb) ON CONFLICT (k) DO UPDATE SET v = $2::jsonb',
      [KEY, JSON.stringify(data)],
    );
  } catch (e) {
    console.error('[store] db save failed:', e.message);
  }
}

function saveBlob(obj) {
  if (pool) {
    pendingBlob = obj;
    if (!saveTimer) saveTimer = setTimeout(flushDb, 400);
    return;
  }
  // File backend — synchronous, matching the original behaviour.
  try {
    if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(config.paths.tenants, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('[store] file save failed:', e.message);
  }
}

module.exports = { init, loadBlob, saveBlob, usingDb: !!pool };
