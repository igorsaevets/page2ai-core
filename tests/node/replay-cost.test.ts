// P2A-061 (T277): the streaming replay looked each element up with linkedom's isConnected and refused a segment holding
// its own boundary with contains; both walk to the root, once per call. A page that chains fills, each segment holding
// k nested <div>s around the next boundary, made every walk longer than the last: 16,000 fills (4.6 MB) took 64 s on
// 0.4.18, 8,000 took 11 s. Now a detached element is remembered (no walk) and the containment test walks up from the
// boundary and through the segment in step, so it costs the shorter walk. Same Markdown, linear time.

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (html: string): string =>
  htmlToMarkdown(html, { baseUrl: 'https://example.test/', includeFrontmatter: false }).markdown;

const chain = (k: number, n: number): string => {
  const parts = ['<!DOCTYPE html><html><head><title>T</title></head><body><main><p>START</p>',
    '<!--$?--><template id="B:0"></template><p>Loading</p><!--/$--><p>MAINEND</p></main>'];
  for (let i = 0; i < n; i++) {
    const id = i.toString(16);
    parts.push(`<div hidden id="S:${id}">`, '<div>'.repeat(k), `<p>SEG${i}X</p>`,
      `<!--$?--><template id="B:${(i + 1).toString(16)}"></template><!--/$-->`, '</div>'.repeat(k), '</div>',
      `<script>$RC("B:${id}","S:${id}")</script>`);
  }
  parts.push('</body></html>');
  return parts.join('');
};

describe('P2A-061: a chain of streaming fills is replayed in linear time', () => {
  it('8,000 chained fills (2.3 MB) take seconds, not minutes, and every segment lands in order', () => {
    const html = chain(14, 8000);
    const t0 = performance.now();
    const out = md(html);
    const ms = performance.now() - t0;
    const segs = out.match(/SEG\d+X/g) || [];
    expect(segs.length).toBe(8000);
    expect(segs.slice(0, 3)).toEqual(['SEG0X', 'SEG1X', 'SEG2X']);
    expect(segs[7999]).toBe('SEG7999X');
    expect(out.indexOf('START')).toBeLessThan(out.indexOf('SEG0X'));
    expect(out.indexOf('SEG7999X')).toBeLessThan(out.indexOf('MAINEND'));
    expect(out).not.toContain('Loading');
    expect(ms).toBeLessThan(4000); // 0.4.18: about 11 s on the machine that measured 0.6 s for this
  }, 120000);

  // T279: Chrome 158 with react-dom 19.3.1's runtime detaches such a segment, then the move throws (depth >= 1) or
  // never ends (depth 0, the tab hangs); either way its text is never shown. 0.4.18 and 0.4.19 printed it.
  it('a segment that holds its own boundary is dropped, wherever in it the boundary sits', () => {
    for (const depth of [0, 1, 40]) {
      const inner = `${'<div>'.repeat(depth)}<p>OWNTEXT</p><!--$?--><template id="B:0"></template><!--/$-->${'</div>'.repeat(depth)}`;
      const html = `<html><body><p>Before</p><div hidden id="S:0">${inner}</div><script>$RC("B:0","S:0")</script></body></html>`;
      const out = md(html);
      expect(out, `depth ${depth}`).not.toContain('OWNTEXT');
      expect(out, `depth ${depth}`).toContain('Before');
    }
  });

  // T279: a call looks its elements up as its script runs, before any reveal (Chrome 158): the first B:1 is the one
  // inside B:0's fallback, which B:0's reveal then removes, so SECOND is lost and "Wait" stays. 0.4.18 and 0.4.19
  // looked up after the earlier fill and put SECOND into the second B:1.
  it('a call gets the element its id names when its script runs, even one that an earlier reveal removes', () => {
    const html = '<html><body><main><p>A</p>' +
      '<!--$?--><template id="B:0"></template><p>Fallback</p><!--$?--><template id="B:1"></template><!--/$--><!--/$-->' +
      '<p>B</p><!--$?--><template id="B:1"></template><p>Wait</p><!--/$--><p>C</p></main>' +
      '<div hidden id="S:0"><p>FIRST</p></div><script>$RC("B:0","S:0")</script>' +
      '<div hidden id="S:1"><p>SECOND</p></div><script>$RC("B:1","S:1")</script></body></html>';
    const out = md(html);
    expect(out).not.toContain('Fallback');
    expect(out).not.toContain('SECOND');
    const order = ['A', 'FIRST', 'B', 'Wait', 'C'].map((w) => out.indexOf(w));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
  });
});
