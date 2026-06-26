'use strict';
const path = require('path');
const express = require('express');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { config } = require('./config');
const link = require('./link');
const tenants = require('./tenants');
const manager = require('./manager');
const alerts = require('./alerts');

const ACCENT = 0xce422b;
const BLANK = '\u200b';

/**
 * HTTP API the Raidar desktop app talks to. Linking is app-only (the app holds
 * valid Rust+ credentials and pushes them here with a one-time code) — there is
 * no browser/Steam pairing flow. The app also pushes live notifications here
 * via /api/notify, which the bot formats and routes to the right channel.
 */

const FEATURE_CHANNEL = {
  alarm: 'alarms', alarms: 'alarms', raid: 'alarms', tc: 'alarms',
  cargo: 'events', heli_chinook: 'events', crash: 'events', event: 'events',
  crate: 'crates', crates: 'crates',
  decay: 'decay',
  price_watch: 'shops', shop: 'shops',
  spy: 'spy', enemy: 'spy',
  bans: 'bans',
  // Device destroyed/offline pushes from the desktop app. Routed to 'events'
  // (not 'alarms') so they render as a normal embed, not the rich alarm-button
  // format — see isAlarmFeature().
  device_destroyed: 'events', device: 'events',
};
const FEATURE_STYLE = {
  alarms: { c: 0xef4444, a: '🚨  BASE ALARM' }, alarm: { c: 0xef4444, a: '🚨  BASE ALARM' },
  tc: { c: 0xef4444, a: '🏚️  YOUR TC DECAYING' },
  raid: { c: 0x10b981, a: '🧨  RAID INTEL' },
  cargo: { c: 0x06b6d4, a: '🚢  CARGO SHIP' }, heli_chinook: { c: 0xef4444, a: '🚁  AIR EVENT' },
  crash: { c: 0xef4444, a: '💥  HELI DOWN' }, crate: { c: 0xf59e0b, a: '📦  LOCKED CRATE' }, crates: { c: 0xf59e0b, a: '📦  LOCKED CRATE' },
  decay: { c: 0xb45309, a: '🧱  DECAY WARNING' }, price_watch: { c: 0x10b981, a: '💰  PRICE WATCH' },
  shop: { c: 0x10b981, a: '🏪  NEW SHOP' },
  bans: { c: 0xef4444, a: '🚷  BAN TRACKER' }, enemy: { c: 0x8b5cf6, a: '🎯  ENEMY INTEL' },
  spy: { c: 0x8b5cf6, a: '🕵️  RUST SPY' }, event: { c: 0x06b6d4, a: '🌍  WORLD EVENT' },
  device_destroyed: { c: 0xef4444, a: '🧨  DEVICE DESTROYED' }, device: { c: 0xf59e0b, a: '🔌  DEVICE EVENT' },
};

let discordClient = null;
function setClient(client) { discordClient = client; }
function guildName(id) {
  try { return (discordClient && discordClient.guilds.cache.get(id) || {}).name || 'Unknown server'; }
  catch { return 'Unknown server'; }
}
function routeChannelId(t, feature) {
  const ch = t.channels || {};
  const key = FEATURE_CHANNEL[feature] || 'events';
  // Dedicated per-feature channel → single "alerts" channel → legacy fallbacks.
  return ch[key] || ch.alerts || ch.events || t.notifyChannelId || ch.general || ch.alarms;
}
function parseContent(content) {
  const m = String(content || '').match(/^\s*([^\s*]+)?\s*\*\*(.+?)\*\*\s*[—-]+\s*([\s\S]*)$/);
  if (m) return { emoji: (m[1] || '').trim(), title: m[2].trim(), desc: m[3].trim() };
  return { emoji: '', title: '', desc: String(content || '').trim() };
}
/**
 * Render the app-supplied `fields` as a clean two-column grid that mirrors the
 * raid-alert box. Discord packs up to three inline fields per row, so after
 * every pair we push a blank inline spacer to force an exact 2-col layout — and
 * when the count is odd we pad the final row with a blank cell + spacer so it
 * stays aligned. Field names/values are kept verbatim (just length-clamped).
 */
function buildGridFields(fields) {
  const list = (Array.isArray(fields) ? fields : []).filter((f) => f && (f.name || f.value)).slice(0, 12);
  if (!list.length) return [];
  const out = [];
  for (let i = 0; i < list.length; i += 2) {
    const a = list[i];
    const b = list[i + 1];
    out.push({ name: String(a.name || BLANK).slice(0, 256), value: String(a.value || BLANK).slice(0, 1024), inline: true });
    out.push(b
      ? { name: String(b.name || BLANK).slice(0, 256), value: String(b.value || BLANK).slice(0, 1024), inline: true }
      : { name: BLANK, value: BLANK, inline: true });
    out.push({ name: BLANK, value: BLANK, inline: true }); // spacer → forces 2 columns
  }
  return out;
}

