// P2A-092 (T298): the lines of a code block are the lines a browser shows. Expressive Code, which renders the code
// blocks of every Starlight site, writes each line as `<div class="ec-line"><div class="code">…</div></div>` with no
// newline character between them, and core read the text of a <pre> by concatenating its text nodes, so the five-line
// block on https://page2ai.net/research/agent-fetch-outcomes/ came out as one line («cd scannerspython
// fetch_failures.py --selftestpython…»). A block element now starts a line, a <p> leaves a blank line and the cells of a
// row are separated by a tab, as in the text Chrome copies from the block. Every expected value in the table below is
// that copy, measured in Chrome 149.0.7827.55 (select the <pre>, Selection.toString()); innerText differs from it where
// the source has a newline next to a line <div>: it reads `<div>a\n</div><div>b</div>` as "a\n\nb\n" while the screen
// and the copy show two lines.

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (body: string): string =>
  htmlToMarkdown(`<html><body><main><h1>Title</h1><p>Start.</p>${body}<p>End.</p></main></body></html>`,
    { baseUrl: 'https://example.test/', includeFrontmatter: false }).markdown;

// The text of the only fenced code block of the output, or null.
const fenced = (body: string): string | null => {
  const m = md(body).match(/^(`{3,})[^\n]*\n([\s\S]*?)\n\1$/m);
  return m ? m[2] : null;
};

// One Expressive Code line, as the research page's HTML writes it.
const ecLine = (text: string): string =>
  `<div class="ec-line"><div class="code"><span style="--0:#d6deeb;--1:#403f53">${text}</span></div></div>`;

describe('P2A-092: each line of an Expressive Code block is a line', () => {
  it('the research page block keeps its five lines', () => {
    const lines = ['cd scanners', 'python fetch_failures.py --selftest',
      'python fetch_failures.py --until 2026-11-16T07:30:00Z --out report', 'python other_clis_t265.py --selftest',
      'python other_clis_t265.py --until 2026-11-16T07:30:00Z --out report-other'];
    const out = md('<div class="expressive-code"><figure class="frame not-content"><figcaption class="header"></figcaption>' +
      `<pre data-language="plaintext"><code>${lines.map(ecLine).join('')}</code></pre><div class="copy">` +
      `<button title="Copy to clipboard" data-copied="Copied!" data-code="${lines.join('\u007f')}"><div></div></button>` +
      '</div></figure></div>');
    expect(out).toContain('```plaintext\n' + lines.join('\n') + '\n```');
    expect(out).not.toContain('scannerspython');
  });

  it('a blank line, which Expressive Code writes as a line holding one newline, stays one blank line', () => {
    // docs.astro.build writes `<div class="ec-line"><div class="code">\n</div></div>`; innerText reads two blank lines.
    expect(fenced(`<pre><code>${ecLine('---')}${ecLine('\n')}${ecLine('const a = 1;')}</code></pre>`))
      .toBe('---\n\nconst a = 1;');
  });

  it('the indentation of each line is kept', () => {
    expect(fenced(`<pre><code>${ecLine('if (a) {')}${ecLine('  b();')}${ecLine('}')}</code></pre>`))
      .toBe('if (a) {\n  b();\n}');
  });
});

describe('P2A-092: code text is the text Chrome copies from the block', () => {
  it.each([
    ['line <div>s with no newline', '<div>a</div><div>b</div>', 'a\nb'],
    ['a newline between two line <div>s is a blank line', '<div>a</div>\n<div>b</div>', 'a\n\nb'],
    ['a newline at the end of each line <div> is that line\'s end, not a blank line', '<div>a\n</div><div>b\n</div>', 'a\nb'],
    ['text before and after a <div>', 'x<div>a</div>y', 'x\na\ny'],
    ['nested line <div>s', '<div class="l"><div class="c">a</div></div><div class="l"><div class="c">b</div></div>', 'a\nb'],
    ['paragraphs stand apart by a blank line', '<p>a</p><p>b</p>', 'a\n\nb'],
    ['an empty <div> adds no line', '<div>a</div><div></div><div>b</div>', 'a\nb'],
    ['list items are lines', '<ol><li>a</li><li>b</li></ol>', 'a\nb'],
    ['table rows are lines and cells are separated by a tab', '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>', 'a\tb\nc\td'],
    ['a block inside a cell ends the line, with no tab after it', '<table><tr><td><div>a</div></td><td>b</td></tr></table>', 'a\nb'],
    ['a text line between two <div>s', '<div>a</div>\nb\n<div>c</div>', 'a\n\nb\nc'],
    ['a <br> right after a line <div>', '<div>a</div><br>b', 'a\n\nb'],
    ['a space between two line <div>s is a line of its own', '<div>a</div> <div>b</div>', 'a\n \nb'],
    ['a hidden line <div> is left out with its line', '<div>a</div><div hidden>x</div><div>b</div>', 'a\nb'],
    ['line <div>s inside <code>', '<code><div>a</div><div>b</div></code>', 'a\nb'],
  ])('%s', (_label, inner, chromeCopy) => {
    expect(fenced(`<pre>${inner}</pre>`)).toBe(chromeCopy);
  });
});

describe('P2A-092: what stays as it was', () => {
  it.each([
    ['Shiki lines: inline spans with a newline between them', '<pre><code><span class="line">a</span>\n<span class="line">b</span></code></pre>', 'a\nb'],
    ['Docusaurus lines: each <div> ends with a <br>', '<pre><code><div class="token-line">a<br></div><div class="token-line">b<br></div></code></pre>', 'a\nb'],
    ['plain text with newlines', '<pre><code>a\n  b\n\nc</code></pre>', 'a\n  b\n\nc'],
  ])('%s', (_label, html, expected) => {
    expect(fenced(html)).toBe(expected);
  });

  it('inline code with line <div>s becomes one code span per line, as with a <br>', () => {
    expect(md('<p>Run <code><div>a</div><div>b</div></code> now</p>')).toContain('Run `a`\n`b` now');
  });

  it('a <pre> with line <div>s in a table cell keeps its lines', () => {
    const out = md('<table><tr><th>Command</th></tr><tr><td><pre><div>cd x</div><div>make</div></pre></td></tr></table>');
    expect(out).toContain('`cd x`<br>`make`');
  });
});
