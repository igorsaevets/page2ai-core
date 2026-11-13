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
const TIMEOUT_MS = 120_000;

describe('P2A-031: pages that render to more than ~120,000 lines', () => {
  // The pages below guard P2A-031 only while this runtime overflows on a call with 150,000 arguments (their smallest
  // spread). A larger stack lets the old spreads through: in Vitest's `threads` pool, whose workers get a 4 MB stack,
  // the 0.4.5 renderer passed all four (T241; `--stack-size` and a future V8 would do the same). This test turns that
  // quiet pass into a failure; then raise the page sizes, or run the file where the stack is Node's default.
  it('this runtime still overflows on a 150,000-argument call (else the pages below prove nothing)', () => {
    const sink: unknown[] = [];
    const args = new Array<unknown>(150_000).fill(0);
    expect(() => sink.push(...args)).toThrow(RangeError);
  });

  it('converts the 90,000-row page of the bug report (the body lines)', () => {
    const md = convert(page("<div><p>Row <b>bold</b> <a href='/x'>link</a></p></div>".repeat(90_000)));
    expect(linesMatching(md, /^Row \*\*bold\*\* \[link\]\(https:\/\/example\.com\/x\)$/)).toHaveLength(90_000);
  }, TIMEOUT_MS);

  it('converts a table with 150,000 rows (the column count)', () => {
    let rows = '';
    for (let i = 0; i < 150_000; i++) rows += `<tr><td>${i}</td><td>x</td></tr>`;
    const md = convert(page(`<table><tr><th>n</th><th>v</th></tr>${rows}</table>`));
    expect(md).toContain('| n | v |\n| --- | --- |\n| 0 | x |\n');
    const body = linesMatching(md, /^\| \d+ \| x \|$/);
    expect(body).toHaveLength(150_000);
    expect(body[body.length - 1]).toBe('| 149999 | x |');
  }, TIMEOUT_MS);

  it('converts a <dl> with 75,000 term/description pairs (the list lines)', () => {
    let items = '';
    for (let i = 0; i < 75_000; i++) items += `<dt>Term ${i}</dt><dd>Def ${i}</dd>`;
    const md = convert(page(`<dl>${items}</dl>`));
    expect(md).toContain('**Term 0**\n: Def 0\n**Term 1**\n: Def 1\n');
    expect(linesMatching(md, /^\*\*Term \d+\*\*$/)).toHaveLength(75_000);
    expect(linesMatching(md, /^: Def \d+$/)).toHaveLength(75_000);
    expect(md).toContain('**Term 74999**\n: Def 74999\n');
  }, TIMEOUT_MS);

  it('converts a <dl> whose <div> group holds 150,000 children (the group)', () => {
    let items = '';
    for (let i = 0; i < 75_000; i++) items += `<dt>Term ${i}</dt><dd>Def ${i}</dd>`;
    const md = convert(page(`<dl><div>${items}</div></dl>`));
    expect(md).toContain('**Term 0**\n: Def 0\n**Term 1**\n: Def 1\n');
    expect(linesMatching(md, /^\*\*Term \d+\*\*$/)).toHaveLength(75_000);
    expect(md).toContain('**Term 74999**\n: Def 74999\n');
  }, TIMEOUT_MS);
});

// Every call whose argument count can grow with the page has to go: a spread argument (`f(...xs)`) and the calls that
// take an argument LIST (`f.apply(this, xs)`, `Reflect.apply(f, t, xs)`, `Reflect.construct(C, xs)`,
// `Function.prototype.apply.call(f, t, xs)`) all put one stack slot per element. A fixed-size array is not exempt; a
// loop costs nothing and keeps this check free of judgement calls. T241 (the T240 panel) added the computed and
// parenthesized forms, Reflect.construct, `apply.call` and the other script extensions, and a test that feeds the
// check every form it must catch and every one it must leave alone, so the check itself cannot go blind.
const calleeOf = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? calleeOf(e.expression) : e);
const memberName = (e: ts.Expression): string | undefined => {
  const c = calleeOf(e);
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  if (ts.isElementAccessExpression(c) && ts.isStringLiteralLike(c.argumentExpression)) return c.argumentExpression.text;
  return undefined;
};
const objectOf = (e: ts.Expression): ts.Expression | undefined => {
  const c = calleeOf(e);
  return ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c) ? calleeOf(c.expression) : undefined;
};
const argumentListCalls = (sf: ts.SourceFile): ts.Node[] => {
  const found: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isSpreadElement(n) && (ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent))) found.push(n.parent);
    if (ts.isCallExpression(n)) {
      const name = memberName(n.expression);
      const obj = objectOf(n.expression);
      const onReflect = obj !== undefined && ts.isIdentifier(obj) && obj.text === 'Reflect';
      if ((name === 'apply' && n.arguments.length >= 2) || (name === 'construct' && onReflect && n.arguments.length >= 2) ||
        (name === 'call' && obj !== undefined && memberName(obj) === 'apply')) found.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
};

describe('no call-argument spread in src/', () => {
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : /\.(?:[cm]?[jt]s|tsx)$/.test(p) ? [p] : [];
    });

  it('finds the source files', () => {
    expect(files(srcDir).some((f) => f.endsWith('basic-renderer.ts'))).toBe(true);
  });

  it('the check catches every argument-list form and leaves array and object spreads alone', () => {
    const flagged = (code: string): number => argumentListCalls(ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true)).length;
    for (const code of ['f(...xs);', 'new C(...xs);', 'a.push(...xs);', 'class A extends B { constructor(xs: number[]) { super(...xs); } }',
      'f.apply(t, xs);', "f['apply'](t, xs);", '(f.apply)(t, xs);', 'Reflect.apply(f, t, xs);', 'Reflect.construct(C, xs);',
      'Function.prototype.apply.call(f, t, xs);']) expect(flagged(code), code).toBe(1);
    for (const code of ['const a = [...xs];', 'const o = { ...p };', 'f([...xs]);', 'function g(...rest: number[]) { return rest; }',
      'const [h, ...t] = xs;', 'f.apply;', 'f.apply(t);', 'f.call(t, a);', 'x.construct(a, b);']) expect(flagged(code), code).toBe(0);
  });

  it('no call or new expression spreads an argument, and nothing calls with an argument list', () => {
    const found: string[] = [];
    for (const file of files(srcDir)) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const n of argumentListCalls(sf))
        found.push(`${relative(srcDir, file).replace(/\\/g, '/')}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${n.getText(sf).slice(0, 80)}`);
    }
    expect(found).toEqual([]);
  });
});
