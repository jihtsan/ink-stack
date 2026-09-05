import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Future HTTP adapters must pin the returned address at connection time and disable redirects. */
export async function validateTarget(input: string, allowedOrigins: readonly string[], options: {allowPrivate?: boolean} = {}): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('invalid_target'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !allowedOrigins.includes(url.origin)) throw new Error('target_not_allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(x=>x.address);
  if (!addresses.length || addresses.some(address => isForbiddenAddress(address, Boolean(options.allowPrivate)))) throw new Error('target_not_allowed');
  return { url, addresses };
}

function isForbiddenAddress(address: string, allowPrivate: boolean): boolean {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) return isForbiddenIpv4(normalized, allowPrivate);
  if (isIP(normalized) === 6) return isForbiddenIpv6(normalized);
  return true;
}

function isForbiddenIpv4(address: string, allowPrivate: boolean): boolean {
  const octets = address.split('.').map(part => Number(part));
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second] = octets;
  const privateOrLoopback =
    first === 10 ||
    first === 127 ||
    first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 168;
  return (
    first === 0 ||
    privateOrLoopback && !allowPrivate ||
    first === 100 && second >= 64 && second <= 127 ||
    first === 169 && second === 254 ||
    first === 192 && second === 0 && octets[2] === 0 ||
    first === 192 && second === 0 && octets[2] === 2 ||
    first === 198 && (second === 18 || second === 19) ||
    first === 198 && second === 51 && octets[2] === 100 ||
    first === 203 && second === 0 && octets[2] === 113 ||
    first >= 224
  );
}

function isForbiddenIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  if (!groups) return true;
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) return true;
  if (groups.every(group => group === 0)) return true;
  if (groups[0] < 0x2000 || groups[0] > 0x3fff) return true;
  return (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0 && groups[6] === 0 && groups[7] === 1 ||
    groups[0] === 0x2001 && groups[1] === 0xdb8 ||
    groups[0] === 0x2002
  );
}

function parseIpv6(address: string): number[] | null {
  if (address.includes('.')) return null;
  const sides = address.split('::');
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides[1] ? sides[1].split(':') : [];
  const missing = sides.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (sides.length === 1 && left.length !== 8)) return null;
  const parts = [...left, ...Array.from({length: missing}, () => '0'), ...right];
  if (parts.length !== 8) return null;
  const groups = parts.map(part => Number.parseInt(part, 16));
  return groups.every((group, index) => /^[0-9a-f]{1,4}$/i.test(parts[index]!) && group >= 0 && group <= 0xffff) ? groups : null;
}
