// P2A-033 + P2A-036: deep nesting is capped in the HTML text before linkedom parses it (src/node/depth-cap.ts).
// On 0.4.16 a page nested past ~800 levels (~400 in Chrome's worker) became the «extraction failed» document, and the
// parse itself cost the square of the depth (100,000 nested <div>: 15 s before any core code ran).
import { describe, expect, it } from 'vitest';
import { Parser } from 'htmlparser2';
import { parseHTML } from 'linkedom';
import { htmlToMarkdown } from '../../src/node/convert.js';
import { boundTreeDepth, capNesting, MAX_PARSE_DEPTH, nestingDepth } from '../../src/node/depth-cap.js';

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

// Text the parser emits outside every element that hides its content (a tag the renderer skips, `hidden`, inline
// display:none or visibility:hidden), exactly, spaces included: capNesting adds <br> and empty comments, never text, and
// drops only what such an element holds (T260: 0.4.17 showed hidden text past the cap and joined `&`+`amp;` into `&`).
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'head', 'title', 'select',
  'datalist', 'textarea', 'iframe', 'object', 'embed', 'audio', 'video']);
const shownText = (html: string): string => {
  let s = '';
  const hiding: boolean[] = [];
  let hidden = 0;
  const p = new Parser({
    onopentag(name, attribs) {
      const a = Object.fromEntries(Object.entries(attribs).map(([k, v]) => [k.toLowerCase(), v]));
      const h = SKIPPED.has(name) || 'hidden' in a || /(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(a.style || '');
      hiding.push(h);
      if (h) hidden++;
    },
    onclosetag() {
      if (hiding.pop()) hidden--;
    },
    ontext(t) {
      if (!hidden) s += t;
    },
  }, { lowerCaseAttributeNames: false, decodeEntities: true, xmlMode: false });
  p.write(html);
  p.end();
  return s;
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
    } else if (r < 8) s += `</${rnd(4) === 0 ? ' ' : ''}${name}>`;
    else s += [` w${i} `, ` w${i} `, '&', '&am', 'p;', '<', '&#6', '5;', ' &#32;'][rnd(9)];
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

  it('bounds the tree and keeps the shown text exactly, on 400 seeded tag soups with a cap of 6', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const html = soup(seed, 150);
      const out = capNesting(html, 6);
      expect(treeDepth(out), html).toBeLessThanOrEqual(6 + 4);
      expect(shownText(out), html).toBe(shownText(html));
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

describe('past the cap the page shows no more and no less than it did (T260, the T259 panel on 0.4.17)', () => {
  const nest = (n: number, inner: string): string => '<div>'.repeat(n) + inner + '</div>'.repeat(n);
  const page = (body: string): string =>
    `<!DOCTYPE html><html><head><title>T</title></head><body><main><p>Start.</p>${body}<p>End.</p></main></body></html>`;
  const md = (html: string): string => htmlToMarkdown(html, { includeFrontmatter: false }).markdown;

  it('shows no hidden text (0.4.17 wrote all seven kinds below 200 levels)', () => {
    const hid = '<div hidden><p>HID_ATTR</p></div><span style="display:none">HID_STYLE</span>' +
      '<div style="visibility: hidden">HID_VIS</div><span style="display&#58;none">HID_ENT</span>' +
      '<template><p>HID_TEMPLATE</p></template><noscript><p>HID_NOSCRIPT</p></noscript>' +
      '<select><option>HID_OPTION</option></select><svg><text>HID_SVG</text></svg>' +
      '<script/><p>HID_SCRIPT</p></script><p>SHOWN_AFTER</p>';
    for (const n of [3, 205, 400, 5000]) {
      const out = md(page(nest(n, hid)));
      expect(out, String(n)).toContain('SHOWN_AFTER');
      expect(out, String(n)).toContain('End.');
      expect(out, String(n)).not.toMatch(/HID_/);
    }
  });

  it('joins no text across a removed tag into a character reference, a tag or extra spaces', () => {
    for (const inner of ['<p>X&<b>amp;</b>Y Z&lt<i>;</i>W Q&#6<b>5;</b>R</p>', '<p>a<<b>div>b</b> c</p>',
      '<p>AAA<span>B</ span>CCC</  span>DDD</p>', '<p>T&#x00000<b>41;</b>U</p>']) {
      const html = page(nest(258, inner));
      expect(capNesting(html), inner).not.toBe(html);
      expect(shownText(capNesting(html)), inner).toBe(shownText(html));
    }
  });

  it('reads a space written as a reference as a space', () => {
    expect(md(page(nest(258, '<div>A</div>&#32;<div>B</div>')))).toBe(md(page(nest(258, '<div>A</div> <div>B</div>'))));
  });

  it('keeps lines, images and hidden text apart when React segments stack past the tree bound', () => {
    const k = 150;
    const html = page(
      nest(k, '<!--$?--><template id="B:0"></template><p>fallback0</p><!--/$-->') + '</main>' +
      `<div hidden id="S:0">${nest(k, '<div>W1 one</div><div>W2 two</div><p>line a<br>line b</p>' +
        '<img src="/deep.png" alt="DEEPIMG"><div hidden>HID_DEEP</div><select><option>HID_OPT</option></select>' +
        '<!--$?--><template id="B:1"></template><p>fallback1</p><!--/$-->')}</div>` +
      `<div hidden id="S:1">${nest(k, '<div>V1 one</div><div>V2 two</div>')}</div>` +
      '<script>$RC("B:0","S:0")</script><script>$RC("B:1","S:1")</script><main>',
    );
    const out = md(html);
    for (const w of ['W1 one', 'W2 two', 'line a', 'line b', 'V1 one', 'V2 two', 'DEEPIMG']) expect(out, w).toContain(w);
    expect(out).not.toMatch(/oneW2|twoline|aline|bV1|oneV2|HID_|fallback/);
  });

  it('boundTreeDepth replaces what is too deep and leaves at most the bound', () => {
    const doc = parseHTML(`<html><body>${nest(300, '<p>DEEP</p>')}</body></html>`).document as unknown as Document;
    expect(boundTreeDepth(doc, 50)).toBeGreaterThan(0);
    const html = (doc as unknown as { toString(): string }).toString();
    expect(treeDepth(html)).toBeLessThanOrEqual(51);
    expect(html).toContain('DEEP');
  });
});
