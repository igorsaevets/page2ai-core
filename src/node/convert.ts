// @page2ai/core/html — an HTML string in, Markdown out.
//
// Public API:
//   htmlToMarkdown(html, opts?)  — convert an HTML string to Markdown
//
// No network and no Node.js built-in: this module's import graph is linkedom, css.escape and the
// renderer, so a bundler can ship it to a browser tab or a Web Worker (the online converter of the
// docs site runs it there). tests/node/public-api.test.ts walks that graph. The package root
// (index.ts) re-exports htmlToMarkdown and adds the guarded fetch: fetchAndConvert hands the page it
// fetched to this same function.
//
// SCOPE: basic renderer only (headings, paragraphs, lists, links, images,
// code blocks, tables, frontmatter, blockquotes, inline formatting) + STATIC
// tab discovery (aria-controls / role=tablist) that emits '## Tab: {label}'
// sections instead of concatenating panels. No interactive tab-click, no
// lazy-load, no <details> auto-expand. For the full pipeline see the browser build.
//
// A later release will port the full lib/core/html-to-md.ts renderer via PageAdapter.

import { parseHTML } from 'linkedom';
import { LinkedomAdapter } from './linkedom-adapter.js';
import { documentTitle, renderBasicMarkdown } from './basic-renderer.js';
import { opensWithHeadOrBody } from './linear-text.js';
import { boundTreeDepth, capNesting, MAX_PARSE_DEPTH } from './depth-cap.js';
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

// P2A-061 (T277): each call looked its elements up with linkedom's isConnected and refused a segment holding its own
// boundary with contains; both walk to the root. A page that chains fills, each segment holding a few nested elements
// around the next boundary, made every walk longer than the last: 16,000 fills (4.6 MB) took 65 s, in the one process
// of the hosted endpoint. Now an element the replay detaches is remembered, so a lookup skips it without a walk; the
// containment test walks up from the boundary and through the segment in step (`holds`), so it costs the shorter
// walk; a script's <template>/<noscript> ancestor and a segment row's table are looked for at most REPLAY_DEPTH levels
// up, and a script or row deeper than that is not replayed (no saved page nests past 42). The replay also stops once
// its steps pass a budget proportional to the page, so no other shape (one run of siblings scanned by many calls, the
// same children moved through many nested segments) makes it quadratic: the segments not moved yet stay where they
// stand, as on a page whose scripts never ran.
const REPLAY_DEPTH = MAX_PARSE_DEPTH + 8; // = the tree bound (boundTreeDepth)
const STEPS_PER_ELEMENT = 128;
interface Work { steps: number }

// The nearest ancestor of `node` that `isStop` accepts, at most REPLAY_DEPTH levels up; null when the document comes
// first; undefined when neither comes within the bound (too deep, or not in the document).
const ancestor = (node: Node, isStop: (n: Node) => boolean, work?: Work): Node | null | undefined => {
  let n = node.parentNode;
  for (let level = 0; n && level < REPLAY_DEPTH; level++, n = n.parentNode) {
    if (work) work.steps++;
    if (n.nodeType === 9) return null;
    if (isStop(n)) return n;
  }
  return undefined;
};
const isTag = (n: Node, tags: RegExp): boolean => n.nodeType === 1 && tags.test((n as Element).tagName);

const runsAsClassicScript = (script: Element): boolean => {
  if (script.hasAttribute('src') || script.hasAttribute('nomodule')) return false;
  if (ancestor(script, (n) => isTag(n, /^(?:TEMPLATE|NOSCRIPT)$/i)) !== null) return false;
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
  if (!/^(?:TBODY|TR|COLGROUP)$/.test(tag)) return false;
  const table = ancestor(el, (n) => isTag(n, /^TABLE$/i));
  return !!table && (table as Element).hasAttribute('hidden');
};

