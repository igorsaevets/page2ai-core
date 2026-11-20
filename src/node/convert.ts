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
const BOUNDARY_START = /^(?:\$[?~!]?|&)$/; // `&` = an <Activity> boundary
const REACT_ID = /[BSP]:[0-9a-f]+$/;
// The HTML standard's JavaScript MIME types ("JavaScript MIME type essence match", no parameters).
const JS_TYPE = /^((application|text)\/(x-)?(ecma|java)script|text\/(javascript1\.[0-5]|jscript|livescript))$/i;

// P2A-061 (T277): each call looked its elements up with linkedom's isConnected and refused a segment holding its own
// boundary with contains; both walk to the root. A page that chains fills, each segment holding a few nested elements
// around the next boundary, made every walk longer than the last: 16,000 fills (4.6 MB) took 65 s, in the one process
// of the hosted endpoint.
// P2A-072..074 (T279): what a browser does, measured in Chrome 158 running react-dom 19.3.1's own inline runtime on
// the same bytes. `$RC` (and `$RR`, once its stylesheets load) looks its two elements up as its script runs, marks the
// boundary `$~` and queues the pair; `$RV` reveals the queue once the page is parsed, in call order: it detaches the
// segment, removes every node from the boundary's <template> to its end comment, or to the end of the parent when there
// is none, and moves the segment's children there. `$RS` moves a segment at once. So the replay runs in two passes:
// every call in document order (`$RS` moves, `$RC` looks up and queues), then the queue. On crafted pages Chrome showed
// what follows, and the replay does the same: a boundary with no end comment loses every later sibling and gets the
// content at the end of its parent; a script that a reveal removes had already run (P2A-073); a segment that an earlier
// reveal removed still fills its boundary; calls that name one segment id all get the first such segment, which fills
// the first boundary while the others lose their fallback; a segment that holds its own boundary is detached, then the
// move throws (HierarchyRequestError; when the boundary is the segment's own child the move never ends and the tab
// hangs), and no later pair is revealed.
// Cost: a reveal's scan removes every node it passes, so the scans add up to the page (0.4.19 counted them too, and its
// budget, sized by elements, ran out on fallbacks padded with comments: P2A-072); an element the first pass detaches is
// remembered, and each id's list is read from a cursor past them (Array.shift() copied the list per call: P2A-074); a
// script's <template>/<noscript> ancestor is looked for before anything moves, at most REPLAY_DEPTH levels up, so a
// script deeper than that is not replayed (no saved page nests past 42). What can repeat is the containment test
// (`holds`) and moving a segment's children (children moved into a boundary inside a later segment move again with it).
// Those steps count against WORK_PER_BYTE per character of the page; past that a call gets at most CALL_STEPS, and one
// that needs more keeps its fallback while the later calls go on (0.4.19 stopped the whole replay there).
// P2A-078 (T280): a child's first move is not counted: each node is moved for the first time at most once, so those
// moves add up to the page. 0.4.20 counted every child, so after a chain had spent the budget a fresh segment of more
// than 64 children (an article of 200 paragraphs) kept its fallback; Chrome showed it. A chain that moves the same
// children again and again still stops where the budget does (Chrome makes every move; that work grows with the
// square of the chain), and a segment refused once is not walked again.
// P2A-079 (T280): a segment that a call reached and did not reveal (refused for cost, or queued after a reveal that
// threw) stays hidden, as in Chrome: it loses its React id, which the renderer otherwise prints as shown (the recovery
// for segments no replayed call names). 0.4.20 printed them, with their fallback.
// P2A-080 (T280): $RC sets `.data` on whatever stands before the boundary's <template> (a text node then reads `$`,
// as Chrome shows it); with nothing there it throws, and so does $RS on a missing segment, a missing placeholder or a
// placeholder inside its segment: the rest of that script does not run. 0.4.20 wanted a `$?`/`$~` comment there and
// kept the fallback otherwise ($!, &, a space, an element), and went on with the script.
// P2A-077 (T280): elements inside <noscript>, <iframe>, <noembed>, <noframes> or <xmp> do not exist in a browser that
// runs scripts (their content is text), so no call finds them; linkedom parses them as elements, and 0.4.20 moved a
// segment out of a <noscript>.
const REPLAY_DEPTH = MAX_PARSE_DEPTH + 8; // = the tree bound (boundTreeDepth)
const WORK_PER_BYTE = 4;
const CALL_STEPS = 64;
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
  first: Map<string, number>; // per id: its elements before this index are gone
  gone: WeakSet<Element>; // detached by the first pass: getElementById no longer finds them
  moved: WeakSet<Node>; // placed by an earlier move: moving it again is work that can repeat
  refused: WeakSet<Element>; // segments left hidden: never walked again
  budget: number;
}
const RAW_TEXT = 'noscript, iframe, noembed, noframes, xmp';
const scanDocument = (doc: Document, bytes: number): StreamScan => {
  const order = new Map<Element, number>();
  const ids = new Map<string, Element[]>();
  const inert = new WeakSet<Element>();
  for (const box of doc.querySelectorAll(RAW_TEXT)) {
    if (inert.has(box)) continue; // its outer box marked it already
    for (const el of box.querySelectorAll('*')) inert.add(el);
  }
  for (const el of doc.querySelectorAll('*')) {
    if (inert.has(el)) continue;
    order.set(el, order.size);
    if (!el.id || !REACT_ID.test(el.id)) continue;
    const list = ids.get(el.id);
    if (list) list.push(el);
    else ids.set(el.id, [el]);
  }
  return {
    order, ids, first: new Map(), gone: new WeakSet(), moved: new WeakSet(), refused: new WeakSet(), steps: 0,
    budget: WORK_PER_BYTE * bytes + 65536,
  };
};

