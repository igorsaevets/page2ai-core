// P2A-010..013, filed from the iron-note-backend session (incoming-bugs/page2ai-bugs.md, 2026-10-15/16). Each repro
// printed the bug file's output byte for byte on npm 0.1.11 and was re-run on core main a499952 before the fix (T115):
//
//   P2A-010  a link in a table cell lost its target and its code formatting (main: still lost)
//   P2A-011  a <br> in a cell glued the words around it (main: already fixed by the T109 cell walk, b20f39e)
//   P2A-012  content under the `hidden` attribute was converted, though a browser renders none of it
//   P2A-013  a table nested in a cell leaked into the outer table: the row holding it widened by the inner
//            cells and the inner rows came out again as rows of the outer table (2 columns became 5)
//
// The kept-hidden cases (until-found, tab panels, blocks holding code, React streaming segments) come from the corpus:
// Starlight and Biome hide inactive tab panels, docs.sentry.io keeps code-tab variants in bare `<div hidden>`s, and
// docs.anthropic.com sends its article as a React segment `<div hidden id="S:0">`. A corpus A/B also showed the
// element-junction space splitting a Sphinx name in a cell, so cells stay tight.
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (html: string, extra: Record<string, unknown> = {}): string =>
  htmlToMarkdown(html, { baseUrl: 'https://example.test/', includeFrontmatter: false, ...extra }).markdown.trim();
const page = (body: string): string => `<html><body><main>${body}</main></body></html>`;

describe('P2A-011: a <br> in a cell is a line break', () => {
  it('the bug file case: a header cell and a data cell', () => {
    expect(md(page('<table><thead><tr><th>gladia<br><span>values on 2 of 4 files</span></th><th>B</th></tr></thead>'
      + '<tbody><tr><td>x<br>y</td><td>z</td></tr></tbody></table>')))
      .toBe('| gladia<br>values on 2 of 4 files | B |\n| --- | --- |\n| x<br>y | z |');
  });
});

