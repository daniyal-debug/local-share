import os from 'node:os';
import crypto from 'node:crypto';

/** Strip IPv6 wrappers so we always reason about a plain address. */
export function normalizeIp(raw) {
  if (!raw) return '0.0.0.0';
  let ip = String(raw).trim();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

export function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 127) return true;
  return false;
}

/**
 * Two devices count as being on the same network when this returns the same key.
 *
 * Self-hosted on a LAN every client arrives with its own 192.168.x.y address, so we
 * group by /24 subnet. Behind a proxy on the public internet every client on one
 * Wi-Fi shares a single NAT address, so we group by the exact address.
 */
export function networkKey(remoteIp) {
  const ip = normalizeIp(remoteIp);
  const parts = ip.split('.');
  if (parts.length === 4 && isPrivateIpv4(ip)) {
    return `net:${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  return `net:${ip}`;
}

export function clientIp(req) {
  return normalizeIp(req.ip || req.socket?.remoteAddress);
}

export function networkKeyForRequest(req) {
  return networkKey(clientIp(req));
}

const ADJECTIVES = [
  'Amber', 'Brisk', 'Cobalt', 'Dusty', 'Ember', 'Fern', 'Golden', 'Hazel',
  'Indigo', 'Jade', 'Krypton', 'Lunar', 'Maple', 'Nimbus', 'Onyx', 'Pearl'
];
const NOUNS = [
  'Harbor', 'Meadow', 'Orbit', 'Canyon', 'Lantern', 'Summit', 'Willow', 'Beacon',
  'Cavern', 'Prairie', 'Reef', 'Thicket', 'Valley', 'Anchor', 'Foundry', 'Garden'
];

/** Stable, human-readable name for a network. Never exposes the raw address. */
export function networkLabel(key) {
  const digest = crypto.createHash('sha256').update(key).digest();
  return `${ADJECTIVES[digest[0] % ADJECTIVES.length]} ${NOUNS[digest[1] % NOUNS.length]}`;
}

/** Best-guess LAN address so a phone can be pointed at this server. */
export function lanAddress() {
  const candidates = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      candidates.push(address.address);
    }
  }
  candidates.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
  return candidates[0] || null;
}
