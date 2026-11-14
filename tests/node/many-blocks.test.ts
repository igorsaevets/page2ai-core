// Page2AI T243 (P2A-037, from the T242 review panel, Gemini): a container of many code blocks cost O(n²). For every
// <pre>, the renderer counted the <pre> elements under each of its three nearest ancestors (an ancestor wrapping more
// than one code block gives no language), so a container of n blocks was searched n times. On core 0.4.8, 8,000
// sibling blocks (96 KB) took 20 s and 12,000 wrapped ones 75 s, synchronously. Budget 1 s here; the fixed renderer
// counts each ancestor once per render and needs well under 0.1 s for each page below.

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/convert.js';

const timed = (body: string): { ms: number; markdown: string } => {
  const html = `<html><body><main>${body}<p>after</p></main></body></html>`;
  const t = performance.now();
  const r = htmlToMarkdown(html, { baseUrl: 'https://example.com/', includeFrontmatter: false });
  return { ms: performance.now() - t, markdown: r.markdown };
};
const lines = (s: string, line: string): number => s.split('\n').filter((l) => l === line).length;

describe('a container of many code blocks converts in linear time (each took seconds on 0.4.8)', () => {
  it('6,000 sibling <pre>', () => {
    const { ms, markdown } = timed(`<div>${'<pre>code-line</pre>'.repeat(6_000)}</div>`);
    expect(lines(markdown, 'code-line')).toBe(6_000);
    expect(markdown).toContain('after');
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('6,000 <pre>, each in its own wrapper', () => {
    const { ms, markdown } = timed(`<div>${'<div class="w"><pre>code-line</pre></div>'.repeat(6_000)}</div>`);
    expect(lines(markdown, 'code-line')).toBe(6_000);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('6,000 list items with a <pre> each', () => {
    const { ms, markdown } = timed(`<ul>${'<li><pre>code-line</pre></li>'.repeat(6_000)}</ul>`);
    // A list item's code block is indented under its marker: `- ```` then `  code-line`.
    expect(lines(markdown, '  code-line')).toBe(6_000);
    expect(ms).toBeLessThan(1000);
  }, 120_000);
});

// The same shape of cost elsewhere: an id lookup per tab (linkedom's getElementById walks the whole tree) and a <pre>
// probe of every hidden ancestor per table row or article. On 0.4.8 each page below took 5-9 s.
const seq = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join('');
const count = (s: string, needle: string): number => s.split(needle).length - 1;

describe('tab lists and hidden containers with many entries convert in linear time', () => {
  it('a tab list of 8,000 tabs, each naming its panel by aria-controls', () => {
    const body = `<div role="tablist">${seq(8_000, (i) => `<button role="tab" aria-controls="p${i}">tab${i}</button>`)}</div>`
      + seq(8_000, (i) => `<div role="tabpanel" id="p${i}">panel-body</div>`);
    const { ms, markdown } = timed(body);
    expect(count(markdown, '### Tab: tab')).toBe(8_000);
    expect(lines(markdown, 'panel-body')).toBe(8_000);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('a tab list of 10,000 tabs whose aria-controls names no element', () => {
    const { ms, markdown } = timed(`<div role="tablist">${'<button role="tab" aria-controls="nope">tab</button>'.repeat(10_000)}</div>`);
    expect(markdown).toContain('after');
    expect(markdown).not.toContain('Tab:');
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('8,000 tab panels labelled by an id that names no element', () => {
    const { ms, markdown } = timed(`<div>${'<div role="tabpanel" data-state="inactive" aria-labelledby="nope">panel-body</div>'.repeat(8_000)}</div>`);
    expect(lines(markdown, 'panel-body')).toBe(8_000);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('8,000 rows of a hidden <tbody>', () => {
    const { ms, markdown } = timed(`<table><tbody hidden>${'<tr><td>row-text</td></tr>'.repeat(8_000)}</tbody></table>`);
    expect(markdown).toContain('after');
    expect(markdown).not.toContain('row-text');
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('12,000 articles inside a hidden <div>', () => {
    const { ms, markdown } = timed(`<div hidden>${'<article><p>article-text</p></article>'.repeat(12_000)}</div><p>visible text here</p>`);
    expect(markdown).toContain('visible text here');
    expect(markdown).not.toContain('article-text');
    expect(ms).toBeLessThan(1000);
  }, 120_000);
});

describe('the language of a code block from its ancestors (the rule the count serves)', () => {
  const md = (body: string): string => timed(body).markdown;

  it('an ancestor around ONE code block gives its language', () => {
    expect(md('<div class="language-python"><pre>print(1)</pre></div>')).toContain('```python\nprint(1)\n```');
  });

  it('an ancestor around TWO code blocks gives none, to either', () => {
    const out = md('<div class="language-python"><pre>a = 1</pre><pre>b = 2</pre></div>');
    expect(out).toContain('```\na = 1\n```');
    expect(out).toContain('```\nb = 2\n```');
    expect(out).not.toContain('```python');
  });

  it('the count is per document: the same markup converts the same way twice', () => {
    const body = '<div class="language-python"><pre>one</pre></div><div class="language-python"><pre>x</pre><pre>y</pre></div>';
    const first = md(body);
    expect(md(body)).toBe(first);
    expect(first).toContain('```python\none\n```');
    expect(first).toContain('```\nx\n```');
  });
});
