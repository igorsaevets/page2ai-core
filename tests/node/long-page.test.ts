// P2A-031 (Page2AI T239): core 0.4.5 returned «Page2AI extraction failed ... Maximum call stack size exceeded» for a
// page that renders to about 120,000 Markdown lines or more. The renderer spread page-sized arrays into call arguments
// (`parts.push(...lines)`, `out.push('', ...lines, '')`, `seq.push(...children)`, `Math.max(...widths)`), and V8 throws
// a RangeError for a call with that many arguments. Each page below failed whole on 0.4.5, each through a different
// one of those calls; the last test keeps call-argument spreads out of src/ so a new one cannot wait for a long page.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/convert.js';

const page = (body: string): string => `<html><head><title>dense</title></head><body><main>${body}</main></body></html>`;
const convert = (html: string): string => {
  const r = htmlToMarkdown(html, { baseUrl: 'https://example.com/', includeFrontmatter: false });
  // htmlToMarkdown turns any exception into an error document; name it in the failure instead of a count mismatch.
  expect(r.title, r.markdown.slice(0, 400)).toBe('dense');
  return r.markdown;
};
const linesMatching = (md: string, re: RegExp): string[] => md.split('\n').filter((l) => re.test(l));
const LONG = 120_000;

describe('P2A-031: pages that render to more than ~120,000 lines', () => {
  it('converts the 90,000-row page of the bug report (the body lines)', () => {
    const md = convert(page("<div><p>Row <b>bold</b> <a href='/x'>link</a></p></div>".repeat(90_000)));
    expect(linesMatching(md, /^Row \*\*bold\*\* \[link\]\(https:\/\/example\.com\/x\)$/)).toHaveLength(90_000);
  }, LONG);

  it('converts a table with 150,000 rows (the column count)', () => {
    let rows = '';
    for (let i = 0; i < 150_000; i++) rows += `<tr><td>${i}</td><td>x</td></tr>`;
    const md = convert(page(`<table><tr><th>n</th><th>v</th></tr>${rows}</table>`));
    expect(md).toContain('| n | v |\n| --- | --- |\n| 0 | x |\n');
    const body = linesMatching(md, /^\| \d+ \| x \|$/);
    expect(body).toHaveLength(150_000);
    expect(body[body.length - 1]).toBe('| 149999 | x |');
  }, LONG);

  it('converts a <dl> with 75,000 term/description pairs (the list lines)', () => {
    let items = '';
    for (let i = 0; i < 75_000; i++) items += `<dt>Term ${i}</dt><dd>Def ${i}</dd>`;
    const md = convert(page(`<dl>${items}</dl>`));
    expect(md).toContain('**Term 0**\n: Def 0\n**Term 1**\n: Def 1\n');
    expect(linesMatching(md, /^\*\*Term \d+\*\*$/)).toHaveLength(75_000);
    expect(linesMatching(md, /^: Def \d+$/)).toHaveLength(75_000);
    expect(md).toContain('**Term 74999**\n: Def 74999\n');
  }, LONG);

  it('converts a <dl> whose <div> group holds 150,000 children (the group)', () => {
    let items = '';
    for (let i = 0; i < 75_000; i++) items += `<dt>Term ${i}</dt><dd>Def ${i}</dd>`;
    const md = convert(page(`<dl><div>${items}</div></dl>`));
    expect(md).toContain('**Term 0**\n: Def 0\n**Term 1**\n: Def 1\n');
    expect(linesMatching(md, /^\*\*Term \d+\*\*$/)).toHaveLength(75_000);
    expect(md).toContain('**Term 74999**\n: Def 74999\n');
  }, LONG);
});

// Every call whose argument count can grow with the page has to go: a spread argument (`f(...xs)`) and
// `f.apply(this, xs)` both put one stack slot per element. A fixed-size array is not exempt; a loop costs nothing and
// keeps this check free of judgement calls.
describe('no call-argument spread in src/', () => {
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });

  it('finds the source files', () => {
    expect(files(srcDir).some((f) => f.endsWith('basic-renderer.ts'))).toBe(true);
  });

  it('no call or new expression spreads an argument, and nothing calls .apply with an argument list', () => {
    const found: string[] = [];
    for (const file of files(srcDir)) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const where = (n: ts.Node): string =>
        `${relative(srcDir, file).replace(/\\/g, '/')}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${n.getText(sf).slice(0, 80)}`;
      const visit = (n: ts.Node): void => {
        if (ts.isSpreadElement(n) && (ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent))) found.push(where(n.parent));
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'apply' &&
          n.arguments.length >= 2) found.push(where(n));
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(found).toEqual([]);
  });
});
