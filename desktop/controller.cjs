class VpnController {
  constructor(store, driver) {
    this.store = store;
    this.driver = driver;
    this.activeId = null;
    this.busy = false;
    this.startedAt = null;
    this.latencies = {};
    this.verifiedId = null;
  }
  async state() {
    const profiles = await this.store.list();
    const active = [];
    if (!this.busy) {
      for (const profile of profiles) if (await this.driver.isActive(profile.id)) active.push(profile.id);
      if (active.length > 1) throw new Error('Multiple Aero tunnels are running. Stop extra tunnels with WireGuard before connecting.');
      const previousId = this.activeId;
      this.activeId = active[0] || null;
      if (!this.activeId) this.startedAt = null;
      if (this.activeId !== this.verifiedId) this.verifiedId = null;
      else if (this.activeId !== previousId) this.startedAt = Date.now();
    }
    return { profiles: profiles.map(p => ({ ...p, latency: this.latencies[p.id] || null })), activeId: this.activeId, peerVerified: !!this.activeId && this.verifiedId === this.activeId, busy: this.busy, startedAt: this.startedAt, engine: this.driver.availability() };
  }
  async connect(id) {
    if (this.busy) throw new Error('A tunnel operation is already in progress.');
    this.busy = true;
    let attempted = false;
    try {
      const profiles = await this.store.list();
      for (const profile of profiles) {
        if (await this.driver.isActive(profile.id)) throw new Error('Disconnect the current tunnel before connecting another.');
      }
      this.store.configPath(id);
      if (!profiles.some(p => p.id === id)) throw new Error('Profile not found.');
      await this.store.validate(id);
      attempted = true;
      await this.driver.change('up', id, this.store.configPath(id));
      if (!await this.waitForStatus(id, true)) throw new Error('The system did not report an active tunnel. Check WireGuard and try again.');
      this.activeId = id;
      this.startedAt = Date.now();
      this.verifiedId = this.driver.platform === 'win32' ? id : null;
    } catch (error) {
      this.verifiedId = null;
      if (attempted) {
        try {
          if (await this.driver.isActive(id)) {
            await this.driver.change('down', id, this.store.configPath(id));
            if (!await this.waitForStatus(id, false)) throw new Error('Tunnel is still active.');
          }
        } catch {
          throw new Error(`${error.message} Automatic cleanup could not be confirmed. Use Disconnect or stop the Aero WireGuard service as administrator.`);
        }
      }
      throw error;
    } finally { this.busy = false; }
    return this.state();
  }
  async disconnect() {
    if (this.busy) throw new Error('A tunnel operation is already in progress.');
    this.busy = true;
    try {
      const active = [];
      for (const profile of await this.store.list()) if (await this.driver.isActive(profile.id)) active.push(profile.id);
      if (active.length > 1) throw new Error('Multiple Aero tunnels are running. Stop extra tunnels with WireGuard.');
      const id = active[0];
      if (!id) { this.activeId = null; this.startedAt = null; }
      else {
      await this.driver.change('down', id, this.store.configPath(id));
      if (!await this.waitForStatus(id, false)) throw new Error('The tunnel is still active. Disconnect it with WireGuard before exiting.');
      this.activeId = null;
      this.startedAt = null;
      this.verifiedId = null;
      }
    } finally { this.busy = false; }
    return this.state();
  }
  async measure() {
    if (this.busy) throw new Error('Wait for the current tunnel operation to finish.');
    const profiles = await this.store.list();
    // Small batches avoid flooding the network when many profiles are imported.
    for (let i = 0; i < profiles.length; i += 4) {
      await Promise.all(profiles.slice(i, i + 4).map(async p => { this.latencies[p.id] = await this.driver.ping(p.host); }));
    }
    return this.state();
  }
  async remove(id) {
    if (this.busy) throw new Error('Wait for the current operation to finish.');
    this.busy = true;
    try {
      this.store.configPath(id);
      if (await this.driver.isActive(id)) throw new Error('Disconnect this profile before removing it.');
      await this.store.remove(id);
      delete this.latencies[id];
    } finally { this.busy = false; }
    return this.state();
  }
  async import(source, name) {
    if (this.busy) throw new Error('Wait for the current operation to finish.');
    this.busy = true;
    try { await this.store.import(source, name); }
    finally { this.busy = false; }
    return this.state();
  }
  async waitForStatus(id, expected) {
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await this.driver.isActive(id) === expected) return true;
      if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 400));
    }
    return false;
  }
}
module.exports = { VpnController };
