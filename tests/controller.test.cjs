const test = require('node:test');
const assert = require('node:assert/strict');
const { VpnController } = require('../desktop/controller.cjs');
const { NativeWireGuard } = require('../desktop/native.cjs');

function fixture() {
  let running = false;
  const profiles = [{ id: 'avpn12345678', name: 'Test', host: 'vpn.example.com', endpoint: 'vpn.example.com:51820' }];
  const calls = [];
  const store = { list: async () => profiles, configPath: id => { if (!/^avpn[0-9a-f]{8}$/.test(id)) throw new Error('Invalid profile ID.'); return `/profiles/${id}.conf`; }, validate: async () => {}, remove: async () => { profiles.splice(0); }, import: async () => {} };
  const driver = { isActive: async () => running, availability: () => ({ available: true }), change: async (action, id, file) => { calls.push({ action, id, file }); running = action === 'up'; }, ping: async () => ({ ms: 12.5, measuredAt: Date.now() }) };
  return { controller: new VpnController(store, driver), store, driver, calls, setRunning: value => { running = value; } };
}

test('connects only after verifying a system tunnel and disconnects it', async () => {
  const { controller, calls } = fixture();
  const state = await controller.connect('avpn12345678');
  assert.equal(state.activeId, 'avpn12345678');
  assert.ok(state.startedAt);
  assert.equal((await controller.disconnect()).activeId, null);
  assert.deepEqual(calls.map(c => c.action), ['up', 'down']);
});

test('does not report success when the system interface failed to start', async () => {
  const { controller, driver } = fixture();
  driver.change = async () => {};
  controller.waitForStatus = async () => false;
  await assert.rejects(controller.connect('avpn12345678'), /did not report/);
  assert.equal((await controller.state()).activeId, null);
  assert.equal(controller.busy, false);
});

test('recovers after administrator approval is declined', async () => {
  const { controller, driver } = fixture();
  driver.change = async () => { throw new Error('permission was declined'); };
  await assert.rejects(controller.connect('avpn12345678'), /declined/);
  assert.equal(controller.busy, false);
  assert.equal((await controller.state()).activeId, null);
});

test('detects an existing tunnel after restarting and refuses a second connection', async () => {
  const { controller, setRunning, calls } = fixture();
  setRunning(true);
  const restored = await controller.state();
  assert.equal(restored.activeId, 'avpn12345678');
  assert.ok(restored.startedAt);
  assert.equal(restored.peerVerified, false);
  await assert.rejects(controller.connect('avpn12345678'), /Disconnect/);
  assert.equal(calls.length, 0);
  await assert.rejects(controller.remove('avpn12345678'), /Disconnect/);
});

test('serializes operations before any asynchronous profile read', async () => {
  const { controller, store, calls } = fixture();
  let resume;
  const original = store.list;
  store.list = () => new Promise(resolve => { resume = () => original().then(resolve); });
  const first = controller.connect('avpn12345678');
  await assert.rejects(controller.connect('avpn12345678'), /already in progress/);
  await assert.rejects(controller.remove('avpn12345678'), /current operation/);
  await assert.rejects(controller.import('config', 'name'), /current operation/);
  store.list = original;
  resume();
  await first;
  assert.equal(calls.length, 1);
});

test('keeps failed latency probes distinct from a zero-millisecond measurement', async () => {
  const { controller, driver } = fixture();
  assert.equal((await controller.measure()).profiles[0].latency.ms, 12.5);
  driver.ping = async () => ({ ms: null, measuredAt: Date.now() });
  assert.equal((await controller.measure()).profiles[0].latency.ms, null);
});

test('native ping parses ICMP average without launching a shell', async () => {
  const calls = [];
  const driver = new NativeWireGuard('linux', async (file, args) => { calls.push({ file, args }); return 'rtt min/avg/max/mdev = 10.123/12.456/13.789/1.000 ms'; });
  assert.equal((await driver.ping('vpn.example.com')).ms, 12.5);
  assert.equal(calls[0].file, '/bin/ping');
  assert.deepEqual(calls[0].args, ['-n', '-c', '3', '-W', '2', 'vpn.example.com']);
});

