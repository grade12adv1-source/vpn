const quote = value => `'${value.replace(/'/g, "''")}'`;

// Runs inside the UAC-approved process. All executables and paths come from the
// main process; the renderer supplies only a validated profile ID.
function connectionScript(wireguard, wg, curl, id, configPath) {
  if (!/^avpn[0-9a-f]{8}$/.test(id)) throw new Error('Invalid profile ID.');
  return String.raw`
$ErrorActionPreference = 'Stop'
$wireguard = ${quote(wireguard)}
$wg = ${quote(wg)}
$curl = ${quote(curl)}
$id = ${quote(id)}
$configPath = ${quote(configPath)}
$serviceName = 'WireGuardTunnel$' + $id
$installed = $false
$verified = $false
$peer = $null
$keepalive = $null
$result = 23
try {
  $installed = $true
  & $wireguard /installtunnelservice $configPath
  if ($LASTEXITCODE -ne 0) { throw 'Install failed' }
  $wait = [Diagnostics.Stopwatch]::StartNew()
  do {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -eq 'Running') { break }
    Start-Sleep -Milliseconds 250
  } while ($wait.Elapsed.TotalSeconds -lt 5)
  if (!$service -or $service.Status -ne 'Running') { throw 'Service did not start' }
  $peers = @(& $wg show $id peers 2>$null)
  if ($LASTEXITCODE -ne 0 -or $peers.Count -ne 1) { throw 'Cannot query peer' }
  $peer = $peers[0].Trim()
  $settings = @(& $wg show $id persistent-keepalive 2>$null)
  if ($LASTEXITCODE -ne 0 -or $settings.Count -ne 1) { throw 'Cannot query keepalive' }
  $keepalive = ($settings[0] -split '\s+')[1]
  if ($keepalive -eq 'off') { $keepalive = '0' }
  if ($keepalive -notmatch '^\d+$') { throw 'Invalid keepalive' }
  # A temporary keepalive generates tunnel traffic even before the user opens
  # a site. Restore the original value before reporting success.
  & $wg set $id peer $peer persistent-keepalive 1 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot probe peer' }
  $result = 20
  $wait.Restart()
  $handshake = $false
  do {
    $lines = @(& $wg show $id latest-handshakes 2>$null)
    if ($LASTEXITCODE -eq 0 -and $lines.Count -eq 1) {
      $timestamp = ($lines[0] -split '\s+')[1]
      if ($timestamp -match '^\d+$' -and [long]$timestamp -gt 0) { $handshake = $true; break }
    }
    Start-Sleep -Milliseconds 500
  } while ($wait.Elapsed.TotalSeconds -lt 30)
  if (!$handshake) { throw 'Peer did not respond' }
  & $wg set $id peer $peer persistent-keepalive $keepalive 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot restore keepalive' }
  $keepalive = $null

  # Probe a full tunnel using its assigned source address. This prevents a
  # working Wi-Fi route from masquerading as a working VPN. No key is sent to
  # these sites. curl retains the Windows certificate verification defaults.
  $text = Get-Content -LiteralPath $configPath -Raw
  $address = [regex]::Match($text, '(?m)^Address\s*=\s*(.+)$').Groups[1].Value
  $allowed = [regex]::Match($text, '(?m)^AllowedIPs\s*=\s*(.+)$').Groups[1].Value
  $routes = @($allowed.Split(',') | ForEach-Object { $_.Trim() })
  $addresses = @($address.Split(',') | ForEach-Object { ($_.Trim() -split '/')[0] })
  $source = $null
  $family = $null
  if ($routes -contains '0.0.0.0/0') {
    $source = $addresses | Where-Object { $_ -notmatch ':' } | Select-Object -First 1
    $family = '--ipv4'
  } elseif ($routes -contains '::/0') {
    $source = $addresses | Where-Object { $_ -match ':' } | Select-Object -First 1
    $family = '--ipv6'
  }
  if ($family) {
    $result = 21
    if (!$source -or !(Test-Path -LiteralPath $curl)) { throw 'Cannot check tunnel Internet access' }
    $reachable = $false
    foreach ($url in @('https://www.microsoft.com/', 'https://www.cloudflare.com/')) {
      & $curl $family --interface $source --noproxy '*' --connect-timeout 4 --max-time 6 --silent --fail --output NUL $url 2>$null
      if ($LASTEXITCODE -eq 0) { $reachable = $true; break }
    }
    if (!$reachable) { throw 'Tunnel Internet check failed' }
  }
  $verified = $true
  $result = 0
} catch {
  # Errors deliberately contain no configuration contents or private keys.
} finally {
  if (!$verified) {
    if ($installed) {
      try { & $wireguard /uninstalltunnelservice $id 2>$null } catch { $result = 22 }
      $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
      if ($service -and $service.Status -ne 'Stopped') {
        try { Stop-Service -Name $serviceName -Force -ErrorAction Stop } catch { $result = 22 }
      }
      $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
      if ($service -and $service.Status -ne 'Stopped') { $result = 22 }
    }
  }
}
exit $result
`;
}

module.exports = { connectionScript };
