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
//
// BL-37, the follow-ups of the same review (T110), each output parsed with micromark 4 + GFM:
//   list items a block in an item (code, table, <dl>, quote) started at column 0 and ended the list;
//              an item starting with one printed a bare `-` and a blank line; a nested list did not
//              nest under `10.`; text before a nested item that starts with a block became `##`
//   links      a `)` or `(` without its pair ended the link destination early
//   </body>    text after a stray </body> or </html> was dropped
//
// The review of that fix (T111), each output also rendered by GitHub (POST /markdown) and pandoc:
//   rule       an item opening with a rule printed `- ---`, a thematic break: the item left the list
//   paragraphs two <p> in one item printed without a blank line, one paragraph to a parser
//   after list a block after a nested list in the same item joined that list's last item
//   links      one unpaired `)` encoded every parenthesis; control characters ended the link
//   </body>    deleting the end tags from the source also deleted them inside <title> and <xmp> text

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
    ['a list marker after <br> inside an item', '<ul><li>a<br>- b</li></ul>', '- a\n   \\- b'],
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

describe('blocks inside a list item stay in the item', () => {
  it.each([
    ['code after the step text', '<ol><li><p>Install:</p><pre><code class="language-bash">npm i x</code></pre></li><li><p>Run:</p></li></ol>',
      '1. Install:\n\n   ```bash\n   npm i x\n   ```\n\n2. Run:'],
    ['code as the first child', '<ul><li><pre><code>npm i x</code></pre></li><li>next</li></ul>', '- ```\n  npm i x\n  ```\n\n- next'],
    ['indented code keeps its indentation', '<ul><li><pre><code>def f():\n    return 1\n\nf()</code></pre></li></ul>',
      '- ```\n  def f():\n      return 1\n\n  f()\n  ```'],
    ['a table as the first child', '<ul><li><table><tr><th>a</th></tr><tr><td>1</td></tr></table></li></ul>', '- | a |\n  | --- |\n  | 1 |'],
    ['a table after text, then more text', '<ul><li>Options:<table><tr><th>a</th></tr><tr><td>1</td></tr></table>after</li></ul>',
      '- Options:\n\n   | a |\n   | --- |\n   | 1 |\n\n   after'],
    ['a <dl> as the first child', '<ul><li><dl><dt>Term</dt><dd>Def</dd></dl></li><li>next</li></ul>', '- **Term**\n  : Def\n\n- next'],
    ['a <div> of paragraphs as the first child', '<ul><li><div><p>one</p><p>two</p></div></li></ul>', '- one\n\n  two'],
    ['a quote as the first child', '<ul><li><blockquote><p>quoted</p></blockquote></li></ul>', '- > quoted'],
    ['a nested list as the first child', '<ul><li><ul><li>inner</li></ul></li><li>outer</li></ul>', '- - inner\n- outer'],
    ['a nested item starting with code is not a setext heading', '<ul><li>parent text<ul><li><pre><code>x = 1</code></pre></li></ul></li></ul>',
      '- parent text\n   - ```\n     x = 1\n     ```'],
    ['text after a nested list stays out of its last item', '<ul><li>parent<ul><li>sub</li></ul>after</li></ul>', '- parent\n   - sub\n\n   after'],
    ['an item without blocks is unchanged', '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>', '- a\n   - b\n- c'],
  ])('%s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });
  it('a list nests under step 10 and later', () => {
    const steps = Array.from({ length: 10 }, (_, i) => `<li>step ${i + 1}<ul><li>sub ${i + 1}</li></ul></li>`).join('');
    const out = md(page(`<ol>${steps}</ol>`));
    expect(out).toContain('9. step 9\n   - sub 9\n10. step 10\n    - sub 10');
  });
  it.each([
    ['a rule opening a bulleted item is not a thematic break', '<ul><li><div><hr><p>x</p></div></li><li>next</li></ul>',
      '- ***\n\n  x\n\n- next'],
    ['nor in a nested item', '<ul><li><ul><li><div><hr><p>x</p></div></li></ul></li></ul>', '- - ***\n\n    x'],
    ['an ordered item keeps its dashes', '<ol><li><div><hr><p>x</p></div></li></ol>', '1. ---\n\n   x'],
    ['two paragraphs stay two', '<ul><li><p>A</p><p>B</p></li></ul>', '- A\n\n   B'],
    ['text, a paragraph, text', '<ul><li>Lead<p>Para</p>tail</li></ul>', '- Lead\n\n   Para\n\n   tail'],
    ['paragraphs in a numbered step', '<ol><li><p>one</p><p>two</p></li><li><p>x</p></li></ol>', '1. one\n\n   two\n2. x'],
    ['a block after a nested list stays out of its last item', '<ul><li><ul><li>a</li></ul><div><p>x</p></div></li></ul>',
      '- - a\n\n   x'],
    ['an image figure too', '<ul><li><ul><li>a</li></ul><figure><img src="x.png" alt="i"></figure></li></ul>',
      '- - a\n\n   ![i](https://example.test/x.png)'],
    ['an empty item is left out and the numbers stay the page\'s', '<ol><li>Step 1</li><li> </li><li>Step 3</li></ol>',
      '1. Step 1\n3. Step 3'],
  ])('%s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });
});

describe('link destinations', () => {
  it.each([
    ['a ) without its pair is encoded', '<p><a href="https://x.test/a)b">link</a></p>', '[link](https://x.test/a%29b)'],
    ['a ( without its pair is encoded', '<p><a href="https://x.test/a(b">link</a></p>', '[link](https://x.test/a%28b)'],
    ['balanced parentheses are left as written', '<p><a href="https://x.test/wiki/Foo_(bar)">wiki</a></p>', '[wiki](https://x.test/wiki/Foo_(bar))'],
    ['an image source too', '<p><img src="https://x.test/i(1.png" alt="pic"></p>', '![pic](https://x.test/i%281.png)'],
  ])('%s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });
  it('a block-level link too', () => {
    expect(md(page('<div><a href="https://x.test/a)b">link</a></div>'))).toBe('[link](https://x.test/a%29b)');
  });
  it.each([
    ['only the unpaired parenthesis is encoded', '<p><a href="https://x.test/wiki/Foo_(bar)?x=)">t</a></p>',
      '[t](https://x.test/wiki/Foo_(bar)?x=%29)'],
    ['a ) before a ( are both unpaired', '<p><a href="https://x.test/a)b(c">t</a></p>', '[t](https://x.test/a%29b%28c)'],
  ])('%s', (_label, html, expected) => {
    expect(md(page(html))).toBe(expected);
  });
  it.each([
    // No baseUrl: the href cannot be resolved, so the URL parser does not encode it first.
    ['a control character', '<p><a href="a\x01b">t</a></p>', '[t](a%01b)'],
    ['an emoji before an unpaired parenthesis', '<p><a href="\u{1F600}(a">t</a></p>', '[t](\u{1F600}%28a)'],
  ])('unresolved: %s', (_label, html, expected) => {
    expect(htmlToMarkdown(page(html), { includeFrontmatter: false }).markdown.trim()).toBe(expected);
  });
});

describe('text after a stray </body> or </html> is kept, as a browser keeps it', () => {
  it.each([
    ['after </body>', '<html><body><p>inside</p></body><p>after</p></html>'],
    ['after </html>', '<html><body><p>inside</p></body></html><p>after</p>'],
    ['in a fragment', '<p>inside</p></body><p>after</p>'],
    ['in a second <body>', '<html><body><p>inside</p></body><body><p>after</p></body></html>'],
  ])('%s', (_label, html) => {
    expect(md(html)).toBe('inside\n\nafter');
  });
  it('an end tag inside <xmp> text stays text', () => {
    expect(md('<html><body><xmp>x</body>y</xmp><p>after</p></body></html>')).toBe('x</body>y\n\nafter');
  });
  it('an end tag inside <title> stays in the title', () => {
    const r = htmlToMarkdown('<html><head><title>Hello </body> World</title></head><body><p>x</p></body></html>',
      { baseUrl: 'https://example.test/' });
    expect(r.title).toBe('Hello </body> World');
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