// One walk of the document, on the first call: each element's place in parse order, and the elements carrying React's
// ids. getElementById walks the tree on linkedom, so a lookup per call made a page of 16,000 calls take 9 s (T127;
// codex, T126 panel), and it also finds ids inside <template> contents, which a browser's does not; querySelectorAll
// does not enter them.
interface StreamScan extends Work {
  order: Map<Element, number>;
  ids: Map<string, Element[]>;
  gone: WeakSet<Element>; // detached by the replay: not in the document any more
  budget: number;
}
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
  return { order, ids, gone: new WeakSet(), steps: 0, budget: STEPS_PER_ELEMENT * order.size + 65536 };
};

// Every element of `node` (itself included) is out of the document for good: the replay is the only thing that
// detaches nodes here, and it never puts a detached one back (a segment's children are moved out before it is
// forgotten). Each node is forgotten once, so the walks add up to the page.
const forget = (scan: StreamScan, node: Node): void => {
  const stack: Node[] = [node];
  for (let n = stack.pop(); n; n = stack.pop()) {
    scan.steps++;
    if (n.nodeType !== 1) continue;
    scan.gone.add(n as Element);
    for (let c = n.firstChild; c; c = c.nextSibling) stack.push(c);
  }
};

// Whether `segment` holds `node` (contains, without its walk to the root): one step up from the node and one step on
// through the segment's subtree at a time, so the answer costs the shorter of the two. A chain's segments are small and
// its boundaries deep; React's are both small. Shapes where both are large are what the budget is for.
const holds = (scan: StreamScan, segment: Node, node: Node): boolean => {
  let up: Node | null = node.parentNode;
  let down: Node | null = segment.firstChild;
  for (;;) {
    scan.steps++;
    if (up === segment || down === node) return true;
    if (!up || up.nodeType === 9 || !down) return false; // reached the document, or walked the whole segment
    up = up.parentNode;
    if (down.firstChild) down = down.firstChild;
    else {
      while (down && down !== segment && !down.nextSibling) down = down.parentNode;
      down = down && down !== segment ? down.nextSibling : null;
    }
  }
};

// getElementById as the script sees it when it runs: the first element with that id still in the document, if the
// parser had reached it before the script.
const lookup = (scan: StreamScan, id: string, script: Element): Element | null => {
  const list = scan.ids.get(id);
  while (list?.length && scan.gone.has(list[0])) list.shift();
  const el = list?.[0];
  return el && (scan.order.get(el) ?? Infinity) < (scan.order.get(script) ?? -1) ? el : null;
};

const fillBoundary = (scan: StreamScan, script: Element, boundaryId: string, segmentId: string): void => {
  const segment = lookup(scan, segmentId, script);
  if (!isSegment(segment)) return;
  const marker = lookup(scan, boundaryId, script);
  if (!marker) {
    segment.remove(); // React's $RC drops a segment whose boundary is gone: the browser never shows it
    forget(scan, segment);
    return;
  }
  const open = marker.previousSibling;
  if (marker.tagName !== 'TEMPLATE' || open?.nodeType !== 8 || !BOUNDARY_PENDING.test((open as Comment).data)) return;
  const parent = marker.parentNode;
  if (!parent || holds(scan, segment, marker)) return; // a segment never moves into its own boundary
  let close = marker.nextSibling;
  for (let depth = 0; close; close = close.nextSibling) {
    scan.steps++;
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
    forget(scan, n);
    n = next;
  }
  for (; segment.firstChild; scan.steps++) parent.insertBefore(segment.firstChild, close);
  forget(scan, segment);
  (open as Comment).data = '$';
};