// Every element of `node` (itself included) is out of the document for the rest of the first pass, which never puts
// a detached node back. Each node is forgotten once, so these walks add up to the page.
const forget = (scan: StreamScan, node: Node): void => {
  const stack: Node[] = [node];
  for (let n = stack.pop(); n; n = stack.pop()) {
    if (n.nodeType !== 1) continue;
    scan.gone.add(n as Element);
    for (let c = n.firstChild; c; c = c.nextSibling) stack.push(c);
  }
};

// Steps the current call may spend on work that can repeat: what is left of the budget, and at least CALL_STEPS.
const allowance = (scan: StreamScan): number => Math.max(scan.budget - scan.steps, CALL_STEPS);

// Whether `segment` holds `node` (contains, without its walk to the root): one step up from the node and one step on
// through the segment's subtree at a time, so the answer costs the shorter of the two walks; undefined when neither
// ends within `limit` steps. A chain's segments are small and its boundaries deep; React's are both small.
const holds = (scan: StreamScan, segment: Node, node: Node, limit: number): boolean | undefined => {
  let up: Node | null = node.parentNode;
  let down: Node | null = segment.firstChild;
  for (let step = 0; step < limit; step++) {
    scan.steps++;
    if (up === segment || down === node) return true;
    if (!up || up.nodeType === 9 || !down) return false; // reached a root, or walked the whole segment
    up = up.parentNode;
    if (down.firstChild) down = down.firstChild;
    else {
      while (down && down !== segment && !down.nextSibling) down = down.parentNode;
      down = down && down !== segment ? down.nextSibling : null;
    }
  }
  return undefined;
};

// How many of the segment's children an earlier move placed, when that is at most `limit`; undefined when more.
const moveCost = (scan: StreamScan, segment: Node, limit: number): number | undefined => {
  let again = 0;
  for (let c = segment.firstChild; c; c = c.nextSibling) if (scan.moved.has(c) && ++again > limit) return undefined;
  return again;
};
const moveChildren = (scan: StreamScan, segment: Node, parent: Node, before: Node | null): void => {
  for (let c = segment.firstChild; c; c = segment.firstChild) {
    scan.moved.add(c);
    parent.insertBefore(c, before);
  }
};
const keepHidden = (scan: StreamScan, segment: Element): void => {
  scan.refused.add(segment);
  segment.removeAttribute('id');
};

// getElementById as the script sees it when it runs: the first element with that id still in the document, if the
// parser had reached it before the script.
const lookup = (scan: StreamScan, id: string, script: Element): Element | null => {
  const list = scan.ids.get(id);
  if (!list) return null;
  let at = scan.first.get(id) ?? 0;
  while (at < list.length && scan.gone.has(list[at])) at++;
  scan.first.set(id, at);
  const el = list[at];
  return el && (scan.order.get(el) ?? Infinity) < (scan.order.get(script) ?? -1) ? el : null;
};

