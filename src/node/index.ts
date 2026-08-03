// @page2ai/core — Node.js entry point.
//
// Public API:
//   htmlToMarkdown(html, opts?)  — convert an HTML string to Markdown
//   fetchAndConvert(url, opts?)  — SSRF-guarded fetch + convert
//
// v0.1 SCOPE: basic renderer only (headings, paragraphs, lists, links, images,
// code blocks, tables, frontmatter, blockquotes, inline formatting) + STATIC
// tab discovery (aria-controls / role=tablist) that emits '## Tab: {label}'
// sections instead of concatenating panels. No interactive tab-click, no
// lazy-load, no <details> auto-expand. For the full pipeline see the browser build.
//
// v0.2 will port the full lib/core/html-to-md.ts renderer via PageAdapter.

import { parseHTML } from 'linkedom';
import { LinkedomAdapter } from './linkedom-adapter.js';
import { renderBasicMarkdown } from './basic-renderer.js';
import { fetchProtected } from './fetch-protected.js';
import { assertSafeUrl } from './ssrf-guard.js';
import { CORE_VERSION } from '../shared/constants.js';
import type { ProfileName } from '../shared/types.js';

export interface HtmlToMarkdownOptions {
  baseUrl?: string;
  profile?: ProfileName | 'auto';
  includeFrontmatter?: boolean;
  includeImages?: boolean;
}

export interface FetchAndConvertOptions extends HtmlToMarkdownOptions {
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  tryMdSuffixFirst?: boolean;   // Mintlify/etc. convention: URL.md returns clean md
}

export interface ConversionResult {
  markdown: string;
  title: string;
  baseUrl: string;
  charCount: number;
  extractedAt: string;
  source: 'html-parse' | 'md-suffix' | 'content-negotiation' | 'llms-txt';
}

export const htmlToMarkdown = (
  html: string,
  opts: HtmlToMarkdownOptions = {},
): ConversionResult => {
  const injectedBase = opts.baseUrl ?? 'about:blank';
  try {
    const { document } = parseHTML(html);
    const adapter = new LinkedomAdapter(document as unknown as Document, injectedBase);
    const title = (document.querySelector('title')?.textContent || '').trim();
    const markdown = renderBasicMarkdown(document as unknown as Document, adapter, {
      baseUrl: adapter.baseUrl(),
      includeFrontmatter: opts.includeFrontmatter ?? true,
      includeImages: opts.includeImages ?? true,
    });
    return {
      markdown,
      title,
      baseUrl: adapter.baseUrl(),
      charCount: markdown.length,
      extractedAt: new Date().toISOString(),
      source: 'html-parse',
    };
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const fallback = [
      '---',
      `title: "Page2AI extraction failed"`,
      `source: "${injectedBase}"`,
      `captured_at: "${new Date().toISOString()}"`,
      `extractor: "page2ai-core"`,
      `extractor_version: "${CORE_VERSION}"`,
      `error: "${errMsg.replace(/"/g, '\\"')}"`,
      '---',
      '',
      '# Page2AI extraction failed',
      '',
      `Could not parse HTML from ${injectedBase}.`,
      '',
      `Error: ${errMsg}`,
      '',
    ].join('\n');
    return {
      markdown: fallback,
      title: 'Page2AI extraction failed',
      baseUrl: injectedBase,
      charCount: fallback.length,
      extractedAt: new Date().toISOString(),
      source: 'html-parse',
    };
  }
};