/**
 * Build a polished, professional embed for every NON-alarm notification type,
 * styled to match alerts.buildAlertEmbed: per-feature accent colour, an emoji
 * author line (e.g. "🚢  CARGO SHIP"), a bold parsed title, a ">>>"-quoted
 * description, a tidy 2-column fielded grid, an optional thumbnail, and a
 * footer with a subtle right-side "● LIVE" accent + timestamp.
 */
function buildNotifyEmbed(feature, content, fields, serverName) {
  const st = FEATURE_STYLE[feature] || { c: ACCENT, a: 'RAIDAR ALERTS SERVICE' };
  const p = parseContent(content);

  const embed = new EmbedBuilder()
    .setColor(st.c)
    .setAuthor({ name: st.a })
    .setTitle(`${p.emoji ? p.emoji + ' ' : ''}${p.title || st.a}`.slice(0, 256))
    .setDescription((p.desc ? `>>> ${p.desc}` : (String(content || '').trim() || BLANK)).slice(0, 4096))
    .setFooter({ text: `${serverName || 'Raidar'} • Real-time Monitoring        ● LIVE` })
    .setTimestamp();

  const grid = buildGridFields(fields);
  if (grid.length) embed.addFields(grid);
  if (st.t) embed.setThumbnail(st.t);

  return embed;
}

// True when a pushed feature should use the rich alarm format (alarm/raid/tc).
function isAlarmFeature(feature) { return (FEATURE_CHANNEL[feature] || 'events') === 'alarms'; }

// Build the rich fielded alert + button row for an app-pushed alarm/raid/tc.
function buildAlarmMessage(feature, content, fields, serverName, guildId) {
  const p = parseContent(content);
  const gridField = Array.isArray(fields) ? fields.find((f) => /grid/i.test(f && f.name || '')) : null;
  const embed = alerts.buildAlertEmbed({
    title: `${p.emoji ? p.emoji + ' ' : ''}${p.title || 'RAID ALERT'}`.slice(0, 256),
    targetEntity: p.title || 'Smart Alarm',
    grid: gridField ? gridField.value : '—',
    serverName: serverName || 'Unknown',
    triggerUnix: Math.floor(Date.now() / 1000),
    description: p.desc ? `>>> ${p.desc}` : undefined,
  });
  return { embeds: [embed], components: [alerts.buildAlertButtons(guildId)] };
}

