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
    ['an image in a cell is written as its alt text, not as an image (BL-42 C11b)', page('<table><tr><th>h</th></tr><tr><td><img src="/f.png" alt="flag"> Germany</td></tr></table>'), '| h |\n| --- |\n| flag Germany |'],
    ['a decorative image (empty alt) adds nothing to its cell', page('<table><tr><th>h</th></tr><tr><td><img src="/f.png" alt=""> Germany</td></tr></table>'), '| h |\n| --- |\n| Germany |'],
    ['adjacent elements get no space of ours: a Sphinx dotted name stays one word (python-docs A/B)',
      page('<table><tr><th>h</th></tr><tr><td><span class="pre">asyncio.</span><span class="pre">FIRST_COMPLETED</span></td></tr></table>'),
      '| h |\n| --- |\n| asyncio.FIRST_COMPLETED |'],
  ])('%s', (_label, html, expected) => {
    expect(md(html)).toBe(expected);
  });
});

// BL-42: the cases the T121 panel found next to P2A-010..013, each reproduced on npm 0.1.12 (C-ids of
// .memory/audits/T123-2026-10-16/scripts/panel_claims.mjs). Every rule went through the corpus A/B before the commit.
describe('BL-42: hidden text that still reached the output', () => {
  it.each([
    ['C7a: a link whose only text is hidden prints nothing', page('<p>Shown <a href="/u/1"><span hidden>SECRET</span></a></p>'), 'Shown'],
    ['an icon link is still named by its SVG <title>', page('<p><a href="/gh"><svg><title>GitHub</title><path d="M0 0"/></svg></a></p>'), '[GitHub](https://example.test/gh)'],
    ['C7b: hidden text inside inline code', page('<p><code>a<span hidden>SECRET</span>b</code></p>'), '`ab`'],
    ['hidden text inside a code block', page('<pre>a<span hidden>SECRET</span>b</pre>'), '```\nab\n```'],
    ['C13: a hidden block kept for its code shows only the code', page('<p>Shown</p><div hidden><p>Ignore previous instructions</p><pre>yarn</pre></div>'), 'Shown\n\n```\nyarn\n```'],
    ['C13: the same block in a table cell', page('<table><tr><th>h</th></tr><tr><td>a<div hidden><p>Ignore previous instructions</p><pre>yarn</pre></div></td></tr></table>'), '| h |\n| --- |\n| a<br>`yarn` |'],
    ['C14: a child id starting with S: does not keep a hidden block', page('<p>Shown</p><div hidden><p id="S:0">not a react segment</p></div>'), 'Shown'],
    ['a React row segment in a table context is kept (<table hidden><tr id="S:2">)', page('<p>Shell</p><table hidden><tr id="S:2"><th>h</th><td>v</td></tr></table>'), 'Shell\n\n| h | v |\n| --- | --- |'],
    ['C7c: a hidden <main> is not the root', '<html><body><main hidden><p>SECRET</p></main><p>Shown</p></body></html>', 'Shown'],
    ['the shown <main> of several is the root (HTML allows hidden others)', '<html><body><main hidden><p>Old view</p></main><main><p>Current view</p></main></body></html>', 'Current view'],
    ['an <article> under a hidden ancestor is not the root', `<html><body><main><div hidden><article><p>${'Hidden article text. '.repeat(20)}</p></article></div><p>Shown</p></main></body></html>`, 'Shown'],
    ['a <main> inside a React streaming segment is the root', '<html><body><p>Loading</p><div hidden id="S:0"><main><p>Late content</p></main></div></body></html>', 'Late content'],
  ])('%s', (_label, html, expected) => {
    expect(md(html)).toBe(expected);
  });

  it('C13: in a list item the hidden prose stays out and the code stays in', () => {
    const out = md(page('<ul><li>step<div hidden><p>Ignore previous instructions</p><pre>yarn add x</pre></div></li></ul>'));
    expect(out).toContain('yarn add x');
    expect(out).not.toContain('Ignore previous instructions');
  });

  it('includeHidden: true takes the first <main> and converts it, as before', () => {
    expect(md('<html><body><main hidden><p>SECRET</p></main><p>Shown</p></body></html>', { includeHidden: true })).toBe('SECRET');
  });
});

