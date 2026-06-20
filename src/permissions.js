'use strict';
const { PermissionFlagsBits } = require('discord.js');
const { config } = require('./config');
const tenants = require('./tenants');

/**
 * Gate for control commands (/toggle, /say, /pair, /unpair, /alarms).
 *
 * Per-guild settings take precedence over the global .env fallback. Allow if:
 *   1. user id in the guild's allowedUserIds (or global ALLOWED_USER_IDS)
 *   2. member has the guild's controlRoleId (or global CONTROL_ROLE_ID)
 *   3. nothing configured → server Administrators only
 *
 * Default-deny so a random member can't toggle someone's base.
 */
function canControl(interaction) {
  const t = interaction.guildId ? tenants.get(interaction.guildId) : null;
  const roleId = (t && t.controlRoleId) || config.controlRoleId || '';
  const allowed = (t && t.allowedUserIds && t.allowedUserIds.length ? t.allowedUserIds : config.allowedUserIds) || [];

  if (allowed.includes(interaction.user.id)) return true;

  if (roleId && interaction.member && interaction.member.roles && interaction.member.roles.cache && interaction.member.roles.cache.has(roleId)) {
    return true;
  }

  const nothingConfigured = !roleId && allowed.length === 0;
  if (nothingConfigured) {
    return Boolean(interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator));
  }
  return false;
}

module.exports = { canControl };
