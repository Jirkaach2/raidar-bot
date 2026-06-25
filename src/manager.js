'use strict';
const RustBridge = require('./rust');
const tenants = require('./tenants');
const { lookupPlayer } = require('./lookup');

/**
 * Owns Rust+ connections per guild, with idle management:
 *   - guilds with a notify channel stay connected (needed to catch alarms)
 *   - other guilds connect on demand (when a command is used) and disconnect
 *     after IDLE_MS of inactivity, so inactive servers don't hold a socket.
 *
 * Alarms are detected over the live connection (a Smart Alarm entity flipping
 * to ON emits an entityChanged broadcast). `onNotify(guildId, event)` is
 * injected by index.js to post to Discord.
 */
const IDLE_MS = 10 * 60 * 1000;

/**
 * Compact one-line team-chat summary for `!check` (kept under ~120 chars).
 * Omits null fields. Example:
 *   RAIDAR: Joe | 1,204h Rust | 8h/2wk | VAC | K/D 2.3
 */
function formatCheckLine(p) {
  const parts = [`RAIDAR: ${p.name}`];
  if (p.rustHours != null) parts.push(`${p.rustHours.toLocaleString()}h Rust`);
  else if (p.visibility === 'private') parts.push('private');
  if (p.recentHours != null) parts.push(`${p.recentHours}h/2wk`);
  if (p.vacBanned) parts.push('VAC');
  else if (p.gameBans && p.gameBans > 0) parts.push(`${p.gameBans} game ban${p.gameBans === 1 ? '' : 's'}`);
  if (p.kd != null) parts.push(`K/D ${Math.round(p.kd * 100) / 100}`);
  let line = parts.join(' | ');
  if (line.length > 120) line = line.slice(0, 119) + '…';
  return line;
}

/** HH:MM in-game clock from a getTime() payload. */
function fmtGameTime(t) {
  const h = Math.floor(t.time || 0);
  const m = Math.floor(((t.time || 0) - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Short relative age (e.g. "2d 3h ago") from an epoch-seconds timestamp. */
function shortRelative(unixSec) {
  const s = Math.max(0, Math.floor((Date.now() - unixSec * 1000) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (!d) parts.push(`${m}m`);
  return `${parts.slice(0, 2).join(' ') || '0m'} ago`;
}

class Manager {
  constructor() {
    this.rust = new Map();      // guildId -> RustBridge
    this.lastUsed = new Map();  // guildId -> timestamp
    this.onNotify = () => {};
    setInterval(() => this._sweepIdle(), 60_000).unref();
  }

  bootAll() {
    // Nothing to pre-connect: notifications come from the app (/api/notify),
    // and command connections are established on demand.
  }

  touch(guildId) { this.lastUsed.set(guildId, Date.now()); }

  getRust(guildId) {
    const b = this.rust.get(guildId);
    return b && b.connected ? b : null;
  }

  /** Connect if needed and resolve once connected (or null on timeout). */
  async ensureRust(guildId) {
    this.touch(guildId);
    let b = this.rust.get(guildId);
    if (b && b.connected) return b;
    this.startRust(guildId);
    b = this.rust.get(guildId);
    if (!b) return null;
    if (b.connected) return b;
    return new Promise((resolve) => {
      const done = (val) => { clearTimeout(timer); b.off('connected', onConn); resolve(val); };
      const onConn = () => done(b);
      const timer = setTimeout(() => done(b.connected ? b : null), 9000);
      b.once('connected', onConn);
    });
  }

  startFcm() { /* no-op — FCM removed */ }

  startRust(guildId) {
    const t = tenants.get(guildId);
    if (!t || !t.server) return;
    let bridge = this.rust.get(guildId);
    if (!bridge) {
      bridge = new RustBridge();
      this.rust.set(guildId, bridge);
      bridge.on('connected', (s) => console.log(`[rust:${guildId}] connected to ${s.name || s.ip}`));
      bridge.on('disconnected', () => console.log(`[rust:${guildId}] disconnected`));
      bridge.on('rust-error', (e) => console.error(`[rust:${guildId}]`, e && e.message ? e.message : e));
      // In-game team-chat commands → compact one-line replies in team chat.
      bridge.on('teamMessage', async (m) => {
        try {
          const text = m && m.message;
          if (!text || typeof text !== 'string') return;
          // Never react to our own "RAIDAR:" replies (avoids feedback loops).
          if (/^\s*RAIDAR:/i.test(text)) return;
          const token = (text.trim().split(/\s+/)[0] || '').toLowerCase();

          if (token === '!check') {
            const match = text.match(/^\s*!check\s+"?(\d{17})"?/i);
            if (!match) return;
            const steamId = match[1];
            let p;
            try {
              p = await lookupPlayer(steamId);
            } catch (e) {
              await bridge.sendTeamMessage(`RAIDAR: ${e.message || 'invalid SteamID64'}`).catch(() => {});
              return;
            }
            await bridge.sendTeamMessage(formatCheckLine(p)).catch(() => {});
            return;
          }

          if (token === '!pop') {
            const info = await bridge.getInfo();
            await bridge.sendTeamMessage(`RAIDAR: ${info.players}/${info.maxPlayers} online`).catch(() => {});
            return;
          }

          if (token === '!time') {
            const tm = await bridge.getTime();
            const day = tm.time >= tm.sunrise && tm.time < tm.sunset;
            await bridge.sendTeamMessage(`RAIDAR: ${fmtGameTime(tm)} in-game (${day ? 'day' : 'night'})`).catch(() => {});
            return;
          }

          if (token === '!wipe') {
            const info = await bridge.getInfo();
            const rel = info.wipeTime ? shortRelative(info.wipeTime) : 'unknown';
            await bridge.sendTeamMessage(`RAIDAR: last wipe ${rel}`).catch(() => {});
            return;
          }
        } catch (e) {
          console.error(`[rust:${guildId}] teamMessage`, e && e.message ? e.message : e);
        }
      });
    }
    bridge.connect(t.server);
  }

  _sweepIdle() {
    const now = Date.now();
    for (const [guildId, b] of this.rust) {
      if (now - (this.lastUsed.get(guildId) || 0) > IDLE_MS) {
        b.disconnect();
        this.rust.delete(guildId);
        console.log(`[rust:${guildId}] idle — released socket`);
      }
    }
  }

  stop(guildId) {
    const r = this.rust.get(guildId);
    if (r) { r.disconnect(); this.rust.delete(guildId); }
    this.lastUsed.delete(guildId);
  }
}

module.exports = new Manager();