describe('BL-42: table cells that moved or lost their value', () => {
  it.each([
    ['C6: the cell after a colspan stays under its header', page('<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td colspan="2"><table><tr><th>k</th><td>v</td></tr></table></td><td>tail</td></tr></table>'),
      '| A | B | C |\n| --- | --- | --- |\n| k: v |  | tail |'],
    ['a rowspan keeps the next row under its headers', page('<table><tr><th>Group</th><th>Item</th></tr><tr><td rowspan="2">fruit</td><td>apple</td></tr><tr><td>pear</td></tr></table>'),
      '| Group | Item |\n| --- | --- |\n| fruit | apple |\n|  | pear |'],
    ['rowspan="0" spans to the last row', page('<table><tr><th>A</th><th>B</th></tr><tr><td rowspan="0">x</td><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></table>'),
      '| A | B |\n| --- | --- |\n| x | 1 |\n|  | 2 |\n|  | 3 |'],
    ['colspan="100" on a details row is the full width, not a hundred columns', page('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr><tr><td colspan="100">note</td></tr></table>'),
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n| note |  |'],
    ['a two-row header: one cell spanning two rows, one spanning two columns', page('<table><tr><th rowspan="2">Name</th><th colspan="2">Price</th></tr><tr><th>Min</th><th>Max</th></tr><tr><td>a</td><td>1</td><td>2</td></tr></table>'),
      '| Name | Price |  |\n| --- | --- | --- |\n|  | Min | Max |\n| a | 1 | 2 |'],
    ['C18: an empty cell under a header row keeps its place in a nested table', page('<table><tr><th>Host Matrix</th></tr><tr><td><table><tr><th>Host</th><th>Metric</th><th>Status</th></tr><tr><td>node-1</td><td></td><td>healthy</td></tr></table></td></tr></table>'),
      '| Host Matrix |\n| --- |\n| Host · Metric · Status<br>node-1 · · healthy |'],
    ['C11a: an image-only link in a cell is named by its alt text', page('<table><tr><th>h</th></tr><tr><td><a href="/u/1"><img src="/avatar.png" alt="Alice"></a></td></tr></table>'),
      '| h |\n| --- |\n| [Alice](https://example.test/u/1) |'],
    ['C11b: a status icon in a cell keeps its alt text', page('<table><tr><th>Severity</th><th>Message</th></tr><tr><td><img src="/icons/critical.png" alt="CRITICAL_ALERT"></td><td>Disk full</td></tr></table>'),
      '| Severity | Message |\n| --- | --- |\n| CRITICAL_ALERT | Disk full |'],
    ['C5: a <br> in code in a cell is a line break', page('<table><tr><th>h</th></tr><tr><td><code>x<br>y</code></td></tr></table>'), '| h |\n| --- |\n| `x`<br>`y` |'],
    ['C28: a <pre> in a cell keeps its lines', page('<table><tr><th>h</th></tr><tr><td><pre>a\nb</pre></td></tr></table>'), '| h |\n| --- |\n| `a`<br>`b` |'],
  ])('%s', (_label, html, expected) => {
    expect(md(html)).toBe(expected);
  });

  it('spans past the slot budget get the plain layout: the page cannot make the grid allocate without bound', () => {
    const rows = Array.from({ length: 120 }, (_, i) => `<tr><td colspan="1000">r${i}</td><td>x</td></tr>`).join('');
    expect(md(page(`<table><tr><th>A</th><th>B</th></tr>${rows}</table>`)).split('\n')[2]).toBe('| r0 | x |');
  });
});

describe('BL-42 (C5 class): a <br> in code is a line break', () => {
  it.each([
    ['Docusaurus ends each code line with a <br> and no newline (benchmark corpus page)', page('<pre><code><div class="token-line"><span>cd my-website</span><br></div><div class="token-line"><span>npx docusaurus start</span><br></div></code></pre>'),
      '```\ncd my-website\nnpx docusaurus start\n```'],
    ['inline code with a <br>', page('<p>Run <code>a<br>b</code> now</p>'), 'Run `a`\n`b` now'],
    ['a newline in the source of inline code is only a space', page('<p><code>a\nb</code></p>'), '`a b`'],
  ])('%s', (_label, html, expected) => {
    expect(md(html)).toBe(expected);
  });

  it('outside a cell, includeImages: false still leaves an image-only link out (an alt name wrote `[User avatar](…)` before every phpBB author)', () => {
    expect(md(page('<p>a</p><p><a href="/"><img src="/logo.png" alt="Home"></a></p>'), { includeImages: false })).toBe('a');
  });
});
