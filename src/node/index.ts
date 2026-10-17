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
// A later release will port the full lib/core/html-to-md.ts renderer via PageAdapter.

import { parseHTML } from 'linkedom';
import { LinkedomAdapter } from './linkedom-adapter.js';
import { documentTitle, renderBasicMarkdown } from './basic-renderer.js';
import { FetchProtectionError, fetchProtected } from './fetch-protected.js';
import { assertSafeUrl } from './ssrf-guard.js';
import { CORE_VERSION } from '../shared/constants.js';
import type { ProfileName } from '../shared/types.js';

export interface HtmlToMarkdownOptions {
  baseUrl?: string;
  profile?: ProfileName | 'auto';
  includeFrontmatter?: boolean;
  includeImages?: boolean;
  // Also convert content under the HTML `hidden` attribute, which a browser does not show (default: false).
  includeHidden?: boolean;
}

export interface FetchAndConvertOptions extends HtmlToMarkdownOptions {
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
}

export interface ConversionResult {
  markdown: string;
  title: string;
  baseUrl: string;
  charCount: number;
  extractedAt: string;
  // 'markdown-response': the URL names a Markdown or text file (.md, .txt, ...), returned as is.
  source: 'html-parse' | 'markdown-response';
}

// linkedom builds the document of a FRAGMENT around its first element: `<style>..</style><div>..`
// gets <style> as documentElement, an empty synthetic <body>, and every later top-level node as
// a sibling outside both, so the walk found nothing and returned "" with no error (P2A-003: an
// HTMX-style partial; `<h1>T</h1><p>x</p>` loses even the heading). Plain text or "" gets no
// documentElement at all and linkedom's own `body` getter throws. Any parse whose root is not
// <html> is redone inside an html/body shell.
// A browser keeps what follows a stray </body> or </html>: HTML parsing reprocesses it in the body
// (spec "after body" modes). linkedom leaves it beside <body> or beside <html>, where the walk never
// looks, so `<body><p>a</p></body><p>b</p>` lost "b" (BL-37). Those nodes are moved into the body, a
// second <body> or <html> by its children. T110 deleted the two end tags from the source instead,
// which also deleted them inside <title>, <xmp> and <plaintext> text (T110 panel: grok, spark, agy).
const adoptAfterBody = (doc: Document): Document => {
  const body = doc.body;
  const root = doc.documentElement;
  if (!body || !root || body.parentNode !== root) return doc;
  const strays: Node[] = [];
  for (let n = body.nextSibling; n; n = n.nextSibling) strays.push(n);
  for (let n = root.nextSibling; n; n = n.nextSibling) strays.push(n);
  const adopt = (n: Node): void => {
    if (n.nodeType === 1 && /^(?:BODY|HTML)$/.test((n as Element).tagName)) {
      for (const c of [...n.childNodes]) adopt(c);
      n.parentNode?.removeChild(n);
    } else if (n.nodeType === 1 || (n.nodeType === 3 && (n.textContent || '').trim())) {
      body.appendChild(n);
    }
  };
  for (const n of strays) adopt(n);
  return doc;
};

