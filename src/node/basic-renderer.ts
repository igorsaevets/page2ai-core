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
import { absUrl, chooseCodeFence, cleanInline, escapeMd, escapeMdTableCell } from '../shared/utils.js';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS']);
const INLINE_TAGS = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'CODE', 'SPAN', 'SMALL', 'MARK', 'U', 'S', 'DEL', 'INS', 'SUB', 'SUP', 'ABBR', 'CITE', 'Q', 'DFN', 'KBD', 'SAMP', 'VAR', 'TIME']);
const KNOWN_LANGS = new Set(['bash', 'sh', 'shell', 'python', 'py', 'javascript', 'js', 'typescript', 'ts', 'tsx', 'jsx', 'json', 'yaml', 'yml', 'toml', 'html', 'css', 'sql', 'go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'php', 'ruby', 'markdown', 'md', 'mermaid', 'dockerfile', 'text']);

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

  if (opts.includeFrontmatter) {
    parts.push(...buildFrontmatter(doc, opts.baseUrl));
  }

  const title = cleanInline(doc.querySelector('title')?.textContent || '');
  if (title) parts.push(`# ${title}`, '');

  const root = pickContentRoot(doc);
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

const buildFrontmatter = (doc: Document, baseUrl: string): string[] => {
  const title = cleanInline(doc.querySelector('title')?.textContent || '');
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
  fm.push(`extractor_version: ${yq('0.1.0')}`);
  fm.push('---', '');
  return fm;
};

const pickContentRoot = (doc: Document): Element | null => {
  const cand =
    doc.querySelector('main article') ||
    doc.querySelector('article') ||
    doc.querySelector('main') ||
    doc.querySelector('[role="main"]') ||
    doc.body ||
    doc.documentElement ||
    null;
  return (cand as unknown as Element) || null;
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
    const panels = siblingPanels.map((p) => ({
      label: p.getAttribute('aria-labelledby') ||
             p.getAttribute('aria-label') ||
             p.getAttribute('data-value') ||
             p.id ||
             'Panel',
      el: p,
    }));
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
      const text = renderInline(li, opts).trim();
      if (text) out.push(`${pfx}${marker} ${text}`);
      for (const sub of li.children) {
        if (sub.tagName === 'UL' || sub.tagName === 'OL') {
          renderNodeWithTabs(sub, out, depth + 1, opts, tabGroups, capturedPanelEls);
        }
      }
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

const renderInline = (el: Element, opts: RenderOpts): string => {
  const parts: string[] = [];
  for (const node of el.childNodes) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const t = cleanInline(node.textContent || '');
      if (t) parts.push(t);
      continue;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const c = node as Element;
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
    const t = cleanInline(c.textContent || '');
    if (t) parts.push(t);
  }
  return parts.join(' ').replace(/\s+\n\s+/g, '\n');
};

const renderCodeBlock = (pre: Element, out: string[]): void => {
  const codeEl = pre.querySelector('code') || pre;
  const text = (codeEl.textContent || '').replace(/\r/g, '').replace(/^\n+|\n+$/g, '');
  if (!text.trim()) return;

  let lang = '';
  const codeClass = codeEl.getAttribute('class') || pre.getAttribute('class') || '';
  const langMatch = codeClass.match(/language-([a-z0-9_+#.-]+)/i);
  if (langMatch) {
    const l = langMatch[1].toLowerCase();
    if (KNOWN_LANGS.has(l) || /^[a-z][a-z0-9]{0,15}$/.test(l)) lang = l;
  }
  const dataLang = pre.getAttribute('data-language') || codeEl.getAttribute('data-language') || '';
  if (!lang && dataLang) {
    const l = dataLang.toLowerCase();
    if (KNOWN_LANGS.has(l) || /^[a-z][a-z0-9]{0,15}$/.test(l)) lang = l;
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