function start() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    const mem = process.memoryUsage();
    res.json({
      ok: true,
      uptime: Math.floor(process.uptime()),
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
      version: process.env.npm_package_version || (() => { try { return require(path.resolve(__dirname, '../package.json')).version; } catch { return 'unknown'; } })(),
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
    });
  });

  app.post('/api/link', (req, res) => {
    const { code, credentials, server, devices } = req.body || {};
    const guildId = link.claim(code);
    if (!guildId) return res.status(400).json({ error: 'Invalid or expired code.' });

    if (credentials && credentials.fcm_credentials) tenants.setCredentials(guildId, credentials);
    if (server && server.ip) tenants.setServer(guildId, server);
    if (Array.isArray(devices)) {
      for (const d of devices) {
        if (d && Number.isFinite(d.entityId)) tenants.upsertDevice(guildId, { entityId: d.entityId, name: d.name || 'Device', type: d.type });
      }
    }
    if (credentials && credentials.fcm_credentials) manager.startFcm(guildId);
    if (server && server.ip) manager.startRust(guildId);

    console.log(`[link] guild ${guildId} linked via app (server: ${server && server.name ? server.name : 'n/a'})`);
    res.json({ ok: true });
  });

  app.post('/api/sync', (req, res) => {
    const { authToken, server, devices } = req.body || {};
    if (!authToken) return res.status(400).json({ error: 'Missing authToken.' });
    let synced = 0;
    for (const [guildId, t] of tenants.all()) {
      if (!t.credentials || t.credentials.rustplus_auth_token !== authToken) continue;
      if (server && server.ip) tenants.setServer(guildId, server);
      if (Array.isArray(devices)) {
        const clean = devices
          .filter((d) => d && Number.isFinite(d.entityId))
          .map((d) => ({ entityId: d.entityId, name: d.name || 'Device', type: d.type }));
        tenants.update(guildId, { devices: clean });
      }
      if (server && server.ip) manager.startRust(guildId);
      synced++;
    }
    res.json({ ok: true, synced });
  });

  // ── Live notifications pushed from the app → routed to channels ──
  app.post('/api/notify', async (req, res) => {
    const { authToken, feature, content, fields } = req.body || {};
    if (!authToken || !content) return res.status(400).json({ error: 'Missing authToken or content.' });
    let sent = 0;
    for (const [guildId, t] of tenants.all()) {
      if (!t.credentials || t.credentials.rustplus_auth_token !== authToken) continue;
      const chId = routeChannelId(t, feature);
      if (!chId || !discordClient) continue;
      try {
        const c = await discordClient.channels.fetch(chId);
        if (!c || !c.isTextBased()) continue;
        if (isAlarmFeature(feature)) {
          // Respect a per-guild mute window set via the "Mute 1 Hour" button.
          if (tenants.isMuted(guildId)) continue;
          await c.send(buildAlarmMessage(feature, content, fields, t.server && t.server.name, guildId));
          sent++;
        } else {
          await c.send({ embeds: [buildNotifyEmbed(feature, content, fields, t.server && t.server.name)] });
          sent++;
        }
      } catch { /* channel gone / no perms */ }
    }
    console.log(`[notify] feature=${feature} → ${sent} channel(s)`);
    res.json({ ok: true, sent });
  });

  app.post('/api/status', (req, res) => {
    const { authToken } = req.body || {};
    if (!authToken) return res.status(400).json({ error: 'Missing authToken.' });
    const links = [];
    for (const [guildId, t] of tenants.all()) {
      if (t.credentials && t.credentials.rustplus_auth_token === authToken) {
        links.push({
          guildId,
          guildName: guildName(guildId),
          serverName: (t.server && t.server.name) || '',
          allowedUserIds: t.allowedUserIds || [],
        });
      }
    }
    res.json({ links });
  });

  // Set who may use control commands/buttons in a guild (device whitelist).
  app.post('/api/permissions', (req, res) => {
    const { authToken, guildId, allowedUserIds } = req.body || {};
    if (!authToken || !guildId) return res.status(400).json({ error: 'Missing authToken or guildId.' });
    const t = tenants.get(guildId);
    if (!t || !t.credentials || t.credentials.rustplus_auth_token !== authToken) {
      return res.status(403).json({ error: 'Not authorized.' });
    }
    const clean = Array.isArray(allowedUserIds) ? allowedUserIds.map(String).map((s) => s.trim()).filter((s) => /^\d{5,}$/.test(s)) : [];
    tenants.update(guildId, { allowedUserIds: clean });
    res.json({ ok: true, allowedUserIds: clean });
  });

  // List a linked guild's members so the app can show top-role members + search
  // by name. Requires the privileged GuildMembers intent (see index.js). Fails
  // soft with { ok:false } so the app falls back to raw user IDs gracefully.
  app.post('/api/members', async (req, res) => {
    const { authToken, guildId } = req.body || {};
    if (!authToken || !guildId) return res.status(400).json({ error: 'Missing authToken or guildId.' });
    const t = tenants.get(guildId);
    if (!t || !t.credentials || t.credentials.rustplus_auth_token !== authToken) {
      return res.status(403).json({ error: 'Not authorized.' });
    }
    try {
      const guild = await discordClient.guilds.fetch(guildId);
      const fetched = await guild.members.fetch();
      const list = [];
      for (const member of fetched.values()) {
        if (member.user && member.user.bot) continue;
        const isOwner = member.id === guild.ownerId;
        const perms = member.permissions;
        const isAdmin = !!(perms && (perms.has(PermissionsBitField.Flags.Administrator) || perms.has(PermissionsBitField.Flags.ManageGuild)));
        const highest = member.roles.highest;
        list.push({
          id: member.id,
          name: member.displayName || member.user.username,
          roleName: (highest && highest.name) || '',
          rolePos: (highest && highest.position) || 0,
          isAdmin,
          isOwner,
        });
      }
      // Sort DESC by owner, then admin, then highest-role position.
      list.sort((a, b) => (Number(b.isOwner) - Number(a.isOwner)) || (Number(b.isAdmin) - Number(a.isAdmin)) || (b.rolePos - a.rolePos));
      const members = list.slice(0, 200).map((m) => ({ id: m.id, name: m.name, roleName: m.roleName, isAdmin: m.isAdmin, isOwner: m.isOwner }));
      res.json({ ok: true, members, top: members.slice(0, 4) });
    } catch {
      // Intent not granted / fetch error → soft fail (HTTP 200) so the app copes.
      res.json({ ok: false, error: 'members_unavailable' });
    }
  });

  app.post('/api/unlink', (req, res) => {
    const { authToken, guildId } = req.body || {};
    if (!authToken || !guildId) return res.status(400).json({ error: 'Missing authToken or guildId.' });
    const t = tenants.get(guildId);
    if (!t || !t.credentials || t.credentials.rustplus_auth_token !== authToken) {
      return res.status(403).json({ error: 'Not authorized to unlink this server.' });
    }
    manager.stop(guildId);
    tenants.remove(guildId);
    console.log(`[link] guild ${guildId} unlinked via app`);
    res.json({ ok: true });
  });

  app.listen(config.pairingPort, () => console.log(`[api] listening on :${config.pairingPort}`));
}

module.exports = { start, setClient };
