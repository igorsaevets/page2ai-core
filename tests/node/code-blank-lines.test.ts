// P2A-094 (T298, fixed T307): blank lines inside a code block are the page's code. Core squeezed every run of empty
// lines in its output to one, fenced code included, so `import os`, two blank lines, `def main():` came out with one
// blank line: a Python file lost its PEP 8 spacing, and a here-document or a Markdown sample in a code block changed.
// The squeeze now skips fenced code. Every expected code text below is what Chrome 158.0.8127.37 copies from the block
// (select the <pre>, Selection.toString()), measured by D:/AI_Scratch/web-to-md/t307-work/blank_lines_t307.py, which
// also reads each Markdown output with markdown-it-py 4.2 (commonmark): its code blocks equal that copy, list items and
// quotes included. Leading and trailing blank lines of a block are dropped, as before.

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (body: string): string =>
  htmlToMarkdown(`<html><body><main><h1>Title</h1><p>Start.</p>${body}<p>End.</p></main></body></html>`,
    { baseUrl: 'https://example.test/', includeFrontmatter: false }).markdown;

// The text between "Start." and "End." in the output.
const between = (body: string): string => {
  const out = md(body);
  return out.slice(out.indexOf('Start.'), out.indexOf('End.') + 4);
};

// The text of the only fenced code block of the output (backtick or tilde fence), or null.
const fenced = (body: string): string | null => {
  const m = md(body).match(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1$/m);
  return m ? m[2] : null;
};

// One Expressive Code line; a blank line is a line holding one newline character, as Starlight writes it.
const ecLine = (text: string): string => `<div class="ec-line"><div class="code">${text || '\n'}</div></div>`;

// The output with every fenced block removed: what is left is prose, where runs of empty lines are still squeezed.
const prose = (out: string): string => out.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1$/gm, '<code>');

describe('P2A-094: the blank lines of a code block are the ones Chrome copies', () => {
  const cases: [string, string, string][] = [
    ['two blank lines (PEP 8 spacing)', '<pre><code>import os\n\n\ndef main():\n    pass</code></pre>',
      'import os\n\n\ndef main():\n    pass'],
    ['three blank lines', '<pre><code>a = 1\n\n\n\nb = 2</code></pre>', 'a = 1\n\n\n\nb = 2'],
    ['CRLF line ends', '<pre><code>a = 1\r\n\r\n\r\nb = 2</code></pre>', 'a = 1\n\n\nb = 2'],
    ['lines made by <br>', '<pre>a = 1<br><br><br>b = 2</pre>', 'a = 1\n\n\nb = 2'],
    ['Expressive Code blank line <div>s', `<pre><code>${['a = 1', '', '', 'b = 2'].map(ecLine).join('')}</code></pre>`,
      'a = 1\n\n\nb = 2'],
    ['line <div>s holding a <br>', '<pre><code><div>a = 1</div><div><br></div><div><br></div><div>b = 2</div></code></pre>',
      'a = 1\n\n\nb = 2'],
    ['a here-document', '<pre><code>cat &lt;&lt;EOF\nfirst\n\n\nlast\nEOF</code></pre>', 'cat <<EOF\nfirst\n\n\nlast\nEOF'],
    ['code that looks like Markdown', '<pre><code>- item\n\n\n&gt; quote\n\n\n1. x</code></pre>',
      '- item\n\n\n> quote\n\n\n1. x'],
    ['code holding a ``` fence (written in a ~~~ fence)', '<pre><code>```js\nx = 1\n\n\ny = 2\n```</code></pre>',
      '```js\nx = 1\n\n\ny = 2\n```'],
    ['code holding a ~~~ fence', '<pre><code>~~~\nx = 1\n\n\ny = 2\n~~~</code></pre>', '~~~\nx = 1\n\n\ny = 2\n~~~'],
    ['blank lines at both ends are dropped, the inner ones kept', '<pre><code>\n\na = 1\n\n\nb = 2\n\n\n</code></pre>',
      'a = 1\n\n\nb = 2'],
  ];
  for (const [name, body, copy] of cases) {
    it(name, () => expect(fenced(body)).toBe(copy));
  }

  it('in a list item, after the item text', () => {
    expect(between('<ul><li>Step:<pre><code>a = 1\n\n\nb = 2</code></pre></li></ul>'))
      .toBe('Start.\n\n- Step:\n\n   ```\n   a = 1\n\n\n   b = 2\n   ```\n\nEnd.');
  });

  it('in a list item that opens with the block (the fence on the marker line)', () => {
    expect(between('<ol><li><pre><code>a = 1\n\n\nb = 2</code></pre></li></ol>'))
      .toBe('Start.\n\n1. ```\n   a = 1\n\n\n   b = 2\n   ```\n\nEnd.');
  });

  it('in a nested list item', () => {
    expect(between('<ul><li>One<ul><li>Two<pre><code>a = 1\n\n\nb = 2</code></pre></li></ul></li></ul>'))
      .toBe('Start.\n\n- One\n   - Two\n\n      ```\n      a = 1\n\n\n      b = 2\n      ```\n\nEnd.');
  });

  it('in a quote (unchanged: a quoted blank line is "> ", never squeezed)', () => {
    expect(between('<blockquote><pre><code>a = 1\n\n\nb = 2</code></pre></blockquote>'))
      .toBe('Start.\n\n> ```\n> a = 1\n> \n> \n> b = 2\n> ```\n\nEnd.');
  });

  it('two blocks on a page, prose with a run of blank lines between them', () => {
    const out = md('<pre><code>a = 1\n\n\nb = 2</code></pre><div>x<br><br><br><br>y</div><pre><code>c = 3\n\n\nd = 4</code></pre>');
    expect(out).toContain('```\na = 1\n\n\nb = 2\n```');
    expect(out).toContain('```\nc = 3\n\n\nd = 4\n```');
    expect(prose(out)).not.toMatch(/\n\n\n/);
  });
});

