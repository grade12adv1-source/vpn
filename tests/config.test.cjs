const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parseConfig, endpointParts } = require('../desktop/config.cjs');
const { ProfileStore } = require('../desktop/store.cjs');

// Synthetic test keys; these fixtures are never usable server credentials.
const key = Buffer.alloc(32, 7).toString('base64');
const sample = `[Interface]\nPrivateKey = ${key}\nAddress = 10.8.0.2/32, fd00::2/128\nDNS = 1.1.1.1\nMTU = 1420\n\n[Peer]\nPublicKey = ${key}\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = vpn.example.com:51820\nPersistentKeepalive = 25\n`;

test('parses dual-stack profiles and preserves server MTU', () => {
  const profile = parseConfig(sample);
  assert.equal(profile.host, 'vpn.example.com');
  assert.equal(profile.port, 51820);
  assert.equal(profile.mtu, 1420);
  assert.equal(profile.fullTunnel, true);
  assert.equal(profile.ipv6, true);
  assert.equal(profile.dnsConfigured, true);
  assert.equal(parseConfig(profile.normalized).normalized, profile.normalized);
});

test('rejects privileged shell hooks and configuration rewrite directives', () => {
  for (const option of ['PreUp', 'PostUp', 'PreDown', 'PostDown', 'SaveConfig', 'Table']) {
    assert.throws(() => parseConfig(sample.replace('MTU = 1420', `${option} = arbitrary`)), /Unsupported/);
  }
});

test('rejects invalid keys, networks, DNS and extra peers', () => {
  assert.throws(() => parseConfig(sample.replace(key, 'bad-key')), /PrivateKey/);
  assert.throws(() => parseConfig(sample.replace('10.8.0.2/32', '999.8.0.2/32')), /Address/);
  assert.throws(() => parseConfig(sample.replace('0.0.0.0/0', '0.0.0.0/33')), /AllowedIPs/);
  assert.throws(() => parseConfig(sample.replace('DNS = 1.1.1.1', 'DNS = 1.1.1.1; touch /tmp/file')), /DNS/);
  assert.throws(() => parseConfig(sample + '\n[Peer]\n'), /exactly one/);
  assert.throws(() => parseConfig(sample.replace('MTU = 1420', 'MTU = 9001')), /MTU/);
});

test('requires essential client fields and disallows duplicate fields', () => {
  assert.throws(() => parseConfig(sample.replace(`PrivateKey = ${key}\n`, '')), /requires/);
  assert.throws(() => parseConfig(sample.replace('MTU = 1420', 'MTU = 1420\nMTU = 1280')), /Duplicate/);
  assert.throws(() => parseConfig('x'.repeat(65537)), /64 KB/);
});

test('accepts bracketed IPv6 endpoints and rejects argument or shell injection', () => {
  assert.deepEqual(endpointParts('[2001:db8::1]:51820'), { host: '2001:db8::1', port: 51820 });
  for (const endpoint of ['-n:80', 'x;curl:80', 'a$(x):80', 'x:65536', 'x:0', 'a..b:80', '[not-ip]:80']) assert.throws(() => endpointParts(endpoint));
});

test('stores private files with restricted permissions and never returns keys', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aero-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ProfileStore(root);
  const profile = await store.import(sample, '<script>alert(1)</script>');
  assert.equal(profile.name, '<script>alert(1)</script>');
  assert.ok(!JSON.stringify(await store.list()).includes(key));
  assert.ok(!Object.hasOwn(profile, 'normalized'));
  if (process.platform !== 'win32') assert.equal((await fs.stat(store.configPath(profile.id))).mode & 0o777, 0o600);
  assert.throws(() => store.configPath('../../secret'), /Invalid/);
  await store.remove(profile.id);
  assert.equal((await store.list()).length, 0);
});

test('invalid imports create no files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aero-invalid-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ProfileStore(root);
  await store.init();
  await assert.rejects(store.import(sample + 'PostUp = bad\n', 'unsafe'), /Unsupported/);
  assert.deepEqual(await fs.readdir(store.root), []);
});

module.exports = { sample };
