'use strict';
const axios = require('axios');

/**
 * Shared player-lookup module.
 *
 * Given a 17-digit SteamID64, builds a normalized player profile from:
 *   - Steam Web API (summaries, owned games / Rust playtime, ban status)
 *   - RustStats RPC (best-effort PvP combat stats)
 *
 * Steam calls require process.env.STEAM_API_KEY. Network/lookup failures are
 * swallowed (fields fall back to null) — the ONLY thing that throws is an
 * invalid SteamID input, so callers can surface a friendly error.
 */

const RUST_APPID = 252490;
const STEAM_BASE = 'https://api.steampowered.com';

/** Lenient numeric parse: strips commas/%/whitespace and applies k/m suffixes. */
function parseLooseNumber(val) {
  if (val == null) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  let s = String(val).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/,/g, '').replace(/%/g, '').replace(/\s+/g, '');
  let mult = 1;
  if (s.endsWith('k')) { mult = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 1e6; s = s.slice(0, -1); }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return n * mult;
}

/** True only for a clean 17-digit SteamID64. */
function isValidSteamId64(id) {
  return typeof id === 'string' && /^\d{17}$/.test(id);
}

async function fetchSummary(steamId, key) {
  try {
    const { data } = await axios.get(`${STEAM_BASE}/ISteamUser/GetPlayerSummaries/v2/`, {
      params: { key, steamids: steamId }, timeout: 8000,
    });
    const p = data && data.response && data.response.players && data.response.players[0];
    if (!p) return null;
    return {
      name: p.personaname || null,
      visibility: p.communityvisibilitystate === 3 ? 'public' : 'private',
      avatar: p.avatarfull || p.avatarmedium || p.avatar || null,
    };
  } catch { return null; }
}

async function fetchPlaytime(steamId, key) {
  try {
    const { data } = await axios.get(`${STEAM_BASE}/IPlayerService/GetOwnedGames/v1/`, {
      params: {
        key, steamid: steamId,
        include_played_free_games: 1,
        'appids_filter[0]': RUST_APPID,
      },
      timeout: 8000,
    });
    const games = data && data.response && data.response.games;
    const rust = Array.isArray(games) ? games.find((g) => g.appid === RUST_APPID) : null;
    if (!rust) return { rustHours: null, recentHours: null };
    const rustHours = typeof rust.playtime_forever === 'number' ? Math.round(rust.playtime_forever / 60) : null;
    const recentHours = typeof rust.playtime_2weeks === 'number' ? Math.round((rust.playtime_2weeks / 60) * 10) / 10 : null;
    return { rustHours, recentHours };
  } catch { return { rustHours: null, recentHours: null }; }
}

async function fetchBans(steamId, key) {
  try {
    const { data } = await axios.get(`${STEAM_BASE}/ISteamUser/GetPlayerBans/v1/`, {
      params: { key, steamids: steamId }, timeout: 8000,
    });
    const b = data && data.players && data.players[0];
    if (!b) return { vacBanned: false, gameBans: 0, daysSinceLastBan: null, economyBan: null };
    const numGameBans = typeof b.NumberOfGameBans === 'number' ? b.NumberOfGameBans : 0;
    const numVacBans = typeof b.NumberOfVACBans === 'number' ? b.NumberOfVACBans : 0;
    const banned = !!b.VACBanned || numVacBans > 0;
    const days = (banned || numGameBans > 0) && typeof b.DaysSinceLastBan === 'number' ? b.DaysSinceLastBan : null;
    return {
      vacBanned: banned,
      gameBans: numGameBans,
      daysSinceLastBan: days,
      economyBan: b.EconomyBan || null,
    };
  } catch { return { vacBanned: false, gameBans: 0, daysSinceLastBan: null, economyBan: null }; }
}

async function fetchCombatStats(steamId) {
  try {
    const { data } = await axios.post('https://ruststats.io/api/rpc/get_profile',
      { id: steamId },
      { timeout: 8000, headers: { 'Content-Type': 'application/json' } });
    const pvp = data && data.pvp_stats;
    if (!pvp) return { kd: null, accuracy: null, headshotPct: null, kills: null };
    const acc = parseLooseNumber(pvp.bullets_hit_percent);
    const hs = parseLooseNumber(pvp.headshot_percent);
    return {
      kd: parseLooseNumber(pvp.kdr),
      // accuracy returned as a percent string (e.g. "24.92%") → fraction 0..1
      accuracy: acc == null ? null : acc / 100,
      headshotPct: hs,
      kills: parseLooseNumber(pvp.kills),
    };
  } catch { return { kd: null, accuracy: null, headshotPct: null, kills: null }; }
}

/**
 * Look up a player by SteamID64. Throws only on invalid input.
 * @param {string} steamId64 17-digit SteamID64
 * @returns {Promise<object>} normalized player profile
 */
async function lookupPlayer(steamId64) {
  const steamId = String(steamId64 == null ? '' : steamId64).trim();
  if (!isValidSteamId64(steamId)) {
    throw new Error('That doesn’t look like a SteamID64. I need a 17-digit numeric ID (e.g. 76561198000000000).');
  }
  const key = process.env.STEAM_API_KEY;

  const [summary, playtime, bans, combat] = await Promise.all([
    key ? fetchSummary(steamId, key) : Promise.resolve(null),
    key ? fetchPlaytime(steamId, key) : Promise.resolve({ rustHours: null, recentHours: null }),
    key ? fetchBans(steamId, key) : Promise.resolve({ vacBanned: false, gameBans: 0, daysSinceLastBan: null, economyBan: null }),
    fetchCombatStats(steamId),
  ]);

  return {
    steamId,
    name: (summary && summary.name) || steamId,
    avatar: (summary && summary.avatar) || null,
    visibility: (summary && summary.visibility) || 'private',
    rustHours: playtime.rustHours,
    recentHours: playtime.recentHours,
    vacBanned: bans.vacBanned,
    gameBans: bans.gameBans,
    daysSinceLastBan: bans.daysSinceLastBan,
    economyBan: bans.economyBan,
    kd: combat.kd,
    accuracy: combat.accuracy,
    headshotPct: combat.headshotPct,
    kills: combat.kills,
  };
}

module.exports = { lookupPlayer, isValidSteamId64, parseLooseNumber };