describe('P2A-094: what stays as it was', () => {
  it('one blank line and blank lines made of spaces are kept as they are', () => {
    expect(fenced('<pre><code>a = 1\n\nb = 2</code></pre>')).toBe('a = 1\n\nb = 2');
    expect(fenced('<pre><code>a = 1\n  \n    \nb = 2</code></pre>')).toBe('a = 1\n  \n    \nb = 2');
  });

  it('empty line <div>s make no line, as in Chrome', () => {
    expect(fenced('<pre><code><div>a = 1</div><div></div><div></div><div>b = 2</div></code></pre>')).toBe('a = 1\nb = 2');
  });

  it('runs of blank lines in prose are still squeezed to one', () => {
    expect(between('<div>x<br><br><br><br>y</div><p>z</p>')).toBe('Start.\n\nx\n\ny\n\nz\n\nEnd.');
    expect(md('<p>x</p><p></p><p>&nbsp;</p><p></p><p>y</p>')).not.toMatch(/\n\n\n/);
  });

  it('a paragraph that opens with a code span holding ``` is no fence: the prose after it is still squeezed', () => {
    const out = md('<p><code>a```b</code> text</p><div>x<br><br><br><br>y</div>');
    expect(out).toContain('````a```b```` text');
    expect(out).not.toMatch(/\n\n\n/);
  });

  it('the fence closes where the code ends: the prose after a ~~~ fenced block is squeezed', () => {
    const out = md('<pre><code>```js\nx = 1\n\n\ny = 2\n```</code></pre><div>x<br><br><br><br>y</div>');
    expect(out).toContain('~~~\n```js\nx = 1\n\n\ny = 2\n```\n~~~');
    expect(prose(out)).not.toMatch(/\n\n\n/);
  });

  it('a line behind 150 quote prefixes is read in linear time', () => {
    const depth = 150;
    const body = '<blockquote>'.repeat(depth) + '<p>deep</p><div>x<br><br><br><br>y</div>' + '</blockquote>'.repeat(depth);
    const t0 = Date.now();
    const out = md(body);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(out).toContain('> '.repeat(depth) + 'deep');
  });
});
