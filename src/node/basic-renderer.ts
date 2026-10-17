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
import { absUrl, chooseCodeFence, cleanInline, escapeMd, longestRun } from '../shared/utils.js';

// HEAD/TITLE: the root can be documentElement (see usableBody). The form widgets and embeds hold
// option lists and "your browser does not support" fallbacks, never page text; they used to stay
// out only because the walk dropped all bare text (P2A-001), and must not arrive with the fix.
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'HEAD', 'TITLE',
  'SELECT', 'DATALIST', 'TEXTAREA', 'IFRAME', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO',
]);
const INLINE_TAGS = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'CODE', 'SPAN', 'SMALL', 'MARK', 'U', 'S', 'DEL', 'INS', 'SUB', 'SUP', 'ABBR', 'CITE', 'Q', 'DFN', 'KBD', 'SAMP', 'VAR', 'TIME']);
// Phrasing-level tags. Sitting directly in a container (`<div><span>Plan</span> starter</div>`)
// they join the text around them into one paragraph instead of being walked as containers.
const PHRASING_TAGS = new Set([
  ...INLINE_TAGS, 'IMG', 'BR', 'WBR', 'BUTTON', 'LABEL', 'OUTPUT', 'DATA', 'BDI', 'BDO', 'FONT',
  'BIG', 'TT', 'STRIKE', 'ACRONYM', 'NOBR', 'RUBY', 'RT', 'RP', 'METER', 'PROGRESS', 'INPUT',
]);
// A run made of nothing but these renders one element per line, as it did before runs existed.
const RUN_ATOMS = new Set(['A', 'IMG', 'BR']);
// Block-level tags met in INLINE position (a card <div> inside a link, a styling <div> folded into
// an <li>): the browser starts a new line for them, so their text is spaced from its neighbours.
const INLINE_BLOCK_GAP = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY',
  'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);
const KNOWN_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shellsession', 'powershell', 'ps1', 'bat', 'cmd', 'python', 'py', 'javascript', 'js', 'typescript', 'ts', 'tsx', 'jsx', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'html', 'xml', 'css', 'scss', 'less', 'sass', 'sql', 'graphql', 'go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'php', 'ruby', 'r', 'lua', 'perl', 'dart', 'scala', 'elixir', 'haskell', 'markdown', 'md', 'mdx', 'mermaid', 'dockerfile', 'docker', 'nginx', 'diff', 'http', 'proto', 'tex', 'latex', 'vue', 'svelte', 'astro', 'plaintext', 'text', 'txt']);

