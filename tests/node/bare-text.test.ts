// Regression tests for three defects reported 2026-10-15 from real use (D:\WEB to MD\incoming-bugs,
// P2A-001..003), all found on a server-rendered admin page whose output LOOKED complete:
//
//   P2A-001  text outside a recognised block tag was dropped: the walk iterated element children
//            only, so `<div>Hello</div>`, a metric tile, a key/value grid, text beside a <br>, a
//            <section>'s own sentence and every <dl> term vanished (25 of 26 labels on that page).
//   P2A-002  an entity inside a word split it: linkedom yields `account&#39;s` as three text nodes
//            and the inline renderer joined parts with a space ("account ' s").
//   P2A-003  a fragment without <html>/<body> converted to "" with no error.
//
// The last block asserts the property instead of examples: every visible text node of a
// dashboard-shaped page must reach the output. That check is what would have caught P2A-001.

import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (html: string): string =>
  htmlToMarkdown(html, { baseUrl: 'https://example.test/', includeFrontmatter: false }).markdown.trim();
const page = (body: string): string => `<html><body><main>${body}</main></body></html>`;

describe('P2A-001: text outside block tags', () => {
  it.each([
    ['bare div beside a p', '<div>Hello div</div><p>Hello p</p>', 'Hello div\n\nHello p'],
    ['span directly in a div', '<div><span>Span text</span></div>', 'Span text'],
    ['card heading + div', '<div class="card"><h3>Activity</h3><div>Period: 7 days</div></div>', '### Activity\n\nPeriod: 7 days'],
    ['metric tile', '<div class="tile"><div class="label">Recordings</div><div class="value">5</div></div>', 'Recordings: 5'],
    // P2A-014: label/value grids with class hints (k/v, label/value) and short texts
    // are now paired as "Label: value" instead of two paragraphs (heuristic in basic-renderer).
    ['key/value grid', '<h3>Billing</h3><div class="kv"><div class="k">Plan</div><div class="v">starter</div></div>', '### Billing\n\nPlan: starter'],
    ['section > div', '<section><div>In a section</div></section>', 'In a section'],
    ['div with br', '<div>line one<br>line two</div>', 'line one\nline two'],
    ['div text then p', '<div>Outer text<p>Inner p</p></div>', 'Outer text\n\nInner p'],
    ['bare blockquote text', '<blockquote>Quoted bare</blockquote>', '> Quoted bare'],
    ['text around a link', '<div>Read the <a href="/d">docs</a>. Now.</div>', 'Read the [docs](https://example.test/d). Now.'],
    ['script inside a run', '<div>Text <script>track()</script> more</div>', 'Text more'],
    ['aria-hidden inside a run', '<div>Save <span aria-hidden="true">*</span>now</div>', 'Save now'],
  ])('%s', (_label, body, expected) => {
    expect(md(page(body))).toBe(expected);
  });

  it('keeps a text-less row of links one per line, as before', () => {
    expect(md(page('<nav><a href="/1">One</a><a href="/2">Two</a></nav>'))).toBe(
      '[One](https://example.test/1)\n[Two](https://example.test/2)',
    );
  });

  it('does not emit option lists or embed fallbacks', () => {
    const out = md(page('<p>Pick</p><select><option>Belarus</option><option>Chile</option></select><video>Your browser does not support video</video>'));
    expect(out).toBe('Pick');
  });

  it('renders <dl> terms and definitions, including <div>-wrapped groups', () => {
    expect(md(page('<h3>Billing</h3><dl><dt>Plan</dt><dd>starter</dd><div><dt>Credits</dt><dd>149</dd></div></dl>'))).toBe(
      '### Billing\n\n**Plan**\n: starter\n**Credits**\n: 149',
    );
  });

  it('walks a <dd> that holds blocks instead of flattening it (Sphinx API entries)', () => {
    const out = md(page('<dl><dt>run(coro)</dt><dd><p>Run it.</p><pre><code class="language-python">run(main())</code></pre><table><tr><th>a</th></tr><tr><td>1</td></tr></table></dd></dl>'));
    expect(out).toContain('**run(coro)**');
    expect(out).toContain('```python\nrun(main())\n```');
    expect(out).toContain('| a |');
  });

  it('walks a <dl> with no <dt>/<dd> as a plain container', () => {
    expect(md(page('<dl><div>Layout text</div></dl>'))).toBe('Layout text');
  });
});