// React streaming SSR (Fizz: Next.js App Router, Remix, Mintlify) sends the shell first, with a Suspense fallback
// where late content goes, `<!--$?--><template id="B:0"></template>fallback<!--/$-->`, and the content later, at the
// end of <body>: `<div hidden id="S:0">` and `<script>$RC("B:0","S:0")</script>`, which moves it into the boundary in
// place of the fallback. With no script run, the article stayed hidden beside <main> and the root printed the shell
// (the benchmark's docs.anthropic.com page: 212 characters of "Loading..." for a 12,270-character article, BL-39; 7 of
// 16 fresh Next.js / Mintlify / Remix pages stream, T126). So the calls are replayed in document order, as a browser
// runs them: $RC, and $RR (the same once stylesheets load), fill a boundary; $RS moves a segment onto its
// `<template id="P:1">` placeholder; $RX (client rendering) keeps the fallback. Chromium running only a page's inline
// scripts gave the converter the same page (8 of 8 pages, T126).
//
// A call counts only where a browser would run it (T127, the T126 panel; each case run in Chromium 149 with React's
// own runtime): call text in a `type="application/json"` script, a comment, a string or a <noscript> had moved a hidden
// segment into the root. So: a classic script (no `src`, no `nomodule`, a JavaScript `type` or none, outside <template>
// and <noscript>; React never writes a module script, and one runs after the classic ones), the call at a statement
// start as React writes it (all 23 calls on the 8 streaming pages begin the script or follow `;`), segment and boundary
// parsed before the script, as getElementById sees them when it runs, and only on markup React writes: one of its
// segment wrappers and a pending boundary closed by its own comment. What a script does is not checked: `$RC` defined
// as a no-op, or not at all, still moves segments; no real page streams without React's runtime. The external runtime
// (`<template data-rci>`, `unstable_externalRuntimeSrc`) is not replayed: none of the 16 pages uses it.
// Ids as React prints them: an optional identifierPrefix, then B:, S: or P: and hex.
const FILL_BOUNDARY = /\$R[CR]\("([^"\\]*B:[0-9a-f]+)","([^"\\]*S:[0-9a-f]+)"/;
const FILL_PLACEHOLDER = /\$RS\("([^"\\]*S:[0-9a-f]+)","([^"\\]*P:[0-9a-f]+)"/;
const STREAM_CALL = new RegExp(`(?<![^;])(?:${FILL_BOUNDARY.source}|${FILL_PLACEHOLDER.source})`, 'g');
const BOUNDARY_PENDING = /^\$[?~]$/; // `$~` = queued by React 19.2's batched reveal
const BOUNDARY_START = /^(?:\$[?~!]?|&)$/; // `&` = an <Activity> boundary
const REACT_ID = /[BSP]:[0-9a-f]+$/;
// The HTML standard's JavaScript MIME types ("JavaScript MIME type essence match", no parameters).
const JS_TYPE = /^((application|text)\/(x-)?(ecma|java)script|text\/(javascript1\.[0-5]|jscript|livescript))$/i;

const runsAsClassicScript = (script: Element): boolean => {
  if (script.hasAttribute('src') || script.hasAttribute('nomodule')) return false;
  if (script.parentElement?.closest('template, noscript')) return false;
  const type = script.getAttribute('type');
  if (type !== null) return type === '' || JS_TYPE.test(type.trim());
  const language = script.getAttribute('language');
  return !language || JS_TYPE.test(`text/${language}`);
};

// React's segment wrappers (ReactFizzConfigDOM.js, writeStartSegment): `<div hidden>`, `<svg>` and `<math>` with
// aria-hidden="true" and display:none, `<table hidden>`, or the <tbody>, <tr> or <colgroup> of a `<table hidden>`.
const isSegment = (el: Element | null): el is Element => {
  if (!el) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'DIV' || tag === 'TABLE') return el.hasAttribute('hidden');
  if (tag === 'SVG' || tag === 'MATH') {
    return el.getAttribute('aria-hidden') === 'true' && /display:\s*none/.test(el.getAttribute('style') || '');
  }
  return /^(?:TBODY|TR|COLGROUP)$/.test(tag) && !!el.closest('table')?.hasAttribute('hidden');
};

// One walk of the document, on the first call: each element's place in parse order, and the elements carrying React's
// ids. getElementById walks the tree on linkedom, so a lookup per call made a page of 16,000 calls take 9 s (T127;
// codex, T126 panel), and it also finds ids inside <template> contents, which a browser's does not; querySelectorAll
// does not enter them.
interface StreamScan { order: Map<Element, number>; ids: Map<string, Element[]> }
const scanDocument = (doc: Document): StreamScan => {
  const order = new Map<Element, number>();
  const ids = new Map<string, Element[]>();
  for (const el of doc.querySelectorAll('*')) {
    order.set(el, order.size);
    if (!el.id || !REACT_ID.test(el.id)) continue;
    const list = ids.get(el.id);
    if (list) list.push(el);
    else ids.set(el.id, [el]);
  }
  return { order, ids };
};

// getElementById as the script sees it when it runs: the first element with that id still in the document, if the
// parser had reached it before the script.
const lookup = (scan: StreamScan, id: string, script: Element): Element | null => {
  const list = scan.ids.get(id);
  while (list?.length && !list[0].isConnected) list.shift();
  const el = list?.[0];
  return el && (scan.order.get(el) ?? Infinity) < (scan.order.get(script) ?? -1) ? el : null;
};

const fillBoundary = (scan: StreamScan, script: Element, boundaryId: string, segmentId: string): void => {
  const segment = lookup(scan, segmentId, script);
  if (!isSegment(segment)) return;
  const marker = lookup(scan, boundaryId, script);
  if (!marker) {
    segment.remove(); // React's $RC drops a segment whose boundary is gone: the browser never shows it
    return;
  }
  const open = marker.previousSibling;
  if (marker.tagName !== 'TEMPLATE' || open?.nodeType !== 8 || !BOUNDARY_PENDING.test((open as Comment).data)) return;
  const parent = marker.parentNode;
  if (!parent || segment.contains(marker)) return;
  let close = marker.nextSibling;
  for (let depth = 0; close; close = close.nextSibling) {
    if (close.nodeType !== 8) continue;
    const data = (close as Comment).data;
    if (data === '/$' || data === '/&') {
      if (!depth) break;
      depth--;
    } else if (BOUNDARY_START.test(data)) depth++;
  }
  if (!close) return;
  segment.remove();
  for (let n: ChildNode | null = marker; n && n !== close; ) {
    const next: ChildNode | null = n.nextSibling;
    parent.removeChild(n);
    n = next;
  }
  while (segment.firstChild) parent.insertBefore(segment.firstChild, close);
  (open as Comment).data = '$';
};

const fillPlaceholder = (scan: StreamScan, script: Element, segmentId: string, placeholderId: string): void => {
  const segment = lookup(scan, segmentId, script);
  if (!isSegment(segment)) return;
  const placeholder = lookup(scan, placeholderId, script);
  if (!placeholder) {
    segment.remove(); // React's $RS removes the segment, then fails on the missing placeholder
    return;
  }
  const parent = placeholder.parentNode;
  if (placeholder.tagName !== 'TEMPLATE' || !parent || segment.contains(placeholder)) return;
  segment.remove();
  while (segment.firstChild) parent.insertBefore(segment.firstChild, placeholder);
  placeholder.remove();
};

const revealStreamedSegments = (doc: Document): Document => {
  let scan: StreamScan | undefined;
  for (const script of [...doc.querySelectorAll('script')]) {
    const text = script.textContent || '';
    if (!text.includes('$R') || !runsAsClassicScript(script)) continue;
    for (const m of text.matchAll(STREAM_CALL)) {
      scan ??= scanDocument(doc);
      if (m[1]) fillBoundary(scan, script, m[1], m[2]);
      else fillPlaceholder(scan, script, m[3], m[4]);
    }
  }
  return doc;
};

const parseDocument = (source: string): Document => {
  const first = parseHTML(source).document as unknown as Document;
  if (first.documentElement?.tagName === 'HTML') return adoptAfterBody(first);
  const inner = source.replace(/^﻿/, '').replace(/^\s*<\?xml[^>]*>/i, '').replace(/^\s*<!doctype[^>]*>/i, '');
  // Only a fragment that STARTS with <head> or <body> brings its own; one met later is wrapped like any
  // other content. Matching `<body` anywhere left `the <body> tag is required` outside the body, losing
  // "the " (mimo, T109).
  const shell = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:head|body)[\s>]/i.test(inner)
    ? `<!DOCTYPE html><html>${inner}</html>`
    : `<!DOCTYPE html><html><head></head><body>${inner}</body></html>`;
  return adoptAfterBody(parseHTML(shell).document as unknown as Document);
};

export const htmlToMarkdown = (
  html: string,
  opts: HtmlToMarkdownOptions = {},
): ConversionResult => {
  const injectedBase = opts.baseUrl ?? 'about:blank';
  try {
    const document = revealStreamedSegments(parseDocument(html));
    const adapter = new LinkedomAdapter(document, injectedBase);
    const title = documentTitle(document).trim();
    const markdown = renderBasicMarkdown(document, adapter, {
      baseUrl: adapter.baseUrl(),
      includeFrontmatter: opts.includeFrontmatter ?? true,
      includeImages: opts.includeImages ?? true,
      includeHidden: opts.includeHidden ?? false,
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

// Re-export public types + errors for consumers (MCP server catches these).
export type { ProfileName } from '../shared/types.js';
export { LinkedomAdapter } from './linkedom-adapter.js';
// assertSafeUrlResolved is the exact check fetchAndConvert runs on the URL and on every redirect
// hop, so a caller can learn before fetching whether a URL will be refused; findIpBlockReason is
// its address rule. Both sat in the published .d.ts without being importable (P2A-009).
export { SsrfBlockedError, assertSafeUrl, assertSafeUrlResolved, findIpBlockReason } from './ssrf-guard.js';
export { FetchProtectionError, fetchProtected } from './fetch-protected.js';
