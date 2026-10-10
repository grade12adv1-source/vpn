const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { connectionScript } = require('../desktop/windows-connect.cjs');
const { NativeWireGuard } = require('../desktop/native.cjs');

const script = connectionScript('C:\\Program Files\\WireGuard\\wireguard.exe', 'C:\\Program Files\\WireGuard\\wg.exe', 'C:\\Windows\\System32\\curl.exe', 'avpn12345678', "C:\\Users\\Jane's account\\avpn12345678.conf");

test('connection verification is bounded and full-tunnel checks bind to the tunnel address', () => {
  assert.ok(script.includes('latest-handshakes'));
  assert.ok(script.includes('Elapsed.TotalSeconds -lt 30'));
  assert.ok(script.includes('--interface $source --noproxy'));
  assert.ok(script.includes('--max-time 6'));
  assert.ok(!script.includes('--insecure'));
  assert.ok(script.includes('persistent-keepalive $keepalive'));
  assert.ok(script.includes('/uninstalltunnelservice $id'));
  assert.ok(script.includes('Stop-Service -Name $serviceName'));
});

test('PowerShell connection helper parses successfully on Windows', { skip: process.platform !== 'win32' }, () => {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const parse = `$s=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); $t=$null; $e=$null; $null=[System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e); if($e.Count -gt 0){$e | ForEach-Object {$_.Message}; exit 1}`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parse]);
});

test('native connection failure codes identify server, Internet and cleanup failures', async () => {
  for (const [code, pattern] of [[20, /handshake within 30 seconds/], [21, /Internet check failed/], [22, /could not stop/], [23, /could not start or verify/]]) {
    const driver = new NativeWireGuard('win32', async () => { const error = new Error('System failure'); error.code = code; throw error; });
    driver.availability = () => ({ available: true });
    driver.windowsExe = 'C:\\WireGuard\\wireguard.exe';
    driver.wgExe = 'C:\\WireGuard\\wg.exe';
    driver.curlExe = 'C:\\Windows\\System32\\curl.exe';
    await assert.rejects(driver.change('up', 'avpn12345678', 'C:\\profiles\\avpn12345678.conf'), pattern);
  }
});

function simulate(mode) {
  const helper = connectionScript('Fake-WireGuard', 'Fake-Wg', 'Fake-Curl', 'avpn12345678', 'profile.conf')
    .replace('exit $result', 'Write-Output ("AERO_RESULT:" + (@{ code=$result; active=$global:active; keepalive=$global:mockKeepalive; probes=$global:probes } | ConvertTo-Json -Compress))');
  const harness = String.raw`
$global:active=$false
$global:mockKeepalive=25
$global:probes=0
$global:mode='${mode}'
function Fake-WireGuard {
  $global:LASTEXITCODE=0
  if ($args[0] -eq '/installtunnelservice') {
    $global:active=$true
    if ($global:mode -eq 'partial-install') { $global:LASTEXITCODE=1 }
  } else {
    if ($global:mode -eq 'cleanup-failed') { $global:LASTEXITCODE=1 }
    else { $global:active=$false }
  }
}
function Fake-Wg {
  $global:LASTEXITCODE=0
  if ($args[0] -eq 'set') { $global:mockKeepalive=[int]$args[5] }
  elseif ($args[2] -eq 'peers') { 'synthetic-peer' }
  elseif ($args[2] -eq 'persistent-keepalive') { 'synthetic-peer' + [char]9 + $global:mockKeepalive }
  elseif ($args[2] -eq 'latest-handshakes') {
    if ($global:mode -eq 'no-handshake') { 'synthetic-peer' + [char]9 + '0' }
    else { 'synthetic-peer' + [char]9 + '1234567890' }
  }
}
function Get-Service {
  if ($global:active) { [PSCustomObject]@{Status='Running'} }
}
function Stop-Service {
  if ($global:mode -eq 'cleanup-failed') { throw 'Stop denied' }
  $global:active=$false
}
function Get-Content {
  if ($global:mode -eq 'split') { 'Address = 10.8.0.2/32' + [char]10 + 'AllowedIPs = 10.8.0.0/24' }
  else { 'Address = 10.8.0.2/32' + [char]10 + 'AllowedIPs = 0.0.0.0/0' }
}
function Test-Path { $true }
function Fake-Curl {
  $global:probes++
  if ($global:mode -eq 'internet-failed' -or $global:mode -eq 'cleanup-failed') { $global:LASTEXITCODE=28 }
  else { $global:LASTEXITCODE=0 }
}
${helper}
`;
  const encoded = Buffer.from(harness, 'utf16le').toString('base64');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 45000 });
  return JSON.parse(/AERO_RESULT:(\{[^\r\n]+\})/.exec(output)[1]);
}

for (const [mode, code, active, probes] of [
  ['success', 0, true, 1],
  ['internet-failed', 21, false, 2],
  ['partial-install', 23, false, 0],
  ['cleanup-failed', 22, true, 2],
  ['split', 0, true, 0],
  ['no-handshake', 20, false, 0]
]) {
  test(`Windows helper control flow: ${mode}`, { skip: process.platform !== 'win32' }, () => {
    const result = simulate(mode);
    assert.equal(result.code, code);
    assert.equal(result.active, active);
    assert.equal(result.probes, probes);
    if (code === 0) assert.equal(result.keepalive, 25);
  });
}
