'use strict';
const RustBridge = require('./rust');
const tenants = require('./tenants');

/**
 * Owns Rust+ connections per guild, with idle management:
 *   - guilds with a notify channel stay connected (needed to catch alarms)
 *   - other guilds connect on demand (when a command is used) and disconnect
 *     after IDLE_MS of inactivity, so inactive servers don't hold a socket.
 *
 * Alarms are detected over the live connection (a Smart Alarm entity flipping
 * to ON emits an entityChanged broadcast). `onNotify(guildId, event)` is
 * injected by index.js to post to Discord.
 */
const IDLE_MS = 10 * 60 * 1000;

class Manager {
  constructor() {
    this.rust = new Map();      // guildId -> RustBridge
    this.lastUsed = new Map();  // guildId -> timestamp
    this.onNotify = () => {};
    setInterval(() => this._sweepIdle(), 60_000).unref();
  }

  bootAll() {
    // Nothing to pre-connect: notifications come from the app (/api/notify),
    // and command connections are established on demand.
  }

  touch(guildId) { this.lastUsed.set(guildId, Date.now()); }

  getRust(guildId) {
    const b = this.rust.get(guildId);
    return b && b.connected ? b : null;
  }

  /** Connect if needed and resolve once connected (or null on timeout). */
  async ensureRust(guildId) {
    this.touch(guildId);
    let b = this.rust.get(guildId);
    if (b && b.connected) return b;
    this.startRust(guildId);
    b = this.rust.get(guildId);
    if (!b) return null;
    if (b.connected) return b;
    return new Promise((resolve) => {
      const done = (val) => { clearTimeout(timer); b.off('connected', onConn); resolve(val); };
      const onConn = () => done(b);
      const timer = setTimeout(() => done(b.connected ? b : null), 9000);
      b.once('connected', onConn);
    });
  }

  startFcm() { /* no-op — FCM removed */ }

  startRust(guildId) {
    const t = tenants.get(guildId);
    if (!t || !t.server) return;
    let bridge = this.rust.get(guildId);
    if (!bridge) {
      bridge = new RustBridge();
      this.rust.set(guildId, bridge);
      bridge.on('connected', (s) => console.log(`[rust:${guildId}] connected to ${s.name || s.ip}`));
      bridge.on('disconnected', () => console.log(`[rust:${guildId}] disconnected`));
      bridge.on('rust-error', (e) => console.error(`[rust:${guildId}]`, e && e.message ? e.message : e));
    }
    bridge.connect(t.server);
  }

  _sweepIdle() {
    const now = Date.now();
    for (const [guildId, b] of this.rust) {
      if (now - (this.lastUsed.get(guildId) || 0) > IDLE_MS) {
        b.disconnect();
        this.rust.delete(guildId);
        console.log(`[rust:${guildId}] idle — released socket`);
      }
    }
  }

  stop(guildId) {
    const r = this.rust.get(guildId);
    if (r) { r.disconnect(); this.rust.delete(guildId); }
    this.lastUsed.delete(guildId);
  }
}

module.exports = new Manager();
