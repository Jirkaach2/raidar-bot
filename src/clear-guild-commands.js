'use strict';
const { REST, Routes } = require('discord.js');
const { config, assertDeployReady } = require('./config');

/**
 * One-off: clears GUILD-scoped slash commands for a guild so only the GLOBAL
 * set remains (removes the duplicates that appear when both were registered).
 *
 *   node src/clear-guild-commands.js <GUILD_ID>
 */
async function main() {
  assertDeployReady();
  const guildId = process.argv[2];
  if (!guildId) { console.error('Usage: node src/clear-guild-commands.js <GUILD_ID>'); process.exit(1); }
  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body: [] });
  console.log(`Cleared guild-scoped commands for ${guildId}. Only global commands remain.`);
}

main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
