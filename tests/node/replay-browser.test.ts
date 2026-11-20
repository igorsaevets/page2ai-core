// P2A-072..075 (T279): the streaming replay does what Chrome does with the same bytes. Each page below was loaded in
// Chrome 158 (headless, installed Google Chrome) with react-dom 19.3.1's own inline runtime ($RB, $RV, $RC as React
// writes them) and read once React's reveal had run; the expected text is what Chrome showed. Here the calls run
// without that runtime, as on every saved page: the replay never executes a page's script.
// What Chrome showed: $RC only looks its two elements up as its script runs and queues the pair; the reveal runs once
// the page is parsed, in call order; it detaches the segment, removes every node from the boundary to its end comment
// (to the end of the parent when there is none) and moves the segment's children there.

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (html: string): string =>
  htmlToMarkdown(html, { baseUrl: 'https://example.test/', includeFrontmatter: false }).markdown.trim();
const hex = (i: number): string => i.toString(16);
const calls = (list: string[]): string => list.map((c) => `<script>${c}</script>`).join('');
const words = (s: string): string[] => s.match(/[A-Za-z0-9]+/g) || [];

describe('P2A-072..075: the streaming replay shows what Chrome shows', () => {
  it('P2A-072: fills whose fallbacks are padded with comments all happen (0.4.19 stopped part way)', () => {
    let h = '<html><body><main>';
    for (let i = 0; i < 40; i++) h += `<!--$?--><template id="B:${hex(i)}"></template>${'<!---->'.repeat(4000)}<p>FB${i}</p><!--/$-->`;
    h += '</main>';
    for (let i = 0; i < 40; i++) h += `<div hidden id="S:${hex(i)}"><p>SEGX${i}</p></div>`;
    const out = md(h + calls([...Array(40).keys()].map((i) => `$RC("B:${hex(i)}","S:${hex(i)}")`)) + '</body></html>');
    expect(words(out).filter((w) => /^SEGX\d+$/.test(w))).toHaveLength(40);
    expect(out).not.toMatch(/FB\d/);
  });

  it('P2A-072: boundaries with no end comment take every later sibling; a valid fill after them still happens', () => {
    for (const n of [3, 1000]) {
      let h = '<html><body><main><div>';
      for (let i = 0; i < n; i++) h += `<!--$?--><template id="B:${hex(i)}"></template>`;
      h += '<span>s</span>'.repeat(200) + '</div><!--$?--><template id="B:fffff"></template><p>LOADING</p><!--/$--></main>';
      for (let i = 0; i < n; i++) h += `<div hidden id="S:${hex(i)}"><p>D${i}</p></div>`;
      h += '<div hidden id="S:fffff"><p>REALCONTENT</p></div>';
      const list = [...Array(n).keys()].map((i) => `$RC("B:${hex(i)}","S:${hex(i)}")`);
      // Chrome: the first reveal removes the other templates and the 200 spans and appends D0; the others find no
      // boundary; REALCONTENT fills its own.
      expect(md(h + calls([...list, '$RC("B:fffff","S:fffff")']) + '</body></html>'), `n=${n}`).toBe('D0\n\nREALCONTENT');
    }
  });

  it('a boundary with no end comment: later siblings in its parent go, the rest of the page stays', () => {
    const html = '<html><body><main><p>START</p><div><!--$?--><template id="B:0"></template><p>FBZERO</p><p>AFTER</p></div>' +
      '<p>OUTSIDE</p></main><div hidden id="S:0"><p>SEGZERO</p></div>' + calls(['$RC("B:0","S:0")']) + '</body></html>';
    expect(md(html)).toBe('START\n\nSEGZERO\n\nOUTSIDE');
  });

  it('P2A-073: a call whose script an earlier reveal removes still runs (it ran when it was parsed)', () => {
    const html = '<html><body><div hidden id="S:0"><p>ZERO</p></div><div hidden id="S:1"><p>ONE</p></div>' +
      '<main><p>START</p><!--$?--><template id="B:1"></template><p>FBONE</p><!--/$--><p>MID</p>' +
      `<!--$?--><template id="B:0"></template><p>FBZERO</p>${calls(['$RC("B:0","S:0")', '$RC("B:1","S:1")'])}<!--/$-->` +
      '<p>END</p></main></body></html>';
    expect(md(html)).toBe('START\n\nONE\n\nMID\n\nZERO\n\nEND');
  });

  it('a segment that an earlier reveal removed still fills its boundary (it was looked up before)', () => {
    const html = '<html><body><main><!--$?--><template id="B:0"></template><p>FBZERO</p><div hidden id="S:1"><p>ONE</p></div>' +
      '<!--/$--><!--$?--><template id="B:1"></template><p>FBONE</p><!--/$--></main><div hidden id="S:0"><p>ZERO</p></div>' +
      calls(['$RC("B:0","S:0")', '$RC("B:1","S:1")']) + '</body></html>';
    expect(md(html)).toBe('ZERO\n\nONE');
  });

  it('P2A-074: calls naming one segment id all get the first segment; the other boundaries lose their fallback', () => {
    let h = '<html><body><main><p>START</p>';
    for (let i = 0; i < 3; i++) h += `<!--$?--><template id="B:${hex(i)}"></template><p>FB${i}</p><!--/$-->`;
    h += '<p>END</p></main>';
    for (let i = 0; i < 3; i++) h += `<div hidden id="S:d"><p>SEGX${i}</p></div>`;
    expect(md(h + calls([0, 1, 2].map((i) => `$RC("B:${hex(i)}","S:d")`)) + '</body></html>')).toBe('START\n\nSEGX0\n\nEND');
  });

  it('a segment holding its own boundary is dropped and no later pair is revealed (the move throws)', () => {
    const page = (order: string[]): string =>
      '<html><body><main><p>START</p><!--$?--><template id="B:1"></template><p>FBONE</p><!--/$--><p>END</p></main>' +
      '<div hidden id="S:0"><p>SEGZERO</p><section><!--$?--><template id="B:0"></template><p>FBZERO</p><!--/$--></section></div>' +
      '<div hidden id="S:1"><p>ONE</p></div>' + calls(order) + '</body></html>';
    expect(md(page(['$RC("B:0","S:0")', '$RC("B:1","S:1")']))).toBe('START\n\nFBONE\n\nEND');
    expect(md(page(['$RC("B:1","S:1")', '$RC("B:0","S:0")']))).toBe('START\n\nONE\n\nEND');
    // The boundary as the segment's own child: Chrome never finishes that reveal (the tab hangs); the replay ends.
    const direct = '<html><body><main><p>START</p></main><div hidden id="S:0"><p>SEGZERO</p><!--$?-->' +
      '<template id="B:0"></template><p>FBZERO</p><!--/$--></div>' + calls(['$RC("B:0","S:0")']) + '</body></html>';
    expect(md(direct)).toBe('START');
  });

  it('P2A-072: work that repeats is bounded per call, so a later cheap fill still happens (0.4.19 stopped there)', () => {
    // 1,000 children moved through a chain of 2,000 segments, each revealed into a boundary inside the next one:
    // every reveal moves them again (Chrome makes those 2 million moves). Past the budget a reveal that would move more
    // than its share keeps its fallback, and the reveals after it go on.
    const k = 1000;
    const m = 2000;
    let h = '<html><body><main><p>START</p><!--$?--><template id="B:0"></template><p>FB0</p><!--/$--><p>MID</p>' +
      '<!--$?--><template id="B:fffff"></template><p>LASTFALLBACK</p><!--/$--></main>';
    h += `<div hidden id="S:0">${'<i>x</i>'.repeat(k)}</div>`;
    for (let j = 1; j <= m; j++) h += `<div hidden id="S:${hex(j)}"><!--$?--><template id="B:${hex(j + 1)}"></template><!--/$--></div>`;
    h += '<div hidden id="S:fffff"><p>LASTCONTENT</p></div>';
    const list = [];
    for (let j = 1; j <= m; j++) list.push(`$RC("B:${hex(j + 1)}","S:${hex(j - 1)}")`);
    list.push(`$RC("B:0","S:${hex(m)}")`, '$RC("B:fffff","S:fffff")');
    const t0 = performance.now();
    const out = md(h + calls(list) + '</body></html>');
    expect(performance.now() - t0).toBeLessThan(10000);
    expect(out).toContain('LASTCONTENT');
    expect(out).not.toContain('LASTFALLBACK');
    expect(out).not.toContain('FB0');
  }, 60000);

  it('P2A-075: an SVG segment wrapper written in upper case is found; of two names that differ in case the first wins', () => {
    for (const attrs of ['ARIA-HIDDEN="true" STYLE="display:none" ID="S:0"',
      'ARIA-HIDDEN="true" aria-hidden="false" Style="display:none" Id="S:0"']) {
      const html = '<html><body><main><p>A</p><!--$?--><template id="B:0"></template><p>FBSVG</p><!--/$--><p>Z</p></main>' +
        `<svg ${attrs}><g><text>SEGSVG</text></g></svg>${calls(['$RC("B:0","S:0")'])}</body></html>`;
      const out = md(html);
      expect(out, attrs).not.toContain('FBSVG');
      expect(out, attrs).toContain('A');
    }
    // A later name that only matches once lowercased is dropped, as Chrome drops it: aria-hidden stays "false".
    const html = '<html><body><main><p>A</p><!--$?--><template id="B:0"></template><p>FBSVG</p><!--/$--></main>' +
      `<svg aria-hidden="false" ARIA-HIDDEN="true" style="display:none" id="S:0"><text>SEGSVG</text></svg>${calls(['$RC("B:0","S:0")'])}</body></html>`;
    expect(md(html)).toContain('FBSVG');
  });
});
