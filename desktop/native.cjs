const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20000, maxBuffer: 256 * 1024, windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err) {
        const error = new Error(err.code === 'ENOENT' ? 'Required system tool is not installed.' : 'System operation failed or permission was declined.');
        error.code = err.code;
        reject(error);
      } else resolve(stdout.trim());
    });
  });
}
const quotePS = value => `'${value.replace(/'/g, "''")}'`;

class NativeWireGuard {
  constructor(platform = process.platform, execute = run) {
    this.platform = platform;
    this.execute = execute;
    this.quick = platform === 'darwin'
      ? ['/opt/homebrew/bin/wg-quick', '/usr/local/bin/wg-quick'].find(p => fs.existsSync(p))
      : ['/usr/bin/wg-quick', '/usr/local/bin/wg-quick'].find(p => fs.existsSync(p));
    this.windowsExe = platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WireGuard', 'wireguard.exe') : null;
  }
  availability() {
    if (this.platform === 'win32') return { available: fs.existsSync(this.windowsExe), platform: 'Windows', instructions: 'Install the official WireGuard for Windows client, then restart Aero VPN.' };
    if (this.platform === 'linux') return { available: !!this.quick && fs.existsSync('/usr/bin/pkexec') && fs.existsSync('/usr/sbin/ip'), platform: 'Linux', instructions: 'Install wireguard-tools, iproute2, a polkit authentication agent, and resolvconf if your profile specifies DNS.' };
    if (this.platform === 'darwin') return { available: !!this.quick, platform: 'macOS', instructions: 'Install wireguard-tools and wireguard-go with Homebrew. Administrator approval is required when connecting.' };
    return { available: false, platform: this.platform, instructions: 'This operating system is not supported.' };
  }
  async change(action, id, configPath) {
    if (!['up', 'down'].includes(action) || !/^avpn[0-9a-f]{8}$/.test(id)) throw new Error('Invalid tunnel operation.');
    if (!this.availability().available) throw new Error(this.availability().instructions);
    if (this.platform === 'linux') {
      await this.execute('/usr/bin/pkexec', [this.quick, action, configPath], { timeout: 120000 });
    } else if (this.platform === 'darwin') {
      // osascript handles administrator approval; both arguments are shell-quoted.
      const sq = value => `'${value.replace(/'/g, "'\\''")}'`;
      const command = `${sq(this.quick)} ${action} ${sq(configPath)}`;
      await this.execute('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`], { timeout: 120000 });
    } else {
      const arg = action === 'up' ? `/installtunnelservice "${configPath}"` : `/uninstalltunnelservice ${id}`;
      const script = `$p = Start-Process -FilePath ${quotePS(this.windowsExe)} -ArgumentList ${quotePS(arg)} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
      await this.execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 120000 });
    }
  }
  async isActive(id) {
    if (!/^avpn[0-9a-f]{8}$/.test(id)) throw new Error('Invalid profile ID.');
    try {
      if (this.platform === 'linux') {
        const output = await this.execute('/usr/sbin/ip', ['-j', 'link', 'show', 'dev', id]);
        return JSON.parse(output).some(link => link.flags?.includes('UP'));
      }
      if (this.platform === 'win32') {
        const output = await this.execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `try { (Get-Service -Name ${quotePS(`WireGuardTunnel$${id}`)} -ErrorAction Stop).Status.ToString() } catch { if ($_.FullyQualifiedErrorId -like 'NoServiceFoundForGivenName*') { 'Absent' } else { Write-Error $_; exit 1 } }`]);
        return output === 'Running';
      }
      const iface = fs.readFileSync(`/var/run/wireguard/${id}.name`, 'utf8').trim();
      if (!/^utun\d+$/.test(iface)) return false;
      const output = await this.execute('/sbin/ifconfig', [iface]);
      return /<[^>]*\bUP\b/.test(output);
    } catch {
      if (this.platform === 'win32') throw new Error('Could not verify the WireGuard service state. Check that PowerShell and Windows services are accessible.');
      return false;
    }
  }
  async ping(host) {
    // The endpoint is parsed before invocation. No shell or user-supplied flags.
    try {
      const args = this.platform === 'win32' ? ['-n', '3', '-w', '1500', host] : this.platform === 'darwin' ? ['-n', '-c', '3', '-W', '1500', host] : ['-n', '-c', '3', '-W', '2', host];
      const output = await this.execute(this.platform === 'win32' ? 'ping.exe' : '/bin/ping', args, { timeout: 10000 });
      const avg = /(?:rtt|round-trip)[^=]*=\s*[\d.]+\/([\d.]+)\//.exec(output);
      const times = [...output.matchAll(/(?:time|temps|zeit)[=<]\s*([\d.,]+)\s*ms/gi)].map(m => Number(m[1].replace(',', '.')));
      const ms = avg ? Number(avg[1]) : times.length ? times.reduce((a,b) => a+b, 0) / times.length : null;
      return { ms: Number.isFinite(ms) && ms > 0 ? Math.round(ms * 10) / 10 : null, measuredAt: Date.now() };
    } catch { return { ms: null, measuredAt: Date.now() }; }
  }
}

module.exports = { NativeWireGuard, run };
