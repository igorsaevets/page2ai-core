import { describe, expect, it } from 'vitest';
import {
  compactLinkLabels,
  dedupeAdjacentLinks,
} from '../../src/shared/md-postprocess.js';

// The bug these lock down (found in the T60 audit, reproduced on the shipped
// 0.1.5 build): the link regexes captured the URL with [^)]+, which stops at
// the FIRST ')'. A Wikipedia-style URL ".../Foo_(bar)" was split mid-URL, so
// duplicates were not detected and a stray ')' leaked into the output:
//   in:  [A](http://x/a_(b)) [A](http://x/a_(b))
//   out: [A](http://x/a_(b)) )
describe('dedupeAdjacentLinks — parenthesised URLs', () => {
  const cfg = { dedupeAdjacentLinks: true };

  it('dedupes inline duplicates whose URL contains balanced parens, no stray tail', () => {
    const out = dedupeAdjacentLinks('[A](http://x/a_(b)) [A](http://x/a_(b))', cfg);
    expect(out).toBe('[A](http://x/a_(b))');
  });

  it('dedupes identical adjacent lines with paren URLs', () => {
    const out = dedupeAdjacentLinks(
      '[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))\n[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))',
      cfg,
    );
    expect(out).toBe('[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))');
  });

  it('keeps distinct links intact', () => {
    const input = '[A](http://x/one) [B](http://x/two)';
    expect(dedupeAdjacentLinks(input, cfg)).toBe(input);
  });
});

describe('compactLinkLabels — parenthesised URLs', () => {
  it('truncates a long label without cutting the URL at an inner paren', () => {
    const longLabel = 'x'.repeat(80);
    const out = compactLinkLabels(
      `[${longLabel}](https://en.wikipedia.org/wiki/Foo_(bar))`,
      { compactLinkLabels: true, maxLinkLabelChars: 20 },
    );
    expect(out).toContain('(https://en.wikipedia.org/wiki/Foo_(bar))');
    expect(out).toContain('…');
  });
});
