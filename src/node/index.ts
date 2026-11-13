// @page2ai/core — Node.js entry point.
//
// Public API:
//   htmlToMarkdown(html, opts?)  — convert an HTML string to Markdown. It lives in convert.ts, which
//                                  is also published alone as '@page2ai/core/html' (no network code).
//   fetchAndConvert(url, opts?)  — SSRF-guarded fetch + convert
//
// What the conversion covers: the SCOPE note at the top of convert.ts.

import { htmlToMarkdown } from './convert.js';
import type { ConversionResult, HtmlToMarkdownOptions } from './convert.js';
import { FetchProtectionError, fetchProtected } from './fetch-protected.js';
import type { FetchPolicyOptions } from './fetch-policy.js';
import { assertSafeUrl } from './ssrf-guard.js';
import { CORE_VERSION } from '../shared/constants.js';

export interface FetchAndConvertOptions extends HtmlToMarkdownOptions, FetchPolicyOptions {
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  // Stops the fetch like its timeout does (fetch-policy.ts: also reaches it through runWithFetchSignal).
  signal?: AbortSignal;
}

// Wrap a raw markdown response in the frontmatter block so downstream consumers
// see the same shape as html-to-md output. `extractor_source` says that no
// conversion happened, because a caller measuring conversion quality needs to know.
const wrapMdWithFrontmatter = (raw: string, url: string, title: string): string => {
  const yq = (s: string): string => '"' + String(s).replace(/"/g, '\\"') + '"';
  const fm = [
    '---',
    `title: ${yq(title)}`,
    `source: ${yq(url)}`,
    `captured_at: ${yq(new Date().toISOString())}`,
    `extractor: ${yq('page2ai-core')}`,
    `extractor_version: ${yq(CORE_VERSION)}`,
    `extractor_source: ${yq('markdown-response')}`,
    '---',
    '',
  ];
  return fm.join('\n') + raw.replace(/^﻿/, '').trim() + '\n';
};

// The Markdown path honours includeFrontmatter and counts characters the way htmlToMarkdown
// does (the whole returned Markdown). Until 0.1.12 it always prepended the frontmatter and
// counted only the body, so `include_frontmatter: false` in the MCP server was ignored
// (T121 panel, codex).
const mdResponseMarkdown = (
  raw: string,
  url: string,
  title: string,
  opts: FetchAndConvertOptions,
): string =>
  (opts.includeFrontmatter ?? true)
    ? wrapMdWithFrontmatter(raw, url, title)
    : raw.replace(/^﻿/, '').trim() + '\n';

// A Markdown body must never reach the HTML parser. linkedom will happily accept
// it, find no <article> or <main>, and return an empty document, which reads as
// "extraction failed" when in fact the server handed over exactly what was asked
// for. See page2ai-benchmark RETRACTION-2026-07-25.md. Plain text fares no better: its line
// breaks collapse into one paragraph (T137: a README.md from raw.githubusercontent.com, served as
// text/plain, came out as one line with no heading and no code block, in 0.1.13 as well).
const MARKDOWN_CONTENT_TYPE = /^(text\/markdown|text\/x-markdown)/i;
const HTML_CONTENT_TYPE = /^(text\/html|application\/xhtml\+xml)/i;

// A path that names a Markdown file (.md, .markdown, .mdown, .mkd, .mdx) or a plain-text one (.txt,
// llms.txt among them). A browser shows such a file as its text whatever text type the server
// gives it: GitHub raw serves .md as text/plain, object stores often as application/octet-stream.
// That file is the page, so it is returned as is.
const TEXT_FILE_PATH = /\.(?:md|markdown|mdown|mkd|mdx|txt)$/i;
const TEXT_FILE_TYPES =
  /^(text\/html|application\/xhtml\+xml|text\/markdown|text\/x-markdown|text\/plain|application\/octet-stream|binary\/octet-stream)/i;

const pathOf = (u: string): string => {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
};

const looksLikeHtml = (s: string): boolean => /^\s*<(!doctype|html)\b/i.test(s);

export const fetchAndConvert = async (
  url: string,
  opts: FetchAndConvertOptions = {},
): Promise<ConversionResult> => {
  assertSafeUrl(url);
  // Only the URL the caller named is fetched: no `<url>.md` twin, no llms.txt, and the Accept
  // header is a browser's (BL-49, Igor 2026-10-17: such copies are often stale).
  const resp = await fetchProtected(url, {
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    userAgent: opts.userAgent,
    allowedPorts: opts.allowedPorts,
    extraBlockedIps: opts.extraBlockedIps,
    signal: opts.signal,
    acceptContentTypes: TEXT_FILE_PATH.test(pathOf(url)) ? TEXT_FILE_TYPES : undefined,
  });

  if (!HTML_CONTENT_TYPE.test(resp.contentType) && !looksLikeHtml(resp.text)) {
    // The URL names a Markdown or text file: that file is the page. Handing it to the HTML parser
    // would wreck it, so it is returned as is and labelled.
    if (TEXT_FILE_PATH.test(pathOf(resp.finalUrl))) {
      if (resp.text.includes('\u0000')) {
        throw new FetchProtectionError('the file is not text (its body holds a NUL byte)', resp.finalUrl);
      }
      const raw = resp.text.replace(/^﻿/, '').trim();
      const title = (raw.match(/^#\s+(.+)$/m)?.[1] || '').trim();
      const markdown = mdResponseMarkdown(raw, resp.finalUrl, title, opts);
      return {
        markdown,
        title,
        baseUrl: resp.finalUrl,
        charCount: markdown.length,
        extractedAt: new Date().toISOString(),
        source: 'markdown-response',
      };
    }
    // Markdown for a page address, although the request asked for HTML as a browser does: the
    // server picked a Markdown copy by something other than Accept (User-Agent, a cache). That copy
    // is what BL-49 removed, so it is refused, not returned as the page (T136 panel: spark13cont,
    // grokbuild and goog38flash each named this path).
    if (MARKDOWN_CONTENT_TYPE.test(resp.contentType)) {
      throw new FetchProtectionError(
        `the server answered with Markdown (${resp.contentType.split(';')[0]!.trim()}) for a page address ` +
          'although the request asked for HTML as a browser does; page2ai returns only the page, never a ' +
          'Markdown copy of it. If the address is a Markdown file, pass its .md URL',
        resp.finalUrl,
      );
    }
  }

  return htmlToMarkdown(resp.text, { ...opts, baseUrl: opts.baseUrl ?? resp.finalUrl });
};

// htmlToMarkdown and its types come from convert.ts, the network-free module behind '@page2ai/core/html'.
export { htmlToMarkdown } from './convert.js';
export type { ConversionResult, HtmlToMarkdownOptions } from './convert.js';
// Re-export public types + errors for consumers (MCP server catches these).
export type { ProfileName } from '../shared/types.js';
export { LinkedomAdapter } from './linkedom-adapter.js';
// assertSafeUrlResolved is the exact check fetchAndConvert runs on the URL and on every redirect
// hop, so a caller can learn before fetching whether a URL will be refused; findIpBlockReason is
// its address rule. Both sat in the published .d.ts without being importable (P2A-009).
export { SsrfBlockedError, assertSafeUrl, assertSafeUrlResolved, findIpBlockReason } from './ssrf-guard.js';
export { DEFAULT_UA, FetchProtectionError, fetchProtected, getProxyForUrl, _resetHostThrottle } from './fetch-protected.js';
export { runWithFetchSignal, resolveFetchPolicy, effectivePort } from './fetch-policy.js';
export type { FetchPolicyOptions } from './fetch-policy.js';