test('Windows service query uses a fixed, validated service name', async () => {
  const calls = [];
  const driver = new NativeWireGuard('win32', async (file, args) => { calls.push({ file, args }); return 'Running'; });
  assert.equal(await driver.isActive('avpn12345678'), true);
  assert.ok(calls[0].args.at(-1).includes("'WireGuardTunnel$avpn12345678'"));
  await assert.rejects(driver.isActive("x'; Invoke-Expression 'bad"), /Invalid/);
});

test('native driver rejects invalid tunnel actions before privilege elevation', async () => {
  const driver = new NativeWireGuard('win32', async () => { assert.fail('Must not invoke system tools'); });
  await assert.rejects(driver.change('delete', 'avpn12345678', '/x'), /Invalid/);
  await assert.rejects(driver.change('up', '../../evil', '/x'), /Invalid/);
});

test('Windows service query failure remains an error rather than a disconnected claim', async () => {
  const driver = new NativeWireGuard('win32', async () => { throw new Error('Access denied'); });
  await assert.rejects(driver.isActive('avpn12345678'), /Could not verify/);
});

test('waits for a pending Windows service to become active', async () => {
  const { controller, driver } = fixture();
  let checks = 0;
  driver.isActive = async () => ++checks >= 2;
  assert.equal(await controller.waitForStatus('avpn12345678', true), true);
  assert.equal(checks, 2);
});

test('Windows tunnel changes request UAC with fixed WireGuard arguments', async () => {
  const calls = [];
  const driver = new NativeWireGuard('win32', async (file, args, options) => { calls.push({ file, args, options }); return ''; });
  driver.availability = () => ({ available: true });
  driver.windowsExe = 'C:\\Program Files\\WireGuard\\wireguard.exe';
  driver.wgExe = 'C:\\Program Files\\WireGuard\\wg.exe';
  driver.curlExe = 'C:\\Windows\\System32\\curl.exe';
  await driver.change('up', 'avpn12345678', "C:\\Users\\Jane's account\\profiles\\avpn12345678.conf");
  await driver.change('down', 'avpn12345678', 'unused');
  assert.equal(calls[0].file, 'powershell.exe');
  assert.ok(calls[0].args.at(-1).includes('-Verb RunAs -Wait -PassThru'));
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(calls[0].args.at(-1))[1];
  const elevated = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(elevated.includes('/installtunnelservice'));
  assert.ok(elevated.includes("Jane''s account"));
  assert.ok(calls[1].args.at(-1).includes('/uninstalltunnelservice avpn12345678'));
  assert.equal(calls[0].options.timeout, 240000);
});

test('rolls back a tunnel when startup verification fails after creation', async () => {
  const { controller, driver, calls } = fixture();
  controller.waitForStatus = async (_id, expected) => !expected;
  await assert.rejects(controller.connect('avpn12345678'), /did not report/);
  assert.deepEqual(calls.map(c => c.action), ['up', 'down']);
  assert.equal((await controller.state()).activeId, null);
});

test('cleans up a partially started tunnel after a driver failure', async () => {
  const { controller, driver, setRunning } = fixture();
  const actions = [];
  driver.change = async action => {
    actions.push(action);
    setRunning(action === 'up');
    if (action === 'up') throw new Error('Server did not respond');
  };
  await assert.rejects(controller.connect('avpn12345678'), /Server did not respond/);
  assert.deepEqual(actions, ['up', 'down']);
  assert.equal((await controller.state()).activeId, null);
});

test('explicitly reports when rollback is denied instead of claiming recovery', async () => {
  const { controller, driver, setRunning } = fixture();
  driver.change = async action => {
    if (action === 'up') { setRunning(true); throw new Error('Verification failed'); }
    throw new Error('Permission declined');
  };
  await assert.rejects(controller.connect('avpn12345678'), /cleanup could not be confirmed/);
  assert.equal((await controller.state()).activeId, 'avpn12345678');
});

test('verification status is not assumed for a tunnel discovered after restart', async () => {
  const { controller, driver } = fixture();
  driver.platform = 'win32';
  assert.equal((await controller.connect('avpn12345678')).peerVerified, true);
  controller.verifiedId = null;
  assert.equal((await controller.state()).peerVerified, false);
});
