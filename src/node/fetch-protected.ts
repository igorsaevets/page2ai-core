// Hardened fetch for the Node MCP server:
// - SSRF guard with DNS resolution + pinning: every hop is checked (string +
//   DNS), and the connection is pinned to the validated addresses via an undici
//   Agent so a DNS rebinding between the check and the connect cannot reach
//   an internal address
// - Redirects followed MANUALLY (redirect: 'manual', max 10 hops) so an
//   internal target is rejected before the request is made, not after
// - AbortController timeout (default 15s, covers the whole redirect chain)
// - Response size cap (default 10MB) — abort if body exceeds
// - Strips UTF-8 BOM from response text
// - Basic content-type guard: text/html, application/xhtml+xml, text/markdown, text/x-markdown
//   and text/plain by default; a caller may widen it (fetchAndConvert does for a URL that names
//   a text file)
// - The Accept header is the one Firefox sends when it navigates to a page (BROWSER_ACCEPT), so a
//   docs platform that negotiates (Fumadocs, Mintlify, Vercel, Supabase, Stripe, the Claude docs)
//   answers with the page a person sees, not with its own Markdown copy, which can be older than
//   the page (BL-49). It contains neither `markdown` nor `text/plain`, because servers match those
//   words in the header and ignore its q-values (T137, measured 2026-10-17: `text/html,
//   text/markdown;q=0` still got Markdown from platform.claude.com; `text/html,text/plain` got it
//   from fumadocs.dev). A URL that is itself a Markdown or text file is still served, through `*/*`.
//
// - Proxy support: honours HTTPS_PROXY / HTTP_PROXY / NO_PROXY env vars. When a
//   proxy is configured for the target URL, the request goes through an undici
//   ProxyAgent. DNS pinning is impossible through a proxy (the proxy resolves
//   the target hostname), so the SSRF DNS check becomes advisory: it still
//   catches hostnames that resolve to private IPs, but the proxy may re-resolve
//   to a different address. The proxy itself is trusted infrastructure — its URL
//   is NOT subject to the SSRF guard. When NO_PROXY matches the target, the
//   direct DNS-pinned path is used as before.
//
// - TLS: the cipher list of Mozilla's "intermediate" configuration (TLS_CIPHERS), not Node's
//   default one; a server that speaks none of it gets one retry with Node's defaults.
//
// KNOWN LIMITATION: no charset detection for non-UTF-8 pages (Windows-1251 docs will
// mojibake); a later release may add it via `fetch-charset-detection`.

import { Agent, ProxyAgent } from 'undici';
import {
  assertSafeUrl,
  resolveAndValidate,
  SsrfBlockedError,
} from './ssrf-guard.js';
import {
  assertAddressAllowed,
  assertPortAllowed,
  currentFetchSignal,
  resolveFetchPolicy,
  type FetchPolicyOptions,
} from './fetch-policy.js';
import { CORE_VERSION } from '../shared/constants.js';

export interface FetchProtectedOptions extends FetchPolicyOptions {
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  acceptContentTypes?: RegExp;
  /** Stops the fetch like its timeout does. Default: the signal of an enclosing runWithFetchSignal(). */
  signal?: AbortSignal;
}

export interface FetchProtectedResult {
  text: string;
  finalUrl: string;
  contentType: string;
  bytesRead: number;
  statusCode: number;
}

export const DEFAULT_UA = `page2ai-core/${CORE_VERSION} (+https://github.com/igorsaevets/page2ai-core)`;
const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;  // 10 MB
const DEFAULT_ACCEPT = /^(text\/html|text\/markdown|text\/x-markdown|text\/plain|application\/xhtml\+xml)/i;
// Firefox 132 and later, top-level navigation (MDN, "List of default Accept values", read 2026-10-17:
// https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Content_negotiation/List_of_default_Accept_values).
// A server that answered this header with Markdown would answer every Firefox user with it.
export const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const MAX_REDIRECTS = 10;

// TLS cipher list for every outgoing connection: Mozilla's "intermediate" configuration, guidelines 6.0
// (https://ssl-config.mozilla.org/guidelines/6.0.json, read 2026-11-12): the three TLS 1.3 suites, then the six
// TLS 1.2 suites with ECDHE and AEAD (GCM, ChaCha20). Node's default list (24 entries on Node 24) also offers CBC
// and DHE suites, and Cloudflare's bot checks challenge that handshake whatever the User-Agent says. Measured
// 2026-11-12 from one PC with this module's own User-Agent: npmjs.com, openai.com and medium.com answered 403
// `cf-mitigated: challenge` to Node's default list and 200 with the page to this one, as they did to curl. The
// User-Agent does not change: a site still sees page2ai by name and can refuse it by name.
export const TLS_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
].join(':');

