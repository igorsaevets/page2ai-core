// P2A-076..080 (T280): what the T279 review panel found in 0.4.20, re-measured. Every expected text is what Chrome 158
// showed for the same bytes with react-dom 19.3.1's own inline runtime ($RB, $RV, $RC, and $RS where a test names it),
// read once React's reveal had run (D:\AI_Scratch\web-to-md\t280-work\cases_t280.mjs, chrome_t280.py). Each test
// fails on 0.4.20.

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (html: string): string =>
  htmlToMarkdown(html, { baseUrl: 'https://example.test/', includeFrontmatter: false }).markdown.trim();
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
const hex = (i: number): string => i.toString(16);
const rc = (b: string, s: string): string => `<script>$RC("B:${b}","S:${s}")</script>`;
const page = (body: string): string => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe('P2A-076: attribute names are fixed in one pass over each element', () => {
  it('40,000 upper-case attributes on one element, the last HIDDEN: hidden, and linear (0.4.20: 5.3 s)', () => {
    let attrs = '';
    for (let i = 0; i < 40000; i++) attrs += ` DATA-A${i}="v"`;
    for (const tag of ['div', 'section', 'svg']) {
      const t0 = performance.now();
      const out = md(page(`<main><p>START</p><${tag}${attrs} HIDDEN><p>SECRET</p></${tag}><p>END</p></main>`));
      expect(performance.now() - t0, tag).toBeLessThan(2000);
      expect(flat(out), tag).toBe('START END');
    }
  });

  it('of two names that match once lowered the first stays, also past 64 such pairs', () => {
    const link = (attrs: string): string => md(page(`<main><p><a${attrs}>link</a></p></main>`));
    expect(link(' HREF="/first" href="/second"')).toContain('(https://example.test/first)');
    expect(link(' href="/first" HREF="/second"')).toContain('(https://example.test/first)');
    let pairs = '';
    for (let i = 0; i < 100; i++) pairs += ` DATA-X${i}="1" data-x${i}="2"`;
    expect(link(`${pairs} HREF="/first" href="/second"`)).toContain('(https://example.test/first)');
  });
});

describe('P2A-077: no call finds an element whose content a browser reads as text', () => {
  it('a segment inside <noscript>, <iframe>, <noembed>, <noframes> or <xmp> does not fill (Chrome: the fallback)', () => {
    for (const box of ['noscript', 'iframe', 'noembed', 'noframes', 'xmp']) {
      const out = md(page(`<main><p>START</p><!--$?--><template id="B:0"></template><p>FBZERO</p><!--/$--><p>END</p></main>` +
        `<${box}><div hidden id="S:0"><p>BOXTEXT</p></div></${box}>${rc('0', '0')}`));
      expect(flat(out), box).toBe('START FBZERO END');
    }
  });
});

describe('P2A-078: a first move is not counted against the budget', () => {
  it('after a chain has spent the budget, a fresh segment of 200 paragraphs still fills its boundary', () => {
    // 1,000 boundaries, each inside the previous segment, revealed innermost first: 500 children move 1,000 times.
    // Chrome makes all of those moves; the replay stops the chain where the budget runs out (its fallback stays).
    const m = 1000;
    let segs = '';
    for (let i = 1; i < m; i++) {
      segs += `<div hidden id="S:${hex(i)}"><!--$?--><template id="B:${hex(i + 1)}"></template><b>FB${i}</b><!--/$--></div>`;
    }
    segs += `<div hidden id="S:${hex(m)}">${'<i>x</i>'.repeat(500)}</div>`;
    let calls = '';
    for (let i = m; i >= 1; i--) calls += rc(hex(i), hex(i));
    const rows = [...Array(200).keys()].map((r) => `<p>ROW${r}</p>`).join('');
    const out = md(page(`<main><p>START</p><!--$?--><template id="B:1"></template><p>FBONE</p><!--/$--><p>MID</p>` +
      `<!--$?--><template id="B:fffff"></template><p>LASTFALLBACK</p><!--/$--></main>` +
      `${segs}<div hidden id="S:fffff">${rows}</div>${calls}${rc('fffff', 'fffff')}`));
    expect(out.match(/ROW\d+/g)).toHaveLength(200);
    expect(out).not.toContain('LASTFALLBACK');
  });
});

describe('P2A-079: a segment that a call reached and did not reveal stays hidden', () => {
  it('after a reveal that throws, the later queued segment is not printed (no <main>: the body is the root)', () => {
    const out = md(page(`<p>START</p><!--$?--><template id="B:1"></template><p>FBONE</p><!--/$--><p>END</p>` +
      `<div hidden id="S:0"><div><!--$?--><template id="B:0"></template><p>FBX</p><!--/$--></div></div>` +
      `<div hidden id="S:1"><p>ONELEFTOVER</p></div>${rc('0', '0')}${rc('1', '1')}`));
    expect(flat(out)).toBe('START FBONE END');
  });
});

describe('P2A-080: $RC marks whatever stands before the template; a call that throws ends its script', () => {
  const prev = (open: string, close = '<!--/$-->'): string =>
    flat(md(page(`<main><p>START</p>${open}<template id="B:0"></template><p>FBZERO</p>${close}<p>END</p></main>` +
      `<div hidden id="S:0"><p>SEGZERO</p></div>${rc('0', '0')}`)));

  it('a space, an element, another comment, $! or & before the template: the boundary fills', () => {
    expect(prev('<!--$?--> ')).toBe('START $ SEGZERO END'); // the space becomes `$~`, then `$`
    expect(prev('<!--$?--><span>SPANTEXT</span>')).toBe('START SPANTEXT SEGZERO END');
    expect(prev('<!--note-->')).toBe('START SEGZERO END');
    expect(prev('<!--$!-->')).toBe('START SEGZERO END');
    expect(prev('<!--&-->', '<!--/&-->')).toBe('START SEGZERO END');
  });

  const twoBoundaries = (scripts: string): string =>
    flat(md(page(`<main><p>START</p><div><template id="B:0"></template><p>FBZERO</p><!--/$--></div>` +
      `<!--$?--><template id="B:1"></template><p>FBONE</p><!--/$--><p>END</p></main>` +
      `<div hidden id="S:0"><p>SEGZERO</p></div><div hidden id="S:1"><p>SEGONE</p></div>${scripts}`)));

  it('nothing before the template: the call throws and the next call of its script does not run', () => {
    expect(twoBoundaries('<script>$RC("B:0","S:0");$RC("B:1","S:1")</script>')).toBe('START FBZERO FBONE END');
    expect(twoBoundaries(rc('0', '0') + rc('1', '1'))).toBe('START FBZERO SEGONE END'); // its own script runs
  });

  it('$RS on a missing segment throws: the $RC after it in the same script does not run', () => {
    const out = md(page(`<main><p>START</p><!--$?--><template id="B:0"></template><p>FBZERO</p><!--/$--><p>END</p></main>` +
      `<div hidden id="S:0"><p>SEGZERO</p></div><script>$RS("S:9","P:9");$RC("B:0","S:0")</script>`));
    expect(flat(out)).toBe('START FBZERO END');
  });
});
