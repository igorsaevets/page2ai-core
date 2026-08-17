// Basic Markdown renderer for the v0.1 Node build. Covers the essentials:
// headings, paragraphs, lists, links, images, code blocks, tables, blockquotes,
// inline formatting, YAML frontmatter, plus STATIC tab discovery emitting
// '## Tab: {label}' sections (Spark P20 fix — prevents Python+TypeScript panel
// concatenation on docs.anthropic.com, platform.openai.com, Mintlify, etc.).
// NOT a port of the full extension renderer.
//
// v0.2 will replace this with the full lib/core/html-to-md.ts pipeline via
// PageAdapter, once the browser renderer is refactored to accept an adapter.

import type { PageAdapter } from '../shared/page-adapter.js';
import { CORE_VERSION } from '../shared/constants.js';
import { absUrl, chooseCodeFence, cleanInline, escapeMd, escapeMdTableCell } from '../shared/utils.js';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS']);
const INLINE_TAGS = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'CODE', 'SPAN', 'SMALL', 'MARK', 'U', 'S', 'DEL', 'INS', 'SUB', 'SUP', 'ABBR', 'CITE', 'Q', 'DFN', 'KBD', 'SAMP', 'VAR', 'TIME']);
const KNOWN_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shellsession', 'powershell', 'ps1', 'bat', 'cmd', 'python', 'py', 'javascript', 'js', 'typescript', 'ts', 'tsx', 'jsx', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'html', 'xml', 'css', 'scss', 'less', 'sass', 'sql', 'graphql', 'go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'php', 'ruby', 'r', 'lua', 'perl', 'dart', 'scala', 'elixir', 'haskell', 'markdown', 'md', 'mdx', 'mermaid', 'dockerfile', 'docker', 'nginx', 'diff', 'http', 'proto', 'tex', 'latex', 'vue', 'svelte', 'astro', 'plaintext', 'text', 'txt']);

