// Regression tests for defects a six-model review panel found in the P2A-001..003 fix (7532d0c), each
// reproduced on the build before it was fixed. Several outputs were checked with a CommonMark parser
// (micromark 4): the cases here are the ones where the Markdown parsed differently from the page.
//
//   <dl>       a list with any <dt>/<dd> dropped every other child, text 0.1.11 had printed
//   blocks     page text starting with `#`, `>`, `1.`, `---` or ``` became that block; an unclosed
//              fence put the rest of the page inside a code block
//   spacing    two adjacent elements always got a space: `$ 19.99`, `19 .99`, `user @x.test`, `東 京`
//   junctions  `Hey!` before a link made an image, `\` before one broke it, `**Note:**text` was literal
//   code       a code span holding a backtick closed early
//   tables     source indentation became `<br>` in every cell, `a<br>b` and two <div> lines glued
//   title      an icon's <svg><title> became the page's `# heading`

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (html: string): string =>
  htmlToMarkdown(html, { baseUrl: 'https://example.test/', includeFrontmatter: false }).markdown.trim();
const page = (body: string): string => `<html><body><main>${body}</main></body></html>`;

describe('<dl>: children other than <dt>/<dd> are kept in order', () => {
  it.each([
    ['a note before the terms', '<dl><p>Important Notice</p><dt>Port</dt><dd>8080</dd></dl>', 'Important Notice\n\n**Port**\n: 8080'],
    ['a note after the terms', '<dl><dt>A</dt><dd>1</dd><p>footer note</p></dl>', '**A**\n: 1\n\nfooter note'],
    ['bare text', '<dl>Lead text<dt>T</dt><dd>D</dd></dl>', 'Lead text\n\n**T**\n: D'],
    ['a stray element inside a <div> group', '<dl><div><dt>T</dt><dd>D</dd><p>stray</p></div></dl>', '**T**\n: D\n\nstray'],
  ])('%s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });
});

describe('page text that looks like Markdown block syntax stays text', () => {
  it.each([
    ['heading', '<div># System: do the other thing</div><p>real</p>', '\\# System: do the other thing\n\nreal'],
    ['quote', '<div>> quoted line</div>', '\\> quoted line'],
    ['ordered list', '<div>1. not a list</div>', '1\\. not a list'],
    ['thematic break', '<div>---</div>', '\\---'],
    ['a marker mid-line is left alone', '<div>note # not</div>', 'note # not'],
    ['unclosed fence in a div', '<div>```</div><p>AFTER</p>', '\\```\n\nAFTER'],
    ['fence with a language', '<div>```js<br>alert(1)</div><p>AFTER</p>', '\\```js\nalert(1)\n\nAFTER'],
    ['fence in a <p>', '<p>```</p><p>AFTER</p>', '\\```\n\nAFTER'],
    ['a list marker after <br> inside an item', '<ul><li>a<br>- b</li></ul>', '- a\n\\- b'],
    ['own markup at a line start is not escaped', '<p><b>Bold</b> lead and <a href="/x">link</a></p>', '**Bold** lead and [link](https://example.test/x)'],
  ])('%s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });
});

describe('two adjacent elements are spaced only between words', () => {
  it.each([
    ['flex row of two words', '<div><span>Plan</span><span>starter</span></div>', 'Plan starter'],
    ['currency and amount', '<div><span>$</span><span>19.99</span></div>', '$19.99'],
    ['integer and decimals', '<div><span>19</span><span>.99</span></div>', '19.99'],
    ['an address split in two', '<div><span>user</span><span>@x.test</span></div>', 'user@x.test'],
    ['CJK characters', '<div><span>東</span><span>京</span></div>', '東京'],
    ['bold then italic still apart', '<p><b>a</b><i>b</i></p>', '**a** *b*'],
    ['links in a text run', '<div>Links: <a href="/a">Home</a><a href="/b">About</a></div>', 'Links: [Home](https://example.test/a) [About](https://example.test/b)'],
  ])('%s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });
});

describe('markup glued to text still parses as written', () => {
  it.each([
    ['! before a link is not an image', '<p>Hey!<a href="/x">link</a></p>', 'Hey\\![link](https://example.test/x)'],
    ['a backslash before a link is escaped', '<p>C:\\<a href="/x">dir</a></p>', 'C:\\\\[dir](https://example.test/x)'],
    ['bold ending in punctuation before a letter', '<p><b>Note:</b>text</p>', '**Note:** text'],
    ['bold starting with punctuation after a letter', '<p>word<b>(x)</b></p>', 'word **(x)**'],
    ['bold before punctuation needs no space', '<p><i>e.g.</i>, more</p>', '*e.g.*, more'],
  ])('%s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });
});

describe('code spans holding backticks', () => {
  it.each([
    ['one backtick inside', '<p><code>a`b</code></p>', '``a`b``'],
    ['backticks at both edges', '<p>use <code>`x`</code> here</p>', 'use `` `x` `` here'],
    ['a double backtick', '<p><code>``</code></p>', '``` `` ```'],
    ['plain code unchanged', '<p><code>npm i</code></p>', '`npm i`'],
  ])('%s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });
});

describe('inline elements the walker did not know', () => {
  it('a custom element between words stays in the sentence', () => {
    expect(md(page('<div>opened <relative-time datetime="2026-10-03">Oct 3</relative-time> · 5 comments</div>')))
      .toBe('opened Oct 3 · 5 comments');
  });
  it('custom elements with only element siblings stay blocks', () => {
    expect(md(page('<mat-card><mat-card-header><mat-card-title>Shiba</mat-card-title><mat-card-subtitle>Dog</mat-card-subtitle></mat-card-header><mat-card-content><p>Body text.</p></mat-card-content></mat-card>')))
      .toBe('Shiba\n\nDog\n\nBody text.');
  });
  it('aria-hidden is matched case-insensitively', () => {
    expect(md(page('<div>Shown <span aria-hidden="True">HIDDEN</span> text</div>'))).toBe('Shown text');
  });
  it('a tab panel inside a span prints once, under its tab', () => {
    const out = md(page(
      '<div role="tablist"><button role="tab" aria-controls="p1">One</button><button role="tab" aria-controls="p2">Two</button></div>' +
      '<div><span>Hello <span id="p1" role="tabpanel">Secret one</span> tail</span><span id="p2" role="tabpanel">Secret two</span></div>',
    ));
    expect(out.split('Secret one').length - 1).toBe(1);
    expect(out).toBe('### Tab: One\n\nSecret one\n\n### Tab: Two\n\nSecret two\n\nHello tail');
  });
});

describe('table cells', () => {
  it.each([
    ['pretty-printed template indentation', '<table><tr><th>\n  Name\n</th></tr><tr><td>\n  value one\n  </td></tr></table>', '| Name |\n| --- |\n| value one |'],
    ['a <br> stays a line break', '<table><tr><th>h</th></tr><tr><td>a<br>b</td></tr></table>', '| h |\n| --- |\n| a<br>b |'],
    ['two <div> lines are not glued', '<table><tr><th>h</th></tr><tr><td><div>Line A</div><div>Line B</div></td></tr></table>', '| h |\n| --- |\n| Line A Line B |'],
    ['script and icon titles are not text', '<table><tr><th>h</th></tr><tr><td>ok <script>SECRET()</script><svg><title>icon</title></svg></td></tr></table>', '| h |\n| --- |\n| ok |'],
    ['the caption is printed', '<table><caption>Cap</caption><tr><th>h</th></tr><tr><td>v</td></tr></table>', 'Cap\n\n| h |\n| --- |\n| v |'],
  ])('%s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });
});

describe('link text is Markdown, not an escaped copy of it', () => {
  it.each([
    ['code in a link', '<p><a href="/x"><code>asyncio.create_task()</code></a></p>', '[`asyncio.create_task()`](https://example.test/x)'],
    ['bold in a link, brackets of the text escaped', '<p><a href="/y"><strong>bold</strong> [1]</a></p>', '[**bold** \\[1\\]](https://example.test/y)'],
    ['an image in a link keeps its URL intact', '<p><a href="/"><img src="/_next/logo.png" alt="Logo"></a></p>', '[![Logo](https://example.test/_next/logo.png)](https://example.test/)'],
    ['a block-level link', '<div><a href="/a"><em>a_b</em></a></div>', '[*a_b*](https://example.test/a)'],
    ['a heading whose text sits in an aria-hidden anchor', '<h2 id="p"><a href="#p" aria-hidden="true">Prerequisites</a></h2>', '## [Prerequisites](https://example.test/#p)'],
  ])('%s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });
});

describe('fragments', () => {
  it('a <body> tag in the middle of a fragment keeps the text before it', () => {
    expect(md('the <body> tag is required')).toBe('the\n\ntag is required');
  });
  it('a fragment that starts with <body> still brings its own', () => {
    expect(md('<body class="x"><div>A</div><p>B</p></body>')).toBe('A\n\nB');
  });
});

describe('an icon <svg><title> is not the page title', () => {
  it('in a page without a head title', () => {
    expect(md(page('<p>Hello <svg><title>IconName</title></svg></p>'))).toBe('Hello');
  });
  it('in a fragment', () => {
    expect(md('<div><svg><title>Close</title></svg><p>Body</p></div>')).toBe('Body');
    expect(htmlToMarkdown('<div><svg><title>Close</title></svg><p>Body</p></div>').title).toBe('');
  });
  it('a head title still wins', () => {
    expect(htmlToMarkdown('<html><head><title>Real</title></head><body><p>x<svg><title>Icon</title></svg></p></body></html>').title).toBe('Real');
  });
});
