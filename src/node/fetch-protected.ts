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
// KNOWN LIMITATION: no charset detection for non-UTF-8 pages (Windows-1251 docs will
// mojibake); a later release may add it via `fetch-charset-detection`.

import { Agent } from 'undici';
import {
  assertSafeUrl,
  resolveAndValidate,
  SsrfBlockedError,
} from './ssrf-guard.js';

export interface FetchProtectedOptions {
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  acceptContentTypes?: RegExp;
}

export interface FetchProtectedResult {
  text: string;
  finalUrl: string;
  contentType: string;
  bytesRead: number;
  statusCode: number;
}

const DEFAULT_UA = 'page2ai-core/0.1 (+https://github.com/igorsaevets/page2ai-core)';
const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;  // 10 MB
const DEFAULT_ACCEPT = /^(text\/html|text\/markdown|text\/x-markdown|text\/plain|application\/xhtml\+xml)/i;
// Firefox 132 and later, top-level navigation (MDN, "List of default Accept values", read 2026-10-17:
// https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Content_negotiation/List_of_default_Accept_values).
// A server that answered this header with Markdown would answer every Firefox user with it.
export const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const MAX_REDIRECTS = 10;

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

const createPinnedAgent = (
  addrs: { address: string; family: number }[],
): Agent =>
  new Agent({
    connect: {
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

export const fetchProtected = async (
  rawUrl: string,
  opts: FetchProtectedOptions = {},
): Promise<FetchProtectedResult> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const ua = opts.userAgent ?? DEFAULT_UA;
  const accept = opts.acceptContentTypes ?? DEFAULT_ACCEPT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
      const host = normalizeHost(parsed.hostname);
      let agent: Agent | undefined;
      if (!isIpv4Literal(host) && !host.includes(':')) {
        const addrs = await resolveAndValidate(host, currentUrl);
        agent = createPinnedAgent(addrs);
      }
      try {
        resp = await fetch(currentUrl, {
          signal: controller.signal,
          headers: {
            'user-agent': ua,
            accept: BROWSER_ACCEPT,
          },
          redirect: 'manual',
          ...(agent ? { dispatcher: agent } as Record<string, unknown> : {}),
        } as RequestInit);
      } finally {
        if (agent) {
          agent.close().catch(() => {});
        }
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
  }
};