const yq = (s: string): string => '"' + String(s).replace(/"/g, '\\"') + '"';

interface RenderOpts {
  baseUrl: string;
  includeFrontmatter: boolean;
  includeImages: boolean;
}

// Result of static tab discovery. When `panels` is populated we treat the
// container as a tab group and emit each panel as a labelled section instead
// of walking normally.
interface TabGroup {
  container: Element;
  panels: Array<{ label: string; el: Element }>;
}

export const renderBasicMarkdown = (
  doc: Document,
  adapter: PageAdapter,
  opts: RenderOpts,
): string => {
  const parts: string[] = [];

  const root = pickContentRoot(doc);
  const rawTitle = cleanInline(doc.querySelector('title')?.textContent || '');
  // The site suffix is dropped, not relocated: an earlier draft emitted it as a `site_name:`
  // frontmatter field, which put the exact chrome string the cleanup had just removed back
  // into the output one line lower. Provenance already lives in `source:`.
  const { title } = splitSiteSuffix(doc, root, rawTitle);

  if (opts.includeFrontmatter) {
    parts.push(...buildFrontmatter(doc, opts.baseUrl, title));
  }

  if (title) parts.push(`# ${title}`, '');
  if (root && root.children) {
    const tabGroups = discoverTabGroups(root);
    const capturedPanelEls = new WeakSet<Element>();
    tabGroups.forEach((g) => g.panels.forEach((p) => capturedPanelEls.add(p.el)));

    const lines: string[] = [];
    void adapter;
    walkWithTabs(root, lines, 0, opts, tabGroups, capturedPanelEls);
    parts.push(...lines);
  } else {
    parts.push('', '<!-- AI: page has no extractable body content -->', '');
  }

  return normalizeBlank(parts.join('\n')).trim() + '\n';
};

// Split "Page Title - Site Name" into the page title and the site brand. The suffix is
// stripped only on evidence, never on pattern alone: it must equal og:site_name, or the same
// string must occur in the page OUTSIDE the content root (a brand that repeats in the header
// or sidebar is chrome; a dash inside a real title has no such twin). Measured on the v0.2
// corpus: mdBook, Sphinx and GitBook all suffix <title> with a site name that also sits in
// their chrome, and that suffix was the single biggest source of boilerplate in our output.
const TITLE_SEPARATORS = [' - ', ' | ', ' — ', ' – ', ' · ', ' :: '];

// Unicode-aware: accented and non-Latin letters survive, so "Café - Süd" compares against
// chrome text without collapsing distinct words into accidental equality. (A reviewer caught
// the ASCII-only first draft destroying umlauts and CJK before this shipped.)
const squeezeText = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

// Does `needle` occur in the document text OUTSIDE the chosen content root?
const chromeContainsText = (doc: Document, root: Element | null, needle: string): boolean => {
  const target = squeezeText(needle);
  if (!target) return false;
  let acc = '';
  const walk = (node: Node): void => {
    if (node === (root as unknown as Node)) return;
    if (node.nodeType === 3 /* TEXT_NODE */) {
      acc += ' ' + (node.textContent || '');
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const tag = (node as Element).tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
    for (const c of node.childNodes) walk(c);
  };
  const top = (doc.body as unknown as Node) || (doc.documentElement as unknown as Node);
  if (!top) return false;
  walk(top);
  return squeezeText(acc).includes(target);
};

const splitOnce = (
  doc: Document,
  root: Element | null,
  ogSiteSq: string,
  t: string,
): { title: string; siteName: string } => {
  let cut = -1;
  let sepLen = 0;
  for (const sep of TITLE_SEPARATORS) {
    const i = t.lastIndexOf(sep);
    if (i > cut) {
      cut = i;
      sepLen = sep.length;
    }
  }
  // cut is the separator's index, i.e. the prefix length. 4 keeps "FAQ - Site" intact (a
  // 3-letter page name plus brand reads fine) while letting "Intro - Site" strip; the
  // evidence gate below, not this floor, is what prevents false strips.
  if (cut < 4) return { title: t, siteName: '' };
  const prefix = t.slice(0, cut).trim();
  const suffix = t.slice(cut + sepLen).trim();
  if (!prefix || suffix.length < 3 || suffix.length > 80) return { title: t, siteName: '' };
  const isSite =
    (ogSiteSq && squeezeText(suffix) === ogSiteSq) || chromeContainsText(doc, root, suffix);
  return isSite ? { title: prefix, siteName: suffix } : { title: t, siteName: '' };
};

const splitSiteSuffix = (
  doc: Document,
  root: Element | null,
  rawTitle: string,
): { title: string; siteName: string } => {
  const t = cleanInline(rawTitle);
  if (!t) return { title: t, siteName: '' };
  const ogSiteSq = squeezeText(
    cleanInline(doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || ''),
  );
  // Up to two evidence-gated strips: "Gemini thinking | Gemini API | Google AI for Developers"
  // carries TWO chrome segments, and one pass leaves the middle one behind (reviewer-raised).
  // Each strip requires its own evidence, so a legitimate "A - B - C" title loses nothing.
  const first = splitOnce(doc, root, ogSiteSq, t);
  if (!first.siteName) return first;
  const second = splitOnce(doc, root, ogSiteSq, first.title);
  return second.siteName
    ? { title: second.title, siteName: `${second.siteName} ${first.siteName}`.trim() }
    : first;
};

const buildFrontmatter = (
  doc: Document,
  baseUrl: string,
  titleOverride?: string,
): string[] => {
  const title = titleOverride ?? cleanInline(doc.querySelector('title')?.textContent || '');
  const description = cleanInline(
    doc.querySelector('meta[name="description"]')?.getAttribute('content') || '',
  );
  const lang = doc.documentElement?.getAttribute('lang') || 'unknown';
  const canonical = absUrl(
    doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',
    baseUrl,
  );
  const ogTitle = cleanInline(
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || '',
  );
  const ogDescription = cleanInline(
    doc.querySelector('meta[property="og:description"]')?.getAttribute('content') || '',
  );
  const author = cleanInline(
    doc.querySelector('meta[name="author"]')?.getAttribute('content') ||
      doc.querySelector('meta[property="article:author"]')?.getAttribute('content') ||
      '',
  );
  const publishedTime = cleanInline(
    doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content') || '',
  );

  const fm: string[] = ['---'];
  fm.push(`title: ${yq(title)}`);
  fm.push(`source: ${yq(baseUrl)}`);
  fm.push(`captured_at: ${yq(new Date().toISOString())}`);
  fm.push(`language: ${yq(lang)}`);
  if (description) fm.push(`description: ${yq(description)}`);
  if (canonical) fm.push(`canonical: ${yq(canonical)}`);
  if (ogTitle && ogTitle !== title) fm.push(`og_title: ${yq(ogTitle)}`);
  if (ogDescription && ogDescription !== description) fm.push(`og_description: ${yq(ogDescription)}`);
  if (author) fm.push(`author: ${yq(author)}`);
  if (publishedTime) fm.push(`published: ${yq(publishedTime)}`);
  fm.push(`extractor: ${yq('page2ai-core')}`);
  fm.push(`extractor_version: ${yq(CORE_VERSION)}`);
  fm.push('---', '');
  return fm;
};

// Tags that are page furniture rather than page content. Used ONLY to score candidate roots,
// never to skip anything during rendering: once a root is chosen the walker still emits
// everything inside it.
//
// FORM and DIALOG were here and were removed after being measured. A page whose content IS a
// form - a permit application, a calculator, a docs page with a playground - scored as empty,
// so a small unrelated card next to it became the highest-scoring <article> and won the root.
// On the test case the whole application disappeared from the output and a "related permits"
// teaser was returned in its place: the same failure this function exists to prevent, pointed
// the other way. A form inside real chrome is still excluded, because its NAV/HEADER/FOOTER/
// ASIDE ancestor is excluded and the walk never reaches it.
const CHROME_TAGS = new Set([
  'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SCRIPT', 'STYLE', 'NOSCRIPT',
  'TEMPLATE', 'SVG', 'CANVAS',
]);

// Length of the text a reader would call content: chrome and hidden subtrees excluded.
// Deliberately counts characters and not nodes - a nav with 60 one-word links outnumbers an
// article's paragraphs, so a node count ranks the navigation above the prose.
const contentTextLength = (el: Element): number => {
  let n = 0;
  const walk = (node: Node): void => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      n += (node.textContent || '').replace(/\s+/g, ' ').trim().length + 1;
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const e = node as Element;
    if (CHROME_TAGS.has(e.tagName)) return;
    if ((e.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return;
    if (e.hasAttribute('hidden')) return;
    for (const c of e.childNodes) walk(c);
  };
  walk(el);
  return n;
};

// Minimum share of its container's content text that an <article> must carry before we accept
// it AS the page. Measured 2026-08-02 on raw server HTML - the bytes this path actually
// receives, not a browser-rendered copy:
//
//   github.com/modelcontextprotocol/servers    1 article    5923/7065 = 0.84   the README
//   github.com/igorsaevets/page2ai-mcp         1 article    6048/7438 = 0.81   the README
//   docs.astro.build/en/getting-started/       5 articles    300/1362 = 0.22   <article class="card">
//   starlight.astro.build/                     5 articles    213/3171 = 0.07   cards again
//   blog.cloudflare.com/                      19 articles    471/6640 = 0.07   post teasers
//
// Real articles cluster at 0.8 and above, cards and teasers at 0.25 and below, and nothing
// observed lands between - so this threshold sits in an empty gap rather than on a boundary
// case it was fitted to.
const ARTICLE_DOMINANCE = 0.5;

// Second, independent way for an <article> to prove it is the page: dwarfing every other
// <article> on it. This exists because the container ratio alone has a blind spot - a real post
// followed by a large "related posts" rail of teasers can fall under 0.5 and lose to <main>,
// dragging fourteen teasers into the output. Measured on that shape: the post scored 6.2k
// against a 14.2k container, so the ratio said "not dominant" about the one thing on the page
// that was.
//
// A list of cards is a list because its members are COMPARABLE: Astro's five cards measured
// 300/181/155/127/107, a 1.7x spread. A page with one real article and some teasers is not:
// 6.2k against 0.5k is 12x. Three is comfortably inside that gap in both directions.
const ARTICLE_DWARFS_SIBLINGS = 3;

// linkedom can hand back a <body> with zero children while the content sits under
// documentElement. Reproduced 2026-08-02 on nodejs.org/api/fs.html: body.childNodes.length is 0
// and documentElement.textContent is 256,836 characters. Trusting doc.body there yields the
// "no extractable body content" comment for a page that is almost entirely content.
const usableBody = (doc: Document): Element | null => {
  const body = doc.body as unknown as Element | null;
  if (body && body.childNodes && body.childNodes.length > 0) return body;
  return (doc.documentElement as unknown as Element) || body || null;
};

const pickContentRoot = (doc: Document): Element | null => {
  // The semantic container first. <main> is unique per document by spec, so unlike <article>
  // it cannot be a component.
  const semantic =
    (doc.querySelector('main') as unknown as Element | null) ||
    (doc.querySelector('[role="main"]') as unknown as Element | null);
  const container = semantic || usableBody(doc);
  if (!container) return null;

  // Why this is not `doc.querySelector('main article') || doc.querySelector('article')`:
  // querySelector returns the FIRST match in document order, and HTML5 defines <article> as any
  // independently distributable composition - which design systems spend on cards, teasers and
  // comments. On docs.astro.build the first <article> is `class="card sl-flex"` holding 155
  // characters while <main> holds 1,362, so the tool emitted a heading, one question and one
  // sentence for the whole page. Our own documentation site runs that framework.
  const articles = Array.from(container.querySelectorAll('article'))
    .map((a) => ({ el: a as unknown as Element, n: contentTextLength(a as unknown as Element) }))
    .sort((x, y) => y.n - x.n);

  if (articles.length) {
    const best = articles[0];
    // An <article> replaces the container when it dominates the container, OR when it dwarfs
    // every other <article> present. Either test alone has a blind spot the other covers:
    // the ratio misses a real post buried under a related-posts rail, and the sibling test
    // says nothing at all when there is only one <article> on the page.
    //
    // Both tests run whether or not the container is semantic. An earlier version short-cut
    // `if (!semantic) return best.el`, reasoning that a raw <body> carries every sidebar not
    // marked up as chrome and so the comparison meant nothing. That reasoning was right and the
    // conclusion was still wrong: it reinstated exactly the behaviour this function exists to
    // replace. Measured on a card grid inside `<div class="sl-main">` rather than <main> - a
    // shape older Starlight themes and many docs templates emit - it returned 32 characters for
    // the whole page, reproducing the original defect on the layout family that motivated the
    // fix. A body-relative ratio is a weaker signal than a <main>-relative one, but a weak
    // signal beats a known-bad default.
    const containerLen = contentTextLength(container);
    const runnerUp = articles[1]?.n ?? 0;
    const dominatesContainer = containerLen > 0 && best.n / containerLen >= ARTICLE_DOMINANCE;
    const dwarfsSiblings = runnerUp > 0 && best.n / runnerUp >= ARTICLE_DWARFS_SIBLINGS;
    if (dominatesContainer || dwarfsSiblings) return best.el;
  }
  return container;
};

// Static tab discovery: aria-controls chains, role="tablist" siblings, and
// data-state attribute pairs. Emits '## Tab: {label}' sections. Does NOT
// click — for Node we treat each panel as ALREADY present in the DOM.
const discoverTabGroups = (root: Element): TabGroup[] => {
  const groups: TabGroup[] = [];
  const seenContainers = new WeakSet<Element>();
  // Path 1: [role="tablist"] with aria-controls chain
  root.querySelectorAll('[role="tablist"]').forEach((tl) => {
    if (seenContainers.has(tl)) return;
    const tabs = [...tl.querySelectorAll('[role="tab"], button')];
    const panels: Array<{ label: string; el: Element }> = [];
    for (const tab of tabs) {
      const label = cleanInline(tab.textContent || '');
      if (!label) continue;
      const controls = tab.getAttribute('aria-controls');
      if (!controls) continue;
      // linkedom supports getElementById via document.getElementById
      const doc = tl.ownerDocument;
      if (!doc) continue;
      const panel = doc.getElementById(controls);
      if (!panel) continue;
      panels.push({ label, el: panel });
    }
    if (panels.length >= 2) {
      groups.push({ container: tl, panels });
      seenContainers.add(tl);
    }
  });
  // Path 2: data-state="active"/"inactive" panels sharing a parent
  root.querySelectorAll('[data-state="active"], [data-state="inactive"]').forEach((el) => {
    if (el.getAttribute('role') !== 'tabpanel') return;
    const parent = el.parentElement;
    if (!parent || seenContainers.has(parent)) return;
    const siblingPanels = [...parent.children].filter(
      (c) => c.getAttribute('role') === 'tabpanel',
    );
    if (siblingPanels.length < 2) return;
    const panels = siblingPanels.map((p) => {
      // aria-labelledby is an IDREF list, not text: dereference it to the
      // labelling element's text instead of emitting the raw id as a heading.
      const labelledBy = p.getAttribute('aria-labelledby') || '';
      const doc = p.ownerDocument;
      const labelledText = labelledBy && doc
        ? labelledBy
            .split(/\s+/)
            .map((id) => doc.getElementById(id)?.textContent || '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
        : '';
      return {
        label: labelledText ||
               p.getAttribute('aria-label') ||
               p.getAttribute('data-value') ||
               p.id ||
               'Panel',
        el: p,
      };
    });
    groups.push({ container: parent, panels });
    seenContainers.add(parent);
  });
  return groups;
};

const walkWithTabs = (
  el: Element,
  out: string[],
  depth: number,
  opts: RenderOpts,
  tabGroups: TabGroup[],
  capturedPanelEls: WeakSet<Element>,
): void => {
  for (const child of el.children) {
    renderNodeWithTabs(child, out, depth, opts, tabGroups, capturedPanelEls);
  }
};

const renderNodeWithTabs = (
  el: Element,
  out: string[],
  depth: number,
  opts: RenderOpts,
  tabGroups: TabGroup[],
  capturedPanelEls: WeakSet<Element>,
): void => {
  // If THIS element is a captured tab panel, skip — it will be rendered as
  // part of its tab group section, not inline.
  if (capturedPanelEls.has(el)) return;
  // If THIS element is a tab-group container, render its panels as sections.
  const group = tabGroups.find((g) => g.container === el);
  if (group) {
    for (const panel of group.panels) {
      out.push('', `### Tab: ${escapeMd(panel.label)}`, '');
      walkWithTabs(panel.el, out, depth, opts, tabGroups, capturedPanelEls);
    }
    return;
  }
  renderNode(el, out, depth, opts, tabGroups, capturedPanelEls);
};

const renderNode = (
  el: Element,
  out: string[],
  depth: number,
  opts: RenderOpts,
  tabGroups: TabGroup[],
  capturedPanelEls: WeakSet<Element>,
): void => {
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return;
  if (el.getAttribute('aria-hidden') === 'true') return;

  const pfx = '   '.repeat(depth);

  if (/^H[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const text = renderInline(el, opts).trim();
    if (text) out.push('', `${'#'.repeat(level)} ${text}`, '');
    return;
  }

  if (tag === 'PRE') {
    renderCodeBlock(el, out);
    return;
  }

  if (tag === 'P') {
    const text = renderInline(el, opts).trim();
    if (text) out.push('', text, '');
    return;
  }

  if (tag === 'A') {
    const href = absUrl(el.getAttribute('href') || '', opts.baseUrl);
    const text = renderInline(el, opts).trim() || cleanInline(el.textContent || '');
    if (text && href) out.push(`${pfx}[${escapeMd(text)}](${href})`);
    else if (text) out.push(`${pfx}${escapeMd(text)}`);
    return;
  }

  if (tag === 'BLOCKQUOTE') {
    const inner: string[] = [];
    walkWithTabs(el, inner, depth, opts, tabGroups, capturedPanelEls);
    const text = inner.join('\n').trim();
    if (text) {
      out.push('');
      text.split('\n').forEach((l) => out.push(`> ${l}`));
      out.push('');
    }
    return;
  }

  if (tag === 'UL' || tag === 'OL') {
    const items = [...el.children].filter((c) => c.tagName === 'LI');
    let i = 1;
    for (const li of items) {
      const marker = tag === 'OL' ? `${i}.` : '-';
      renderListItem(li, marker, out, depth, pfx, opts, tabGroups, capturedPanelEls);
      i++;
    }
    return;
  }

  if (tag === 'TABLE') {
    renderTable(el as HTMLTableElement, out);
    return;
  }

  if (tag === 'IMG') {
    if (!opts.includeImages) return;
    const alt = cleanInline(el.getAttribute('alt') || '');
    const src = absUrl(el.getAttribute('src') || el.getAttribute('data-src') || '', opts.baseUrl);
    if (src) out.push(`${pfx}![${escapeMd(alt || 'image')}](${src})`);
    return;
  }

  if (tag === 'HR') { out.push('', '---', ''); return; }
  if (tag === 'BR') { out.push(''); return; }

  walkWithTabs(el, out, depth, opts, tabGroups, capturedPanelEls);
};

// Block tags that, as direct children of an <li>, render below the bullet instead of being
// flattened into its text. UL/OL were always here; the rest joined after the Sphinx measurement
// above. P is handled separately in renderListItem: it splits the inline run onto its own line
// (keeping loose-list paragraph breaks) without being demoted to a detached block.
const LI_BLOCK_TAGS = new Set(['UL', 'OL', 'PRE', 'TABLE', 'BLOCKQUOTE', 'DIV', 'FIGURE', 'DL', 'SECTION', 'DETAILS']);

// Does this element contain any block-level structure, or is it pure presentation around
// inline content? Decides whether a DIV inside an <li> is folded into the bullet text
// (`<li><div>text</div></li>` keeps its bullet) or rendered as a block below it.
const hasBlockContent = (el: Element): boolean =>
  !!el.querySelector('p, div, pre, table, ul, ol, blockquote, figure, dl, section, details, h1, h2, h3, h4, h5, h6');

// One <li>, rendered in DOCUMENT ORDER: inline runs and block children interleave exactly as
// authored. The first approach rendered all inline text first and all blocks after it, which
// reordered `<li>Text1 <pre>..</pre> Text2</li>` into Text1 Text2 pre — a reviewer-found
// defect, fixed before it ever shipped.
const renderListItem = (
  li: Element,
  marker: string,
  out: string[],
  depth: number,
  pfx: string,
  opts: RenderOpts,
  tabGroups: TabGroup[],
  capturedPanelEls: WeakSet<Element>,
): void => {
  let emittedMarker = false;
  let run: Node[] = [];
  const emitLine = (text: string): void => {
    if (!text) return;
    if (!emittedMarker) {
      out.push(`${pfx}${marker} ${text}`);
      emittedMarker = true;
    } else {
      out.push(`${pfx}   ${text}`);
    }
  };
  const flushInline = (): void => {
    const text = renderInlineNodes(run, opts).trim();
    run = [];
    emitLine(text);
  };
  for (const node of li.childNodes) {
    if (node.nodeType === 1 /* ELEMENT_NODE */) {
      const c = node as Element;
      if (c.tagName === 'P') {
        flushInline();
        emitLine(renderInline(c, opts).trim());
        continue;
      }
      if (LI_BLOCK_TAGS.has(c.tagName)) {
        // A DIV with no block structure of its own is a styling wrapper: fold its children
        // into the inline run so the bullet survives.
        if (c.tagName === 'DIV' && !hasBlockContent(c)) {
          run.push(...c.childNodes);
          continue;
        }
        flushInline();
        if (!emittedMarker) {
          out.push(`${pfx}${marker}`);
          emittedMarker = true;
        }
        renderNodeWithTabs(c, out, depth + 1, opts, tabGroups, capturedPanelEls);
        continue;
      }
    }
    run.push(node);
  }
  flushInline();
};

const renderInline = (el: Element, opts: RenderOpts, excludeEls?: Set<Element>): string =>
  renderInlineNodes([...el.childNodes], opts, excludeEls);

const renderInlineNodes = (nodes: Node[], opts: RenderOpts, excludeEls?: Set<Element>): string => {
  const parts: string[] = [];
  for (const node of nodes) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const t = cleanInline(node.textContent || '');
      if (t) parts.push(t);
      continue;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const c = node as Element;
    if (excludeEls && excludeEls.has(c)) continue;
    const tag = c.tagName;
    if (SKIP_TAGS.has(tag)) continue;
    if (tag === 'BR') { parts.push('\n'); continue; }
    if (tag === 'A') {
      const href = absUrl(c.getAttribute('href') || '', opts.baseUrl);
      const text = renderInline(c, opts) || cleanInline(c.textContent || '');
      if (text && href) parts.push(`[${escapeMd(text)}](${href})`);
      else if (text) parts.push(escapeMd(text));
      continue;
    }
    if (tag === 'STRONG' || tag === 'B') {
      const t = renderInline(c, opts) || cleanInline(c.textContent || '');
      if (t) parts.push(`**${t}**`);
      continue;
    }
    if (tag === 'EM' || tag === 'I') {
      const t = renderInline(c, opts) || cleanInline(c.textContent || '');
      if (t) parts.push(`*${t}*`);
      continue;
    }
    if (tag === 'CODE') {
      const t = cleanInline(c.textContent || '');
      if (t) parts.push(`\`${t}\``);
      continue;
    }
    if (tag === 'IMG') {
      const alt = cleanInline(c.getAttribute('alt') || '');
      const src = absUrl(c.getAttribute('src') || '', opts.baseUrl);
      if (src) parts.push(`![${escapeMd(alt || 'image')}](${src})`);
      continue;
    }
    if (INLINE_TAGS.has(tag)) {
      const t = renderInline(c, opts) || cleanInline(c.textContent || '');
      if (t) parts.push(t);
      continue;
    }
    // Unknown container in inline position (a P or styling DIV inside an <li>, a custom
    // element): recurse so links and emphasis inside it survive as markdown. The old fallback
    // took raw textContent, which kept the words but stripped every link.
    const t = renderInlineNodes([...c.childNodes], opts, excludeEls) || cleanInline(c.textContent || '');
    if (t) parts.push(t);
  }
  return parts.join(' ').replace(/\s+\n\s+/g, '\n');
};

// Aliases that authors write but fence renderers do not highlight.
const LANG_ALIASES: Record<string, string> = { python3: 'python', py3: 'python' };

// Tokens that appear after language-/lang- in UI class names and are never languages:
// language-selector, lang-picker, lang-en (a locale), language-tabs. Reviewer-raised; without
// this the generic acceptance below turns them into fence labels like ```selector.
const LANG_DENY = new Set(['en', 'de', 'fr', 'es', 'ru', 'zh', 'ja', 'ko', 'selector', 'picker', 'switcher', 'tabs', 'tab', 'ui', 'label', 'badge', 'wrapper', 'container', 'tools', 'toolbar', 'menu', 'list', 'name', 'icon']);

const normalizeLang = (raw: string, knownOnly: boolean): string => {
  let l = raw.toLowerCase();
  l = LANG_ALIASES[l] || l;
  if (KNOWN_LANGS.has(l)) return l;
  if (LANG_DENY.has(l)) return '';
  if (!knownOnly && /^[a-z][a-z0-9]{0,15}$/.test(l)) return l;
  return '';
};

const renderCodeBlock = (pre: Element, out: string[]): void => {
  const codeEl = pre.querySelector('code') || pre;
  const text = (codeEl.textContent || '').replace(/\r/g, '').replace(/^\n+|\n+$/g, '');
  if (!text.trim()) return;

  // The language label lives wherever the site generator put it, and that is rarely one place:
  // Docusaurus stamps language-X on the <pre> AND a CSS-module class on the <code> (so a
  // first-non-empty fallback between the two never saw the <pre>); VitePress and Hono put
  // language-X on a wrapper <div> above the <pre>; Sphinx uses highlight-python3 two levels up;
  // classic MDN uses class="brush: js". All measured on the v0.2 corpus.
  //
  // Trust falls with distance, two reviewer-found reasons: an ancestor's language-X may cover
  // MULTIPLE code blocks of different languages, and ancestor UI classes like
  // "language-selector" would parse as language "selector". So the element's own classes accept
  // the generic form, while ancestor classes accept only whitelisted languages, and an ancestor
  // wrapping more than one <pre> contributes nothing at all.
  const ownBlob = [codeEl, pre].map((e) => e.getAttribute('class') || '').join(' ');
  const ancestors: Element[] = [];
  let anc = pre.parentElement as Element | null;
  for (let i = 0; i < 3 && anc; i++) {
    if (anc.querySelectorAll('pre').length <= 1) ancestors.push(anc);
    anc = anc.parentElement as Element | null;
  }
  const ancestorBlob = ancestors.map((e) => e.getAttribute('class') || '').join(' ');
  const LANG_CLASS_RE = /(?:^|\s)(?:language|lang)-([a-z0-9_+#.-]+)/i;

  let lang = '';
  // 1. language-X / lang-X: generic form trusted on the element itself, whitelist-only on
  // ancestors.
  const ownMatch = ownBlob.match(LANG_CLASS_RE);
  if (ownMatch) lang = normalizeLang(ownMatch[1], false);
  if (!lang) {
    const ancMatch = ancestorBlob.match(LANG_CLASS_RE);
    if (ancMatch) lang = normalizeLang(ancMatch[1], true);
  }
  // 2. data-language / data-lang attributes, element first, then surviving ancestors.
  if (!lang) {
    for (const e of [codeEl, pre, ...ancestors]) {
      const d = e.getAttribute('data-language') || e.getAttribute('data-lang') || '';
      if (d) {
        lang = normalizeLang(d, false);
        if (lang) break;
      }
    }
  }
  // 3. highlight-X (Sphinx/Pygments) and brush: X (classic MDN): whitelist-only everywhere -
  // these families carry non-language suffixes like highlight-container.
  if (!lang) {
    const hl = (ownBlob + ' ' + ancestorBlob).match(/(?:^|\s)highlight-(?:source-)?([a-z][a-z0-9_+#.-]*)/i);
    if (hl) lang = normalizeLang(hl[1], true);
  }
  if (!lang) {
    const brush = (ownBlob + ' ' + ancestorBlob).match(/brush:\s*([a-z0-9+#-]+)/i);
    if (brush) lang = normalizeLang(brush[1], true);
  }

  const fence = chooseCodeFence(text);
  out.push('', `${fence}${lang}`);
  text.split('\n').forEach((l) => out.push(l));
  out.push(fence, '');
};

const renderTable = (tbl: HTMLTableElement, out: string[]): void => {
  const rows = [...tbl.querySelectorAll('tr')];
  if (!rows.length) return;
  const data = rows.map((tr) =>
    [...tr.querySelectorAll('th, td')].map((c) => escapeMdTableCell(c.textContent || '')),
  );
  const width = Math.max(...data.map((r) => r.length));
  const padded = data.map((r) => { while (r.length < width) r.push(''); return r; });
  out.push('');
  const header = padded[0];
  out.push(`| ${header.join(' | ')} |`);
  out.push(`| ${header.map(() => '---').join(' | ')} |`);
  padded.slice(1).forEach((r) => out.push(`| ${r.join(' | ')} |`));
  out.push('');
};

const normalizeBlank = (s: string): string => s.replace(/\n{3,}/g, '\n\n');
