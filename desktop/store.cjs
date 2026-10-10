const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseConfig } = require('./config.cjs');

class ProfileStore {
  constructor(root) { this.root = path.join(root, 'profiles'); }
  async init() { await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); }
  async list() {
    await this.init();
    const profiles = [];
    for (const filename of await fs.readdir(this.root)) {
      if (!/^avpn[0-9a-f]{8}\.json$/.test(filename)) continue;
      try {
        const metadata = JSON.parse(await fs.readFile(path.join(this.root, filename), 'utf8'));
        const id = filename.slice(0, -5);
        const config = parseConfig(await fs.readFile(this.configPath(id), 'utf8'));
        profiles.push({ id, name: String(metadata.name).slice(0, 80), endpoint: config.endpoint, host: config.host, port: config.port, mtu: config.mtu, fullTunnel: config.fullTunnel, ipv4: config.ipv4, ipv6: config.ipv6, dnsConfigured: config.dnsConfigured });
      } catch { /* Invalid profiles are never passed to a privileged driver. */ }
    }
    return profiles.sort((a, b) => a.name.localeCompare(b.name));
  }
  configPath(id) {
    if (!/^avpn[0-9a-f]{8}$/.test(id)) throw new Error('Invalid profile ID.');
    return path.join(this.root, `${id}.conf`);
  }
  async import(source, name) {
    const config = parseConfig(source);
    await this.init();
    const id = `avpn${crypto.randomBytes(4).toString('hex')}`;
    const cleanName = String(name || 'My server').replace(/[\p{Cc}]/gu, '').slice(0, 80);
    await fs.writeFile(this.configPath(id), config.normalized, { mode: 0o600, flag: 'wx' });
    await fs.writeFile(path.join(this.root, `${id}.json`), JSON.stringify({ name: cleanName }), { mode: 0o600, flag: 'wx' });
    return (await this.list()).find(p => p.id === id);
  }
  async validate(id) { return parseConfig(await fs.readFile(this.configPath(id), 'utf8')); }
  async remove(id) {
    const config = this.configPath(id);
    await fs.unlink(config);
    await fs.unlink(path.join(this.root, `${id}.json`));
  }
}
module.exports = { ProfileStore };
