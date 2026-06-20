'use strict';
const EventEmitter = require('events');
const RustPlus = require('@liamcottle/rustplus.js');

/**
 * One Rust+ connection. Instantiated per tenant (guild) by the manager.
 *   - keeps the connection alive with auto-reconnect
 *   - promisifies the request helpers with a timeout
 *   - re-emits useful broadcasts (team / entity / chat) as events
 */
class RustBridge extends EventEmitter {
  constructor() {
    super();
    this.rp = null;
    this.server = null;
    this.connected = false;
    this._reconnectTimer = null;
    this._wantConnected = false;
  }

  connect(server) {
    this.server = server;
    this._wantConnected = true;
    this._teardown();

    const rp = new RustPlus(server.ip, server.port, server.playerId, server.playerToken, false);
    this.rp = rp;

    rp.on('connected', () => { this.connected = true; this._backoff = 5000; this.emit('connected', server); });
    rp.on('disconnected', () => { this.connected = false; this.emit('disconnected'); this._scheduleReconnect(); });
    rp.on('error', (err) => this.emit('rust-error', err));
    rp.on('message', (msg) => this._onMessage(msg));

    try { rp.connect(); } catch (e) { this.emit('rust-error', e); this._scheduleReconnect(); }
  }

  disconnect() {
    this._wantConnected = false;
    clearTimeout(this._reconnectTimer);
    this._teardown();
    this.connected = false;
  }

  _teardown() {
    if (this.rp) {
      try { this.rp.removeAllListeners(); } catch { /* ignore */ }
      try { this.rp.disconnect(); } catch { /* ignore */ }
      this.rp = null;
    }
  }

  _scheduleReconnect() {
    if (!this._wantConnected) return;
    clearTimeout(this._reconnectTimer);
    // Exponential backoff (5s → 60s) so a rejecting server can't spin the CPU.
    this._backoff = Math.min((this._backoff || 5000) * 1.5, 60000);
    this._reconnectTimer = setTimeout(() => {
      if (this._wantConnected && this.server) this.connect(this.server);
    }, this._backoff);
  }

  _onMessage(msg) {
    const b = msg && msg.broadcast;
    if (!b) return;
    if (b.teamChanged) this.emit('teamChanged', b.teamChanged);
    if (b.entityChanged) this.emit('entityChanged', b.entityChanged);
    if (b.teamMessage && b.teamMessage.message) this.emit('teamMessage', b.teamMessage.message);
  }

  _req(fn, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.rp || !this.connected) return reject(new Error('Not connected to a Rust server.'));
      const timer = setTimeout(() => reject(new Error('Rust+ request timed out.')), timeoutMs);
      try {
        fn((message) => {
          clearTimeout(timer);
          const r = message && message.response;
          if (r && r.error) reject(new Error(r.error.error || 'Rust+ returned an error.'));
          else resolve(r || {});
          return true;
        });
      } catch (e) { clearTimeout(timer); reject(e); }
    });
  }

  getInfo() { return this._req((cb) => this.rp.getInfo(cb)).then((r) => r.info || {}); }
  getTime() { return this._req((cb) => this.rp.getTime(cb)).then((r) => r.time || {}); }
  getTeamInfo() { return this._req((cb) => this.rp.getTeamInfo(cb)).then((r) => r.teamInfo || {}); }
  getMapMarkers() { return this._req((cb) => this.rp.getMapMarkers(cb)).then((r) => r.mapMarkers || {}); }
  getEntityInfo(entityId) { return this._req((cb) => this.rp.getEntityInfo(entityId, cb)).then((r) => r.entityInfo || {}); }
  sendTeamMessage(message) { return this._req((cb) => this.rp.sendTeamMessage(message, cb)); }
  setSwitch(entityId, on) {
    return this._req((cb) => (on ? this.rp.turnSmartSwitchOn(entityId, cb) : this.rp.turnSmartSwitchOff(entityId, cb)));
  }
}

module.exports = RustBridge;
