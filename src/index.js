'use strict';
const { Client, GatewayIntentBits, Options, EmbedBuilder, Events, MessageFlags, ChannelType, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { config, assertReady } = require('./config');
const { commands, handleControlButton, OWNER_ID, ACCENT, DANGER, FOOTER } = require('./commands');
const { canControl } = require('./permissions');
const manager = require('./manager');
const tenants = require('./tenants');
const pairing = require('./pairing');
const channels = require('./channels');

const commandMap = new Map(commands.map((c) => [c.data.name, c]));
// Low-memory cache config. The bot runs on a tiny memory-capped VM (cgroup
// MemoryMax), and routing notifications fetches channels/guilds which otherwise
// cache members + users unbounded → slow RSS creep → OOM kill + restart. Cap
// the caches that grow and sweep stale entries so RSS stays flat.
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 0,
    ReactionManager: 0,
    GuildMemberManager: { maxSize: 25, keepOverLimit: (m) => m.id === m.client.user.id },
    UserManager: { maxSize: 50, keepOverLimit: (u) => u.id === u.client.user.id },
    PresenceManager: 0,
    ThreadManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 600, lifetime: 300 },
    users: { interval: 3600, filter: () => (u) => u.id !== u.client.user.id },
    guildMembers: { interval: 3600, filter: () => (m) => m.id !== m.client.user.id },
    threads: { interval: 3600, lifetime: 1800 },
  },
});

// Safety net: a malformed message from one odd/modded server must never take
// down the whole multi-tenant bot. Log (rate-limited) and keep running.
let _errLogCount = 0;
let _errLogWindow = Date.now();
function guardLog(tag, e) {
  const now = Date.now();
  if (now - _errLogWindow > 10000) { _errLogWindow = now; _errLogCount = 0; }
  if (_errLogCount < 5) { // at most 5 lines / 10s to avoid journald flooding
    _errLogCount++;
    console.error(`[${tag}]`, (e && e.message) ? e.message : e);
  }
}
process.on('uncaughtException', (e) => guardLog('uncaughtException', e));
process.on('unhandledRejection', (e) => guardLog('unhandledRejection', e));

// ── Per-guild notifications (called by the manager) ──────
manager.onNotify = async (guildId, event) => {
  const t = tenants.get(guildId);
  if (!t) return;
  const ch = t.channels || {};
  let channelId;
  if (event.type === 'alarm') channelId = ch.alarms || t.notifyChannelId || ch.general;
  else channelId = ch.general || t.notifyChannelId || ch.alarms;
  if (!channelId) return;
  let embed;
  if (event.type === 'alarm') {
    embed = new EmbedBuilder()
      .setColor(0xef4444)
      .setAuthor({ name: '🚨  SMART ALARM TRIGGERED' })
      .setTitle(event.alarm.title || 'Alarm')
      .setDescription(`## ⚠️ ${event.alarm.message}`)
      .setFooter({ text: `${event.alarm.serverName || 'Raidar'} · Tactical Intelligence` })
      .setTimestamp();
  } else if (event.type === 'server') {
    embed = new EmbedBuilder()
      .setColor(0x6fcf73)
      .setAuthor({ name: '🔗  SERVER LINKED' })
      .setDescription(`Now tracking **${event.server.name || event.server.ip}**.\n-# Use \`/status\` to check it.`)
      .setFooter({ text: 'Raidar · Tactical Intelligence' })
      .setTimestamp();
  } else if (event.type === 'device') {
    embed = new EmbedBuilder()
      .setColor(0xce422b)
      .setAuthor({ name: '🔌  DEVICE PAIRED' })
      .setDescription(`**${event.device.entityName}** is now controllable with \`/toggle\`.`)
      .setFooter({ text: 'Raidar · Tactical Intelligence' })
      .setTimestamp();
  } else return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error(`[notify:${guildId}]`, e.message);
  }
};

