const net = require('node:net');

const interfaceKeys = new Set(['PrivateKey', 'Address', 'DNS', 'MTU', 'ListenPort']);
const peerKeys = new Set(['PublicKey', 'PresharedKey', 'AllowedIPs', 'Endpoint', 'PersistentKeepalive']);
const keyPattern = /^[A-Za-z0-9+/]{43}=$/;

function validCidr(value) {
  const [address, prefix, extra] = value.split('/');
  const family = net.isIP(address);
  return !extra && !!family && /^\d+$/.test(prefix || '') && Number(prefix) <= (family === 4 ? 32 : 128);
}

function endpointParts(value) {
  const match = /^(?:\[([a-fA-F0-9:]+)\]|([a-zA-Z0-9.-]+)):(\d{1,5})$/.exec(value);
  if (!match || +match[3] < 1 || +match[3] > 65535) throw new Error('Endpoint must be a hostname or IP address and a valid port.');
  const host = match[1] || match[2];
  if (match[1] && net.isIP(host) !== 6) throw new Error('Invalid IPv6 endpoint.');
  if (!match[1] && !net.isIP(host) && (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host) || host.includes('..') || host.length > 253)) {
    throw new Error('Invalid endpoint hostname.');
  }
  return { host, port: Number(match[3]) };
}

function parseConfig(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 64 * 1024) throw new Error('Profile must be a WireGuard configuration under 64 KB.');
  const sections = [];
  let section;
  for (const original of source.split(/\r?\n/)) {
    const line = original.split('#')[0].trim();
    if (!line) continue;
    if (/^\[(Interface|Peer)\]$/.test(line)) {
      const type = line.slice(1, -1);
      if ((!sections.length && type !== 'Interface') || (sections.length && type === 'Interface')) throw new Error('Use one Interface section followed by one Peer section.');
      section = { type, values: {} };
      sections.push(section);
      continue;
    }
    const match = /^([A-Za-z]+)\s*=\s*(.+)$/.exec(line);
    if (!section || !match) throw new Error('Invalid WireGuard configuration line.');
    const [, key, value] = match;
    const allowed = section.type === 'Interface' ? interfaceKeys : peerKeys;
    if (!allowed.has(key)) throw new Error(`Unsupported configuration option: ${key}. Scripts and SaveConfig are not permitted.`);
    if (Object.hasOwn(section.values, key)) throw new Error(`Duplicate configuration option: ${key}.`);
    if (/\p{Cc}/u.test(value)) throw new Error('Configuration values cannot contain control characters.');
    if (key.endsWith('Key') && (!keyPattern.test(value) || Buffer.from(value, 'base64').length !== 32)) throw new Error(`${key} must be a base64-encoded 32-byte WireGuard key.`);
    if (key === 'Address' || key === 'AllowedIPs') {
      if (!value.split(',').every(item => validCidr(item.trim()))) throw new Error(`${key} must contain valid CIDR addresses.`);
    }
    if (key === 'DNS' && !value.split(',').every(item => net.isIP(item.trim()))) throw new Error('DNS must contain IP addresses.');
    if (key === 'Endpoint') endpointParts(value);
    if (['MTU', 'ListenPort', 'PersistentKeepalive'].includes(key)) {
      const limits = key === 'MTU' ? [576, 9000] : key === 'ListenPort' ? [1, 65535] : [0, 65535];
      if (!/^\d+$/.test(value) || +value < limits[0] || +value > limits[1]) throw new Error(`Invalid ${key}.`);
    }
    section.values[key] = value;
  }
  if (sections.length !== 2 || sections[1].type !== 'Peer') throw new Error('Import one client profile with exactly one VPN server peer.');
  const iface = sections[0].values;
  const peer = sections[1].values;
  if (!iface.PrivateKey || !iface.Address || !peer.PublicKey || !peer.AllowedIPs || !peer.Endpoint) throw new Error('Profile requires PrivateKey, Address, PublicKey, AllowedIPs, and Endpoint.');
  const normalized = sections.map(s => `[${s.type}]\n${Object.entries(s.values).map(([k,v]) => `${k} = ${v}`).join('\n')}`).join('\n\n') + '\n';
  return {
    normalized,
    endpoint: peer.Endpoint,
    ...endpointParts(peer.Endpoint),
    mtu: iface.MTU ? Number(iface.MTU) : null,
    fullTunnel: peer.AllowedIPs.split(',').some(x => x.trim() === '0.0.0.0/0' || x.trim() === '::/0'),
    ipv4: peer.AllowedIPs.split(',').some(x => x.trim() === '0.0.0.0/0'),
    ipv6: peer.AllowedIPs.split(',').some(x => x.trim() === '::/0'),
    dnsConfigured: !!iface.DNS
  };
}

module.exports = { parseConfig, endpointParts };
