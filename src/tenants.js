'use strict';
const store = require('./store');

/**
 * Per-guild persistence for the public, multi-tenant bot. Each Discord guild
 * owns its own Rust+ pairing, devices and settings — fully isolated.
 *
 *   tenants[guildId] = {
 *     credentials: { fcm_credentials, expo_push_token, rustplus_auth_token, steamId },
 *     server:      { ip, port, playerId, playerToken, name } | null,
 *     devices:     [{ entityId, name, type }],
 *     notifyChannelId: string | null,
 *     controlRoleId:   string | null,
 *     allowedUserIds:  string[],
 *   }
 *
 * Stored as JSON on disk. Credentials are secrets — the data/ dir is gitignored.
 */

function emptyTenant() {
  return { credentials: null, server: null, devices: [], notifyChannelId: null, controlRoleId: null, allowedUserIds: [] };
}

let tenants = {};

/**
 * Load persisted tenants into memory. MUST be awaited during boot before the
 * bot logs in or the HTTP API starts serving, so reads see the real data.
 */
async function init() {
  await store.init();
  tenants = await store.loadBlob();
  return tenants;
}
function save() {
  store.saveBlob(tenants);
}

function get(guildId) {
  return tenants[guildId] || null;
}
function ensure(guildId) {
  if (!tenants[guildId]) { tenants[guildId] = emptyTenant(); save(); }
  return tenants[guildId];
}
function all() {
  return Object.entries(tenants);
}
function update(guildId, patch) {
  const t = ensure(guildId);
  Object.assign(t, patch);
  save();
  return t;
}

function setCredentials(guildId, credentials) { return update(guildId, { credentials }); }
function setServer(guildId, server) { return update(guildId, { server }); }
function setNotifyChannel(guildId, channelId) { return update(guildId, { notifyChannelId: channelId }); }

function upsertDevice(guildId, device) {
  const t = ensure(guildId);
  const i = t.devices.findIndex((d) => d.entityId === device.entityId);
  if (i >= 0) t.devices[i] = { ...t.devices[i], ...device };
  else t.devices.push(device);
  save();
  return t;
}
function removeDevice(guildId, entityId) {
  const t = ensure(guildId);
  t.devices = t.devices.filter((d) => d.entityId !== entityId);
  save();
}
function remove(guildId) {
  delete tenants[guildId];
  save();
}

module.exports = {
  init,
  get, ensure, all, update, remove,
  setCredentials, setServer, setNotifyChannel,
  upsertDevice, removeDevice,
};
