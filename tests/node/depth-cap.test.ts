// P2A-033 + P2A-036: deep nesting is capped in the HTML text before linkedom parses it (src/node/depth-cap.ts).
// On 0.4.16 a page nested past ~800 levels (~400 in Chrome's worker) became the «extraction failed» document, and the
// parse itself cost the square of the depth (100,000 nested <div>: 15 s before any core code ran).
import { describe, expect, it } from 'vitest';
import { Parser } from 'htmlparser2';
import { parseHTML } from 'linkedom';
import { htmlToMarkdown } from '../../src/node/convert.js';
import { capNesting, MAX_PARSE_DEPTH, nestingDepth } from '../../src/node/depth-cap.js';

const VOID = new Set(['area', 'base', 'basefont', 'br', 'col', 'command', 'embed', 'frame', 'hr', 'img', 'input',
  'isindex', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// htmlparser2's own stack depth, with linkedom's options: the number the replay must reproduce.
const parserDepth = (html: string): number => {
  let max = 0;
  const p: Parser = new Parser({
    onopentag(name, _attribs, implied) {
      if (!implied && !VOID.has(name) && (p as unknown as { stack: string[] }).stack.length > max) {
        max = (p as unknown as { stack: string[] }).stack.length;
      }
    },
  }, { lowerCaseAttributeNames: false, decodeEntities: true, xmlMode: false });
  p.write(html);
  p.end();
  return max;
};

// The deepest element linkedom builds (html = 1), walked without recursion.
const treeDepth = (html: string): number => {
  const doc = parseHTML(html).document as unknown as Document;
  let max = 0;
  const work: Array<[Element, number]> = [];
  for (let c = doc.firstElementChild; c; c = c.nextElementSibling) work.push([c, 1]);
  while (work.length) {
    const [el, d] = work.pop() as [Element, number];
    if (d > max) max = d;
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) work.push([c, d + 1]);
  }
  return max;
};

// Text the parser emits, whitespace dropped (capNesting adds spaces and <br>, never letters).
const parserText = (html: string): string => {
  let s = '';
  const p = new Parser({ ontext(t) { s += t; } }, { decodeEntities: true, xmlMode: false });
  p.write(html);
  p.end();
  return s.replace(/\s+/g, '');
};

// Seeded tag soup over the parser's special cases: implied closes, optional end tags, svg/math and `/>`, raw text,
// stray end tags, void elements.
const soup = (seed: number, tokens: number): string => {
  let x = seed;
  const rnd = (n: number): number => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return (x >>> 8) % n;
  };
  const OPEN = ['div', 'p', 'li', 'ul', 'ol', 'td', 'tr', 'th', 'table', 'tbody', 'thead', 'tfoot', 'option',
    'optgroup', 'select', 'dd', 'dt', 'dl', 'h1', 'h2', 'b', 'i', 'span', 'a', 'svg', 'math', 'g', 'desc', 'mi',
    'foreignObject', 'blockquote', 'section', 'button', 'rt', 'rp', 'ruby', 'form', 'body', 'head', 'br', 'hr',
    'img', 'input', 'textarea', 'title', 'script', 'style', 'xmp'];
  const RAW: Record<string, string> = { textarea: 'x<b>y', title: 't<i>', script: 'if(a<b)c()', style: 'a>b{}', xmp: '<p>' };
  let s = '';
  for (let i = 0; i < tokens; i++) {
    const r = rnd(10);
    const name = OPEN[rnd(OPEN.length)];
    if (r < 5) {
      const self = rnd(6) === 0 ? '/' : '';
      s += `<${rnd(5) === 0 ? name.toUpperCase() : name}${rnd(3) === 0 ? ' class="c"' : ''}${self}>`;
      if (RAW[name] && !self) s += `${RAW[name]}</${name}>`;
    } else if (r < 8) s += `</${name}>`;
    else s += ` w${i} `;
  }
  return s;
};

describe('the replay is htmlparser2 10.1.0\'s Parser (P2A-033 T243: a stack without implied closes counted 175 for 42)', () => {
  it('gives the parser\'s depth on 400 seeded tag soups', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const html = soup(seed, 150);
      expect(nestingDepth(html, Infinity).depth, html).toBe(parserDepth(html));
    }
  });

  it('gives the parser\'s depth on minified markup without optional end tags', () => {
    const pages = [
      '<table>' + '<tr><td>a<td>b'.repeat(300) + '</table>',
      '<ul>' + '<li>x'.repeat(300) + '</ul><ol>' + '<li><p>y'.repeat(50) + '</ol>',
      '<ul>' + '<li><a href=/x>t'.repeat(60) + '</ul>',
      '<p><em>a'.repeat(60),
      '<svg><g/><path/><svg/><div/><x/></svg><div/><p>after',
      '<script/><div><p>inside an open script</div>',
    ];
    for (const html of pages) expect(nestingDepth(html, Infinity).depth).toBe(parserDepth(html));
  });
});

