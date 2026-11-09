// Deployment policy for fetchProtected, for a server that fetches pages on behalf of other people
// (the hosted MCP endpoint). Everything here only RESTRICTS: no option or variable can make the SSRF
// guard allow an address or a scheme it refuses on its own.
//
// - Allowed ports: on the first URL and on every redirect hop, checked before DNS. A host that may
//   only reach the web (ports 80 and 443) cannot be used to probe other services on other ports.
// - Extra blocked addresses: single IPs or CIDR ranges refused like the built-in private ranges, on
//   IP literals and on every address a hostname resolves to, on every hop. For addresses the guard
//   cannot know, such as the public address of the server the fetcher runs on.
// - Abort signal: a caller can stop a fetch that is no longer wanted (its client went away). Code
//   between the caller and fetchProtected (an MCP tool handler) need not pass it along:
//   runWithFetchSignal() makes it reach every fetchProtected call made inside it.
//
// The two lists come from the call's options, else from the environment (PAGE2AI_ALLOWED_PORTS,
// PAGE2AI_EXTRA_BLOCKED_IPS, comma-separated), so a server can set them for code it does not call
// directly. A value that does not parse throws on every fetch: a typo must not leave a server open.

import { AsyncLocalStorage } from 'node:async_hooks';
import { BlockList, isIP } from 'node:net';
import { SsrfBlockedError } from './ssrf-guard.js';

export interface FetchPolicyOptions {
  /** Ports a request may go to (the URL's port, else 80 for http and 443 for https). Default: any, or PAGE2AI_ALLOWED_PORTS. */
  allowedPorts?: readonly number[];
  /** IPs or CIDR ranges refused besides the built-in private ranges. Default: none, or PAGE2AI_EXTRA_BLOCKED_IPS. */
  extraBlockedIps?: readonly string[];
}

export interface ResolvedFetchPolicy {
  ports: readonly number[] | null;
  blocked: BlockList | null;
}

const PORTS_ENV = 'PAGE2AI_ALLOWED_PORTS';
const IPS_ENV = 'PAGE2AI_EXTRA_BLOCKED_IPS';

const checkPort = (port: unknown, source: string): number => {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`${source}: ${String(port)} is not a port number (1-65535)`);
  }
  return port;
};

const parsePorts = (raw: string): number[] =>
  raw.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    if (!/^\d{1,5}$/.test(p)) throw new TypeError(`${PORTS_ENV}: "${p}" is not a port number (1-65535)`);
    return checkPort(Number(p), PORTS_ENV);
  });

const buildBlockList = (entries: readonly string[], source: string): BlockList | null => {
  const list = new BlockList();
  let count = 0;
  for (const raw of entries) {
    const entry = String(raw).trim();
    if (!entry) continue;
    const slash = entry.indexOf('/');
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const family = isIP(address);
    if (family === 0) throw new TypeError(`${source}: "${entry}" is not an IP address or a CIDR range`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (slash === -1) {
      list.addAddress(address, type);
    } else {
      const bits = entry.slice(slash + 1);
      if (!/^\d{1,3}$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128)) {
        throw new TypeError(`${source}: "${entry}" has no valid prefix length`);
      }
      list.addSubnet(address, Number(bits), type);
    }
    count++;
  }
  return count > 0 ? list : null;
};

// Read per call (cheap), so a server's environment and a test's both take effect at once.
export const resolveFetchPolicy = (opts: FetchPolicyOptions = {}): ResolvedFetchPolicy => {
  let ports: number[] | null = null;
  if (opts.allowedPorts) {
    ports = opts.allowedPorts.map((p) => checkPort(p, 'allowedPorts'));
    if (ports.length === 0) throw new TypeError('allowedPorts: empty list (leave it out to allow any port)');
  } else {
    const env = process.env[PORTS_ENV]?.trim();
    if (env) {
      ports = parsePorts(env);
      if (ports.length === 0) throw new TypeError(`${PORTS_ENV}: no port listed`);
    }
  }
  let blocked: BlockList | null = null;
  if (opts.extraBlockedIps) {
    blocked = buildBlockList(opts.extraBlockedIps, 'extraBlockedIps');
  } else {
    const env = process.env[IPS_ENV]?.trim();
    if (env) blocked = buildBlockList(env.split(','), IPS_ENV);
  }
  return { ports, blocked };
};

export const effectivePort = (url: URL): number =>
  url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

export const assertPortAllowed = (url: URL, policy: ResolvedFetchPolicy, rawUrl: string): void => {
  if (!policy.ports) return;
  const port = effectivePort(url);
  if (!policy.ports.includes(port)) {
    throw new SsrfBlockedError(`port ${port} is not allowed (allowed: ${policy.ports.join(', ')})`, rawUrl);
  }
};

// The wording names neither the list nor why an address is on it.
export const assertAddressAllowed = (
  address: string,
  host: string,
  policy: ResolvedFetchPolicy,
  rawUrl: string,
): void => {
  if (!policy.blocked) return;
  const family = isIP(address);
  if (family === 0) return;
  if (policy.blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
    throw new SsrfBlockedError(
      host === address
        ? `address ${address} is not allowed on this server`
        : `hostname "${host}" resolves to an address that is not allowed on this server`,
      rawUrl,
    );
  }
};

const fetchSignal = new AsyncLocalStorage<AbortSignal>();

/**
 * Runs `fn` so that every fetchProtected call made inside it, however deep, stops when `signal`
 * aborts (as if its own timeout had fired). A signal passed in a call's options wins.
 */
export const runWithFetchSignal = <T>(signal: AbortSignal, fn: () => T): T => fetchSignal.run(signal, fn);

export const currentFetchSignal = (): AbortSignal | undefined => fetchSignal.getStore();
