'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { canControl } = require('./permissions');
const manager = require('./manager');
const tenants = require('./tenants');

/**
 * Shared builder for rich ALARM-type alert embeds + action buttons. Used by
 * both index.js (live alarm broadcasts) and pairing.js (app-pushed /api/notify
 * for alarm/raid/tc features) so the look & behaviour stay identical.
 *
 *   buildAlertEmbed(opts)  → a red-accent, fielded "raid alert" embed
 *   buildAlertButtons(id)  → [Alert Team] [Mute 1 Hour] [View Live Map]
 *   handleAlertButton(i)   → routes the rmute|/ralert| button presses
 */

const ALERT_COLOR = 0xef4444;
const LIVE_MAP_URL = 'https://raidar.tech';
const MUTE_MS = 60 * 60 * 1000;
const BLANK = '\u200b';

/** Render a grid value as "GRID <X>" (or "—" when unknown). */
function fmtGrid(grid) {
  const g = String(grid == null ? '' : grid).trim();
  if (!g || g === '—' || /^unknown$/i.test(g)) return '—';
  return `GRID ${g.replace(/^grid\s+/i, '')}`;
}

function buildAlertEmbed(opts = {}) {
  const {
    title = '🚨 RAIDAR RAID ALERT',
    targetEntity = 'Smart Alarm',
    grid = '—',
    serverName = 'Unknown',
    triggerUnix = Math.floor(Date.now() / 1000),
    description,
  } = opts;

  const desc = description || `Your smart alarm "**${String(targetEntity || 'Smart Alarm').slice(0, 200)}**" has triggered!`;

  const embed = new EmbedBuilder()
    .setColor(ALERT_COLOR)
    .setAuthor({ name: 'RAIDAR ALERTS SERVICE' })
    .setTitle(String(title).slice(0, 256))
    .setDescription(String(desc).slice(0, 4096))
    // 2×2 grid: inline fields render up to 3 per row, so a blank inline field
    // after each pair forces an exact two-column layout.
    .addFields(
      { name: '🎯 TARGET ENTITY', value: String(targetEntity || '—').slice(0, 1024), inline: true },
      { name: '🗺️ IN-GAME GRID', value: fmtGrid(grid), inline: true },
      { name: BLANK, value: BLANK, inline: true },
      { name: '🖥️ GAME SERVER', value: String(serverName || 'Unknown').slice(0, 1024), inline: true },
      { name: '⏱️ TRIGGER TIME', value: `<t:${triggerUnix}:T>`, inline: true },
      { name: BLANK, value: BLANK, inline: true },
    )
    .setFooter({ text: 'Raidar Alerts • Real-time Monitoring        ● LIVE EVENT' })
    .setTimestamp();
  return embed;
}

function buildAlertButtons(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ralert|${guildId}`).setLabel('Alert Team').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rmute|${guildId}`).setLabel('Mute 1 Hour').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('View Live Map').setStyle(ButtonStyle.Link).setURL(LIVE_MAP_URL),
  );
}

/**
 * Handle the rmute|/ralert| buttons. Returns true if it was one of ours.
 * Only users who pass canControl() may mute or alert the team.
 */
async function handleAlertButton(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('rmute|') && !id.startsWith('ralert|')) return false;

  if (!canControl(interaction)) {
    await interaction.reply({ content: '⛔ You don’t have permission to use this.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const sep = id.indexOf('|');
  const action = id.slice(0, sep);
  const guildId = id.slice(sep + 1) || interaction.guildId;

  if (action === 'rmute') {
    tenants.setMutedUntil(guildId, Date.now() + MUTE_MS);
    await interaction.reply({ content: '🔇 Muted alarms for 1 hour.', flags: MessageFlags.Ephemeral });
    return true;
  }

  // ralert → ping @here in the channel AND relay into the live in-game team chat.
  try {
    if (interaction.channel && interaction.channel.isTextBased()) {
      await interaction.channel.send({ content: '@here 🚨 Base under attack — check the alert above!' });
    }
  } catch { /* ignore send failures */ }
  try {
    const bridge = await manager.ensureRust(guildId);
    if (bridge) await bridge.sendTeamMessage('[RAIDAR] Base under attack — check Discord!');
  } catch { /* no live bridge — the @here ping still went out */ }
  await interaction.reply({ content: '📣 Team alerted in Discord + in-game chat.', flags: MessageFlags.Ephemeral });
  return true;
}

module.exports = { buildAlertEmbed, buildAlertButtons, handleAlertButton };
