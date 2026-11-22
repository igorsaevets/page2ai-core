import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

// P2A-086 (incoming-bugs/page2ai-bugs.md, found T286 on https://code.claude.com/docs/en/mcp): Mintlify puts the page's
// «On this page» table of contents inside <main>, ahead of the article. Core 0.4.23 printed it (11,624 characters on
// that page) and, because its <h2> was the first heading the walk met, wrote the page title a second time when it
// reached the real <h1>. T289 measured both on 1,065 saved pages and 236 live pages agents opened
// (D:/AI_Scratch/web-to-md/t289-work/): tables of contents in a nav on 15 live pages, the title twice on 52 saved and
// 4 live pages, most of those from a heading above the <h1> that is not a table of contents (a news kicker, a menu's
// hidden heading, a blog's site-name <h1>, a hidden widget inside the <h1>).

const md = (html: string, baseUrl = 'https://example.test/doc'): string =>
  htmlToMarkdown(html, { baseUrl, includeFrontmatter: false }).markdown.trim();
const doc = (title: string, body: string): string =>
  `<html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
const SECTIONS = '<h2 id="a">Section A</h2><p>Text of section A.</p><h2 id="b">Section B</h2><p>Text of section B.</p>';
const ARTICLE = `<p>Intro paragraph of the document body.</p>${SECTIONS}`;
const EXPECTED_ARTICLE = '# Doc title\n\nIntro paragraph of the document body.\n\n## Section A\n\nText of section A.\n\n## Section B\n\nText of section B.';

describe('P2A-086: an in-page table of contents is left out', () => {
  it('the bug file case: a Mintlify-shaped «On this page» nav before the <h1>, one H1 and no link list', () => {
    const html = '<html><head><title>Doc title</title></head><body><main><div class="toc"><nav><h2>On this page</h2><ul><li><a href="#a">Section A</a></li><li><a href="#b">Section B</a></li></ul></nav></div><div class="content"><header><h1>Doc title</h1></header><p>Intro paragraph of the document body.</p><h2 id="a">Section A</h2><p>Text of section A.</p><h2 id="b">Section B</h2><p>Text of section B.</p></div></main></body></html>';
    expect(md(html)).toBe(EXPECTED_ARTICLE);
  });

  it.each([
    ['role=navigation on a div', '<div role="navigation"><a href="#a">Section A</a> <a href="#b">Section B</a></div>'],
    ['links written as this page\'s full URL', '<nav><a href="https://example.test/doc#a">Section A</a><a href="https://example.test/doc#b">Section B</a></nav>'],
    ['a «Back to top» link beside them', '<nav><a href="#a">Section A</a><a href="#b">Section B</a><a href="#top">Back to top</a><a href="#">Top</a></nav>'],
    ['a label and a numbered list', '<nav aria-label="Contents"><h3>Table of contents</h3><ol><li><a href="#a">1. Section A</a></li><li><a href="#b">2. Section B</a></li></ol></nav>'],
  ])('%s', (_label, toc) => {
    expect(md(doc('Doc title', `<h1>Doc title</h1>${toc}${ARTICLE}`))).toBe(EXPECTED_ARTICLE);
  });

  it('a percent-encoded fragment reaches a non-ASCII id', () => {
    const html = doc('Doc title', '<nav><a href="#%D1%80%D0%B0%D0%B7">раз</a><a href="#%D0%B4%D0%B2%D0%B0">два</a></nav><h1>Doc title</h1><h2 id="раз">раз</h2><p>Один.</p><h2 id="два">два</h2><p>Два.</p>');
    expect(md(html)).toBe('# Doc title\n\n## раз\n\nОдин.\n\n## два\n\nДва.');
  });
});

describe('P2A-086: a nav that is not only a table of contents is kept', () => {
  it.each([
    ['breadcrumbs: links to other pages', '<nav aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/docs">Docs</a></nav>', '[Home](https://example.test/) / [Docs](https://example.test/docs)'],
    ['a menu whose # links open its own submenus', '<nav><a href="#m1">Menu one</a><ul id="m1"><li><a href="/x">X page</a></li></ul><a href="#m2">Menu two</a><ul id="m2"><li><a href="/y">Y page</a></li></ul></nav>', 'X page'],
    ['a hash-routed app: #/ routes name no element', '<nav><a href="#/settings">Settings</a><a href="#/billing">Billing</a></nav>', '[Settings](https://example.test/doc#/settings)'],
    ['fragments that name no element', '<nav><a href="#nowhere">Gone A</a><a href="#missing">Gone B</a></nav>', 'Gone A'],
    ['one link only: a skip link', '<nav><a href="#a">Skip to content</a></nav>', 'Skip to content'],
    ['a tab bar written as a nav', '<nav><a href="#a" role="tab" aria-controls="a">Tab A</a><a href="#b" role="tab" aria-controls="b">Tab B</a></nav>', 'Tab A'],
    ['skip links wrapped around real text (be.ch)', '<nav aria-label="Sprunglinks"><a href="#a">Zum Inhalt</a><a href="#b">Zur Suche</a><p>The canton\'s vaccination hotline answers on weekdays from eight to five and on Saturdays until noon.</p></nav>', 'vaccination hotline'],
    ['links mostly to other pages', '<nav><a href="#a">Section A</a><a href="/p1">P1</a><a href="/p2">P2</a></nav>', '[P1](https://example.test/p1)'],
  ])('%s', (_label, navHtml, needle) => {
    expect(md(doc('Doc title', `<h1>Doc title</h1>${navHtml}${ARTICLE}`))).toContain(needle);
  });
});

describe('P2A-086: the page title is written once', () => {
  const h1Lines = (s: string): string[] => s.split('\n').filter((l) => /^# /.test(l));

  it.each([
    ['a news kicker above the <h1>', '<h3>Politics</h3><h1>Doc title</h1><p>Body.</p>', ['# Doc title'], '### Politics'],
    ['a blog\'s site-name <h1> above the post\'s', '<h1>My blog</h1><h1>Doc title</h1><p>Body.</p>', ['# Doc title', '# My blog'], 'Body.'],
    ['a menu\'s heading inside a kept nav', '<nav><h2>Main navigation</h2><a href="/a">A page</a> <a href="/b">B page</a></nav><h2>Doc title</h2><p>Body.</p>', ['# Doc title'], '## Main navigation'],
    ['a hidden widget inside the <h1> (developer.chrome.com)', '<h1>Doc title<span hidden>Stay organized with collections</span></h1><p>Body.</p>', ['# Doc title'], 'Body.'],
  ])('%s', (_label, body, h1s, needle) => {
    const out = md(doc('Doc title', body));
    expect(h1Lines(out)).toEqual(h1s);
    // One heading line names the page at any level: 0.4.23 wrote `## Doc title` under the menu's heading.
    expect(out.split('\n').filter((l) => /^#{1,6} Doc title$/.test(l))).toEqual(['# Doc title']);
    expect(out).toContain(needle);
  });

  it('an h2-h6 that repeats the title after another heading is content and stays', () => {
    const out = md(doc('Doc title', '<h1>Other</h1><p>Lede.</p><h2>Doc title</h2><p>Body.</p>'));
    expect(out).toContain('# Other');
    expect(out).toContain('## Doc title');
  });
});

