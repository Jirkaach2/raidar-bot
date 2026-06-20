'use strict';
const { REST, Routes } = require('discord.js');
const { config, assertDeployReady } = require('./config');
const { commands } = require('./commands');

/**
 * Registers the slash commands with Discord. Guild-scoped registration is
 * instant; global registration can take up to an hour to propagate.
 */
async function main() {
  assertDeployReady();
  const rest = new REST({ version: '10' }).setToken(config.token);

  const ownerCmds = commands.filter((c) => c.owner).map((c) => c.data.toJSON());
  const publicCmds = commands.filter((c) => !c.owner).map((c) => c.data.toJSON());

  if (config.guildId) {
    // Test mode: everything to one guild, instantly.
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: [...publicCmds, ...ownerCmds] });
    console.log(`Registered ${publicCmds.length + ownerCmds.length} commands to test guild ${config.guildId}.`);
    return;
  }

  // Public commands → global (visible everywhere).
  await rest.put(Routes.applicationCommands(config.clientId), { body: publicCmds });
  console.log(`Registered ${publicCmds.length} global commands (may take ~1h to appear).`);

  // Owner commands → only the owner's guild (hidden from every other server).
  if (config.ownerGuildId) {
    try {
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.ownerGuildId), { body: ownerCmds });
      console.log(`Registered ${ownerCmds.length} owner commands to guild ${config.ownerGuildId}.`);
    } catch (e) {
      console.error('Owner command registration failed:', e.message);
    }
  }
}

main().catch((e) => { console.error('Failed to deploy commands:', e); process.exit(1); });
