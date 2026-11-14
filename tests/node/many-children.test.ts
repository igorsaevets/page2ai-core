// Page2AI T242 (P2A-035, from the T241 review panel): an element with many inline children cost O(n²). The inline
// renderer read the text it was building (a regex, endsWith, slice) once per child, and V8 copies a string grown with
// `+=` whole on every such read; a table nested in a cell read its growing row line once per cell the same way. On
// core 0.4.7 each page below took 4-25 s (a page of a few MB, minutes), synchronously. Budget 1 s here; the fixed
// renderer needs about 0.1-0.3 s for each. Long words, not more children: the old cost grew with the length of the
// text it re-read, so long words widen the gap without a bigger DOM to parse.

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/convert.js';

const WORD = 'x'.repeat(300);
const BACKSLASH = String.fromCharCode(92);

const timed = (body: string): { ms: number; markdown: string } => {
  const html = `<html><body><main>${body}<p>after</p></main></body></html>`;
  const t = performance.now();
  const r = htmlToMarkdown(html, { baseUrl: 'https://example.com/', includeFrontmatter: false });
  return { ms: performance.now() - t, markdown: r.markdown };
};
const count = (s: string, needle: string): number => s.split(needle).length - 1;

describe('an element with many children converts in linear time (each took seconds on 0.4.7)', () => {
  it('a paragraph of 10,000 links', () => {
    const { ms, markdown } = timed(`<p>${`<a href="/x">${WORD}</a>`.repeat(10_000)}</p>`);
    expect(count(markdown, `[${WORD}](https://example.com/x)`)).toBe(10_000);
    expect(markdown).toContain('after');
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('a paragraph of 5,000 links, each after a "!" that must be escaped', () => {
    // `![` would make each link an image, so the `!` before it becomes `\!`.
    const { ms, markdown } = timed(`<p>${`!<a href="/x">${WORD}</a>`.repeat(5_000)}</p>`);
    expect(count(markdown, `${BACKSLASH}![${WORD}](https://example.com/x)`)).toBe(5_000);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('a list item of 10,000 bold runs', () => {
    const { ms, markdown } = timed(`<ul><li>${`<b>${WORD}</b>`.repeat(10_000)}</li></ul>`);
    expect(count(markdown, `**${WORD}**`)).toBe(10_000);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('a paragraph of 10,000 backslashes, each before an element that opens with "*"', () => {
    // The page's backslash would escape the `*`, so a second backslash is put before it.
    const { ms, markdown } = timed(`<p>${`${BACKSLASH}<span>*${WORD}</span>`.repeat(10_000)}</p>`);
    expect(count(markdown, `${BACKSLASH}${BACKSLASH}*${WORD}`)).toBe(10_000);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('a table nested in a cell whose row holds 10,000 header/data pairs', () => {
    const { ms, markdown } = timed(`<table><tr><td><table><tr>${`<th>k</th><td>${WORD}</td>`.repeat(10_000)}</tr></table></td></tr></table>`);
    expect(count(markdown, `k: ${WORD}`)).toBe(10_000);
    expect(ms).toBeLessThan(1000);
  }, 120_000);
});
