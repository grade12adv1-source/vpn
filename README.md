# Aero VPN

A Windows-first WireGuard desktop client built with Electron. Import your own server profile, compare measured endpoint round-trip times, and connect through the official WireGuard system service. The interface also includes an optional preference to select the lowest measured latency before connecting.

## Run on Windows

1. Install Node.js 24 LTS and the official [WireGuard for Windows](https://www.wireguard.com/install/) client in its default location.
2. In this repository, run `npm ci`, then `npm start`.
3. Get a **client** `.conf` file from your own WireGuard server or a provider supporting WireGuard profile export. Import it in Aero, then connect and approve the Windows UAC prompt.

There is no bundled VPN server or trial account. Until a working profile is imported, the interface remains disconnected and shows no invented latency or traffic data. No credentials are needed to build or test the app.

## Build

The included `.github/workflows/windows-build.yml` builds the app on Windows after a push to `main` or a manual run. Open the repository’s **Actions** tab, select a successful **Build Windows app** run, and download **Aero-VPN-Windows** under **Artifacts**. Extract the downloaded ZIP and run the `.exe`. You must be signed into GitHub to download workflow artifacts; they expire after 30 days.

```sh
npm test
npm run build
npm run dist:win
```

`build` produces an unpacked app for the current operating system. `dist:win` creates a portable x64 Windows executable in `dist/`; copy and run it on Windows 10 or newer. It does not install the separate WireGuard client. Builds are unsigned; Windows may show an unrecognized-publisher warning. For public distribution, configure a code-signing certificate in a separate release environment and enable `win.signExecutable` before releasing. This repository does not contain signing keys.

`npm run dist:installer` creates an optional NSIS installer on Windows. Linux cross-builds of that installer require a working Wine toolset; the pinned toolset did not initialize in the onboarding cloud. The portable build avoids that prerequisite.

## Connection and latency behavior

- Windows connections call the official `wireguard.exe /installtunnelservice` and `/uninstalltunnelservice` commands through a UAC-approved process. The app checks the named service before reporting **tunnel active**. This does not verify a peer handshake or Internet reachability; inspect the official WireGuard client and test your intended destination.
- Latency is the average of three ICMP probes to each configured endpoint. Servers may block ICMP while still accepting WireGuard UDP. Measurements are not VPN throughput or a latency guarantee, and checking through an existing tunnel changes the measured path.
- WireGuard uses the profile’s MTU, DNS, routes, and keepalive configuration. The app does not arbitrarily reduce MTU or claim to eliminate distance and network congestion. Prefer a nearby, uncongested server and measure while disconnected.
- Closing the app can leave a tunnel running after a confirmation. On relaunch, the client detects its own existing tunnel services. It does not manage tunnels created by other WireGuard clients.
- There is no app-level kill switch, auto-reconnect, IPv6 blocking, or provisioned server infrastructure. A profile without `::/0` can leave IPv6 traffic outside the tunnel. The UI shows routing and DNS coverage notes.

## Profile security

Import accepts one Interface and one Peer section with normal WireGuard client fields. `PreUp`, `PostUp`, `PreDown`, `PostDown`, `SaveConfig`, and other unsupported options are rejected, preventing imported profiles from running administrator shell hooks. Profile names are rendered as text. All system operations use fixed executables and argument arrays; the renderer cannot supply a command or configuration path.

Profiles are stored under Electron’s user-data folder (`%APPDATA%/Aero VPN/profiles` or `%APPDATA%/aero-vpn/profiles`, depending on the packaged name). The desktop account’s directory permissions protect them on Windows; Unix files are created with mode `0600` in a `0700` directory. Administrators and processes running as your account can still read them. The app needs a plaintext file for the native WireGuard installer; it is not an encrypted password vault. Backups of your application folder can contain private keys.

Private keys never enter the renderer, analytics, or network requests. The app has no analytics or remote interface assets. Windows WireGuard is responsible for protecting its own installed service configuration.

## Other platforms

The native adapter includes Linux (`wg-quick`, `iproute2`, `pkexec`, a working polkit agent, and `resolvconf` for DNS profiles) and macOS (Homebrew `wireguard-tools` and `wireguard-go`) paths. These are secondary adapters and require real-host integration testing before distribution. Never run the entire Electron app as root or disable its sandbox to connect a VPN.

## Development validation

`npm test` covers profile parsing, unsafe configuration rejection, restricted profile storage, failed system operations, concurrent connection prevention, existing-tunnel detection, latency parsing, and Windows service queries. A cloud machine without a Windows desktop, a WireGuard server, and UAC cannot prove a real Windows tunnel handshake. Use a real Windows host and your own configuration to validate the complete connection flow.

`python tests/ui-smoke.py` exercises the interface with a simulated desktop bridge in the onboarding cloud (Python Playwright and `/usr/bin/chromium` are available). It checks profile import, safe text rendering, latency sorting, fastest-profile selection, simulated connect/disconnect, removal confirmation, preferences, navigation, and window sizing. It does not create or validate a real tunnel.

The current cloud’s Linux sandbox does not support Electron’s required setuid helper or unprivileged user namespaces, so native Electron startup could not be validated there. No sandbox bypass is configured in the app. The Windows executable needs validation on a Windows desktop.

The cloud environment is already isolated. Use `/workspace/vpn` directly; do not create a Git worktree unless explicitly requested. Dependencies and app builds can be retained, but desktop and tunnel processes must be restarted in each new task.