describe('P2A-012: content under `hidden` is left out, as a browser leaves it out', () => {
  it.each([
    ['a paragraph (bug file case)', '<p>Shown</p><p hidden>Hidden paragraph</p>', 'Shown'],
    ['a table row (bug file case)', '<table><tr><th>A</th></tr><tr><td>a</td></tr><tr hidden><td>hidden row</td></tr></table>', '| A |\n| --- |\n| a |'],
    ['a row group', '<table><tr><th>A</th></tr><tbody hidden><tr><td>x</td></tr></tbody><tbody><tr><td>y</td></tr></tbody></table>', '| A |\n| --- |\n| y |'],
    ['a cell', '<table><tr><th>A</th><th>C</th></tr><tr><td>a</td><td hidden>b</td><td>c</td></tr></table>', '| A | C |\n| --- | --- |\n| a | c |'],
    ['an inline span', '<p>a <span hidden>secret</span> b</p>', 'a b'],
    ['a list item, numbering as the browser shows it', '<ol><li>one</li><li hidden>gone</li><li>two</li></ol>', '1. one\n2. two'],
    ['a paragraph inside a list item', '<ul><li>a<p hidden>gone</p></li></ul>', '- a'],
    ['a term and its definition', '<dl><dt>T</dt><dd>D</dd><dt hidden>T2</dt><dd hidden>D2</dd></dl>', '**T**\n: D'],
    ['any attribute value, as in a browser', '<p>a</p><p hidden="false">b</p>', 'a'],
    ['the Matrix shape: a closed details row holding a table', '<table><tr><th>model</th><th>f1</th></tr>'
      + '<tr><td>gladia</td><td><button>2/4</button></td></tr>'
      + '<tr hidden><td colspan="2"><table><tr><th>file</th><td>0.91</td></tr></table></td></tr></table>',
      '| model | f1 |\n| --- | --- |\n| gladia | 2/4 |'],
  ])('%s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });

  it.each([
    ['hidden="until-found": a collapsed section the browser find reveals', '<p>a</p><div hidden="until-found"><p>found text</p></div>', 'a\n\nfound text'],
    ['a tab panel: every panel is rendered, as the extension clicks each tab', '<div role="tabpanel"><p>npm i x</p></div><div role="tabpanel" hidden><p>yarn add x</p></div>', 'npm i x\n\nyarn add x'],
    ['a React streaming segment (Next.js sends late Suspense content this way)', '<p>Shell</p><div hidden id="S:0"><p>Late content</p></div>', 'Shell\n\nLate content'],
    ['a React segment in a table context', '<p>Shell</p><table hidden><tbody id="S:1"><tr><th>h</th></tr><tr><td>v</td></tr></tbody></table>', 'Shell\n\n| h |\n| --- |\n| v |'],
    ['a block holding code: an unmarked code tab (docs.sentry.io yarn/pnpm variants)', '<pre>npm i x</pre><div hidden><pre>yarn add x</pre></div>', '```\nnpm i x\n```\n\n```\nyarn add x\n```'],
  ])('kept: %s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });

  it('includeHidden: true converts hidden content as before', () => {
    expect(md(page('<p>a</p><p hidden>b</p><table><tr><th>A</th></tr><tr hidden><td>r</td></tr></table>'), { includeHidden: true }))
      .toBe('a\n\nb\n\n| A |\n| --- |\n| r |');
  });
});

describe('P2A-013: a nested table stays inside its cell', () => {
  it.each([
    ['the bug file case: key/value rows', '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr>'
      + '<tr><td colspan="2"><table><tr><th>k</th><td>v</td></tr><tr><th>k2</th><td>v2</td></tr></table></td></tr></table>',
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n| k: v<br>k2: v2 |  |'],
    ['a header row and data rows', '<table><tr><th>X</th></tr><tr><td><table><tr><th>Name</th><th>Size</th></tr>'
      + '<tr><td>a.txt</td><td>3 KB</td></tr></table></td></tr></table>',
      '| X |\n| --- |\n| Name · Size<br>a.txt · 3 KB |'],
    ['a header ending in a colon gets no second one', '<table><tr><th>X</th></tr><tr><td><table><tr><th>Name:</th><td>a</td></tr></table></td></tr></table>',
      '| X |\n| --- |\n| Name: a |'],
    ['nested deeper, inside a <div> in the cell', '<table><tr><th>X</th><th>Y</th></tr><tr><td><div><table><tr><td>p</td><td>q</td></tr></table></div></td><td>z</td></tr></table>',
      '| X | Y |\n| --- | --- |\n| p · q | z |'],
    ['the inner caption stays with the inner table', '<table><tr><th>X</th></tr><tr><td><table><caption>Inner</caption><tr><td>v</td></tr></table></td></tr></table>',
      '| X |\n| --- |\n| Inner<br>v |'],
    ['two sibling tables are two tables', '<table><tr><th>A</th></tr><tr><td>1</td></tr></table><table><tr><th>B</th></tr><tr><td>2</td></tr></table>',
      '| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |'],
  ])('%s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });
});

describe('P2A-010: a cell keeps its links and code', () => {
  it.each([
    ['the bug file case B: a link only', '<html><body><table><thead><tr><th>User</th></tr></thead><tbody><tr><td><a href="/u/abcd1234"><code>abcd1234</code></a></td></tr></tbody></table></body></html>',
      '| User |\n| --- |\n| [`abcd1234`](https://example.test/u/abcd1234) |'],
    ['the bug file case A: a link and a <div>, no <br> at the ends', `<html><body><table><thead><tr><th>User</th><th>Plan</th></tr></thead><tbody><tr><td>
  <a class="user-link" href="/u/abcd1234"><code>abcd1234</code></a>
  <div class="user-email">no address - phone sign-up</div>
</td><td>free</td></tr></tbody></table></body></html>`,
      '| User | Plan |\n| --- | --- |\n| [`abcd1234`](https://example.test/u/abcd1234) no address - phone sign-up | free |'],
    ['a pipe in link text and in code is escaped for the table', page('<table><tr><th>h</th></tr><tr><td><a href="/x">a|b</a> <code>c|d</code></td></tr></table>'),
      '| h |\n| --- |\n| [a\\|b](https://example.test/x) `c\\|d` |'],
    ['bold text', page('<table><tr><th>h</th></tr><tr><td><b>Total</b> 5</td></tr></table>'), '| h |\n| --- |\n| **Total** 5 |'],
    ['images stay out of cells, as before', page('<table><tr><th>h</th></tr><tr><td><img src="/f.png" alt="flag"> Germany</td></tr></table>'), '| h |\n| --- |\n| Germany |'],
    ['adjacent elements get no space of ours: a Sphinx dotted name stays one word (python-docs A/B)',
      page('<table><tr><th>h</th></tr><tr><td><span class="pre">asyncio.</span><span class="pre">FIRST_COMPLETED</span></td></tr></table>'),
      '| h |\n| --- |\n| asyncio.FIRST_COMPLETED |'],
  ])('%s', (_label, html, expected) => {
    expect(md(html)).toBe(expected);
  });
});
