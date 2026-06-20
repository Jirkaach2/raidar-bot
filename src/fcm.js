'use strict';
const EventEmitter = require('events');
const PushReceiverClient = require('@liamcottle/push-receiver/src/client');

/**
 * One FCM push listener. Instantiated per tenant (guild) with that guild's
 * registered credentials. Emits:
 *   - 'pairing'        { ip, port, playerId, playerToken, name }
 *   - 'entityPairing'  { entityId, entityType, entityName, ... }
 *   - 'alarm'          { title, message, serverName, ip, port }
 *
 * Parsing mirrors fcm-sidecar/index.js so behaviour matches the app exactly.
 */
class FcmListener extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this._stopped = false;
  }

  start(fcmCredentials) {
    const gcm = fcmCredentials && fcmCredentials.gcm;
    if (!gcm || !gcm.androidId || !gcm.securityToken) {
      this.emit('error', new Error('Invalid FCM credentials.'));
      return;
    }
    this._stopped = false;
    const client = new PushReceiverClient(gcm.androidId, gcm.securityToken, []);
    this.client = client;
    client.on('ON_DATA_RECEIVED', (data) => this._onData(data));
    client.on('ON_CONNECT', () => this.emit('connected'));
    client.on('ON_DISCONNECT', () => { if (!this._stopped) this.emit('disconnected'); });
    client.connect().catch((e) => this.emit('error', e));
  }

  stop() {
    this._stopped = true;
    if (this.client) {
      try { this.client.destroy ? this.client.destroy() : this.client._destroy && this.client._destroy(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  _onData(data) {
    let bodyString = '{}';
    const appData = Array.isArray(data.appData) ? data.appData : null;
    if (appData) {
      const body = appData.find((x) => x.key === 'body');
      if (body) bodyString = body.value;
    } else if (data.message && data.message.data) {
      bodyString = data.message.data.body || '{}';
    }

    let parsed;
    try { parsed = JSON.parse(bodyString); } catch { return; }

    if (parsed.type === 'server') {
      this.emit('pairing', {
        ip: parsed.ip,
        port: parseInt(parsed.port, 10),
        playerId: parsed.playerId,
        playerToken: parseInt(parsed.playerToken, 10),
        name: parsed.name || '',
      });
    } else if (parsed.type === 'entity') {
      this.emit('entityPairing', {
        entityId: parseInt(parsed.entityId, 10),
        entityType: parsed.entityType,
        entityName: parsed.entityName || 'Device',
        serverName: parsed.name || '',
      });
    } else if (parsed.type === 'alarm') {
      let title = 'Smart Alarm';
      let message = 'Your base is under attack!';
      if (appData) {
        const t = appData.find((x) => x.key === 'title');
        const m = appData.find((x) => x.key === 'message');
        if (t && t.value) title = t.value;
        if (m && m.value) message = m.value;
      }
      this.emit('alarm', { title, message, serverName: parsed.name || '', ip: parsed.ip || '', port: parsed.port ? parseInt(parsed.port, 10) : null });
    }
  }
}

module.exports = FcmListener;
