// Seed Heroku Postgres with an existing tenants.json (one-off migration tool).
//
//   $env:DATABASE_URL = (heroku config:get DATABASE_URL -a <app>)
//   node scripts/seed-db.mjs [path/to/tenants.json]
//
// Stores the whole tenant map as the single `bot_kv` JSONB row the bot reads.
import fs from 'fs';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL first.'); process.exit(1); }

const file = process.argv[2] || 'data/tenants.json';
let blob;
try { blob = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error(`Cannot read ${file}:`, e.message); process.exit(1); }

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
await pool.query('CREATE TABLE IF NOT EXISTS bot_kv (k text PRIMARY KEY, v jsonb NOT NULL)');
await pool.query(
  'INSERT INTO bot_kv (k, v) VALUES ($1, $2::jsonb) ON CONFLICT (k) DO UPDATE SET v = $2::jsonb',
  ['tenants', JSON.stringify(blob)],
);
console.log(`Seeded ${Object.keys(blob).length} guild(s) into bot_kv.`);
await pool.end();