// $RC and $RR as their script runs: both elements looked up, the pair queued.
// Each returns true when the call throws in the browser, so that the rest of its script does not run.
const queueBoundary = (scan: StreamScan, script: Element, boundaryId: string, segmentId: string, queue: Element[]): boolean => {
  const segment = lookup(scan, segmentId, script);
  if (!isSegment(segment) || scan.refused.has(segment)) return false;
  const marker = lookup(scan, boundaryId, script);
  if (!marker) {
    segment.remove(); // React's $RC drops a segment whose boundary is gone: the browser never shows it
    forget(scan, segment);
    return false;
  }
  if (marker.tagName !== 'TEMPLATE') return false;
  const open = marker.previousSibling;
  if (!open) return true; // `previousSibling.data = "$~"` on null
  if (open.nodeType === 8 || open.nodeType === 3) (open as CharacterData).data = '$~';
  queue.push(marker, segment);
  return false;
};

// $RS, at once: the segment's children go where its placeholder stands.
const fillPlaceholder = (scan: StreamScan, script: Element, segmentId: string, placeholderId: string): boolean => {
  const segment = lookup(scan, segmentId, script);
  if (!segment) return true; // `a.parentNode` of null
  if (!isSegment(segment) || scan.refused.has(segment)) return false;
  const placeholder = lookup(scan, placeholderId, script);
  if (!placeholder) {
    segment.remove(); // React's $RS removes the segment, then fails on the missing placeholder
    forget(scan, segment);
    return true;
  }
  const parent = placeholder.parentNode;
  if (placeholder.tagName !== 'TEMPLATE' || !parent) return false;
  const limit = allowance(scan);
  const start = scan.steps;
  const inside = holds(scan, segment, placeholder, limit);
  if (inside === undefined) {
    keepHidden(scan, segment); // too costly to tell
    return false;
  }
  if (inside) {
    segment.remove(); // React detaches it, then its move throws (or never ends)
    forget(scan, segment);
    return true;
  }
  const again = moveCost(scan, segment, limit - (scan.steps - start));
  if (again === undefined) {
    keepHidden(scan, segment);
    return false;
  }
  segment.remove();
  scan.steps += again;
  moveChildren(scan, segment, parent, placeholder);
  forget(scan, segment);
  placeholder.remove();
  forget(scan, placeholder);
  return false;
};

// $RV: the queued pairs revealed in call order, once the page is parsed.
const reveal = (scan: StreamScan, queue: Element[]): void => {
  for (let i = 0; i < queue.length; i += 2) {
    const marker = queue[i];
    const segment = queue[i + 1];
    if (scan.refused.has(segment)) continue;
    const limit = allowance(scan);
    const start = scan.steps;
    const inside = holds(scan, segment, marker, limit);
    if (inside === undefined) {
      keepHidden(scan, segment); // too costly to tell: this pair keeps its fallback, the later ones go on
      continue;
    }
    if (inside) {
      segment.parentNode?.removeChild(segment); // React detaches it, then its move throws: no later pair is revealed
      for (let j = i + 3; j < queue.length; j += 2) keepHidden(scan, queue[j]);
      return;
    }
    const again = moveCost(scan, segment, limit - (scan.steps - start));
    if (again === undefined) {
      keepHidden(scan, segment);
      continue;
    }
    segment.parentNode?.removeChild(segment);
    const parent = marker.parentNode;
    if (!parent) continue; // an earlier reveal removed the boundary: its segment is lost with it
    const open = marker.previousSibling;
    let end: ChildNode | null = marker;
    for (let depth = 0; end; ) {
      if (end.nodeType === 8) {
        const data = (end as Comment).data;
        if (data === '/$' || data === '/&') {
          if (!depth) break;
          depth--;
        } else if (BOUNDARY_START.test(data)) depth++;
      }
      const next: ChildNode | null = end.nextSibling;
      parent.removeChild(end);
      end = next;
    }
    scan.steps += again;
    moveChildren(scan, segment, parent, end);
    if (open && (open.nodeType === 8 || open.nodeType === 3)) (open as CharacterData).data = '$';
  }
};

const revealStreamedSegments = (doc: Document, bytes: number): Document => {
  // Which scripts run is decided before anything moves: a browser runs each one as it parses it, before a later reveal
  // can remove it (P2A-073: 0.4.19 asked after the moves and skipped a script an earlier fill had removed).
  const runs: [Element, string][] = [];
  for (const script of doc.querySelectorAll('script')) {
    const text = script.textContent || '';
    if (text.includes('$R') && runsAsClassicScript(script)) runs.push([script, text]);
  }
  let scan: StreamScan | undefined;
  const queue: Element[] = [];
  for (const [script, text] of runs) {
    for (const m of text.matchAll(STREAM_CALL)) {
      scan ??= scanDocument(doc, bytes);
      const threw = m[1] ? queueBoundary(scan, script, m[1], m[2], queue) : fillPlaceholder(scan, script, m[3], m[4]);
      if (threw) break;
    }
  }
  if (scan) reveal(scan, queue);
  return doc;
};

