// Hardened fetch for the Node MCP server:
// - SSRF guard (assertSafeUrl blocks private ranges, metadata endpoints)
// - AbortController timeout (default 15s)
// - Response size cap (default 10MB) — abort if body exceeds
// - Follows redirects and returns the FINAL URL for absUrl base resolution
// - Strips UTF-8 BOM from response text
// - Basic content-type guard: only text/html, text/markdown, text/plain accepted
//
// KNOWN LIMITATION (v0.1): no charset detection for non-UTF-8 pages (Windows-1251
// docs will mojibake). Planned for v0.2 via `fetch-charset-detection`.

import { assertSafeUrl, SsrfBlockedError } from './ssrf-guard.js';

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
  assertSafeUrl(rawUrl);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const ua = opts.userAgent ?? DEFAULT_UA;
  const accept = opts.acceptContentTypes ?? DEFAULT_ACCEPT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(rawUrl, {
      signal: controller.signal,
      headers: {
        'user-agent': ua,
        accept: 'text/html,text/markdown,text/plain,application/xhtml+xml,*/*;q=0.5',
      },
      redirect: 'follow',
    });

    // After redirects — validate FINAL URL is still SSRF-safe (fetch may have
    // followed a redirect INTO a private range).
    const finalUrl = resp.url || rawUrl;
    if (finalUrl !== rawUrl) {
      try {
        assertSafeUrl(finalUrl);
      } catch (e) {
        throw new FetchProtectionError(
          `redirect landed on SSRF-blocked URL: ${(e as SsrfBlockedError).message}`,
          rawUrl,
        );
      }
    }

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
  } finally {
    clearTimeout(timer);
  }
};