describe('the cap', () => {
  const nested = (n: number): string => `<html><body>${'<div>'.repeat(n)}deep text${'</div>'.repeat(n)}</body></html>`;

  it('returns a page no deeper than the cap as the same string', () => {
    const atCap = nested(MAX_PARSE_DEPTH - 2);
    expect(nestingDepth(atCap).depth).toBe(MAX_PARSE_DEPTH);
    expect(capNesting(atCap)).toBe(atCap);
    expect(capNesting(nested(MAX_PARSE_DEPTH - 1))).not.toBe(nested(MAX_PARSE_DEPTH - 1));
  });

  it('bounds the tree and keeps every word, on 400 seeded tag soups with a cap of 6', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const html = soup(seed, 150);
      const out = capNesting(html, 6);
      expect(treeDepth(out), html).toBeLessThanOrEqual(6 + 4);
      expect(parserText(out), html).toBe(parserText(html));
    }
  });

  it('keeps a list item, a row and a cell under a list or a table at the cap, so their text is written', () => {
    for (const level of ['<ul><li>', '<ol><li><p>p</p>', '<table><tr><td>', '<table><tbody><tr><td><blockquote>']) {
      const page = `<html><body>${level.repeat(400)}DEEPTEXT</body></html>`;
      const md = htmlToMarkdown(page).markdown;
      expect(md, level).toContain('DEEPTEXT');
    }
  });
});

describe('deep pages convert with their text (0.4.16: the «extraction failed» document past ~800 levels)', () => {
  const page = (body: string): string =>
    `<html><head><title>D</title></head><body><main><p>Start.</p>${body}<p>End.</p></main></body></html>`;
  const shapes: Record<string, string> = {
    div: '<div>'.repeat(3000) + '<p>DEEPTEXT</p>' + '</div>'.repeat(3000),
    blockquote: '<blockquote>'.repeat(3000) + 'DEEPTEXT' + '</blockquote>'.repeat(3000),
    list: '<ul><li>'.repeat(1500) + 'DEEPTEXT' + '</li></ul>'.repeat(1500),
    span: '<p>' + '<span>'.repeat(5000) + 'DEEPTEXT' + '</span>'.repeat(5000) + '</p>',
    table: '<table><tr><td>'.repeat(4000) + 'DEEPTEXT' + '</td></tr></table>'.repeat(4000),
    unclosedListLinks: '<ul>' + '<li><a href="/x">t'.repeat(2000) + '<li>DEEPTEXT</ul>',
    unclosedParagraphs: '<p><em>t'.repeat(2000) + '<p>DEEPTEXT',
    hiddenTabPanels: Array.from({ length: 1500 }, (_, i) =>
      `<div hidden><div role="tablist"><button role="tab" aria-controls="q${i}">Q${i}</button></div></div><div id="q${i}">`)
      .join('') + 'DEEPTEXT' + '</div>'.repeat(1500),
  };
  for (const [name, body] of Object.entries(shapes)) {
    it(name, () => {
      const md = htmlToMarkdown(page(body)).markdown;
      expect(md).not.toMatch(/extraction failed|Maximum call stack/);
      expect(md).toContain('DEEPTEXT');
      expect(md).toContain('End.');
    });
  }

  it('100,000 nested <div> convert in well under 5 s (0.4.16: 15 s of parse, then the failure document)', () => {
    const t = performance.now();
    const md = htmlToMarkdown(page('<div>'.repeat(100000) + 'DEEPTEXT' + '</div>'.repeat(100000))).markdown;
    expect(performance.now() - t).toBeLessThan(5000);
    expect(md).toContain('DEEPTEXT');
  });

  it('separates the lines of block elements removed past the cap', () => {
    const body = Array.from({ length: 600 }, (_, i) => `<div>line${i} `).join('') + '</div>'.repeat(600);
    const md = htmlToMarkdown(page(body)).markdown;
    expect(md).toContain('line599');
    expect(md).not.toMatch(/line\d+line\d+/);
  });
});