const fillPlaceholder = (scan: StreamScan, script: Element, segmentId: string, placeholderId: string): void => {
  const segment = lookup(scan, segmentId, script);
  if (!isSegment(segment)) return;
  const placeholder = lookup(scan, placeholderId, script);
  if (!placeholder) {
    segment.remove(); // React's $RS removes the segment, then fails on the missing placeholder
    forget(scan, segment);
    return;
  }
  const parent = placeholder.parentNode;
  if (placeholder.tagName !== 'TEMPLATE' || !parent || holds(scan, segment, placeholder)) return;
  segment.remove();
  for (; segment.firstChild; scan.steps++) parent.insertBefore(segment.firstChild, placeholder);
  forget(scan, segment);
  placeholder.remove();
  forget(scan, placeholder);
};

const revealStreamedSegments = (doc: Document): Document => {
  let scan: StreamScan | undefined;
  for (const script of [...doc.querySelectorAll('script')]) {
    const text = script.textContent || '';
    if (!text.includes('$R') || !runsAsClassicScript(script)) continue;
    for (const m of text.matchAll(STREAM_CALL)) {
      scan ??= scanDocument(doc);
      if (scan.steps > scan.budget) return doc; // the segments not moved yet stay where they stand
      if (m[1]) fillBoundary(scan, script, m[1], m[2]);
      else fillPlaceholder(scan, script, m[3], m[4]);
    }
  }
  return doc;
};

// Every parse goes through the depth cap first: deep nesting stalls linkedom's parser and overflows the walks
// (depth-cap.ts; P2A-033, P2A-036).
// P2A-071 (T277): linkedom keeps attribute names as the page wrote them (its HTML parse turns lowerCaseAttributeNames
// off) and getAttribute / hasAttribute compare names exactly, so `<div HIDDEN>`, `<div STYLE="display:none">` and
// `<a HREF>` read as having no hidden, style or href: hidden text came out at every depth in every version, and the
// links and images of an uppercase page were lost. A browser lowercases attribute names as it parses HTML and keeps the
// first of two that differ only in case; so does this, on HTML elements (SVG keeps viewBox and the like).
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const lowerAttributeNames = (doc: Document): void => {
  for (const el of doc.querySelectorAll('*')) {
    const attrs = el.attributes;
    let upper = false;
    for (let i = 0; i < attrs.length && !upper; i++) upper = /[A-Z]/.test(attrs[i].name);
    if (!upper || el.namespaceURI !== HTML_NS) continue;
    const all = [...attrs].map((a): [string, string] => [a.name, a.value]);
    const kept = new Map<string, string>();
    for (const [name, value] of all) if (!kept.has(name.toLowerCase())) kept.set(name.toLowerCase(), value);
    for (const [name] of all) el.removeAttribute(name);
    for (const [name, value] of kept) el.setAttribute(name, value);
  }
};

const parse = (source: string): Document => {
  const doc = parseHTML(capNesting(source)).document as unknown as Document;
  lowerAttributeNames(doc);
  return doc;
};

const parseDocument = (source: string): Document => {
  const first = parse(source);
  if (first.documentElement?.tagName === 'HTML') return adoptAfterBody(first);
  const inner = source.replace(/^﻿/, '').replace(/^\s*<\?xml[^>]*>/i, '').replace(/^\s*<!doctype[^>]*>/i, '');
  // Only a fragment that STARTS with <head> or <body> brings its own; one met later is wrapped like any
  // other content. Matching `<body` anywhere left `the <body> tag is required` outside the body, losing
  // "the " (mimo, T109). opensWithHeadOrBody skips the leading comments in one pass: the regex it replaced doubled its
  // time with each comment, and 40 of them ran for hours (T241).
  const shell = opensWithHeadOrBody(inner)
    ? `<!DOCTYPE html><html>${inner}</html>`
    : `<!DOCTYPE html><html><head></head><body>${inner}</body></html>`;
  return adoptAfterBody(parse(shell));
};

export const htmlToMarkdown = (
  html: string,
  opts: HtmlToMarkdownOptions = {},
): ConversionResult => {
  const injectedBase = opts.baseUrl ?? 'about:blank';
  try {
    const document = revealStreamedSegments(parseDocument(html));
    boundTreeDepth(document);
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
