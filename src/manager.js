'use strict';
const RustBridge = require('./rust');
const tenants = require('./tenants');
const { lookupPlayer } = require('./lookup');
const { getGridCoordinate } = require('./grid');

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

/** In-game time (h/m) until the next sunrise/sunset transition. */
function untilTransition(t) {
  const day = t.time >= t.sunrise && t.time < t.sunset;
  let delta;
  if (day) delta = t.sunset - t.time;
  else if (t.time >= t.sunset) delta = (24 - t.time) + t.sunrise;
  else delta = t.sunrise - t.time;
  if (delta < 0) delta += 24;
  const h = Math.floor(delta);
  const m = Math.floor((delta - h) * 60);
  return { day, next: day ? 'night' : 'day', h, m };
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

/**
 * Compact loot reference for the in-game `!loot <crate>` reply. No live DB, so
 * these are curated top picks per crate (kept short for team chat).
 */
const LOOT_TOP = {
  military: 'Military: Metal Frags, Scrap, Pistol Bullets',
  elite: 'Elite: Scrap, Tech Trash, Assault Rifle',
  basic: 'Basic: Wood, Metal Frags, Low Grade Fuel',
  locked: 'Locked: Scrap, Tech Trash, HQ Metal',
};

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

          if (token === '!team') {
            const team = await bridge.getTeamInfo();
            const members = team.members || [];
            const online = members.filter((mm) => mm.isOnline);
            let names = online.map((mm) => mm.name).join(', ');
            if (names.length > 80) names = names.slice(0, 79) + '…';
            await bridge.sendTeamMessage(`RAIDAR: ${online.length}/${members.length} online${names ? ': ' + names : ''}`).catch(() => {});
            return;
          }

          if (token === '!cargo') {
            const info = await bridge.getInfo();
            const res = await bridge.getMapMarkers();
            const cargo = (res.markers || []).find((mm) => mm.type === 5);
            await bridge.sendTeamMessage(cargo ? `RAIDAR: cargo at ${getGridCoordinate(cargo.x, cargo.y, info.mapSize)}` : 'RAIDAR: no cargo on map').catch(() => {});
            return;
          }

          if (token === '!vendor') {
            const info = await bridge.getInfo();
            const res = await bridge.getMapMarkers();
            // Travelling vendor is marker type 15 on newer rustplus.
            const vendor = (res.markers || []).find((mm) => mm.type === 15);
            await bridge.sendTeamMessage(vendor ? `RAIDAR: vendor at ${getGridCoordinate(vendor.x, vendor.y, info.mapSize)}` : 'RAIDAR: no travelling vendor on map').catch(() => {});
            return;
          }

          if (token === '!online') {
            const team = await bridge.getTeamInfo();
            const members = team.members || [];
            const online = members.filter((mm) => mm.isOnline);
            await bridge.sendTeamMessage(`RAIDAR: ${online.length}/${members.length} teammates online`).catch(() => {});
            return;
          }

          if (token === '!grid') {
            const info = await bridge.getInfo();
            const team = await bridge.getTeamInfo();
            const online = (team.members || []).filter((mm) => mm.isOnline);
            let line = online.map((mm) => `${mm.name} ${getGridCoordinate(mm.x, mm.y, info.mapSize)}`).join(', ');
            if (!line) line = 'no teammates online';
            if (line.length > 120) line = line.slice(0, 119) + '…';
            await bridge.sendTeamMessage(`RAIDAR: ${line}`).catch(() => {});
            return;
          }

          if (token === '!loot') {
            const crate = (text.trim().split(/\s+/)[1] || '').toLowerCase();
            const line = LOOT_TOP[crate];
            await bridge.sendTeamMessage(`RAIDAR: ${line || 'use !loot military|elite|basic|locked'}`).catch(() => {});
            return;
          }

          if (token === '!heli') {
            const info = await bridge.getInfo();
            const res = await bridge.getMapMarkers();
            const heli = (res.markers || []).find((mm) => mm.type === 8);
            await bridge.sendTeamMessage(heli ? `RAIDAR: heli at ${getGridCoordinate(heli.x, heli.y, info.mapSize)}` : 'RAIDAR: no heli active').catch(() => {});
            return;
          }

          if (token === '!events') {
            const res = await bridge.getMapMarkers();
            const markers = res.markers || [];
            const cargo = markers.filter((mm) => mm.type === 5).length;
            const heli = markers.filter((mm) => mm.type === 8).length;
            const chinook = markers.filter((mm) => mm.type === 4).length;
            const crate = markers.filter((mm) => mm.type === 6).length;
            const parts = [];
            if (cargo) parts.push(`cargo x${cargo}`);
            if (heli) parts.push(`heli x${heli}`);
            if (chinook) parts.push(`chinook x${chinook}`);
            if (crate) parts.push(`crate x${crate}`);
            await bridge.sendTeamMessage(`RAIDAR: ${parts.length ? parts.join(', ') : 'no active events'}`).catch(() => {});
            return;
          }

          if (token === '!sun') {
            const tm = await bridge.getTime();
            const u = untilTransition(tm);
            await bridge.sendTeamMessage(`RAIDAR: ${u.h}h${u.m}m until ${u.next}`).catch(() => {});
            return;
          }

          if (token === '!status') {
            const info = await bridge.getInfo();
            const tm = await bridge.getTime();
            const day = tm.time >= tm.sunrise && tm.time < tm.sunset;
            await bridge.sendTeamMessage(`RAIDAR: ${info.players}/${info.maxPlayers} online · ${fmtGameTime(tm)} ${day ? 'day' : 'night'}`).catch(() => {});
            return;
          }

          if (token === '!crate' || token === '!crates') {
            const info = await bridge.getInfo();
            const res = await bridge.getMapMarkers();
            // No manual timer store on the bot — report live locked-crate
            // markers (type 6) currently on the map, with their grids.
            const crates = (res.markers || []).filter((mm) => mm.type === 6);
            if (!crates.length) { await bridge.sendTeamMessage('RAIDAR: no locked crates on map').catch(() => {}); return; }
            let grids = crates.map((c) => getGridCoordinate(c.x, c.y, info.mapSize)).join(', ');
            if (grids.length > 100) grids = grids.slice(0, 99) + '…';
            await bridge.sendTeamMessage(`RAIDAR: ${crates.length} crate(s): ${grids}`).catch(() => {});
            return;
          }

          if (token === '!devices') {
            const devices = (tenants.get(guildId) && tenants.get(guildId).devices) || [];
            if (!devices.length) { await bridge.sendTeamMessage('RAIDAR: no paired devices').catch(() => {}); return; }
            const parts = [];
            for (const d of devices.slice(0, 8)) {
              let state = '';
              if (d.type === 1) {
                try {
                  const i = await bridge.getEntityInfo(d.entityId);
                  if (i.payload && typeof i.payload.value === 'boolean') state = i.payload.value ? ' [ON]' : ' [OFF]';
                } catch { /* entity unreachable — omit state */ }
              }
              parts.push(`${d.name || d.entityId}${state}`);
            }
            let line = parts.join(', ');
            if (line.length > 110) line = line.slice(0, 109) + '…';
            await bridge.sendTeamMessage(`RAIDAR: ${devices.length} device(s): ${line}`).catch(() => {});
            return;
          }

          if (token === '!switch') {
            const name = text.trim().split(/\s+/).slice(1).join(' ').toLowerCase();
            if (!name) { await bridge.sendTeamMessage('RAIDAR: usage !switch <name>').catch(() => {}); return; }
            const switches = (((tenants.get(guildId) && tenants.get(guildId).devices) || []).filter((d) => d.type === 1));
            const dev = switches.find((d) => (d.name || '').toLowerCase().includes(name));
            if (!dev) { await bridge.sendTeamMessage(`RAIDAR: no switch matching "${name}"`).catch(() => {}); return; }
            let cur = false;
            try { const i = await bridge.getEntityInfo(dev.entityId); cur = !!(i.payload && i.payload.value); } catch { /* assume off */ }
            try {
              await bridge.setSwitch(dev.entityId, !cur);
              await bridge.sendTeamMessage(`RAIDAR: ${dev.name || dev.entityId} → ${!cur ? 'ON' : 'OFF'}`).catch(() => {});
            } catch {
              await bridge.sendTeamMessage(`RAIDAR: failed to toggle ${dev.name || dev.entityId}`).catch(() => {});
            }
            return;
          }

          if (token === '!seed' || token === '!map') {
            const info = await bridge.getInfo();
            await bridge.sendTeamMessage(`RAIDAR: ${info.mapSize}m · seed ${info.seed}`).catch(() => {});
            return;
          }

          if (token === '!queue') {
            const info = await bridge.getInfo();
            await bridge.sendTeamMessage(`RAIDAR: ${info.queuedPlayers || 0} queued`).catch(() => {});
            return;
          }

          if (token === '!help') {
            await bridge.sendTeamMessage('RAIDAR: !check !pop !queue !online !team !grid !status').catch(() => {});
            await bridge.sendTeamMessage('RAIDAR: !time !sun !wipe !cargo !heli !vendor !crates !events').catch(() => {});
            await bridge.sendTeamMessage('RAIDAR: !devices !switch <name> !seed !loot <crate>').catch(() => {});
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
