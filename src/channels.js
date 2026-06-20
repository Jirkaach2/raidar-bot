'use strict';
const { ChannelType, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const tenants = require('./tenants');

const ACCENT = 0xce422b;
const DANGER = 0xef4444;
const FOOTER = { text: 'Raidar · Tactical Intelligence' };

/** Reliably resolve the bot's own member and whether it can manage channels. */
async function canManage(guild) {
  try {
    const me = guild.members.me || await guild.members.fetchMe();
    return !!me && me.permissions.has(PermissionsBitField.Flags.ManageChannels);
  } catch { return false; }
}

async function ensureCategory(guild) {
  const t = tenants.ensure(guild.id);
  const existing = t.channels?.categoryId && guild.channels.cache.get(t.channels.categoryId);
  if (existing) return existing;
  const cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'raidar')
    || await guild.channels.create({ name: 'Raidar', type: ChannelType.GuildCategory, reason: 'Raidar setup' });
  tenants.update(guild.id, { channels: { ...(t.channels || {}), categoryId: cat.id } });
  return cat;
}

async function ensureChannel(guild, key, name) {
  const t = tenants.ensure(guild.id);
  const id = t.channels?.[key];
  if (id && guild.channels.cache.get(id)) return guild.channels.cache.get(id);
  const cat = await ensureCategory(guild);
  const found = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.parentId === cat.id && c.name === name);
  const ch = found || await guild.channels.create({ name, type: ChannelType.GuildText, parent: cat.id, reason: 'Raidar setup' });
  tenants.update(guild.id, { channels: { ...(tenants.ensure(guild.id).channels || {}), [key]: ch.id } });
  return ch;
}

/** Create the Raidar category + #setup + #raidar general. */
async function provisionSection(guild) {
  await ensureCategory(guild);
  const setup = await ensureChannel(guild, 'setup', 'setup');
  await ensureChannel(guild, 'general', 'raidar');
  return { setup };
}

// Maps managed channel names → tenant.channels key, for cleanup on relayout.
const MANAGED_NAME_TO_KEY = {
  'raidar-alarms': 'alarms', 'raidar-events': 'events', 'raidar-crates': 'crates',
  'raidar-decay': 'decay', 'raidar-shops': 'shops', 'raidar-spy': 'spy', 'raidar-bans': 'bans',
  'raidar-cargo': 'cargo', 'raidar-heli': 'heli', 'raidar-players': 'players', 'raidar-alerts': 'alerts',
};

/** Delete managed alert channels under the Raidar category that aren't in keepNames. */
async function cleanupChannels(guild, keepNames) {
  const t = tenants.ensure(guild.id);
  const catId = t.channels && t.channels.categoryId;
  if (!catId) return;
  const channels = { ...(t.channels || {}) };
  for (const c of guild.channels.cache.values()) {
    if (c.type !== ChannelType.GuildText || c.parentId !== catId) continue;
    if (!MANAGED_NAME_TO_KEY[c.name] || keepNames.includes(c.name)) continue;
    try { await c.delete('Raidar layout change'); } catch { /* ignore */ }
    delete channels[MANAGED_NAME_TO_KEY[c.name]];
  }
  tenants.update(guild.id, { channels });
}

/** Create the alert channels and set notification routing. */
async function provisionAlertChannels(guild, mode) {
  await ensureCategory(guild);
  let result;
  let keep;
  if (mode === 'features') {
    const FEATURES = [
      ['alarms', 'raidar-alarms'],
      ['events', 'raidar-events'],
      ['crates', 'raidar-crates'],
      ['decay', 'raidar-decay'],
      ['shops', 'raidar-shops'],
      ['spy', 'raidar-spy'],
      ['bans', 'raidar-bans'],
    ];
    let first = null;
    for (const [key, name] of FEATURES) {
      const ch = await ensureChannel(guild, key, name);
      if (!first) first = ch;
    }
    if (first) tenants.update(guild.id, { notifyChannelId: first.id });
    keep = FEATURES.map((f) => f[1]);
    result = 'Created a channel per feature: alarms, events (cargo/heli/vendor/deep-sea), crates, decay, shops, spy, bans.';
  } else {
    const alerts = await ensureChannel(guild, 'alerts', 'raidar-alerts');
    tenants.update(guild.id, { notifyChannelId: alerts.id, channels: { ...(tenants.ensure(guild.id).channels || {}), alerts: alerts.id } });
    keep = ['raidar-alerts'];
    result = `All alerts will post in <#${alerts.id}>.`;
  }
  await cleanupChannels(guild, keep);
  return result;
}

function welcomeEmbeds(canManageChannels) {
  const setup = new EmbedBuilder()
    .setColor(ACCENT).setAuthor({ name: 'RAIDAR' }).setTitle('👋 Thanks for adding Raidar')
    .setDescription([
      'Bring your **Rust+** server into Discord — live status, team tracking, base alarms and one-tap device control.',
      '',
      '**⚙️ Setup — about 2 minutes**',
      '**1.** Run `/link` here to get a code.',
      '**2.** In the **Raidar app → Settings → Discord Integration**, paste the code and hit **Link**.',
      canManageChannels ? '**3.** Pick how you want alerts below.' : '**3.** Grant me **Manage Channels** and run `/channels` to create dedicated alert channels (or `/alarms here`).',
      '',
      '-# One Rust server per Discord · manage who can control devices in the app.',
    ].join('\n')).setFooter(FOOTER);

  const exampleAlarm = new EmbedBuilder()
    .setColor(DANGER).setAuthor({ name: '🚨  SMART ALARM TRIGGERED' }).setTitle('Base Alarm')
    .setDescription('## ⚠️ Your base may be under attack!').setFooter({ text: 'Example notification · Raidar' });

  const cmds = new EmbedBuilder()
    .setColor(ACCENT).setTitle('📟 Commands')
    .addFields(
      { name: 'Live info', value: '`/status` · `/pop` · `/time` · `/team` · `/events`', inline: false },
      { name: 'Devices', value: '`/control` (tap-to-toggle buttons) · `/devices` · `/toggle`', inline: false },
      { name: 'Setup & chat', value: '`/link` · `/unlink` · `/alarms` · `/say`', inline: false },
    ).setFooter(FOOTER);
  return [setup, exampleAlarm, cmds];
}

function setupButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rsetup|features').setLabel('A channel per feature').setEmoji('📂').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('rsetup|single').setLabel('One alerts channel').setEmoji('📰').setStyle(ButtonStyle.Secondary),
  );
}

async function sendWelcome(channel, canManageChannels) {
  const payload = { embeds: welcomeEmbeds(canManageChannels) };
  if (canManageChannels) payload.components = [setupButtons()];
  await channel.send(payload);
}

module.exports = { canManage, provisionSection, provisionAlertChannels, sendWelcome, setupButtons, welcomeEmbeds, ACCENT, DANGER, FOOTER };