// Every parse goes through the depth cap first: deep nesting stalls linkedom's parser and overflows the walks
// (depth-cap.ts; P2A-033, P2A-036).
// P2A-071 (T277), P2A-075 (T279): linkedom keeps attribute names as the page wrote them (its HTML parse turns
// lowerCaseAttributeNames off) and getAttribute / hasAttribute compare names exactly, so `<div HIDDEN>`,
// `<div STYLE="display:none">` and `<a HREF>` read as having no hidden, style or href: hidden text came out at every
// depth in every version, and the links and images of an uppercase page were lost. A browser's tokenizer lowercases
// the ASCII letters of every attribute name, SVG and MathML ones included, keeps the first of two names that then
// match, and gives SVG elements back the spec's 58 camelCase names (viewBox…) and MathML elements definitionURL
// (measured in Chrome 158, T279). So does this. 0.4.19 left SVG elements alone (React's `<svg ARIA-HIDDEN STYLE>`
// segment wrapper went unrecognised) and lowercased non-ASCII letters too (U+212A KELVIN SIGN became k).
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_CAMEL = new Map(
  ('attributeName attributeType baseFrequency baseProfile calcMode clipPathUnits diffuseConstant edgeMode filterUnits ' +
    'glyphRef gradientTransform gradientUnits kernelMatrix kernelUnitLength keyPoints keySplines keyTimes lengthAdjust ' +
    'limitingConeAngle markerHeight markerUnits markerWidth maskContentUnits maskUnits numOctaves pathLength ' +
    'patternContentUnits patternTransform patternUnits pointsAtX pointsAtY pointsAtZ preserveAlpha preserveAspectRatio ' +
    'primitiveUnits refX refY repeatCount repeatDur requiredExtensions requiredFeatures specularConstant ' +
    'specularExponent spreadMethod startOffset stdDeviation stitchTiles surfaceScale systemLanguage tableValues targetX ' +
    'targetY textLength viewBox viewTarget xChannelSelector yChannelSelector zoomAndPan')
    .split(' ')
    .map((name): [string, string] => [name.toLowerCase(), name]),
);
const attributeName = (el: Element, svg: boolean, name: string): string => {
  const lower = /[A-Z]/.test(name) ? name.replace(/[A-Z]+/g, (s) => s.toLowerCase()) : name;
  if (svg) return SVG_CAMEL.get(lower) ?? lower;
  return lower === 'definitionurl' && el.closest('math') ? 'definitionURL' : lower;
};
const lowerAttributeNames = (doc: Document): void => {
  for (const el of doc.querySelectorAll('*')) {
    const attrs = el.attributes;
    const svg = el.namespaceURI === SVG_NS;
    let change = false;
    for (let i = 0; i < attrs.length && !change; i++) change = attributeName(el, svg, attrs[i].name) !== attrs[i].name;
    if (!change) continue;
    // P2A-076 (T280): renamed where they stand, one step each. Removing every name and setting it back walked the
    // element's attribute list per name (linkedom keeps them in a list): 20,000 attributes took 0.9 s, quadratic.
    const nodes = [...attrs];
    if (nodes.every((a) => Object.getOwnPropertyDescriptor(a, 'name')?.writable === true)) {
      const seen = new Set<string>();
      const later: Attr[] = [];
      for (const attr of nodes) {
        const name = attributeName(el, svg, attr.name);
        if (seen.has(name)) later.push(attr);
        else {
          seen.add(name);
          (attr as { name: string }).name = name;
        }
      }
      // The browser keeps the first of two names that now match, and so does getAttribute; each removal walks the
      // list from its start, so past 64 of them the later ones stay, under the names they had.
      if (later.length <= 64) for (const attr of later) el.removeAttributeNode(attr);
      continue;
    }
    const all = nodes.map((a): [string, string] => [a.name, a.value]);
    const kept = new Map<string, string>();
    for (const [name, value] of all) {
      const adjusted = attributeName(el, svg, name);
      if (!kept.has(adjusted)) kept.set(adjusted, value);
    }
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
    const document = revealStreamedSegments(parseDocument(html), html.length);
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