// 'mozilla' = TLS_CIPHERS; 'node-default' = whatever Node offers, used once for a server that refused the first.
export type TlsProfile = 'mozilla' | 'node-default';
const tlsOptionsFor = (profile: TlsProfile): { ciphers?: string } =>
  profile === 'mozilla' ? { ciphers: TLS_CIPHERS } : {};

// The handshake failed on the protocol or the cipher list: the server sent a handshake_failure,
// protocol_version or insufficient_security alert, or nothing on offer matched. OpenSSL 3.0 (Node 20, 22)
// names the first alert `ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE`, OpenSSL 3.5 (Node 24)
// `ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE` (measured 2026-11-12). Certificate errors (CERT_HAS_EXPIRED,
// ERR_TLS_CERT_ALTNAME_INVALID, ...) do not match: another cipher list cannot fix them.
const TLS_NEGOTIATION_CODE =
  /^ERR_SSL_(?:(?:SSLV3|SSL\/TLS|TLSV1)_ALERT_(?:HANDSHAKE_FAILURE|PROTOCOL_VERSION|INSUFFICIENT_SECURITY)|NO_SHARED_CIPHER|NO_CIPHERS_AVAILABLE|NO_SUITABLE_SIGNATURE_ALGORITHM)$/;
export const isTlsNegotiationFailure = (err: unknown): boolean => {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && TLS_NEGOTIATION_CODE.test(code)) return true;
  }
  return false;
};

export class FetchProtectionError extends Error {
  constructor(reason: string, public readonly url: string) {
    super(`fetch-protected: ${reason} (url: ${url})`);
    this.name = 'FetchProtectionError';
  }
}

const stripBom = (s: string): string => s.replace(/^﻿/, '');

const normalizeHost = (hostname: string): string => {
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.length > 1 && h.endsWith('.')) h = h.slice(0, -1);
  return h;
};

const isIpv4Literal = (host: string): boolean =>
  /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

// Read HTTPS_PROXY / HTTP_PROXY / NO_PROXY from env and return the proxy URL
// for this target, or null when the request should go direct.
// Lowercase env vars take precedence (curl, wget, Node convention).
export const getProxyForUrl = (target: URL): string | null => {
  const noProxy = process.env.no_proxy || process.env.NO_PROXY || '';
  if (noProxy === '*') return null;

  const hostname = normalizeHost(target.hostname);
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');

  for (const entry of noProxy.split(',')) {
    const raw = entry.trim().toLowerCase();
    if (!raw) continue;
    const [patternHost, patternPort] = raw.split(':');
    if (patternPort && patternPort !== port) continue;
    if (!patternHost) continue;
    if (hostname === patternHost) return null;
    const dotted = patternHost.startsWith('.') ? patternHost : '.' + patternHost;
    if (hostname.endsWith(dotted)) return null;
  }

  const proxy =
    target.protocol === 'https:'
      ? process.env.https_proxy || process.env.HTTPS_PROXY
      : process.env.http_proxy || process.env.HTTP_PROXY;

  return proxy || null;
};

const createPinnedAgent = (
  addrs: { address: string; family: number }[],
  profile: TlsProfile,
): Agent =>
  new Agent({
    connect: {
      ...tlsOptionsFor(profile),
      lookup: (
        _hostname: string,
        options: { all?: boolean },
        callback: Function,
      ) => {
        if (options.all) {
          callback(null, addrs);
        } else {
          callback(null, addrs[0].address, addrs[0].family);
        }
      },
    },
  });

/** Test-only: the dispatcher a hostname's hop uses without a proxy. */
export const _createPinnedAgent = createPinnedAgent;

// Per-host rate limiting: prevents a looping agent from hammering one site.
// The Map survives across tool calls because the MCP server is a long-running
// process. Redirect hops within one fetchProtected call are not throttled
// against each other — only the entry-point host is rate-limited.
const hostLastFetch = new Map<string, number>();
const HOST_MIN_INTERVAL_MS = 1000;
const HOST_MAP_CAP = 200;

