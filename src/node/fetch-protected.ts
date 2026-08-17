// Hardened fetch for the Node MCP server:
// - SSRF guard with DNS resolution (assertSafeUrlResolved) run on the initial
//   URL AND on every redirect hop, before that hop is followed
// - Redirects followed MANUALLY (redirect: 'manual', max 10 hops) so an
//   internal target is rejected before the request is made, not after
// - AbortController timeout (default 15s, covers the whole redirect chain)
// - Response size cap (default 10MB) — abort if body exceeds
// - Strips UTF-8 BOM from response text
// - Basic content-type guard: only text/html, text/markdown, text/plain accepted
//
// KNOWN LIMITATION (v0.1): no charset detection for non-UTF-8 pages (Windows-1251
// docs will mojibake). Planned for v0.2 via `fetch-charset-detection`.

import { assertSafeUrlResolved, SsrfBlockedError } from './ssrf-guard.js';

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
const DEFAULT_ACCEPT = /^(text\/html|text\/markdown|text\/plain|application\/xhtml\+xml)/i;
const MAX_REDIRECTS = 10;

export class FetchProtectionError extends Error {
  constructor(reason: string, public readonly url: string) {
    super(`fetch-protected: ${reason} (url: ${url})`);
    this.name = 'FetchProtectionError';
  }
}

const stripBom = (s: string): string => s.replace(/^﻿/, '');

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
    // BEFORE connecting to it. With redirect:'follow' the runtime would have
    // already delivered the request to an internal host by the time any
    // post-hoc check could run.
    let currentUrl = rawUrl;
    let resp: Response;
    let hops = 0;
    for (;;) {
      await assertSafeUrlResolved(currentUrl);
      resp = await fetch(currentUrl, {
        signal: controller.signal,
        headers: {
          'user-agent': ua,
          accept: 'text/html,text/markdown,text/plain,application/xhtml+xml,*/*;q=0.5',
        },
        redirect: 'manual',
      });

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
