'use strict';
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const manager = require('./manager');
const tenants = require('./tenants');
const link = require('./link');
const channels = require('./channels');
const { canControl } = require('./permissions');
const { getGridCoordinate } = require('./grid');

const ACCENT = 0xce422b;
const DANGER = 0xef4444;
const FOOTER = { text: 'Raidar · Tactical Intelligence' };
const OWNER_ID = '150232849981636608';

function ephemeral(content) { return { content, flags: MessageFlags.Ephemeral }; }

async function bridgeFor(interaction) {
  if (!interaction.guildId) throw new Error('Use this in a server, not in DMs.');
  const t = tenants.get(interaction.guildId);
  if (!t || !t.credentials) throw new Error('This server isn’t linked yet. Run `/link` and connect it from the Raidar app.');
  if (!t.server) throw new Error('No Rust server linked yet — connect to a server in the Raidar app.');
  const bridge = await manager.ensureRust(interaction.guildId);
  if (!bridge) throw new Error('Reconnecting to the Rust server — try again in a few seconds.');
  return bridge;
}

function bar(cur, max, len = 14) {
  if (!max || max <= 0) return '░'.repeat(len);
  const filled = Math.max(0, Math.min(len, Math.round((cur / max) * len)));
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}
function fmtTime(t) {
  const h = Math.floor(t.time);
  const m = Math.floor((t.time - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function isDay(t) { return t.time >= t.sunrise && t.time < t.sunset; }
function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

const MARKER_LABELS = { 5: '🚢 Cargo Ship', 8: '🚁 Patrol Heli', 4: '🛩️ Chinook', 6: '📦 Locked Crate', 2: '💥 Explosion', 3: '🛒 Vending' };
const DEVICE_GROUPS = { 1: '🔌 Smart Switches', 2: '🚨 Smart Alarms', 3: '📦 Storage Monitors' };

// ── Button-based device control ──────────────────────────
/** Build button rows for the Smart Switches of a guild, reflecting live state. */
async function buildControlRows(guildId, bridge) {
  const switches = (tenants.get(guildId)?.devices || []).filter((d) => d.type === 1).slice(0, 25);
  const states = await Promise.all(switches.map(async (d) => {
    try { const i = await bridge.getEntityInfo(d.entityId); return (i.payload && typeof i.payload.value === 'boolean') ? i.payload.value : null; }
    catch { return null; }
  }));
  const rows = [];
  for (let i = 0; i < switches.length; i += 5) {
    const row = new ActionRowBuilder();
    for (let j = i; j < Math.min(i + 5, switches.length); j++) {
      const d = switches[j];
      const st = states[j];
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`rdev|${d.entityId}`)
          .setLabel(trunc(d.name || `#${d.entityId}`, 20))
          .setEmoji(st === null ? '⚠️' : st ? '🟢' : '🔴')
          .setStyle(st ? ButtonStyle.Success : ButtonStyle.Secondary),
      );
    }
    rows.push(row);
  }
  return { rows, count: switches.length };
}

/** Handle a device-control button press. Returns true if it was ours. */
async function handleControlButton(interaction) {
  if (!interaction.customId || !interaction.customId.startsWith('rdev|')) return false;
  if (!canControl(interaction)) {
    await interaction.reply({ content: '⛔ You don’t have permission to control devices.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const entityId = parseInt(interaction.customId.split('|')[1], 10);
  await interaction.deferUpdate();
  const bridge = await manager.ensureRust(interaction.guildId);
  if (!bridge) return true;
  let cur = false;
  try { const info = await bridge.getEntityInfo(entityId); cur = !!(info.payload && info.payload.value); } catch { /* assume off */ }
  try { await bridge.setSwitch(entityId, !cur); } catch { /* ignore */ }
  const { rows } = await buildControlRows(interaction.guildId, bridge);
  await interaction.editReply({ components: rows });
  return true;
}

const commands = [
  // ── Linking ────────────────────────────────────────────
  {
    data: new SlashCommandBuilder().setName('link').setDescription('Link this server from the Raidar app (or check link status)'),
    control: true,
    async execute(interaction) {
      const t = tenants.get(interaction.guildId);
      const linked = !!(t && t.credentials && t.server);
      const code = link.createCode(interaction.guildId);
      const lines = [];
      if (linked) {
        lines.push(`✅ **Linked** to **${t.server.name || t.server.ip}**`, '-# One server can be linked per Discord — re-link below to switch.', '');
      } else if (t && t.credentials) {
        lines.push('🟡 **Credentials linked**, waiting for a server — connect to one in the Raidar app.', '');
      } else {
        lines.push('Connect your Rust+ account straight from the **Raidar app** — no Steam login needed.', '');
      }
      lines.push(
        `**${linked ? 'Re-link' : 'To link'}:**`,
        '**1.** Open **Raidar → Settings → Discord Integration**',
        '**2.** Enter this code and press **Link**:',
        '',
        `## \`${code}\``,
        '',
        '-# Code expires in 10 minutes · keep it private',
      );
      const embed = new EmbedBuilder()
        .setColor(linked ? 0x6fcf73 : ACCENT)
        .setAuthor({ name: 'RAIDAR' })
        .setTitle(linked ? '🔗 Link status' : '🔗 Link this server')
        .setDescription(lines.join('\n'))
        .setFooter(FOOTER).setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder().setName('unlink').setDescription('Disconnect this server and delete its stored credentials'),
    control: true,
    async execute(interaction) {
      manager.stop(interaction.guildId);
      tenants.remove(interaction.guildId);
      await interaction.reply(ephemeral('🗑️ Unlinked. All stored credentials, the server pairing and devices for this server were removed.'));
    },
  },

  // ── Read-only ──────────────────────────────────────────
  {
    data: new SlashCommandBuilder().setName('status').setDescription('Server population, map and wipe info'),
    async execute(interaction) {
      await interaction.deferReply();
      const info = await (await bridgeFor(interaction)).getInfo();
      const pct = info.maxPlayers ? Math.round((info.players / info.maxPlayers) * 100) : 0;
      const embed = new EmbedBuilder()
        .setColor(ACCENT)
        .setAuthor({ name: '🛰️  SERVER STATUS' })
        .setTitle(info.name || 'Rust Server')
        .setDescription(`\`\`\`${bar(info.players, info.maxPlayers)}  ${pct}%\`\`\``)
        .addFields(
          { name: '👥 Players', value: `**${info.players}** / ${info.maxPlayers}${info.queuedPlayers ? `\n\`${info.queuedPlayers} queued\`` : ''}`, inline: true },
          { name: '🗺️ Map', value: `${info.map || '—'}\n\`${info.mapSize}m\``, inline: true },
          { name: '🌱 Seed', value: `\`${info.seed ?? '—'}\``, inline: true },
        )
        .setFooter(FOOTER).setTimestamp();
      if (info.url) embed.setURL(info.url);
      if (info.logoImage) embed.setThumbnail(info.logoImage);
      if (info.headerImage) embed.setImage(info.headerImage);
      if (info.wipeTime) embed.addFields({ name: '🧹 Last Wipe', value: `<t:${info.wipeTime}:R>`, inline: false });
      await interaction.editReply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('pop').setDescription('Current population'),
    async execute(interaction) {
      await interaction.deferReply();
      const info = await (await bridgeFor(interaction)).getInfo();
      const pct = info.maxPlayers ? Math.round((info.players / info.maxPlayers) * 100) : 0;
      const embed = new EmbedBuilder()
        .setColor(ACCENT).setAuthor({ name: '👥  POPULATION' }).setTitle(info.name || 'Rust Server')
        .setDescription([`\`\`\`${bar(info.players, info.maxPlayers)}  ${pct}%\`\`\``, `**${info.players}** / ${info.maxPlayers} online${info.queuedPlayers ? ` · **${info.queuedPlayers}** queued` : ''}`].join('\n'))
        .setFooter(FOOTER).setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('time').setDescription('In-game time and day/night'),
    async execute(interaction) {
      await interaction.deferReply();
      const t = await (await bridgeFor(interaction)).getTime();
      const day = isDay(t);
      const embed = new EmbedBuilder()
        .setColor(day ? 0xf5a623 : 0x4b6cb8)
        .setAuthor({ name: day ? '☀️  DAYTIME' : '🌙  NIGHTTIME' })
        .setDescription(`# ${day ? '☀️' : '🌙'} ${fmtTime(t)}\n-# In-game time`)
        .setFooter(FOOTER).setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('team').setDescription('Team members, status and grid'),
    async execute(interaction) {
      await interaction.deferReply();
      const bridge = await bridgeFor(interaction);
      const info = await bridge.getInfo();
      const team = await bridge.getTeamInfo();
      const members = team.members || [];
      if (members.length === 0) return interaction.editReply('No team members found.');
      const online = members.filter((m) => m.isOnline && m.isAlive);
      const dead = members.filter((m) => m.isOnline && !m.isAlive);
      const offline = members.filter((m) => !m.isOnline);
      const fmt = (m, g) => `${m.isLeader ? '👑 ' : ''}**${m.name}**${g ? ` · \`${getGridCoordinate(m.x, m.y, info.mapSize)}\`` : ''}`;
      const lines = [];
      if (online.length) lines.push('🟢 **Online**', ...online.map((m) => `> ${fmt(m, true)}`));
      if (dead.length) lines.push('', '💀 **Dead**', ...dead.map((m) => `> ${fmt(m, true)}`));
      if (offline.length) lines.push('', '⚫ **Offline**', ...offline.map((m) => `> ${fmt(m, false)}`));
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(ACCENT).setAuthor({ name: '🛡️  TEAM' }).setDescription(lines.join('\n')).setFooter({ text: `${online.length}/${members.length} online · Raidar` }).setTimestamp()] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('events').setDescription('Live map events (cargo, heli, crates, chinook)'),
    async execute(interaction) {
      await interaction.deferReply();
      const bridge = await bridgeFor(interaction);
      const info = await bridge.getInfo();
      const res = await bridge.getMapMarkers();
      const markers = (res.markers || []).filter((m) => MARKER_LABELS[m.type]);
      const embed = new EmbedBuilder().setColor(ACCENT).setAuthor({ name: '🗺️  MAP EVENTS' }).setFooter(FOOTER).setTimestamp();
      if (markers.length === 0) { embed.setDescription('🕊️ *All quiet — no active events on the map right now.*'); return interaction.editReply({ embeds: [embed] }); }
      const counts = {};
      const located = [];
      for (const m of markers) {
        counts[m.type] = (counts[m.type] || 0) + 1;
        if (m.type === 5 || m.type === 8 || m.type === 4) located.push(`${MARKER_LABELS[m.type]} → \`${getGridCoordinate(m.x, m.y, info.mapSize)}\``);
      }
      const summary = Object.entries(counts).map(([t, n]) => `${MARKER_LABELS[t]} \`×${n}\``).join('  ·  ');
      embed.setDescription([summary, located.length ? '\n' + located.join('\n') : ''].join('\n'));
      await interaction.editReply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('devices').setDescription('List paired smart devices and their state'),
    async execute(interaction) {
      const bridge = await bridgeFor(interaction);
      const devices = tenants.get(interaction.guildId).devices;
      if (devices.length === 0) return interaction.reply(ephemeral('No devices paired. Pair a Smart Switch in-game while the bot is linked.'));
      await interaction.deferReply();
      const byType = {};
      const destroyed = [];
      for (const d of devices) {
        let state = '⬜ unknown';
        try {
          const info = await bridge.getEntityInfo(d.entityId);
          if (info.payload && typeof info.payload.value === 'boolean') state = info.payload.value ? '🟢 ON' : '🔴 OFF';
        } catch (e) {
          if (/not_?found|no entity|entity_destroyed/i.test(e.message || '')) { tenants.removeDevice(interaction.guildId, d.entityId); destroyed.push(d.name); continue; }
          state = '⚠️ unreachable';
        }
        const grp = DEVICE_GROUPS[d.type] || '🔌 Devices';
        (byType[grp] = byType[grp] || []).push(`${state}  **${d.name}**  \`${d.entityId}\``);
      }
      const embed = new EmbedBuilder().setColor(ACCENT).setAuthor({ name: '🔌  SMART DEVICES' }).setFooter({ text: 'Use /control for buttons · Raidar' }).setTimestamp();
      const fields = Object.entries(byType).map(([name, rows]) => ({ name, value: rows.join('\n'), inline: false }));
      if (fields.length) embed.addFields(fields); else embed.setDescription('No devices remaining.');
      if (destroyed.length) embed.addFields({ name: '🗑️ Removed (destroyed)', value: destroyed.join(', '), inline: false });
      await interaction.editReply({ embeds: [embed] });
    },
  },

  // ── Convenient control panel (buttons) ─────────────────
  {
    data: new SlashCommandBuilder().setName('control').setDescription('Open a button panel to toggle Smart Switches (restricted)'),
    control: true,
    async execute(interaction) {
      await interaction.deferReply();
      const bridge = await bridgeFor(interaction);
      const { rows, count } = await buildControlRows(interaction.guildId, bridge);
      if (count === 0) return interaction.editReply('No Smart Switches paired. Pair one in-game while the bot is linked.');
      const embed = new EmbedBuilder()
        .setColor(ACCENT)
        .setAuthor({ name: '🎛️  CONTROL PANEL' })
        .setDescription('Tap a switch to toggle it. 🟢 = on · 🔴 = off')
        .setFooter(FOOTER).setTimestamp();
      await interaction.editReply({ embeds: [embed], components: rows });
    },
  },

  // ── Control (restricted) ───────────────────────────────
  {
    data: new SlashCommandBuilder().setName('toggle').setDescription('Turn a Smart Switch on or off (restricted)')
      .addStringOption((o) => o.setName('device').setDescription('Device to toggle').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('state').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    control: true,
    async autocomplete(interaction) {
      const t = tenants.get(interaction.guildId);
      const focused = interaction.options.getFocused().toLowerCase();
      const choices = ((t && t.devices) || [])
        .filter((d) => d.name.toLowerCase().includes(focused) || String(d.entityId).includes(focused))
        .slice(0, 25).map((d) => ({ name: `${d.name} (${d.entityId})`, value: String(d.entityId) }));
      await interaction.respond(choices);
    },
    async execute(interaction) {
      await interaction.deferReply();
      const bridge = await bridgeFor(interaction);
      const entityId = parseInt(interaction.options.getString('device'), 10);
      const on = interaction.options.getString('state') === 'on';
      const device = tenants.get(interaction.guildId).devices.find((d) => d.entityId === entityId);
      await bridge.setSwitch(entityId, on);
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(on ? 0x6fcf73 : 0x8b857c).setDescription(`${on ? '🟢' : '🔴'} **${device ? device.name : entityId}** is now **${on ? 'ON' : 'OFF'}**`).setFooter({ text: `by ${interaction.user.username} · Raidar` }).setTimestamp()] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('say').setDescription('Send a message to in-game team chat (restricted)')
      .addStringOption((o) => o.setName('message').setDescription('Message text').setRequired(true)),
    control: true,
    async execute(interaction) {
      await interaction.deferReply();
      const bridge = await bridgeFor(interaction);
      const message = interaction.options.getString('message');
      await bridge.sendTeamMessage(`[Discord] ${interaction.user.username}: ${message}`);
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(ACCENT).setAuthor({ name: '💬  TEAM CHAT' }).setDescription(`> ${message}`).setFooter({ text: `sent by ${interaction.user.username} · Raidar` }).setTimestamp()] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('alarms').setDescription('Set or clear this channel for alarm/event notifications (restricted)')
      .addStringOption((o) => o.setName('mode').setDescription('here or off').setRequired(true).addChoices({ name: 'here', value: 'here' }, { name: 'off', value: 'off' })),
    control: true,
    async execute(interaction) {
      const mode = interaction.options.getString('mode');
      if (mode === 'here') {
        tenants.setNotifyChannel(interaction.guildId, interaction.channelId);
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x6fcf73).setDescription('🔔 **Notifications enabled** — alarms & events will be posted in this channel.').setFooter(FOOTER)] });
      } else {
        tenants.setNotifyChannel(interaction.guildId, null);
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x8b857c).setDescription('🔕 **Notifications disabled.**').setFooter(FOOTER)] });
      }
    },
  },

  // ── Channel setup ──────────────────────────────────────
  {
    data: new SlashCommandBuilder().setName('test').setDescription('Send a test notification to your alert channels (restricted)'),
    control: true,
    async execute(interaction) {
      const t = tenants.get(interaction.guildId);
      const ch = (t && t.channels) || {};
      const targets = [...new Set([ch.alarms, ch.general, t && t.notifyChannelId].filter(Boolean))];
      if (targets.length === 0) return interaction.reply(ephemeral('No alert channel set yet. Run `/channels` or `/alarms here` first.'));
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const embed = new EmbedBuilder().setColor(0x6fcf73).setAuthor({ name: '✅  TEST NOTIFICATION' })
        .setDescription('If you can see this, Raidar notifications are wired up correctly.').setFooter(FOOTER).setTimestamp();
      let sent = 0;
      for (const id of targets) {
        try { const c = await interaction.client.channels.fetch(id); if (c && c.isTextBased()) { await c.send({ embeds: [embed] }); sent++; } } catch { /* ignore */ }
      }
      await interaction.editReply(`📨 Sent a test to **${sent}** channel${sent === 1 ? '' : 's'}.`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('channels').setDescription('Create the Raidar section & notification channels (admin)'),
    control: true,
    async execute(interaction) {
      if (!(await channels.canManage(interaction.guild))) {
        return interaction.reply(ephemeral('⚠️ I need the **Manage Channels** permission. Re-invite me with it (or grant it to my role), then run `/channels` again.'));
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { setup } = await channels.provisionSection(interaction.guild);
      await channels.sendWelcome(setup, true);
      await interaction.editReply(`✅ Created your **Raidar** section. Head to <#${setup.id}> and choose your channel layout (per-feature or single).`);
    },
  },

  // ── Owner-only bot administration ──────────────────────
  {
    data: new SlashCommandBuilder().setName('usage').setDescription('Bot host VM statistics (owner only)'),
    owner: true,
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const mem = readMeminfo();
      const disk = diskUsage();
      const load = os.loadavg();
      const cores = os.cpus().length || 1;
      const memPct = mem.total ? Math.round((mem.used / mem.total) * 100) : 0;
      const swapPct = mem.swapTotal ? Math.round((mem.swapUsed / mem.swapTotal) * 100) : 0;
      const diskPct = disk && disk.total ? Math.round((disk.used / disk.total) * 100) : 0;
      const load1Pct = Math.min(100, Math.round((load[0] / cores) * 100));
      const rss = process.memoryUsage().rss;
      const embed = new EmbedBuilder()
        .setColor(memPct > 90 || diskPct > 90 ? DANGER : ACCENT)
        .setAuthor({ name: '🖥️  VM STATISTICS' }).setTitle(os.hostname())
        .addFields(
          { name: '🧠 Memory', value: `\`${bar(mem.used, mem.total)}\` **${memPct}%**\n${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}`, inline: false },
          { name: '💽 Swap', value: mem.swapTotal ? `\`${bar(mem.swapUsed, mem.swapTotal)}\` **${swapPct}%**\n${fmtBytes(mem.swapUsed)} / ${fmtBytes(mem.swapTotal)}` : '—', inline: true },
          { name: '🗄️ Disk', value: disk ? `\`${bar(disk.used, disk.total)}\` **${diskPct}%**\n${fmtBytes(disk.used)} / ${fmtBytes(disk.total)}` : '—', inline: true },
          { name: '⚙️ CPU Load', value: `\`${bar(load[0], cores)}\` **${load1Pct}%**\n${load.map((l) => l.toFixed(2)).join(' · ')} (${cores} core${cores > 1 ? 's' : ''})`, inline: false },
          { name: '⏱️ Uptime', value: `Host: \`${fmtDuration(os.uptime())}\`\nBot: \`${fmtDuration(process.uptime())}\``, inline: true },
          { name: '🤖 Bot', value: `RSS: \`${fmtBytes(rss)}\`\nLive sockets: \`${manager.rust.size}\``, inline: true },
        )
        .setFooter(FOOTER).setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('servers').setDescription('List every server the bot is in (owner only)'),
    owner: true,
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guilds = [...interaction.client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);
      const shown = guilds.slice(0, 25);
      const lines = shown.map((g) => {
        const t = tenants.get(g.id);
        const linked = !!(t && t.credentials && t.server);
        const conn = manager.getRust(g.id) ? '🟢' : (linked ? '🟡' : '⚫');
        const detail = linked ? `🔗 ${trunc(t.server.name || t.server.ip, 32)} · ${t.devices.length} dev${t.notifyChannelId ? ' · 🔔' : ''}` : '— not linked';
        return `${conn} **${trunc(g.name, 28)}** \`${g.id}\`\n> ${detail}`;
      });
      const linkedCount = guilds.filter((g) => { const t = tenants.get(g.id); return t && t.credentials && t.server; }).length;
      const embed = new EmbedBuilder()
        .setColor(ACCENT).setAuthor({ name: '🌐  SERVERS' })
        .setDescription(lines.join('\n') || '*No servers.*')
        .setFooter({ text: `${guilds.length} servers · ${linkedCount} linked · ${manager.rust.size} live · Raidar` })
        .setTimestamp();
      if (guilds.length > 25) embed.addFields({ name: '\u200b', value: `…and ${guilds.length - 25} more` });
      await interaction.editReply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('broadcast').setDescription('Send an announcement to every linked server (owner only)')
      .addStringOption((o) => o.setName('message').setDescription('Announcement text').setRequired(true)),
    owner: true,
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const msg = interaction.options.getString('message');
      const embed = new EmbedBuilder().setColor(ACCENT).setAuthor({ name: '📢  RAIDAR ANNOUNCEMENT' }).setDescription(msg).setFooter(FOOTER).setTimestamp();
      let sent = 0; let failed = 0;
      for (const [guildId, t] of tenants.all()) {
        const chId = (t.channels && t.channels.general) || t.notifyChannelId;
        if (!chId) continue;
        try { const ch = await interaction.client.channels.fetch(chId); if (ch && ch.isTextBased()) { await ch.send({ embeds: [embed] }); sent++; } }
        catch { failed++; }
      }
      await interaction.editReply(`📢 Sent to **${sent}** server${sent === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}.`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('reconnect').setDescription('Force-reconnect Rust+ for a server, or all (owner only)')
      .addStringOption((o) => o.setName('guild').setDescription('Guild ID (blank = all linked)').setRequired(false)),
    owner: true,
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const gid = interaction.options.getString('guild');
      if (gid) {
        manager.stop(gid); manager.startRust(gid);
        return interaction.editReply(`🔄 Reconnecting \`${gid}\`.`);
      }
      let n = 0;
      for (const [guildId, t] of tenants.all()) { if (t.server) { manager.stop(guildId); manager.startRust(guildId); n++; } }
      await interaction.editReply(`🔄 Reconnecting **${n}** linked server${n === 1 ? '' : 's'}.`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('leave').setDescription('Make the bot leave a server and wipe its data (owner only)')
      .addStringOption((o) => o.setName('guild').setDescription('Guild ID').setRequired(true)),
    owner: true,
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const gid = interaction.options.getString('guild');
      const g = interaction.client.guilds.cache.get(gid);
      manager.stop(gid); tenants.remove(gid);
      if (!g) return interaction.editReply(`Removed local data for \`${gid}\` (not currently in that server).`);
      const name = g.name;
      try { await g.leave(); } catch (e) { return interaction.editReply(`⚠️ Couldn’t leave ${name}: ${e.message}`); }
      await interaction.editReply(`👋 Left **${name}** and wiped its data.`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('restart').setDescription('Restart the bot process (owner only)'),
    owner: true,
    async execute(interaction) {
      await interaction.reply(ephemeral('🔄 Restarting… back in a few seconds.'));
      setTimeout(() => process.exit(1), 600); // systemd restarts on non-zero exit
    },
  },
];

// ── VM stats helpers ─────────────────────────────────────
function fmtBytes(b) { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return `${b.toFixed(b < 10 && i > 0 ? 1 : 0)} ${u[i]}`; }
function fmtDuration(sec) { const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60); return [d ? `${d}d` : '', h ? `${h}h` : '', `${m}m`].filter(Boolean).join(' '); }
function readMeminfo() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => { const m = txt.match(new RegExp(`${k}:\\s+(\\d+) kB`)); return m ? parseInt(m[1], 10) * 1024 : 0; };
    const total = get('MemTotal'); const avail = get('MemAvailable') || get('MemFree');
    return { total, used: total - avail, swapTotal: get('SwapTotal'), swapUsed: get('SwapTotal') - get('SwapFree') };
  } catch { return { total: os.totalmem(), used: os.totalmem() - os.freemem(), swapTotal: 0, swapUsed: 0 }; }
}
function diskUsage() {
  try { const c = execSync('df -kP /', { encoding: 'utf8', timeout: 4000 }).trim().split('\n')[1].split(/\s+/); return { total: parseInt(c[1], 10) * 1024, used: parseInt(c[2], 10) * 1024 }; }
  catch { return null; }
}

// Hide owner commands from non-admins (registered only in the owner's guild).
for (const c of commands) if (c.owner) c.data.setDefaultMemberPermissions('0');

module.exports = { commands, handleControlButton, OWNER_ID, ACCENT, DANGER, FOOTER };
