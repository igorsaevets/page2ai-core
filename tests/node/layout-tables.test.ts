// P2A-024, filed from the iron-note-backend session P333c (incoming-bugs/page2ai-bugs.md, 2026-10-20): an HTML e-mail
// is laid out with nested `<table role="presentation">`, and core 0.3.0 printed the whole letter as one Markdown table
// cell on one line, its <h1> and 14 paragraphs run together. A table with role presentation or none is now walked as
// the blocks in its cells. Measured before the fix: 45 IronMemo letter renders (7 languages) went from 1 table row and
// a 876-1,747 character line to 11-17 paragraphs and their own <h1>; of the 53 corpus pages one changed, Wikipedia's
// article message box, all three option sets (default, includeImages: false, includeHidden: true).
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (html: string, extra: Record<string, unknown> = {}): string =>
  htmlToMarkdown(html, { baseUrl: 'https://example.test/', includeFrontmatter: false, ...extra }).markdown.trim();

// The shape of a transactional e-mail: an outer full-width table, a 600 px container, a content row and a footer row.
const letter = (content: string, role = 'presentation'): string =>
  `<html><body><table role="${role}" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>` +
  `<table role="${role}" width="600"><tr><td>${content}</td></tr>` +
  '<tr><td><p>Footer line one.</p><p>Example Inc., 1 Main St.</p></td></tr></table></td></tr></table></body></html>';
const BODY = '<h1>Your notes are ready</h1><p>We finished processing your recording.</p>' +
  '<p><a href="https://example.test/open">Open your notes</a></p>';

const EXPECTED = [
  '# Your notes are ready', '', 'We finished processing your recording.', '',
  '[Open your notes](https://example.test/open)', '', 'Footer line one.', '', 'Example Inc., 1 Main St.',
].join('\n');

describe('P2A-024: a layout table converts as the blocks it holds', () => {
  it('the bug file case: the heading, each paragraph and the footer, no table', () => {
    expect(md(letter(BODY))).toBe(EXPECTED);
  });

  it('role="none" is the same role, and the token is read in any case', () => {
    expect(md(letter(BODY, 'none'))).toBe(EXPECTED);
    expect(md(letter(BODY, 'Presentation'))).toBe(EXPECTED);
  });

  it('only the first token of a role list is read', () => {
    expect(md(letter(BODY, 'presentation none'))).toBe(EXPECTED);
    expect(md(letter(BODY, 'table presentation'))).toMatch(/^\| /m);
  });

  it('a data table inside the layout stays a Markdown table, after the text before it', () => {
    const out = md(letter('<h2>Your plan</h2><table><tr><th>Plan</th><th>Price</th></tr><tr><td>Free</td><td>0</td></tr></table>'));
    expect(out).toContain('## Your plan\n\n| Plan | Price |\n| --- | --- |\n| Free | 0 |');
  });

  it('a table without a role, or with role="table", is still a table', () => {
    const grid = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    expect(md(`<html><body>${grid}</body></html>`)).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(md(`<html><body>${grid.replace('<table>', '<table role="table">')}</body></html>`)).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('cells side by side come out in source order', () => {
    const row = '<html><body><table role="presentation"><tr><td>Left cell</td><td>Right cell</td></tr></table></body></html>';
    expect(md(row)).toBe('Left cell\n\nRight cell');
  });
});

describe('P2A-024: images in a layout table keep the table-cell rule', () => {
  // A letter's spacers and its open-tracking pixel carry an empty alt; as image links they would put the tracking URL
  // into the Markdown, and a viewer that loads images would report the letter as opened.
  const pixel = '<img src="https://track.example.test/open.gif?u=42" width="1" height="1" alt="">';
  const spacer = '<img src="https://example.test/spacer.gif" alt="" width="20" height="1">';

  it('an image alone in its cell is written as its alt text', () => {
    const out = md(letter('<img src="https://example.test/logo.png" alt="Example logo"></td></tr><tr><td><p>Hello.</p>'));
    expect(out).toContain('Example logo');
    expect(out).not.toContain('logo.png');
  });

  it('an image with an empty alt adds nothing, with images on (the default) and off', () => {
    for (const extra of [{}, { includeImages: false }]) {
      const out = md(letter(`${spacer}<p>Hello.</p>${pixel}`), extra);
      expect(out).not.toMatch(/track\.example|spacer\.gif|!\[/);
      expect(out).toContain('Hello.');
    }
  });

  it('a linked image keeps its link, named by the alt text', () => {
    const out = md(letter('<a href="https://example.test/"><img src="https://example.test/logo.png" alt="Example"></a><p>Hello.</p>'));
    expect(out).toContain('[Example](https://example.test/)');
    expect(out).not.toContain('logo.png');
  });

  it('outside a layout table an image is still an image link', () => {
    expect(md('<html><body><p><img src="https://example.test/a.png" alt="A chart"></p></body></html>')).toBe('![A chart](https://example.test/a.png)');
  });
});