const yq = (s: string): string => '"' + String(s).replace(/"/g, '\\"') + '"';

// The page's own <title>. querySelector('title') also finds an inline icon's <svg><title>, which became
// a fake `# IconName` heading on any page or fragment whose <head> has no title (grok, T109).
export const documentTitle = (doc: Document): string =>
  [...doc.querySelectorAll('title')].find((t) => !t.closest('svg'))?.textContent || '';

interface RenderOpts {
  baseUrl: string;
  includeFrontmatter: boolean;
  includeImages: boolean;
  // Convert content under the `hidden` attribute too (isHiddenEl): the old behaviour, off by default.
  includeHidden?: boolean;
  // Rendering the text of a link: its text nodes escape `[`, `]` and `\`.
  inLink?: boolean;
  // Table cells: two adjacent elements get no space of ours (renderInlineNodes), as cells never had one. The space
  // split Sphinx's `asyncio.` + `FIRST_COMPLETED` into two words on the python-docs corpus page (T115 A/B).
  tight?: boolean;
  // Table cells and captions: an image that is not shown is written as its alt text (renderInlineNodes, IMG).
  imageAlt?: boolean;
}

// Result of static tab discovery. When `panels` is populated we treat the
// container as a tab group and emit each panel as a labelled section instead
// of walking normally.
interface TabGroup {
  container: Element;
  panels: Array<{ label: string; el: Element }>;
}

// #9: the synthetic title heading duplicates the page's own <h1> on most well-formed
// pages (h1 == title). While `pendingTitle` is set, the first heading the walk meets is
// skipped if it normalizes to the same string; the window closes at that first heading
// either way, so an identical heading later in the page is content and always renders.
interface TitleDedupe {
  pendingTitle: string;
}

export const renderBasicMarkdown = (
  doc: Document,
  adapter: PageAdapter,
  opts: RenderOpts,
): string => {
  const parts: string[] = [];

  const root = pickContentRoot(doc, opts);
  const rawTitle = cleanInline(documentTitle(doc));
  // The site suffix is dropped, not relocated: an earlier draft emitted it as a `site_name:`
  // frontmatter field, which put the exact chrome string the cleanup had just removed back
  // into the output one line lower. Provenance already lives in `source:`.
  const { title } = splitSiteSuffix(doc, root, rawTitle);

  if (opts.includeFrontmatter) {
    parts.push(...buildFrontmatter(doc, opts.baseUrl, title));
  }

  if (title) parts.push(`# ${title}`, '');
  if (root && root.children) {
    const tabGroups = discoverTabGroups(root, opts);
    const capturedPanelEls = new WeakSet<Element>();
    tabGroups.forEach((g) => g.panels.forEach((p) => capturedPanelEls.add(p.el)));

    const lines: string[] = [];
    void adapter;
    const dedupe: TitleDedupe = { pendingTitle: title ? squeezeText(title) : '' };
    walkWithTabs(root, lines, opts, tabGroups, capturedPanelEls, dedupe);
    // An empty walk is said out loud: a bare "" or a lone title reads as "the page is empty"
    // when the cause is client-side rendering or markup the walk did not understand (P2A-003).
    if (lines.some((l) => l.trim())) parts.push(...lines);
    else parts.push('', '<!-- AI: page has no extractable body content -->', '');
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
  const title = titleOverride ?? cleanInline(documentTitle(doc));
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

const pickContentRoot = (doc: Document, opts: RenderOpts): Element | null => {
  // The semantic container first. <main> is unique per document by spec, so unlike <article>
  // it cannot be a component. Unique among the SHOWN ones: a page may hold several <main> elements as long as all but
  // one are hidden (HTML, "the main element"), and a hidden one became the root and printed its whole text (C7c, codex).
  // So a <main> under no `hidden` at all comes first, one inside a React streaming segment only when there is none, and
  // one under a hidden tab panel or `until-found` section never: those are shown as one part of the page, so as the
  // root they printed only themselves and dropped the visible <main> (T124 panel: codex, grok, mimo, spark, agy).
  const clearUp = (e: Element, exempt: (a: Element) => boolean): boolean => {
    for (let a: Element | null = e; a; a = a.parentElement) if (underHiddenAttr(a, opts) && !exempt(a)) return false;
    return true;
  };
  const pick = (selector: string): Element | undefined => {
    const all = [...doc.querySelectorAll(selector)] as unknown as Element[];
    return all.find((e) => clearUp(e, () => false)) || all.find((e) => clearUp(e, isReactSegment));
  };
  const semantic = pick('main') || pick('[role="main"]') || null;
  const container = semantic || usableBody(doc);
  if (!container) return null;

  // Why this is not `doc.querySelector('main article') || doc.querySelector('article')`:
  // querySelector returns the FIRST match in document order, and HTML5 defines <article> as any
  // independently distributable composition - which design systems spend on cards, teasers and
  // comments. On docs.astro.build the first <article> is `class="card sl-flex"` holding 155
  // characters while <main> holds 1,362, so the tool emitted a heading, one question and one
  // sentence for the whole page. Our own documentation site runs that framework.
  // An <article> under a hidden ancestor is not a candidate: as the root it would print what the browser hides.
  const articles = Array.from(container.querySelectorAll('article'))
    .filter((a) => !hiddenUpTo(a as unknown as Element, container, opts))
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
const discoverTabGroups = (root: Element, opts: RenderOpts): TabGroup[] => {
  const groups: TabGroup[] = [];
  const seenContainers = new WeakSet<Element>();
  // Path 1: [role="tablist"] with aria-controls chain
  root.querySelectorAll('[role="tablist"]').forEach((tl) => {
    if (seenContainers.has(tl)) return;
    const tabs = [...tl.querySelectorAll('[role="tab"], button')];
    const panels: Array<{ label: string; el: Element }> = [];
    for (const tab of tabs) {
      // A tab's label is its name, without the text of hidden elements (T124 panel: `One<span hidden>x</span>` read Onex).
      const label = cleanInline(nameText(tab, opts));
      if (!label) continue;
      const controls = tab.getAttribute('aria-controls');
      if (!controls) continue;
      // linkedom supports getElementById via document.getElementById
      const doc = tl.ownerDocument;
      if (!doc) continue;
      const panel = doc.getElementById(controls);
      // A panel outside the content root is not part of it: a hidden block anywhere on the page was one aria-controls
      // away from being printed (T124 panel: ocmimo).
      if (!panel || !root.contains(panel)) continue;
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
            .map((id) => { const e = doc.getElementById(id); return e ? nameText(e, opts) : ''; })
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
  opts: RenderOpts,
  tabGroups: TabGroup[],
  capturedPanelEls: WeakSet<Element>,
  dedupe: TitleDedupe,
): void => walkNodes([...el.childNodes], out, opts, tabGroups, capturedPanelEls, dedupe);

const walkNodes = (
  nodes: Node[],
  out: string[],
  opts: RenderOpts,
  tabGroups: TabGroup[],
  capturedPanelEls: WeakSet<Element>,
  dedupe: TitleDedupe,
): void => {
  // Child NODES, not element children. Text and phrasing elements sitting directly in a container
  // collect into a run that renders as one paragraph, flushed before each block child. The walk
  // used to iterate `el.children`, so text outside a recognised block tag vanished without a
  // trace: `<div>Hello</div>`, a metric tile's label and value, text beside a `<br>`, a section's
  // own sentence (P2A-001: on a server-rendered admin page 25 of 26 key/value labels and 10 of 12
  // tiles were lost while every heading and table survived, so the output looked complete).
  let run: Node[] = [];
  const flush = (): void => {
    if (!run.length) return;
    const nodes = run;
    run = [];
    const hasText = nodes.some((n) => n.nodeType === 3 && /\S/.test(n.textContent || ''));
    // Links and images with no text between them (a nav row, an icon strip) keep the old
    // one-per-line rendering, so a page without stray text renders exactly as before.
    if (!hasText && nodes.every((n) => n.nodeType !== 1 || RUN_ATOMS.has((n as Element).tagName))) {
      for (const n of nodes) {
        if (n.nodeType === 1) renderNodeWithTabs(n as Element, out, opts, tabGroups, capturedPanelEls, dedupe);
      }
      return;
    }
    // A tab panel nested inside a run element is rendered under its own `### Tab:` heading.
    const text = escapeBlockStarts(renderInlineNodes(nodes, opts, capturedPanelEls).trim());
    if (text) out.push('', text, '');
  };
  // A custom element (`<relative-time>`, `<my-badge>`) has no user-agent style, so it is inline unless
  // its own CSS says otherwise. Among the bare words of its parent it is part of the sentence
  // ("opened Oct 3 · 5 comments", not three paragraphs); among element siblings only (a Material
  // card's title and subtitle) it stays a block, which is how such components are usually styled.
  const parentHasText = nodes.some((n) => n.nodeType === 3 && /\S/.test(n.textContent || ''));
  for (const node of nodes) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      run.push(node);
      continue;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const c = node as Element;
    // Skipped where they stand, without ending the run: renderNode would drop them anyway. A hidden block that holds code
    // goes on to renderNode, which prints only its code.
    if (SKIP_TAGS.has(c.tagName) || hiddenKind(c, opts) === 'hidden') continue;
    const phrasing = PHRASING_TAGS.has(c.tagName) || (parentHasText && c.tagName.includes('-'));
    if (phrasing && !capturedPanelEls.has(c) && !tabGroups.some((g) => g.container === c)) {
      if (isAriaHidden(c)) continue;
      // A link wrapping a whole card (<a><div><h3>..</h3><p>..</p></div></a>) stays a block.
      if (!hasBlockContent(c)) {
        run.push(c);
        continue;
      }
    }
    flush();
    renderNodeWithTabs(c, out, opts, tabGroups, capturedPanelEls, dedupe);
  }
  flush();
};

const renderNodeWithTabs = (
  el: Element,
  out: string[],
  opts: RenderOpts,
  tabGroups: TabGroup[],
  capturedPanelEls: WeakSet<Element>,
  dedupe: TitleDedupe,
): void => {
  // If THIS element is a captured tab panel, skip — it will be rendered as
  // part of its tab group section, not inline.
  if (capturedPanelEls.has(el)) return;
  // If THIS element is a tab-group container, render its panels as sections.
  const group = tabGroups.find((g) => g.container === el);
  if (group) {
    for (const panel of group.panels) {
      out.push('', `### Tab: ${escapeMd(panel.label)}`, '');
      walkWithTabs(panel.el, out, opts, tabGroups, capturedPanelEls, dedupe);
    }
    return;
  }
  renderNode(el, out, opts, tabGroups, capturedPanelEls, dedupe);
};

// Every block renders flush left; a list item indents what it holds (renderListItem).
const renderNode = (
  el: Element,
  out: string[],
  opts: RenderOpts,
  tabGroups: TabGroup[],
  capturedPanelEls: WeakSet<Element>,
  dedupe: TitleDedupe,
): void => {
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return;
  if (isAriaHidden(el)) return;
  const hidden = hiddenKind(el, opts);
  if (hidden === 'hidden') return;
  if (hidden === 'code') {
    for (const pre of outerPres(el, opts)) renderCodeBlock(pre, out, opts);
    return;
  }

  if (/^H[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    // A heading is one line, so a <br> in it, in its text or its code, is a space (T124 panel: mimo,
    // `<h2>Run <code>a<br>b</code> now</h2>` put the rest of the heading into a paragraph under it).
    const text = renderInline(el, opts).replace(/\s*\n\s*/g, ' ').trim();
    if (text) {
      if (dedupe.pendingTitle) {
        // Match on textContent, not the rendered markdown: escaping and link syntax
        // must not defeat the comparison, and the synthetic heading is plain text.
        const isDup = squeezeText(cleanInline(el.textContent || '')) === dedupe.pendingTitle;
        dedupe.pendingTitle = '';
        if (isDup) return;
      }
      out.push('', `${'#'.repeat(level)} ${text}`, '');
    }
    return;
  }

  if (tag === 'PRE') {
    renderCodeBlock(el, out, opts);
    return;
  }

  if (tag === 'P') {
    const text = escapeBlockStarts(renderInline(el, opts, capturedPanelEls).trim());
    if (text) out.push('', text, '');
    return;
  }

  if (tag === 'A') {
    const href = absUrl(el.getAttribute('href') || '', opts.baseUrl);
    const text = linkText(el, opts, href, capturedPanelEls);
    if (text && href) out.push(`[${text}](${mdUrl(href)})`);
    else if (text) out.push(escapeBlockStart(text));
    return;
  }

  if (tag === 'BLOCKQUOTE') {
    const inner: string[] = [];
    walkWithTabs(el, inner, opts, tabGroups, capturedPanelEls, dedupe);
    const text = inner.join('\n').trim();
    if (text) {
      out.push('');
      text.split('\n').forEach((l) => out.push(`> ${l}`));
      out.push('');
    }
    return;
  }

  if (tag === 'UL' || tag === 'OL') {
    // A hidden item takes no number, as in a browser.
    const items = [...el.children].filter((c) => c.tagName === 'LI' && !isHiddenEl(c, opts));
    let i = 1;
    for (const li of items) {
      const marker = tag === 'OL' ? `${i}.` : '-';
      renderListItem(li, marker, out, opts, tabGroups, capturedPanelEls, dedupe);
      i++;
    }
    return;
  }

  if (tag === 'TABLE') {
    renderTable(el, out, opts);
    return;
  }

  // A <dl> without <dt>/<dd> is a layout box and falls through to the generic walk.
  if (tag === 'DL' && renderDefinitionList(el, out, opts, tabGroups, capturedPanelEls, dedupe)) return;

  if (tag === 'IMG') {
    if (!opts.includeImages) return;
    const alt = cleanInline(el.getAttribute('alt') || '');
    const src = absUrl(el.getAttribute('src') || el.getAttribute('data-src') || '', opts.baseUrl);
    if (src) out.push(`![${escapeMd(alt || 'image')}](${mdUrl(src)})`);
    return;
  }

  if (tag === 'HR') { out.push('', '---', ''); return; }
  if (tag === 'BR') { out.push(''); return; }

  walkWithTabs(el, out, opts, tabGroups, capturedPanelEls, dedupe);
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
//
// Each block child renders flush left into its own buffer and is then indented under the marker,
// so a CommonMark parser keeps it inside the item (BL-37). Blocks used to start at column 0 after
// a blank line, which ends the list: the code of every "1. Install:" step left its list and the
// numbering restarted, an item STARTING with a block printed a bare `-` and a blank line (an
// empty item), and a nested list indented by depth alone did not nest under `10.`. A bare marker
// is never printed now: the first block line goes on the marker line (`- ```js`), because a bare
// `-` below a line of text is a setext underline and made that text a `##` heading.
const renderListItem = (
  li: Element,
  marker: string,
  out: string[],
  opts: RenderOpts,
  tabGroups: TabGroup[],
  capturedPanelEls: WeakSet<Element>,
  dedupe: TitleDedupe,
): void => {
  // The item's content starts one space after the marker. Later lines sit three spaces in, as
  // they always have, or at the content column when the marker is wider (`10. ` needs four). The
  // rest of a block opened on the marker line sits exactly at the content column: a fence opened
  // there strips no indentation from its code, so any extra space would enter the code.
  const exact = ' '.repeat(marker.length + 1);
  const cont = ' '.repeat(Math.max(3, marker.length + 1));
  let emittedMarker = false;
  // The last block ended on a content line (a nested list does): text after it needs a blank line,
  // or it continues that list's last item.
  let openBlock = false;
  // A <p> is its own paragraph: without a blank line between them, `<li><p>A</p><p>B</p></li>` printed
  // `- A` / `   B`, one paragraph "A B" to a parser (T110 panel: agy, grok; there before BL-37).
  let prev: 'text' | 'para' | 'block' | '' = '';
  let run: Node[] = [];
  const emit = (lines: string[], kind: 'text' | 'para' | 'block'): void => {
    let i = 0;
    let indent = cont;
    if (!emittedMarker) {
      while (i < lines.length && !lines[i].trim()) i++;
      if (i === lines.length) return;
      // `- ---` is a thematic break, not an item holding one (CommonMark 4.1: the break wins), so the item and
      // the text after it left the list. A rule opening a bulleted item is written with stars (T110 panel: grok).
      const first = lines[i++];
      out.push(`${marker} ${marker === '-' && /^-{3,}$/.test(first) ? '***' : first}`);
      emittedMarker = true;
      if (kind === 'block') indent = exact;
    } else if (
      out[out.length - 1] !== '' && (lines[0] ?? '').trim() !== '' &&
      (openBlock || kind === 'para' || (kind === 'text' && prev === 'para'))
    ) {
      // After a nested list a block needs the blank line too: `- - a` / `   x` made `x` part of item `a`
      // (T110 panel: mimo).
      out.push('');
    }
    for (; i < lines.length; i++) out.push(lines[i] ? indent + lines[i] : '');
    openBlock = kind === 'block' && lines[lines.length - 1].trim() !== '';
    prev = kind;
  };
  const emitText = (raw: string, kind: 'text' | 'para'): void => {
    // `- 1. x` would be a list inside the item and `- # x` a heading inside it.
    if (raw) emit(escapeBlockStarts(raw).split('\n'), kind);
  };
  const flushInline = (): void => {
    const text = renderInlineNodes(run, opts, capturedPanelEls).trim();
    run = [];
    emitText(text, 'text');
  };
  for (const node of li.childNodes) {
    if (node.nodeType === 1 /* ELEMENT_NODE */) {
      const c = node as Element;
      if (hiddenKind(c, opts) === 'hidden') continue;
      if (c.tagName === 'P') {
        flushInline();
        emitText(renderInline(c, opts, capturedPanelEls).trim(), 'para');
        continue;
      }
      if (LI_BLOCK_TAGS.has(c.tagName)) {
        // A DIV with no block structure of its own is a styling wrapper: fold it into the
        // inline run so the bullet survives. Pushed whole, not as its children, so two such
        // DIVs stay apart (INLINE_BLOCK_GAP) now that inline parts are no longer space-joined.
        if (c.tagName === 'DIV' && !hasBlockContent(c)) {
          run.push(c);
          continue;
        }
        flushInline();
        const inner: string[] = [];
        renderNodeWithTabs(c, inner, opts, tabGroups, capturedPanelEls, dedupe);
        emit(inner.join('\n').split('\n'), 'block');
        continue;
      }
    }
    run.push(node);
  }
  flushInline();
};

type ElementFilter = { has(el: Element): boolean };

const renderInline = (el: Element, opts: RenderOpts, excludeEls?: ElementFilter): string =>
  renderInlineNodes(hiddenKind(el, opts) === 'code' ? outerPres(el, opts) : [...el.childNodes], opts, excludeEls);

const isAriaHidden = (el: Element): boolean => (el.getAttribute('aria-hidden') || '').toLowerCase() === 'true';

// An element under the `hidden` attribute, whatever its value: a browser renders none of it, and the extension skips
// it by default (includeHiddenMeaningfulText: false). It used to be converted (P2A-012: a grid's 30 closed details
// rows came out as table rows), and hidden text is a channel for instructions that the reader of the page never sees.
// Four kinds stay, each measured on the benchmark corpus: `hidden="until-found"` (a collapsed section the browser's
// find reveals); tab panels, which are all rendered as the extension clicks every tab (Starlight and Biome hide the
// inactive ones); a block holding code, which is a code tab the page did not mark up as one (docs.sentry.io keeps
// its yarn, pnpm, Loader and CDN variants in bare `<div hidden>`s: dropping them lost 5 unique code blocks) or a copy
// buffer repeating visible code; and React streaming segments: React SSR (Next.js, Mintlify) sends late Suspense
// content as `<div hidden id="S:0">`, or `<table hidden><tbody id="S:0">` in a table, and a script moves it into place.
//
// The code exemption keeps the code and nothing else (C13, T121 panel): it exists for code, and a hidden block kept whole
// for one <pre> printed all its prose, so `<div hidden><p>instructions</p><pre>x</pre></div>` carried the instructions.
// hiddenKind says 'code' for such a block; a walk enters only its outermost <pre>s (outerPres). A hidden list item, row,
// cell, caption, term or definition is left out whole, code or not (isHiddenEl): it is one entry of a structure.
type HiddenKind = 'shown' | 'hidden' | 'code';
const hiddenKind = (el: Element, opts: RenderOpts): HiddenKind => {
  if (opts.includeHidden || !el.hasAttribute('hidden')) return 'shown';
  if ((el.getAttribute('hidden') || '').trim().toLowerCase() === 'until-found') return 'shown';
  // A tab panel is a block: all 27 on the corpus are <div>s, and `<a><span hidden role="tabpanel">` printed its text
  // as the link's (T124 panel: mimo).
  if ((el.getAttribute('role') === 'tabpanel' && !PHRASING_TAGS.has(el.tagName)) || el.tagName === 'PRE' || isReactSegment(el)) return 'shown';
  return el.querySelector('pre') ? 'code' : 'hidden';
};
const isHiddenEl = (el: Element, opts: RenderOpts): boolean => hiddenKind(el, opts) !== 'shown';
// Under the attribute at all, the kept kinds included. Code, a link's name, a tab's label and the page's <main> must not
// come from a hidden element of any kind (T124 panel: `<a><span hidden role="tabpanel">x</span></a>` was named x, and a
// <main> inside a hidden tab panel became the root and dropped the visible <main>).
const underHiddenAttr = (el: Element, opts: RenderOpts): boolean => !opts.includeHidden && el.hasAttribute('hidden');

// React streaming segments as react-dom's server writes them (ReactFizzConfigDOM.js, startSegment*): `<div hidden id=…>`,
// in a table context `<table hidden id=…>` or a `<table hidden>` whose <tbody>, <tr> or <colgroup> carries the id. The id
// is the render's identifierPrefix, `S:` and the segment number in hex. A child's `S:` id counted on any hidden element
// (C14, grok), and so did any element and anything after `S:`: `<img hidden id="S:0">` printed its alt and `id="S:evil"`
// passed (T124 panel: codex, mimo). An HTML parser puts a <tbody> around `<table><tr>`, so a saved or re-serialised page
// has `<table hidden><tbody><tr id=…>` (grok).
const SEGMENT_ID = /S:[0-9a-f]+$/;
const isReactSegment = (el: Element): boolean => {
  if (el.tagName === 'DIV') return SEGMENT_ID.test(el.id);
  if (el.tagName !== 'TABLE') return false;
  if (SEGMENT_ID.test(el.id)) return true;
  return [...el.children].some((c) =>
    (/^(?:TBODY|TR|COLGROUP)$/.test(c.tagName) && SEGMENT_ID.test(c.id)) ||
    (c.tagName === 'TBODY' && !c.id && [...c.children].some((r) => r.tagName === 'TR' && SEGMENT_ID.test(r.id))));
};

// The <pre> elements of a block, outermost only, without those in a hidden list item, row, cell or other entry of a
// structure: such an entry is left out whole wherever it stands (T124 panel: codex, `<div hidden><ul><li hidden><pre>`
// printed the code that the same <li hidden> outside a hidden block drops).
const HIDDEN_ENTRY = /^(?:LI|TR|TD|TH|CAPTION|DT|DD|THEAD|TBODY|TFOOT)$/;
const outerPres = (el: Element, opts: RenderOpts): Element[] =>
  ([...el.querySelectorAll('pre')] as Element[]).filter((p) => {
    if (p.parentElement?.closest('pre')) return false;
    for (let e = p.parentElement; e && e !== el; e = e.parentElement) if (HIDDEN_ENTRY.test(e.tagName) && isHiddenEl(e, opts)) return false;
    return true;
  });

// A line of page TEXT that starts with Markdown block syntax becomes that block: `# x` a heading, `> x`
// a quote, `1. x` a list, `---` a rule, `<div` raw HTML, and an unclosed ``` fence swallows every line
// after it (T109 panel: `<div>```</div><p>AFTER</p>` put AFTER inside a code block). The renderer's own
// inline markup never starts a line with any of these, so escaping each emitted line start is safe.
const escapeBlockStart = (line: string): string => {
  const lead = /^[ \t]*/.exec(line)![0];
  const rest = line.slice(lead.length);
  if (
    /^(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|~{3}|<[A-Za-z/!?])/.test(rest) ||
    /^`{3,}[^`]*$/.test(rest) ||
    /^(?:=+|-+)\s*$/.test(rest) ||
    /^([*_-])(?:\s*\1){2,}\s*$/.test(rest)
  ) return `${lead}\\${rest}`;
  const ol = /^\d{1,9}(?=[.)](?:\s|$))/.exec(rest);
  return ol ? `${lead}${ol[0]}\\${rest.slice(ol[0].length)}` : line;
};
const escapeBlockStarts = (text: string): string => text.split('\n').map(escapeBlockStart).join('\n');

const escapeLinkText = (t: string): string => t.replace(/[\\[\]]/g, '\\$&');

// A link destination may hold parentheses only in balanced pairs, and no spaces, angle brackets or
// ASCII control characters (CommonMark 6.3): `https://x.test/a)b` ended the link after `a`, and a
// relative href that could not be resolved kept its spaces (BL-37). Those characters are
// percent-encoded, so the URL still works when copied out of the Markdown. Only the parentheses that
// have no partner are encoded: `/wiki/Foo_(bar)?x=)` keeps `Foo_(bar)` as written (T110 panel: grok).
const mdUrl = (u: string): string => {
  const open: number[] = [];
  const unpaired = new Set<number>();
  for (let i = 0; i < u.length; i++) {
    if (u[i] === '(') open.push(i);
    else if (u[i] === ')' && open.pop() === undefined) unpaired.add(i);
  }
  for (const i of open) unpaired.add(i);
  const parens = unpaired.size
    ? u.split('').map((ch, i) => (unpaired.has(i) ? (ch === '(' ? '%28' : '%29') : ch)).join('')
    : u;
  return parens.replace(/[\s<>\x00-\x1f\x7f]/g, (c) => encodeURIComponent(c));
};

// A link's text as Markdown, on one line: rendered inline with only the brackets and backslashes of its
// TEXT escaped. escapeMd over the already rendered text turned `<a><code>x</code></a>` into [\`x\`](u)
// and bold link text into literal \*\* stars (T109 panel: spark, grok, mimo; there since 0.1.0).
const linkText = (a: Element, opts: RenderOpts, href: string, excludeEls?: ElementFilter, trim = true): string => {
  const inner = renderInline(a, href ? { ...opts, inLink: true } : opts, excludeEls).replace(/[ \t]*\n[ \t]*/g, ' ');
  if (inner.trim()) return trim ? inner.trim() : inner;
  const fallback = cleanInline(linkName(a, opts));
  return href ? escapeLinkText(fallback) : fallback;
};

// The name of a link whose content renders to nothing: its text, which keeps an icon's SVG <title>, as textContent did.
// textContent also returned the text of hidden elements (C7a, codex: `<a><span hidden>x</span></a>` printed x) and of a
// <style> or <script>, which name nothing. An image's alt is not used here: in a table cell the image already renders as
// its alt (C11a), and with includeImages: false an image link stays out, as the option says (the alt fallback wrote
// `[User avatar](profile)` before every author on the phpBB corpus page, T124 A/B).
const linkName = (a: Element, opts: RenderOpts): string => nameText(a, opts);

// The text an element is named by, a link that renders empty or a tab: its text without what is not drawn, which is a
// hidden element of any kind, the fallback of a skipped element (<noscript>, <canvas>, <object>, <video>), and inside an
// SVG the parts SVG does not render (<defs>, <symbol>, <desc>, <metadata>). T124 panel: codex, grok, agy. An SVG's
// <title> and <text> stay: the <title> names an icon.
const SVG_UNDRAWN = /^(?:DEFS|SYMBOL|DESC|METADATA|STYLE|SCRIPT|CLIPPATH|MASK|PATTERN|MARKER|LINEARGRADIENT|RADIALGRADIENT|FILTER)$/;
const nameText = (el: Element, opts: RenderOpts): string => {
  let s = '';
  const walk = (n: Node, svg: boolean): void => {
    if (n.nodeType === 3 /* TEXT_NODE */) { s += n.textContent || ''; return; }
    if (n.nodeType !== 1 /* ELEMENT_NODE */) return;
    const e = n as Element;
    const tag = e.tagName.toUpperCase();
    if (underHiddenAttr(e, opts) || (svg ? SVG_UNDRAWN.test(tag) : SKIP_TAGS.has(tag) && tag !== 'SVG')) return;
    for (const c of e.childNodes) walk(c, svg || tag === 'SVG');
  };
  for (const c of el.childNodes) walk(c, false);
  return s;
};

// The text of code as a browser lays it out: a <br> is a line break, and hidden elements are left out. textContent
// skips the first and keeps the second: Docusaurus ends every line of a code block with a <br> and writes no newline
// character, so `cd my-website` and `npx docusaurus start` came out as one line (benchmark corpus, T124), `x<br>y` in
// inline code read `xy` (C5, codex), and `<code>a<span hidden>s</span>b</code>` printed the hidden s (C7b, codex).
// Outside a <pre> a newline in the source is only whitespace, so inline code marks a <br> with BR_MARK instead.
const BR_MARK = '\u0000';
const codeText = (el: Element, opts: RenderOpts, br = '\n'): string => {
  let s = '';
  const walk = (n: Node): void => {
    if (n.nodeType === 3 /* TEXT_NODE */) { s += n.textContent || ''; return; }
    if (n.nodeType !== 1 /* ELEMENT_NODE */) return;
    const e = n as Element;
    // Hidden elements of every kind and skipped ones before the <br>: `<br hidden>` breaks no line, a <style> in code is
    // not code, and a tab panel or an `S:` span inside code is no code tab (T124 panel: codex, grok, agy).
    if (underHiddenAttr(e, opts) || SKIP_TAGS.has(e.tagName)) return;
    if (e.tagName === 'BR') { s += br; return; }
    for (const c of e.childNodes) walk(c);
  };
  for (const c of el.childNodes) walk(c);
  return s;
};

// Lines of code as inline Markdown: one code span per line, the lines joined by a line break, which a table cell writes
// as <br> (C28: a <pre> in a cell folded into one line; C5). Blank lines at either end are dropped.
const codeLines = (raw: string[]): string => {
  const lines = raw.map(collapseWs);
  while (lines.length > 1 && !lines[0].trim()) lines.shift();
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
  return lines.map((l) => wrapInline(l, codeSpan)).join('\n');
};

// A code span needs a fence longer than any backtick run inside it, padded with a space when the text
// starts or ends with a backtick (CommonMark 6.1): `a`b` closed after "a", and ``x`` lost its backticks.
const codeSpan = (t: string): string => {
  const fence = '`'.repeat(longestRun(t, '`') + 1);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
};

const WORD_START = /^[\p{L}\p{N}]/u;
const WORD_END = /[\p{L}\p{N}]$/u;
const PUNCT_START = /^[\p{P}\p{S}]/u;
const PUNCT_END = /[\p{P}\p{S}]$/u;
// Scripts written without spaces between words.
const UNSPACED_START = /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;
const UNSPACED_END = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]$/u;

// Two ELEMENTS with nothing between them in the source get a space (a flex row of
// `<span>Plan</span><span>starter</span>`, a pilcrow link after a heading link: the gap is CSS), except
// where the junction sits inside one token: a script written without spaces (`東`+`京`), a currency
// and its amount (`$`+`19.99`), punctuation that attaches to what precedes it (`19`+`.99`, `60`+`%`),
// an opening bracket and what follows it, an `@` (`user`+`@x.test`). The blanket space split all of
// those (T109 panel). The panel's own proposal, a space only between two alphanumerics, glued
// `Inc.·[Trademark`, `more.[View docs` and `👍No` on the benchmark corpus, so it was not taken.
const wordsTouch = (left: string, right: string): boolean =>
  !!left && !!right &&
  !(UNSPACED_END.test(left) || UNSPACED_START.test(right) ||
    (/\p{Sc}$/u.test(left) && /^\p{N}/u.test(right)) ||
    /^[.,;:!?%)\]}»”’@]/u.test(right) || /[([{«“‘@]$/u.test(left));

const collapseWs = (t: string): string => t.replace(/ /g, ' ').replace(/[ \t\r\n\f]+/g, ' ');

// Markup keeps its content's edge whitespace OUTSIDE the delimiters: `<b> bold </b>` must become
// ` **bold** `, because `** bold **` is not emphasis.
const wrapInline = (inner: string, wrap: (core: string) => string): string => {
  const core = inner.trim();
  if (!core) return /\s/.test(inner) ? ' ' : '';
  return (/^\s/.test(inner) ? ' ' : '') + wrap(core) + (/\s$/.test(inner) ? ' ' : '');
};

// Inline parts are concatenated with the source's own whitespace, never a separator of ours.
// linkedom splits text at EVERY character reference - `account&#39;s` arrives as the text nodes
// "account", "'", "s", and `caf&eacute;` as "caf", "é" - so the old `parts.join(' ')` broke each
// word holding one (P2A-002), and put a space between a link and the full stop after it. Two
// ELEMENTS with nothing between them get a space only between words (wordsTouch).
//
// Where markup is glued to its neighbour, the junction must still parse as intended (T109, checked
// with micromark): `**Note:**text` and `word**(x)**` are literal stars because the delimiter sits
// between punctuation and a letter, so emphasis is spaced from the letter there; `Hey!` + `[link](u)`
// is an image and `C:\` + `[d](u)` escapes the bracket, so that `!` or `\` is escaped.
//
// No textContent fallback for elements that render empty, except a link's name: it could only
// resurface text the skip list removes on purpose (script, style, an icon's SVG <title>).
const renderInlineNodes = (nodes: Node[], opts: RenderOpts, excludeEls?: ElementFilter): string => {
  let s = '';
  let afterElement = false;
  let lastVisible = '';
  let punctEdge = false;
  const add = (part: string, fromElement: boolean, visible = part, leadPunct = false): void => {
    if (!part) return;
    if (s && !/\s$/.test(s) && !/^\s/.test(part)) {
      if (fromElement && afterElement && ((!opts.tight && wordsTouch(lastVisible, visible)) || (s.endsWith('*') && part.startsWith('*')))) {
        s += ' ';
      } else if ((punctEdge && WORD_START.test(part)) || (leadPunct && WORD_END.test(s))) {
        s += ' ';
      } else if (fromElement && /(?:^|[^\\])(?:\\\\)*\\$/.test(s) && /^[[!*`_]/.test(part)) {
        s += '\\';
      } else if (fromElement && part.startsWith('[') && /(?:^|[^\\])(?:\\\\)*!$/.test(s)) {
        s = `${s.slice(0, -1)}\\!`;
      }
    }
    s += part;
    afterElement = fromElement;
    lastVisible = visible;
    punctEdge = false;
  };
  const visibleText = (el: Element, rendered: string): string => collapseWs(el.textContent || '').trim() || rendered.trim();
  for (const node of nodes) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const t = collapseWs(node.textContent || '');
      add(opts.inLink ? escapeLinkText(t) : t, false, t);
      continue;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const c = node as Element;
    if (excludeEls && excludeEls.has(c)) continue;
    const tag = c.tagName;
    // aria-hidden is NOT skipped here, although the block walk skips it: docs.sentry.io puts the whole text
    // of 15 <h2>s inside `<a aria-hidden="true">`, and skipping it deleted every one (T109 A/B). The
    // attribute hides from screen readers, not from the screen. `hidden` hides from both (isHiddenEl).
    const hidden = hiddenKind(c, opts);
    if (SKIP_TAGS.has(tag) || hidden === 'hidden') continue;
    if (hidden === 'code') {
      // Each <pre> is set on its own lines by the PRE branch below.
      const code = renderInlineNodes(outerPres(c, opts), opts, excludeEls);
      add(code, true, code.trim());
      continue;
    }
    if (tag === 'BR') { add('\n', false); continue; }
    if (tag === 'PRE') {
      // A <pre> in inline position, which is in a table cell or a link: its lines stay lines (codeLines).
      const code = codeLines(codeText(c, opts).replace(/\r/g, '').split('\n'));
      add(`\n${code}\n`, true, collapseWs(c.textContent || '').trim());
      continue;
    }
    if (tag === 'TABLE') {
      // In inline position a table is nested in a table cell (the block walk renders every other one): its rows
      // become lines of the cell instead of rows of the outer table (P2A-013).
      add(` ${flattenTable(c, opts, excludeEls)} `, true, collapseWs(c.textContent || '').trim());
      continue;
    }
    if (tag === 'A') {
      const href = absUrl(c.getAttribute('href') || '', opts.baseUrl);
      const text = linkText(c, opts, href, excludeEls, false);
      add(wrapInline(text, (t) => (href ? `[${t}](${mdUrl(href)})` : t)), true, visibleText(c, text));
      continue;
    }
    if (tag === 'STRONG' || tag === 'B' || tag === 'EM' || tag === 'I') {
      const mark = tag === 'STRONG' || tag === 'B' ? '**' : '*';
      const inner = renderInline(c, opts, excludeEls);
      const core = inner.trim();
      add(wrapInline(inner, (t) => `${mark}${t}${mark}`), true, visibleText(c, inner), PUNCT_START.test(core));
      punctEdge = PUNCT_END.test(core) && !/\s$/.test(inner);
      continue;
    }
    if (tag === 'CODE') {
      const lines = codeText(c, opts, BR_MARK).split(BR_MARK);
      add(codeLines(lines), true, collapseWs(lines.join(' ')).trim());
      continue;
    }
    if (tag === 'IMG') {
      // Same includeImages contract and src fallback as the block-level IMG branch: an image
      // wrapped in a link, list item, table cell or text run arrives here instead.
      if (!opts.includeImages) {
        // A table cell shows no image but keeps its alt text, the text that stands for an image which is not shown (HTML,
        // "the img element"): a severity icon's CRITICAL came out as an empty cell (C11b, T121 panel). An empty alt marks
        // a decorative image and adds nothing, and so does aria-hidden="true" (T124 panel: agy, a bullet image wrote
        // "bullet point" before every value).
        const alt = opts.imageAlt && !isAriaHidden(c) ? cleanInline(c.getAttribute('alt') || '') : '';
        if (alt) add(` ${opts.inLink ? escapeLinkText(alt) : alt} `, true, alt);
        continue;
      }
      const alt = cleanInline(c.getAttribute('alt') || '');
      const src = absUrl(c.getAttribute('src') || c.getAttribute('data-src') || '', opts.baseUrl);
      if (src) add(`![${escapeMd(alt || 'image')}](${mdUrl(src)})`, true, alt || 'image');
      continue;
    }
    // Any other element, inline or a container in inline position (a P or styling DIV inside an
    // <li>, a custom element): recurse so links and emphasis inside it survive as markdown.
    const inner = renderInline(c, opts, excludeEls);
    add(INLINE_BLOCK_GAP.has(tag) ? ` ${inner} ` : inner, true, visibleText(c, inner));
  }
  return s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n');
};

// <dl> as the extension renders it (lib/core/html-to-md.ts in page2ai-extension): each term bold
// on its own line, each definition on a `: ` line below it, which is the definition-list syntax
// of Pandoc and PHP Markdown Extra and still plain to read where neither applies. HTML allows a
// <div> around each term/definition group, so groups are looked into one level deep. Returns
// false when the list holds no <dt>/<dd> at all, so the caller walks it as a plain container.
//
// Unlike the extension, a <dd> holding block content is walked, not flattened: Sphinx puts a
// whole API entry (paragraphs, code examples, tables, nested <dl>s) inside one <dd>, and the first
// draft of this branch turned docs.python.org's code fences and tables into one line of text.
const renderDefinitionList = (
  dl: Element,
  out: string[],
  opts: RenderOpts,
  tabGroups: TabGroup[],
  capturedPanelEls: WeakSet<Element>,
  dedupe: TitleDedupe,
): boolean => {
  const isItem = (n: Node): boolean => n.nodeType === 1 && ((n as Element).tagName === 'DT' || (n as Element).tagName === 'DD');
  const isGroup = (n: Node): boolean => n.nodeType === 1 && (n as Element).tagName === 'DIV' && [...(n as Element).childNodes].some(isItem);
  if (![...dl.childNodes].some((n) => isItem(n) || isGroup(n))) return false;
  // Everything else in the list (a note, a heading, bare text: invalid HTML that browsers still show)
  // is walked where it stands. The first version collected only <dt>/<dd> and silently dropped the
  // rest, text 0.1.11 had printed (T109 panel, agy + grok: `<dl><p>Note</p><dt>..` lost "Note").
  const seq: Node[] = [];
  for (const n of dl.childNodes) {
    if (n.nodeType === 1 && isHiddenEl(n as Element, opts)) continue;
    if (isGroup(n)) seq.push(...[...(n as Element).childNodes].filter((c) => c.nodeType !== 1 || !isHiddenEl(c as Element, opts)));
    else seq.push(n);
  }
  let lines: string[] = [];
  let stray: Node[] = [];
  const flushLines = (): void => {
    if (lines.length) out.push('', ...lines, '');
    lines = [];
  };
  const flushStray = (): void => {
    if (stray.length) walkNodes(stray, out, opts, tabGroups, capturedPanelEls, dedupe);
    stray = [];
  };
  for (const n of seq) {
    if (!isItem(n)) {
      if (n.nodeType === 1 ? !SKIP_TAGS.has((n as Element).tagName) : n.nodeType === 3 && /\S/.test(n.textContent || '')) {
        flushLines();
        stray.push(n);
      }
      continue;
    }
    flushStray();
    const it = n as Element;
    if (it.tagName === 'DD' && hasBlockContent(it)) {
      flushLines();
      walkWithTabs(it, out, opts, tabGroups, capturedPanelEls, dedupe);
      continue;
    }
    const text = renderInline(it, opts, capturedPanelEls).trim();
    if (!text) continue;
    if (it.tagName === 'DT') {
      lines.push(`**${text}**`);
      continue;
    }
    text.split('\n').filter((l) => l.trim()).forEach((l, i) => lines.push(`${i === 0 ? ': ' : '  '}${i === 0 ? l : escapeBlockStart(l)}`));
  }
  flushStray();
  flushLines();
  return true;
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

const renderCodeBlock = (pre: Element, out: string[], opts: RenderOpts): void => {
  // The first <code> not under a hidden element: a hidden one replaced the visible text (T124 panel: codex,
  // `<pre>VISIBLE<code hidden>SECRET</code>TAIL</pre>` printed SECRET where Chromium shows VISIBLETAIL).
  const codeEl = ([...pre.querySelectorAll('code')] as Element[]).find((c) => {
    for (let e: Element | null = c; e && e !== pre; e = e.parentElement) if (underHiddenAttr(e, opts)) return false;
    return true;
  }) || pre;
  const text = codeText(codeEl, opts).replace(/\r/g, '').replace(/^\n+|\n+$/g, '');
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

// The table's own rows and cells. A descendant query also took those of a table nested in a cell: the inner rows came
// out again as rows of the outer table and the inner cells widened the row holding it (P2A-013: 2 columns became 5).
// Rows and cells under `hidden`, or inside a hidden row group, are left out (P2A-012).
const hiddenUpTo = (el: Element, stop: Element | null, opts: RenderOpts): boolean => {
  for (let e: Element | null = el; e && e !== stop; e = e.parentElement) if (isHiddenEl(e, opts)) return true;
  return false;
};
const ownRows = (tbl: Element, opts: RenderOpts): Element[] =>
  [...tbl.querySelectorAll('tr')].filter((tr) => tr.closest('table') === tbl && !hiddenUpTo(tr, tbl, opts));
const ownCells = (tr: Element, opts: RenderOpts): Element[] =>
  [...tr.querySelectorAll('th, td')].filter((c) => c.closest('tr') === tr && !hiddenUpTo(c, tr, opts));
const ownCaption = (tbl: Element, opts: RenderOpts): Element | undefined =>
  [...tbl.children].find((c) => c.tagName === 'CAPTION' && !isHiddenEl(c, opts));

// A cell as inline Markdown on one line, rendered like any other inline content: links keep their target and code its
// backticks (P2A-010: every row of a users list lost its link), whitespace collapses as a browser collapses it (a
// pretty-printed template's indentation used to become `<br> value<br>`), a block child is spaced from its neighbours
// and a <br> stays a line break (`<br>`). An image is written as its alt text: the image itself stays out of cells, as it
// always has.
const CELL = { includeImages: false, tight: true, imageAlt: true };
const cellMd = (el: Element, opts: RenderOpts): string =>
  renderInline(el, { ...opts, ...CELL })
    .replace(/ *\n */g, '\n')
    .replace(/^\n+|\n+$/g, '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br>')
    .replace(/[ \t]+/g, ' ')
    .trim();

// The rows as a grid of slots, laid out as the HTML table model lays them: a cell spanning columns or rows leaves `null`
// in the slots it covers, so the cells after it stay under their own headers (C6, codex: the cell after a colspan="2"
// landed one column left). Spans are clamped as browsers clamp them (colspan 1..1000, rowspan 0..65534), and a span ends
// with its row group, a <thead>, a <tbody>, a <tfoot> or a run of rows straight under <table>; rowspan="0" spans the
// rest of the group. Chromium puts the <tbody> row after a <thead> rowspan="2" under the headers, where the grid pushed
// it one column right (HTML: "A cell cannot cover slots that are from two or more row groups"; T124 panel: codex, grok,
// mimo, agy; audits/T125-2026-10-16/scripts/browser_layout_check.py). A row under `hidden` takes no part: Chromium lays a
// rowspan over the next shown row. Only the columns in which some cell starts are kept: `colspan="100"` on a details
// row means "the full width", not a hundred columns. The extension pads a colspan with empty cells the same way (max 20,
// no rowspan).
// The page decides the spans, so the slots they cover are budgeted: past SPAN_SLOTS the table gets the plain layout,
// cells in source order, which is what earlier versions printed for every table.
const SPAN_SLOTS = 100000;
const tableGrid = (rows: Element[], opts: RenderOpts): Array<Array<Element | null>> => {
  const grid: Array<Array<Element | null | undefined>> = rows.map(() => []);
  const starts = new Set<number>();
  let covered = 0;
  const groupEnd: number[] = [];
  for (let r = rows.length - 1; r >= 0; r--) {
    groupEnd[r] = r + 1 < rows.length && rows[r + 1].parentElement === rows[r].parentElement ? groupEnd[r + 1] : r + 1;
  }
  for (let r = 0; r < rows.length; r++) {
    let col = 0;
    const left = groupEnd[r] - r;
    for (const cell of ownCells(rows[r], opts)) {
      while (grid[r][col] !== undefined) col++;
      const cs = Math.min(Math.max(parseInt(cell.getAttribute('colspan') || '', 10) || 1, 1), 1000);
      const rsRaw = parseInt(cell.getAttribute('rowspan') || '', 10);
      const rs = rsRaw === 0 ? left : Math.min(Math.max(rsRaw || 1, 1), 65534, left);
      covered += cs * rs - 1;
      if (covered > SPAN_SLOTS) return rows.map((tr) => ownCells(tr, opts));
      for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) grid[r + dr][col + dc] = dr || dc ? null : cell;
      starts.add(col);
      col += cs;
    }
  }
  const keep = [...starts].sort((a, b) => a - b);
  return grid.map((row) => keep.map((c) => row[c] || null));
};

// A table nested in a cell, as lines of that cell: its caption, then one line per row, a header cell joined to the
// data cell after it by ": " (the key/value tables of a details row read `k: v`) and other cells by " · ". Under a header
// row (two or more header cells and nothing else) an empty cell keeps its place, `a · · c`: dropping it moved every later
// value under the header before it (C18, agy).
const flattenTable = (tbl: Element, opts: RenderOpts, excludeEls?: ElementFilter): string => {
  const one = (el: Element): string => renderInline(el, opts, excludeEls).replace(/\s+/g, ' ').trim();
  const cap = ownCaption(tbl, opts);
  const lines = cap && one(cap) ? [one(cap)] : [];
  const grid = tableGrid(ownRows(tbl, opts), opts);
  const head = (grid[0] || []).filter((c): c is Element => !!c);
  const positional = head.length >= 2 && head.every((c) => c.tagName === 'TH');
  for (const row of grid) {
    const cells = row.map((c) => ({ t: c ? one(c) : '', th: c?.tagName === 'TH' }));
    while (cells.length && !cells[cells.length - 1].t) cells.pop();
    let line = '';
    let started = false;
    let afterTh = false;
    for (const { t, th } of cells) {
      if (!t && !positional) continue;
      if (started) line += afterTh && !th ? (line.endsWith(':') ? ' ' : ': ') : ' · ';
      line += t;
      started = true;
      afterTh = th;
    }
    if (line) lines.push(line);
  }
  return lines.join('\n');
};

const renderTable = (tbl: Element, out: string[], opts: RenderOpts): void => {
  const rows = ownRows(tbl, opts);
  if (!rows.length) return;
  // <caption> text was never printed (grok, T109): it names the table.
  const capEl = ownCaption(tbl, opts);
  const caption = capEl ? escapeBlockStart(renderInline(capEl, { ...opts, ...CELL }).replace(/\s+/g, ' ').trim()) : '';
  if (caption) out.push('', caption);
  const data = tableGrid(rows, opts).map((row) => row.map((c) => (c ? cellMd(c, opts) : '')));
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
