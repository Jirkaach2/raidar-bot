'use strict';
/**
 * Short-lived link codes for the "seamless" pairing path: a guild admin runs
 * /link to mint a code, then the Raidar desktop app POSTs its already-valid
 * credentials to /api/link with that code. No browser Steam flow needed.
 */
const codes = new Map(); // CODE -> { guildId, createdAt }
const TTL_MS = 10 * 60 * 1000;

function gen() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += alphabet[Math.floor(Math.random() * alphabet.length)];
  return c;
}

function createCode(guildId) {
  const code = gen();
  codes.set(code, { guildId, createdAt: Date.now() });
  return code;
}

function claim(code) {
  const key = String(code || '').toUpperCase().trim();
  const entry = codes.get(key);
  if (!entry) return null;
  codes.delete(key);
  if (Date.now() - entry.createdAt > TTL_MS) return null;
  return entry.guildId;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of codes) if (now - e.createdAt > TTL_MS) codes.delete(k);
}, 60_000).unref();

module.exports = { createCode, claim };
