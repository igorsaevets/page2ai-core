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
// DNS pinning (BL-22): fetchProtected now creates an undici Agent with a
// connect.lookup that returns only the addresses we validated, so the runtime
// cannot re-resolve to a different (internal) address between our check and
// the connect.

import { lookup } from 'node:dns/promises';

const BLOCKED_IPV4_PATTERNS: RegExp[] = [
  /^127\./,                             // 127.0.0.0/8 loopback
  /^10\./,                              // 10.0.0.0/8 private
  /^169\.254\./,                        // 169.254.0.0/16 link-local (AWS/GCP metadata)
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,     // 172.16.0.0/12 private
  /^192\.168\./,                        // 192.168.0.0/16 private
  /^0\./,                               // 0.0.0.0/8 current network
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,  // 100.64.0.0/10 CGNAT
  /^(22[4-9]|23\d)\./,                  // 224.0.0.0/4 multicast
  /^(24\d|25[0-5])\./,                  // 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  /^192\.0\.[02]\./,                    // 192.0.0.0/24 IETF Protocol Assignments + 192.0.2.0/24 TEST-NET-1
  /^192\.88\.99\./,                     // 192.88.99.0/24 deprecated 6to4 relay anycast (RFC 7526)
  /^198\.51\.100\./,                    // 198.51.100.0/24 TEST-NET-2
  /^203\.0\.113\./,                     // 203.0.113.0/24 TEST-NET-3
  /^198\.1[89]\./,                      // 198.18.0.0/15 benchmarking
];

const BLOCKED_IPV6_PREFIXES: string[] = [
  '::1',      // loopback
  '::ffff:',  // IPv4-mapped (blanket: blocks the whole mapped form)
  // link-local is fe80::/10, i.e. fe80 through febf (T109: only `fe80:` was blocked, fe90::1 passed).
  // A shorter address such as fe9::1 is 0fe9::1, IETF-reserved and unroutable, so over-blocking it is harmless.
  'fe8', 'fe9', 'fea', 'feb',
  'fc',       // unique local (fc00::/7)
  'fd',       // unique local
  '64:ff9b:', // NAT64 well-known (RFC 6146) + local-use (RFC 8215) — embeds IPv4
  '2002:',    // 6to4 (RFC 3056) — embeds IPv4 in bits 16-47
  '2001:db8:',// documentation (RFC 3849)
  '100:',     // discard-only (RFC 6666); rest of 0100::/16 is unassigned
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
    // Teredo 2001::/32 — two canonical forms: 2001::x (all-zero groups compressed)
    // and 2001:0:x (group 1 explicit zero). Must not match 2001:db8: (documentation,
    // already caught) or 2001:4860: (Google DNS, legitimate).
    if (a.startsWith('2001::') || a.startsWith('2001:0:')) {
      return 'IPv6 in blocked range (Teredo 2001::/32)';
    }
    return null;
  }
  if (isIpv4Literal(a)) {
    for (const p of BLOCKED_IPV4_PATTERNS) {
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

// Resolve a hostname via DNS, check every returned address, return them.
// Exported so fetchProtected can pin the connection to these addresses.
export const resolveAndValidate = async (
  hostname: string,
  rawUrl: string,
): Promise<{ address: string; family: number }[]> => {
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError(`DNS resolution failed for "${hostname}"`, rawUrl);
  }
  if (!addrs || addrs.length === 0) {
    throw new SsrfBlockedError(`DNS returned no addresses for "${hostname}"`, rawUrl);
  }
  for (const { address } of addrs) {
    const reason = findIpBlockReason(address);
    if (reason) {
      throw new SsrfBlockedError(
        `hostname "${hostname}" resolves to blocked address ${address} (${reason})`,
        rawUrl,
      );
    }
  }
  return addrs;
};

// String checks plus DNS: resolve the hostname and run every returned address
// through the same IP rules. Fail closed on resolution errors.
export const assertSafeUrlResolved = async (rawUrl: string): Promise<URL> => {
  const parsed = assertSafeUrl(rawUrl);
  const host = normalizeHost(parsed.hostname);
  if (isIpv4Literal(host) || host.includes(':')) {
    return parsed;
  }
  await resolveAndValidate(host, rawUrl);
  return parsed;
};