describe('P2A-086: the table-of-contents test stays linear', () => {
  it('3,000 sibling tables of contents and one with 20,000 links', () => {
    const navs = Array.from({ length: 3000 }, (_, i) => `<nav><a href="#s${i}">S${i}</a><a href="#t${i}">T${i}</a></nav><h2 id="s${i}">S${i}</h2><h3 id="t${i}">T${i}</h3>`).join('');
    const big = `<nav>${Array.from({ length: 20000 }, (_, i) => `<a href="#b${i}">B${i}</a>`).join('')}</nav>${Array.from({ length: 20000 }, (_, i) => `<p id="b${i}">P${i}</p>`).join('')}`;
    const t = performance.now();
    const a = md(doc('Doc title', navs));
    const b = md(doc('Doc title', big));
    expect(performance.now() - t).toBeLessThan(5000);
    expect(a).not.toContain('](https://example.test/doc#s');
    expect(a).toContain('## S2999');
    expect(b).not.toContain('[B19999]');
    expect(b).toContain('P19999');
  });

  it('2,000 nested navs are tested once, at the outermost', () => {
    const open = Array.from({ length: 2000 }, (_, i) => `<nav><a href="/p${i}">P${i}</a>`).join('');
    const t = performance.now();
    const out = md(doc('Doc title', `${open}${'</nav>'.repeat(2000)}<p>End.</p>`));
    expect(performance.now() - t).toBeLessThan(5000);
    expect(out).toContain('End.');
  });
});
