// SSRF guard for the Node MCP server: block outbound requests to loopback,
// private ranges, cloud metadata endpoints, and dangerous schemes.
//
// Two layers:
//   assertSafeUrl(url)          - synchronous string-level checks: scheme,
//                                 blocked hostnames (trailing dot stripped),
//                                 IP-literal ranges.
//   assertSafeUrlResolved(url)  - assertSafeUrl + DNS resolution: EVERY address
//                                 the hostname resolves to must pass the IP
//                                 checks. Closes the v0.1 gap where a public
//                                 name resolving to 127.0.0.1 / 169.254.169.254
//                                 sailed through the string-only check.
//
// REMAINING LIMITATION: the check-then-connect window. fetch() re-resolves the
// name itself, so a DNS record that flips between our lookup and the connect
// (fast-flux rebinding) can still reach an internal address. Closing that needs
// a pinned-IP dispatcher, which needs undici as a runtime dependency; declined
// for now to keep the dependency surface at linkedom + css.escape. Stated in
// SECURITY.md so the promise matches the code.

import { lookup } from 'node:dns/promises';

const PRIVATE_IPV4_PATTERNS: RegExp[] = [
  /^127\./,                             // 127.0.0.0/8 loopback
  /^10\./,                              // 10.0.0.0/8 private
  /^169\.254\./,                        // 169.254.0.0/16 link-local (AWS/GCP metadata)
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,     // 172.16.0.0/12 private
  /^192\.168\./,                        // 192.168.0.0/16 private
  /^0\./,                               // 0.0.0.0/8 current network
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,  // 100.64/10 CGNAT
];

const BLOCKED_IPV6_PREFIXES: string[] = [
  '::1',      // loopback
  '::ffff:',  // IPv4-mapped (blanket: blocks the whole mapped form)
  'fe80:',    // link-local
  'fc',       // unique local (fc00::/7)
  'fd',       // unique local
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  'metadata.google.internal',
  'metadata',
]);

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export class SsrfBlockedError extends Error {
  constructor(reason: string, public readonly url: string) {
    super(`SSRF guard blocked ${url}: ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

const isIpv4Literal = (host: string): boolean =>
  /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

// A fully-qualified name may carry a trailing dot ("metadata.google.internal.")
// and still resolve to the same host; strip it so the blocklist cannot be
// stepped around with one character.
const normalizeHost = (hostname: string): string => {
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.length > 1 && h.endsWith('.')) h = h.slice(0, -1);
  return h;
};

// Pure address check, shared by the literal path and the DNS path.
// Returns a human-readable reason when the address is blocked, else null.
export const findIpBlockReason = (addr: string): string | null => {
  const a = addr.toLowerCase();
  if (a.includes(':')) {
    if (a === '::' || a === '::1') return 'IPv6 loopback/unspecified';
    for (const prefix of BLOCKED_IPV6_PREFIXES) {
      if (a.startsWith(prefix)) return `IPv6 in blocked range (${prefix})`;
    }
    return null;
  }
  if (isIpv4Literal(a)) {
    for (const p of PRIVATE_IPV4_PATTERNS) {
      if (p.test(a)) return 'IPv4 in private range';
    }
  }
  return null;
};

export const assertSafeUrl = (rawUrl: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('malformed URL', rawUrl);
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new SsrfBlockedError(`scheme "${parsed.protocol}" not in {http:, https:}`, rawUrl);
  }
  const host = normalizeHost(parsed.hostname);
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new SsrfBlockedError(`hostname "${host}" blocked`, rawUrl);
  }
  const reason = findIpBlockReason(host);
  if (reason) {
    throw new SsrfBlockedError(`${reason}: "${host}"`, rawUrl);
  }
  return parsed;
};

// String checks plus DNS: resolve the hostname and run every returned address
// through the same IP rules. Fail closed on resolution errors.
export const assertSafeUrlResolved = async (rawUrl: string): Promise<URL> => {
  const parsed = assertSafeUrl(rawUrl);
  const host = normalizeHost(parsed.hostname);
  if (isIpv4Literal(host) || host.includes(':')) {
    return parsed; // IP literal: already fully checked above.
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError(`DNS resolution failed for "${host}"`, rawUrl);
  }
  if (!addrs || addrs.length === 0) {
    throw new SsrfBlockedError(`DNS returned no addresses for "${host}"`, rawUrl);
  }
  for (const { address } of addrs) {
    const reason = findIpBlockReason(address);
    if (reason) {
      throw new SsrfBlockedError(
        `hostname "${host}" resolves to blocked address ${address} (${reason})`,
        rawUrl,
      );
    }
  }
  return parsed;
};
