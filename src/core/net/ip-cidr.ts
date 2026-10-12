import { BlockList, isIP } from 'node:net';

export type IpFamily = 'ipv4' | 'ipv6';

export interface ParsedIpCidr {
  network: string;
  family: IpFamily;
  prefixLength?: number;
}

export function ipFamilyOf(address: string): IpFamily | null {
  const family = isIP(address);
  return family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : null;
}

/** Parse a bare IP or a strictly formed IPv4/IPv6 CIDR. */
export function parseIpCidr(cidr: string): ParsedIpCidr | null {
  if (cidr.length === 0 || cidr !== cidr.trim()) return null;
  const parts = cidr.split('/');
  if (parts.length < 1 || parts.length > 2) return null;
  const network = parts[0]!;
  const family = ipFamilyOf(network);
  if (!family) return null;
  if (parts.length === 1) return { network, family };

  const prefix = parts[1]!;
  if (!/^(?:0|[1-9]\d*)$/.test(prefix)) return null;
  const prefixLength = Number(prefix);
  const maxPrefix = family === 'ipv4' ? 32 : 128;
  if (!Number.isSafeInteger(prefixLength) || prefixLength > maxPrefix) return null;

  try {
    // Delegate address/prefix compatibility validation to Node's IP parser.
    new BlockList().addSubnet(network, prefixLength, family);
  } catch {
    return null;
  }
  return { network, family, prefixLength };
}

export function isValidIpCidr(cidr: string): boolean {
  return parseIpCidr(cidr) !== null;
}

export function ipMatchesCidr(address: string, cidr: string): boolean {
  const parsed = parseIpCidr(cidr);
  if (!parsed || ipFamilyOf(address) !== parsed.family) return false;

  try {
    const list = new BlockList();
    if (parsed.prefixLength === undefined) {
      list.addAddress(parsed.network, parsed.family);
    } else {
      list.addSubnet(parsed.network, parsed.prefixLength, parsed.family);
    }
    return list.check(address, parsed.family);
  } catch {
    return false;
  }
}
