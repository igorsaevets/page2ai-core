// Page2AI T241 (from the T240 review panel): three regexes on the conversion path ran in quadratic or exponential time
// on text a page controls, synchronously, so a single page could hold the MCP server for minutes or hours:
//   convert.ts      /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:head|body)[\s>]/i   each leading comment doubled the time
//   basic-renderer  .replace(/\s*\n\s*/g, ' ') on a heading's text        quadratic in a run of blanks
//   basic-renderer  /\p{L}.*:\s*$/u on a button's aria-label               quadratic in a run of letters
// src/node/linear-text.ts replaces each with a one-pass function. The first block proves each function returns what
// its regex returned; the second times the pages that stalled 0.4.6 (each took seconds there; budget 1 s here).

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/convert.js';
import { endsWithLetteredColon, lineBreakRunsToSpace, opensWithHeadOrBody } from '../../src/node/linear-text.js';

// Every string up to `maxLen` pieces long from a seeded generator: a failure replays.
const generated = (pieces: string[], count: number, maxLen: number, seed: number): string[] => {
  let x = seed;
  const next = (n: number): number => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return x % n;
  };
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    let s = '';
    const len = next(maxLen + 1);
    for (let i = 0; i < len; i++) s += pieces[next(pieces.length)];
    out.push(s);
  }
  return out;
};

describe('each one-pass function returns what its regex returned', () => {
  it('lineBreakRunsToSpace(s) === s.replace(/\\s*\\n\\s*/g, " ")', () => {
    const pieces = [' ', '\n', '\r', '\t', '\u3000', '\u00a0', '\u2028', 'a', 'b', '\n\n'];
    for (const s of generated(pieces, 20_000, 14, 1)) expect(lineBreakRunsToSpace(s), JSON.stringify(s)).toBe(s.replace(/\s*\n\s*/g, ' '));
  });

  it('endsWithLetteredColon(s) === /\\p{L}.*:\\s*$/u.test(s)', () => {
    const pieces = [':', 'a', 'é', 'Ж', '𝐀', '1', '-', ' ', '\n', '\r', '\u2028', '\u2029', '\u3000', '\t'];
    for (const s of generated(pieces, 20_000, 10, 2)) expect(endsWithLetteredColon(s), JSON.stringify(s)).toBe(/\p{L}.*:\s*$/u.test(s));
  });

  it('opensWithHeadOrBody(s) === the old regex with each comment ending at its first -->', () => {
    // The old regex let a comment run past its first `-->`; HTML does not, and neither does the new function. With
    // the comment body tempered to stop there, the regex and the function must agree on everything else.
    const html = /^\s*(?:<!--(?:(?!-->)[\s\S])*-->\s*)*<(?:head|body)[\s>]/i;
    const pieces = ['<!--', '-->', '<!--a-->', '<!---->', '<!-->', ' ', '\n', 'x', '<head>', '<HEAD ', '<body>', '<body\t', '<head', '<bodyx', '<', '-', '>'];
    for (const s of generated(pieces, 20_000, 8, 3)) expect(opensWithHeadOrBody(s), JSON.stringify(s)).toBe(html.test(s));
  });

  it('opensWithHeadOrBody differs from the old regex only by ending a comment at its first -->', () => {
    const old = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:head|body)[\s>]/i;
    expect(old.test('<!--a-->text--><head>')).toBe(true);
    expect(opensWithHeadOrBody('<!--a-->text--><head>')).toBe(false);
    for (const s of ['<head>', '  <!-- a --> <!--b--><body class="x">', '<!--a--><BODY>', '<!-- -->\n<head\t']) {
      expect(old.test(s)).toBe(true);
      expect(opensWithHeadOrBody(s)).toBe(true);
    }
    for (const s of ['', '<html>', '<!-- open', '<!--a--><headx>', 'text<head>', '<!--a-->x<body>']) {
      expect(old.test(s)).toBe(false);
      expect(opensWithHeadOrBody(s)).toBe(false);
    }
  });
});

describe('a page cannot stall the conversion (each of these took seconds to hours on 0.4.6)', () => {
  const timed = (html: string): { ms: number; markdown: string } => {
    const t = performance.now();
    const r = htmlToMarkdown(html, { baseUrl: 'https://example.com/', includeFrontmatter: false });
    return { ms: performance.now() - t, markdown: r.markdown };
  };

  it('a page without <html> whose first 30 nodes are comments', () => {
    // 0.4.6: about 16 s here, doubling with each further comment.
    const { ms, markdown } = timed(`<!DOCTYPE html>${'<!-- c -->'.repeat(30)}<title>T</title><p>Hello</p>`);
    expect(markdown).toContain('Hello');
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('a fragment whose first 30 nodes are comments', () => {
    const { ms, markdown } = timed(`${'<!--a-->'.repeat(30)}<p>Hello</p>`);
    expect(markdown).toContain('Hello');
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('a heading holding 100,000 ideographic spaces', () => {
    // 0.4.6: about 5 s here; the run survives inline rendering, which collapses only ASCII blanks.
    const { ms, markdown } = timed(`<html><body><main><h2>a${'\u3000'.repeat(100_000)}b</h2><p>after</p></main></body></html>`);
    expect(markdown).toMatch(/^## a\u3000+b$/m);
    expect(markdown).toContain('after');
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('a button whose aria-label holds 100,000 letters', () => {
    // 0.4.6: about 3 s here.
    const { ms, markdown } = timed(`<html><body><main><p>Do <button aria-label="${'a'.repeat(100_000)} x">x</button> now</p></main></body></html>`);
    expect(markdown).toContain('now');
    expect(ms).toBeLessThan(1000);
  }, 120_000);
});