// ── Interactions ─────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('rsetup|')) { await handleSetupButton(interaction); return; }
      await handleControlButton(interaction);
      return;
    }
    if (interaction.isAutocomplete()) {
      const cmd = commandMap.get(interaction.commandName);
      if (cmd && cmd.autocomplete) await cmd.autocomplete(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    const cmd = commandMap.get(interaction.commandName);
    if (!cmd) return;

    if (cmd.owner && interaction.user.id !== OWNER_ID) {
      await interaction.reply({ content: '⛔ This is an owner-only command.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (cmd.control && !canControl(interaction)) {
      await interaction.reply({ content: '⛔ You don’t have permission to use this command.', flags: MessageFlags.Ephemeral });
      return;
    }
    await cmd.execute(interaction);
  } catch (err) {
    console.error(`/${interaction.commandName} error:`, err.message);
    const msg = `⚠️ ${err.message || 'Something went wrong.'}`;
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    } catch { /* ignore */ }
  }
});

// Clean up a guild's data if the bot is removed from it.
client.on(Events.GuildDelete, (guild) => {
  console.log(`[discord] removed from guild ${guild.id} — cleaning up`);
  manager.stop(guild.id);
  tenants.remove(guild.id);
});

// Welcome + auto-create the Raidar section when added to a new server.
client.on(Events.GuildCreate, (guild) => {
  console.log(`[discord] joined guild ${guild.name} (${guild.id})`);
  setupServer(guild).catch((e) => console.error('[welcome]', e.message));
});

async function setupServer(guild) {
  const manage = await channels.canManage(guild);
  let target;
  if (manage) {
    const { setup } = await channels.provisionSection(guild);
    target = setup;
  } else {
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const canSend = (c) => c && c.type === ChannelType.GuildText && me && c.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages);
    target = canSend(guild.systemChannel) ? guild.systemChannel : guild.channels.cache.find(canSend);
  }
  if (target) await channels.sendWelcome(target, manage);
}

async function handleSetupButton(interaction) {
  const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)
    || interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
  if (!isAdmin) { await interaction.reply({ content: '⛔ Only server managers can set up channels.', flags: MessageFlags.Ephemeral }); return; }
  if (!(await channels.canManage(interaction.guild))) {
    await interaction.reply({ content: '⚠️ I need the **Manage Channels** permission. Re-invite me with it (or grant it to my role), then try again.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const mode = interaction.customId.split('|')[1];
  const summary = await channels.provisionAlertChannels(interaction.guild, mode);
  await interaction.editReply(`✅ Done — ${summary}`);
}

// ── Boot ─────────────────────────────────────────────────
client.once(Events.ClientReady, (c) => {
  console.log(`[discord] Logged in as ${c.user.tag} — serving ${c.guilds.cache.size} guild(s)`);
  pairing.setClient(c);
  manager.bootAll();
});

// Memory guardian: on the memory-capped VM the kernel cgroup OOM-kills node at
// MemoryMax, which is abrupt and can crash-loop. Instead, watch RSS and exit
// cleanly just BEFORE the cap so systemd restarts us in a known-good state.
const RSS_LIMIT_MB = parseInt(process.env.RSS_LIMIT_MB || '300', 10);
setInterval(() => {
  const rssMb = process.memoryUsage().rss / 1024 / 1024;
  if (rssMb > RSS_LIMIT_MB) {
    console.error(`[mem] RSS ${Math.round(rssMb)}MB exceeded ${RSS_LIMIT_MB}MB — restarting cleanly before OOM.`);
    process.exit(1);
  }
}, 30_000).unref();

assertReady();

// Boot order matters: load persisted tenants BEFORE the HTTP API starts serving
// or the gateway logs in, so the very first /api/* request or notification sees
// the real data (critical with the async Postgres backend on Heroku).
(async () => {
  await tenants.init();
  pairing.start();
  await client.login(config.token);
})().catch((e) => {
  console.error('[boot] fatal:', e && e.message ? e.message : e);
  process.exit(1);
});
