import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

// P2A-089 (incoming-bugs/page2ai-bugs.md, found T289): a page with no shown <main> and no dominant <article> is rendered
// from <body>, and core 0.4.24 printed every site menu, site header, footer and sidebar in it. T289 counted that root on
// 345 of 1,065 saved pages and 76 of 236 live pages agents opened. T295 measured the rule below on those pages and on
// trafilatura's labelled evaluation set (960 pages, tests/evaldata.json: strings of the main text and boilerplate
// strings): no main-text string lost, 96 boilerplate strings no longer printed (D:/AI_Scratch/web-to-md/t295-work/).

const md = (html: string, baseUrl = 'https://example.test/post'): string =>
  htmlToMarkdown(html, { baseUrl, includeFrontmatter: false }).markdown.trim();
const page = (body: string, title = 'Post'): string =>
  `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const PARAS = [
  'The article explains what happened in the town council and why the vote matters for the budget.',
  'Residents can comment on the plan until the end of the month, by letter or at the public meeting.',
  'The next council session is on Tuesday, and the agenda will be published two days before it.',
];
const ARTICLE = `<div class="post"><h1>Post</h1>${PARAS.map((p) => `<p>${p}</p>`).join('')}</div>`;
const EXPECTED = `# Post\n\n${PARAS.join('\n\n')}`;
const MENU = '<nav><a href="/">Home</a> <a href="/news">News</a> <a href="/about">About</a></nav>';
const FOOTER = '<footer><p>© 2026 Example Town</p><nav><a href="/privacy">Privacy</a></nav></footer>';

describe('P2A-089: site chrome on a page rendered from <body> is left out', () => {
  it('the bug file case with an article long enough to be the page: no menu, no footer', () => {
    expect(md(page(`${MENU}${ARTICLE}${FOOTER}`))).toBe(EXPECTED);
  });

  it.each([
    ['a site <header> with the logo link and its menu', `<header><a href="/">Example Town</a>${MENU}</header>`],
    ['a sidebar <aside>', '<aside><h2>Popular</h2><a href="/a">Budget vote explained</a></aside>'],
    ['role=banner', '<div role="banner"><a href="/">Example Town</a></div>'],
    ['role=navigation', '<div role="navigation"><a href="/news">News</a> <a href="/events">Events</a></div>'],
    ['role=contentinfo', '<div role="contentinfo">© 2026 Example Town</div>'],
    ['role=complementary', '<div role="complementary">Subscribe to the newsletter</div>'],
  ])('%s', (_label, chrome) => {
    expect(md(page(`${chrome}${ARTICLE}`))).toBe(EXPECTED);
  });

  it('the landmark holding the first shown <h1> stays (a hero header), a menu inside it goes', () => {
    const html = page(`<header class="hero">${MENU}<h1>Post</h1><p>Lead paragraph of the page, in the hero.</p></header><div>${PARAS.map((p) => `<p>${p}</p>`).join('')}</div>${FOOTER}`);
    expect(md(html)).toBe(`# Post\n\nLead paragraph of the page, in the hero.\n\n${PARAS.join('\n\n')}`);
  });

  it('a hidden <h1> does not keep its landmark', () => {
    expect(md(page(`<header><h1 hidden>Example Town</h1><p>Call the town hall: 555-0100</p>${MENU}</header>${ARTICLE}`))).toBe(EXPECTED);
  });

  it('a form that is the page stays; the chrome around it goes', () => {
    const html = page(`${MENU}<form><h1>Post</h1><p>${PARAS[0]}</p><label>Name <input name="n"></label><p>${PARAS[1]}</p><p>${PARAS[2]}</p></form>${FOOTER}`);
    const out = md(html);
    expect(out).toContain('Name');
    expect(out).toContain(PARAS[2]);
    expect(out).not.toContain('[Home]');
    expect(out).not.toContain('© 2026');
  });

  it('a sidebar that holds the first <h1> is the page and stays; the footer goes', () => {
    const html = page(`<aside><h1>Post</h1>${PARAS.map((p) => `<p>${p}</p>`).join('')}</aside>${FOOTER}`);
    expect(md(html)).toBe(EXPECTED);
  });
});

describe('P2A-089: what stays as before', () => {
  it('a header, footer and nav inside sectioning content belong to it', () => {
    const html = page(`${MENU}<div><section><header><p>By Ann Lee, 1 May 2026</p></header><h1>Post</h1>${PARAS.map((p) => `<p>${p}</p>`).join('')}<nav><a href="/older">Older post</a></nav><footer><p>Tags: council</p></footer></section></div>${FOOTER}`);
    const out = md(html);
    expect(out).toContain('By Ann Lee, 1 May 2026');
    expect(out).toContain('[Older post](https://example.test/older)');
    expect(out).toContain('Tags: council');
    expect(out).not.toContain('[Home]');
    expect(out).not.toContain('© 2026');
  });

  it('a short page is rendered whole: too little would remain without its landmarks', () => {
    const html = page(`${MENU}<div><h1>Post</h1><p>Article text.</p></div>${FOOTER}`);
    expect(md(html)).toBe('# Post\n\n[Home](https://example.test/)\n[News](https://example.test/news)\n[About](https://example.test/about)\n\nArticle text.\n\n© 2026 Example Town\n\n[Privacy](https://example.test/privacy)');
  });

  it('a page whose content is its navigation (a site map) is rendered whole, even with an intro of its own', () => {
    const links = Array.from({ length: 40 }, (_, i) => `<li><a href="/section-${i}">Council section number ${i}</a></li>`).join('');
    const out = md(page(`<div><h1>Site map</h1><p>Every page of the site, listed by section and updated in May. The council publishes its minutes, budgets and plans here, and each section below leads to the pages of one department of the town.</p></div><nav><ul>${links}</ul></nav>`, 'Site map'));
    expect(out).toContain('[Council section number 0](https://example.test/section-0)');
    expect(out).toContain('[Council section number 39](https://example.test/section-39)');
  });

  it('a page with a <main> keeps a nav inside it, as before', () => {
    const html = page(`${MENU}<main><h1>Post</h1><nav><a href="/related">Related story</a></nav>${PARAS.map((p) => `<p>${p}</p>`).join('')}</main>${FOOTER}`);
    const out = md(html);
    expect(out).toContain('[Related story](https://example.test/related)');
    expect(out).not.toContain('[Home]');
  });
});
