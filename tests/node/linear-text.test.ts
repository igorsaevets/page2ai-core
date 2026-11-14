// Page2AI T241 (from the T240 review panel): three regexes on the conversion path ran in quadratic or exponential time
// on text a page controls, synchronously, so a single page could hold the MCP server for minutes or hours:
//   convert.ts      /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:head|body)[\s>]/i   each leading comment doubled the time
//   basic-renderer  .replace(/\s*\n\s*/g, ' ') on a heading's text        quadratic in a run of blanks
//   basic-renderer  /\p{L}.*:\s*$/u on a button's aria-label               quadratic in a run of letters
// src/node/linear-text.ts replaces each with a one-pass function. The first block proves each function returns what
// its regex returned; the second times the pages that stalled 0.4.6 (each took seconds there; budget 1 s here).

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/convert.js';
import { endsWithLetteredColon, InlineText, lineBreakRunsToSpace, opensWithHeadOrBody } from '../../src/node/linear-text.js';

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

// Page2AI T242 (P2A-035): renderInlineNodes asked these questions of the whole text it was building, once per child.
// InlineText answers them from the last part and two facts about the text before it; after every step of 20,000
// generated sequences each answer must equal the old expression on the plain string built by the same steps.
describe('InlineText answers what the old expressions answered on the whole text', () => {
  const ch = String.fromCharCode;
  const pieces = [
    'a', '1', 'é', ch(0x6771), String.fromCodePoint(0x1d400), ch(0xd835), ch(0xdc00), ' ', '\n', '\t', ch(0x3000), ch(0xa0),
    '*', '!', '[', '\\', '\\\\', '.', '`', '_', '$', 'ab', '!a', 'a!', '\\!',
  ];
  const questions = (t: InlineText): unknown[] => [
    t.isEmpty, t.endsWithSpace(), t.endsWithStar(), t.endsWithWordChar(), t.endsWithOpenEscape(), t.endsWithBareBang(), t.toString(),
  ];
  const expressions = (s: string): unknown[] => [
    s === '', /\s$/.test(s), s.endsWith('*'), /[\p{L}\p{N}]$/u.test(s), /(?:^|[^\\])(?:\\\\)*\\$/.test(s), /(?:^|[^\\])(?:\\\\)*!$/.test(s), s,
  ];

  it('after every append and every last-character replacement', () => {
    let x = 7;
    const next = (n: number): number => {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      return (x >>> 16) % n;
    };
    const failures: string[] = [];
    for (let k = 0; k < 20_000 && failures.length < 5; k++) {
      const t = new InlineText();
      let s = '';
      for (let step = next(13); step > 0; step--) {
        if (s && next(6) === 0) {
          t.replaceLastChar('\\!');
          s = `${s.slice(0, -1)}\\!`;
        } else {
          let part = '';
          for (let j = next(3) + 1; j > 0; j--) part += pieces[next(pieces.length)];
          t.append(part);
          s += part;
        }
        const got = JSON.stringify(questions(t));
        const want = JSON.stringify(expressions(s));
        if (got !== want) failures.push(`${JSON.stringify(s)}: got ${got}, want ${want}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('across part boundaries: a surrogate pair, a run of backslashes, an empty part', () => {
    const t = new InlineText();
    t.append(ch(0xd835));
    expect(t.endsWithWordChar()).toBe(false);
    t.append(ch(0xdc00));
    expect(t.endsWithWordChar()).toBe(true); // U+1D400, a letter, split over two parts
    t.append('\\');
    t.append('');
    t.append('\\');
    t.append('\\');
    expect(t.endsWithOpenEscape()).toBe(true); // three backslashes over three parts
    t.append('!');
    expect(t.endsWithBareBang()).toBe(false); // the third backslash escapes it
    t.replaceLastChar('\\!');
    expect(t.toString()).toBe(`${ch(0xd835)}${ch(0xdc00)}\\\\\\\\!`);
    expect(t.endsWithBareBang()).toBe(true);
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