export const _waitForHost = async (host: string): Promise<void> => {
  const now = Date.now();
  const last = hostLastFetch.get(host);
  if (last !== undefined) {
    const elapsed = now - last;
    if (elapsed < HOST_MIN_INTERVAL_MS) {
      const delay = HOST_MIN_INTERVAL_MS - elapsed + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  hostLastFetch.set(host, Date.now());
  if (hostLastFetch.size > HOST_MAP_CAP) {
    const oldest = [...hostLastFetch.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, hostLastFetch.size - HOST_MAP_CAP);
    for (const [k] of oldest) hostLastFetch.delete(k);
  }
};

export const _resetHostThrottle = (): void => { hostLastFetch.clear(); };

export const fetchProtected = async (
  rawUrl: string,
  opts: FetchProtectedOptions = {},
): Promise<FetchProtectedResult> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const ua = opts.userAgent ?? DEFAULT_UA;
  const accept = opts.acceptContentTypes ?? DEFAULT_ACCEPT;
  // Before any wait or request: a policy that does not parse fails the call (fetch-policy.ts).
  const policy = resolveFetchPolicy(opts);

  // Rate-limit by the initial request's host (redirect hops are not throttled).
  const entryHost = normalizeHost(new URL(rawUrl).hostname);
  await _waitForHost(entryHost);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // A caller's signal ends the fetch the way the timeout does (an AbortError).
  const outer = opts.signal ?? currentFetchSignal();
  const onOuterAbort = (): void => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    // Follow redirects by hand: validate every hop (string checks + DNS)
    // BEFORE connecting to it, AND pin the connection to the validated IPs
    // so a DNS rebinding between our check and the connect cannot redirect
    // the socket to an internal address.
    let currentUrl = rawUrl;
    let resp: Response;
    let hops = 0;
    for (;;) {
      const parsed = assertSafeUrl(currentUrl);
      assertPortAllowed(parsed, policy, currentUrl);
      const host = normalizeHost(parsed.hostname);
      const proxyUrl = getProxyForUrl(parsed);
      let addrs: { address: string; family: number }[] | null = null;

      if (isIpv4Literal(host) || host.includes(':')) {
        assertAddressAllowed(host, host, policy, currentUrl);
      } else {
        addrs = await resolveAndValidate(host, currentUrl);
        for (const { address } of addrs) assertAddressAllowed(address, host, policy, currentUrl);
      }
      // Through a proxy the proxy resolves the target (see the header); otherwise the socket is pinned
      // to the validated addresses. An IP literal needs no pinning, only the TLS options.
      const makeDispatcher = (profile: TlsProfile): Agent | ProxyAgent => {
        if (proxyUrl) return new ProxyAgent({ uri: proxyUrl, requestTls: tlsOptionsFor(profile) });
        if (addrs) return createPinnedAgent(addrs, profile);
        return new Agent({ connect: tlsOptionsFor(profile) });
      };
      const send = async (profile: TlsProfile): Promise<Response> => {
        const dispatcher = makeDispatcher(profile);
        try {
          return await fetch(currentUrl, {
            signal: controller.signal,
            headers: {
              'user-agent': ua,
              accept: BROWSER_ACCEPT,
            },
            redirect: 'manual',
            dispatcher,
          } as RequestInit);
        } finally {
          dispatcher.close().catch(() => {});
        }
      };

      try {
        resp = await send('mozilla');
      } catch (err) {
        // A server that speaks none of TLS_CIPHERS (TLS 1.2 with CBC suites only) refuses the
        // handshake before any HTTP is sent: the same hop once more with Node's default list.
        if (controller.signal.aborted || !isTlsNegotiationFailure(err)) throw err;
        resp = await send('node-default');
      }

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) {
          throw new FetchProtectionError(
            `HTTP ${resp.status} redirect without a Location header`,
            rawUrl,
          );
        }
        try { await resp.body?.cancel(); } catch { /* best effort */ }
        hops++;
        if (hops > MAX_REDIRECTS) {
          throw new FetchProtectionError(`more than ${MAX_REDIRECTS} redirects`, rawUrl);
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          throw new FetchProtectionError(`unparseable redirect Location "${location}"`, rawUrl);
        }
        currentUrl = nextUrl;
        continue;
      }
      break;
    }

    const finalUrl = currentUrl;
    const contentType = resp.headers.get('content-type') || '';
    if (!resp.ok) {
      throw new FetchProtectionError(
        `HTTP ${resp.status} ${resp.statusText}, content-type=${contentType}`,
        rawUrl,
      );
    }
    if (!accept.test(contentType)) {
      throw new FetchProtectionError(
        `content-type "${contentType}" not in accepted set`,
        rawUrl,
      );
    }

    // Read with size cap. reader.read() returns Uint8Array chunks; abort if
    // cumulative bytes exceed maxBytes to prevent OOM on malicious 100MB pages.
    const reader = resp.body?.getReader();
    if (!reader) {
      throw new FetchProtectionError('response body is null', rawUrl);
    }
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new FetchProtectionError(
          `response body exceeds ${maxBytes} bytes cap`,
          rawUrl,
        );
      }
      chunks.push(value);
    }

    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
    const text = stripBom(buf.toString('utf-8'));

    return { text, finalUrl, contentType, bytesRead, statusCode: resp.status };
  } catch (e) {
    // Keep the SSRF reason visible to callers when a redirect hop was blocked.
    if (e instanceof SsrfBlockedError) {
      throw new FetchProtectionError(`blocked by SSRF guard: ${e.message}`, rawUrl);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
};