// Wrap a raw markdown response in the frontmatter block so downstream consumers
// see the same shape as html-to-md output. `via` records which channel produced
// it, because a caller measuring conversion quality needs to know that no
// conversion happened.
const wrapMdWithFrontmatter = (
  raw: string,
  url: string,
  title: string,
  via: 'md-suffix' | 'content-negotiation',
): string => {
  const yq = (s: string): string => '"' + String(s).replace(/"/g, '\\"') + '"';
  const fm = [
    '---',
    `title: ${yq(title)}`,
    `source: ${yq(url)}`,
    `captured_at: ${yq(new Date().toISOString())}`,
    `extractor: ${yq('page2ai-core')}`,
    `extractor_version: ${yq(CORE_VERSION)}`,
    `extractor_source: ${yq(via)}`,
    '---',
    '',
  ];
  return fm.join('\n') + raw.replace(/^﻿/, '').trim() + '\n';
};

// A Markdown body must never reach the HTML parser. linkedom will happily accept
// it, find no <article> or <main>, and return an empty document, which reads as
// "extraction failed" when in fact the server handed over exactly what was asked
// for. See page2ai-benchmark RETRACTION-2026-07-25.md.
const MARKDOWN_CONTENT_TYPE = /^(text\/markdown|text\/x-markdown)/i;

const looksLikeHtml = (s: string): boolean => /^\s*<(!doctype|html)\b/i.test(s);

// Attempt the URL.md convention (Mintlify, Anthropic docs, some others).
// Returns null if not applicable or on any failure — callers fall back to HTML.
const tryMdSuffix = async (
  originalUrl: string,
  opts: FetchAndConvertOptions,
): Promise<ConversionResult | null> => {
  const url = originalUrl.replace(/[#?].*$/, '');
  if (url.endsWith('.md') || url.endsWith('.txt')) return null;
  const candidate = url.endsWith('/') ? `${url}index.md` : `${url}.md`;
  try {
    const resp = await fetchProtected(candidate, {
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes ?? 500 * 1024,   // markdown pages should be small
      userAgent: opts.userAgent,
      acceptContentTypes: /^(text\/markdown|text\/plain|application\/octet-stream)/i,
    });
    if (!resp.text || resp.text.length < 32) return null;
    // Cheap sanity: markdown response should not look like HTML
    if (looksLikeHtml(resp.text)) return null;
    const title = (resp.text.match(/^#\s+(.+)$/m)?.[1] || '').trim();
    return {
      markdown: wrapMdWithFrontmatter(resp.text, resp.finalUrl, title, 'md-suffix'),
      title,
      baseUrl: resp.finalUrl,
      charCount: resp.text.length,
      extractedAt: new Date().toISOString(),
      source: 'md-suffix',
    };
  } catch {
    return null;
  }
};

export const fetchAndConvert = async (
  url: string,
  opts: FetchAndConvertOptions = {},
): Promise<ConversionResult> => {
  assertSafeUrl(url);
  const tryMd = opts.tryMdSuffixFirst ?? true;
  if (tryMd) {
    const mdResult = await tryMdSuffix(url, opts);
    if (mdResult) return mdResult;
  }
  const resp = await fetchProtected(url, {
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    userAgent: opts.userAgent,
  });

  // The Accept header above lists text/markdown, and a growing number of
  // documentation platforms honour it: Fumadocs, Mintlify, Vercel and Supabase
  // all answer `content-type: text/markdown` with the page already converted.
  // Handing that to the HTML parser produces an empty document. Return it as-is
  // and say which channel it came from.
  if (MARKDOWN_CONTENT_TYPE.test(resp.contentType) && !looksLikeHtml(resp.text)) {
    const raw = resp.text.replace(/^﻿/, '').trim();
    const title = (raw.match(/^#\s+(.+)$/m)?.[1] || '').trim();
    const markdown = wrapMdWithFrontmatter(raw, resp.finalUrl, title, 'content-negotiation');
    return {
      markdown,
      title,
      baseUrl: resp.finalUrl,
      charCount: raw.length,
      extractedAt: new Date().toISOString(),
      source: 'content-negotiation',
    };
  }

  return htmlToMarkdown(resp.text, { ...opts, baseUrl: opts.baseUrl ?? resp.finalUrl });
};

// Re-export public types + errors for consumers (MCP server catches these).
export type { ProfileName } from '../shared/types.js';
export { LinkedomAdapter } from './linkedom-adapter.js';
export { SsrfBlockedError, assertSafeUrl } from './ssrf-guard.js';
export { FetchProtectionError, fetchProtected } from './fetch-protected.js';