describe('P2A-002: inline whitespace comes from the source, not from the renderer', () => {
  it.each([
    ['&#39; inside a word', "<p>the account&#39;s billing row</p>", "the account's billing row"],
    ['&amp; inside a word', '<p>AT&amp;T</p>', 'AT&T'],
    ['&quot; around a word', '<p>say &quot;hi&quot; now</p>', 'say "hi" now'],
    ['named entity in a word', '<p>caf&eacute; menu</p>', 'café menu'],
    ['&#x2019; apostrophe', '<p>it&#x2019;s here</p>', 'it’s here'],
    ['emphasis edge whitespace moves outside', '<p>a<b> bold </b>word</p>', 'a **bold** word'],
    ['adjacent elements stay apart', '<p><span>Plan</span><span>starter</span></p>', 'Plan starter'],
    ['two styling divs folded into a bullet', '<ul><li><div>a</div><div>b</div></li></ul>', '- a b'],
  ])('%s', (_label, body, expected) => {
    expect(md(page(body))).toBe(expected);
  });
});

describe('P2A-003: fragments and other non-document input', () => {
  it.each([
    ['fragment starting with <style>', '<style>.a{}</style><div class="card"><h3>Billing</h3><p>From the drill.</p></div>', '### Billing\n\nFrom the drill.'],
    ['two top-level elements', '<h1>T</h1><p>Para</p>', '# T\n\nPara'],
    ['<head> and <body> without <html>', '<head><title>T</title></head><body><p>x</p></body>', '# T\n\nx'],
    ['plain text', 'just text, no tags', 'just text, no tags'],
  ])('%s', (_label, html, expected) => {
    expect(md(html)).toBe(expected);
  });

  it('says so instead of returning "" when nothing is extractable', () => {
    expect(md('')).toBe('<!-- AI: page has no extractable body content -->');
    expect(md('<html><body><div id="root"></div></body></html>')).toBe('<!-- AI: page has no extractable body content -->');
  });
});

describe('nothing visible is dropped', () => {
  // Dashboard-shaped, as server templates emit it: cards, a key/value grid, metric tiles, a <dl>,
  // a table, entity-escaped text. Synthetic values only.
  const DASHBOARD = `<html><head><title>Account</title><style>.k{}</style></head><body>
  <nav><a href="/">Home</a><a href="/users">Users</a></nav>
  <main>
    <div class="card"><h3>Activity</h3><div>Period: 7 days</div><div>Updated <time>2026-10-14</time></div></div>
    <div class="tiles">
      <div class="tile"><div class="label">Recordings</div><div class="value">5</div></div>
      <div class="tile"><span class="label">Minutes</span> <span class="value">42</span></div>
    </div>
    <h3>Billing</h3>
    <div class="kv"><div class="k">Plan</div><div class="v">starter</div><div class="k">Renewal</div><div class="v">monthly</div></div>
    <dl><dt>Credits</dt><dd>149</dd><dt>Owner&#39;s region</dt><dd>eu&#8209;west</dd></dl>
    <section>Notes for the account&#39;s operator<br>second line</section>
    <table><tr><th>Day</th><th>Jobs</th></tr><tr><td>Mon</td><td>3</td></tr></table>
    <script>window.x = 1</script>
  </main></body></html>`;

  const visibleTexts = (html: string): string[] => {
    const { document } = parseHTML(html);
    const out: string[] = [];
    const walk = (n: Node): void => {
      if (n.nodeType === 3) {
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) out.push(t);
        return;
      }
      if (n.nodeType !== 1) return;
      if (['SCRIPT', 'STYLE', 'HEAD', 'NAV'].includes((n as Element).tagName)) return;
      for (const c of n.childNodes) walk(c);
    };
    walk(document.body as unknown as Node);
    return out;
  };

  it('every text node of the content root reaches the Markdown', () => {
    const out = md(DASHBOARD);
    const missing = visibleTexts(DASHBOARD).filter((t) => !out.includes(t));
    expect(missing).toEqual([]);
  });
});
