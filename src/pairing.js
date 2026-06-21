'use strict';
const express = require('express');
const { EmbedBuilder } = require('discord.js');
const { config } = require('./config');
const link = require('./link');
const tenants = require('./tenants');
const manager = require('./manager');

const ACCENT = 0xce422b;

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
function buildNotifyEmbed(feature, content, fields, serverName) {
  const st = FEATURE_STYLE[feature] || { c: ACCENT, a: 'RAIDAR ALERT' };
  const p = parseContent(content);
  const embed = new EmbedBuilder().setColor(st.c).setAuthor({ name: st.a }).setTimestamp()
    .setFooter({ text: `${serverName || 'Raidar'} · Tactical Intelligence` });
  if (p.title) embed.setTitle(`${p.emoji ? p.emoji + ' ' : ''}${p.title}`.slice(0, 256));
  embed.setDescription((p.desc ? `>>> ${p.desc}` : (content || '\u200b')).slice(0, 4096));
  if (Array.isArray(fields) && fields.length) {
    embed.addFields(fields.slice(0, 10).map((f) => ({ name: String(f.name || '\u200b').slice(0, 256), value: String(f.value || '\u200b').slice(0, 1024), inline: !!f.inline })));
  }
  return embed;
}

function start() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ ok: true });
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
        if (c && c.isTextBased()) { await c.send({ embeds: [buildNotifyEmbed(feature, content, fields, t.server && t.server.name)] }); sent++; }
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
