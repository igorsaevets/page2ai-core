// SSRF guard for the Node MCP server: block outbound requests to loopback,
// private ranges, cloud metadata endpoints, and dangerous schemes. Callers
// invoke assertSafeUrl(url) before fetching; it throws on any block hit.
//
// KNOWN LIMITATION (v0.1): only IP-literal hosts are checked. DNS-rebinding
// attacks (hostname resolves to 127.0.0.1) require a resolve+revalidate step;
// planned for v0.2 via `dns.lookup`. Document in README.

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
  '::ffff:',  // IPv4-mapped
  'fe80:',    // link-local
  'fc',       // unique local (fc00::/7)
  'fd',       // unique local
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.',
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

const isIpv6Literal = (host: string): boolean =>
  /^\[?[0-9a-fA-F:]+\]?$/.test(host) && host.includes(':');

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
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new SsrfBlockedError(`hostname "${host}" blocked`, rawUrl);
  }
  if (isIpv4Literal(host)) {
    for (const p of PRIVATE_IPV4_PATTERNS) {
      if (p.test(host)) {
        throw new SsrfBlockedError(`IPv4 "${host}" in private range`, rawUrl);
      }
    }
  } else if (isIpv6Literal(host)) {
    for (const prefix of BLOCKED_IPV6_PREFIXES) {
      if (host.startsWith(prefix)) {
        throw new SsrfBlockedError(`IPv6 "${host}" in blocked range`, rawUrl);
      }
    }
  }
  return parsed;
};
