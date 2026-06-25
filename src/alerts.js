'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { canControl } = require('./permissions');
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

function buildAlertEmbed(opts = {}) {
  const {
    title = '🚨 RAID ALERT',
    targetEntity = 'Smart Alarm',
    grid = '—',
    serverName = 'Unknown',
    triggerUnix = Math.floor(Date.now() / 1000),
    description,
  } = opts;

  const embed = new EmbedBuilder()
    .setColor(ALERT_COLOR)
    .setAuthor({ name: 'RAIDAR ALERTS SERVICE' })
    .setTitle(String(title).slice(0, 256))
    .addFields(
      { name: '🎯 Target Entity', value: String(targetEntity || '—').slice(0, 1024), inline: true },
      { name: '🗺️ In-Game Grid', value: String(grid || '—').slice(0, 1024), inline: true },
      { name: '🖥️ Game Server', value: String(serverName || 'Unknown').slice(0, 1024), inline: true },
      { name: '⏱️ Trigger Time', value: `<t:${triggerUnix}:T>`, inline: true },
    )
    .setFooter({ text: 'Raidar Alerts • Real-time Monitoring' })
    .setTimestamp();
  if (description) embed.setDescription(String(description).slice(0, 4096));
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

  // ralert → re-post the same alert content with an @here team ping.
  try {
    const embeds = (interaction.message && interaction.message.embeds) ? interaction.message.embeds : [];
    if (interaction.channel && interaction.channel.isTextBased()) {
      await interaction.channel.send({ content: '@here', embeds, components: [buildAlertButtons(guildId)] });
    }
  } catch { /* ignore send failures */ }
  await interaction.reply({ content: '📣 Team alerted.', flags: MessageFlags.Ephemeral });
  return true;
}

module.exports = { buildAlertEmbed, buildAlertButtons, handleAlertButton };
