// P2A-071 (T277, T261 panel: DeepSeek, Spark, Hy4, Grok): linkedom keeps attribute names as the page wrote them and
// compares them exactly, so `<div HIDDEN>` and `<div STYLE="display:none">` were printed (a browser hides both) at
// every depth in every version, and `<a HREF>` / `<img SRC>` lost their link and image. A browser lowercases attribute
// names while it parses HTML and keeps the first of two that differ only in case.
// The depth cap replays htmlparser2 10.1.0's stack rules over the copy linkedom parses with (T261 panel, Q5): a
// second copy or another major would make the two disagree without an error.

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (body: string): string =>
  htmlToMarkdown(`<html><body><main><p>Start.</p>${body}<p>End.</p></main></body></html>`,
    { baseUrl: 'https://example.test/', includeFrontmatter: false }).markdown;

describe('P2A-071: attribute names are read as a browser reads them', () => {
  it('uppercase hidden, style and aria-hidden hide their text', () => {
    for (const el of ['<div HIDDEN>SECRET</div>', '<div Hidden>SECRET</div>', '<p STYLE="display:none">SECRET</p>',
      '<div STYLE="VISIBILITY:HIDDEN">SECRET</div>', '<div Aria-Hidden="true">SECRET</div>']) {
      const out = md(el);
      expect(out, el).not.toContain('SECRET');
      expect(out, el).toContain('End.');
    }
  });

  it('uppercase href and src keep the link and the image', () => {
    const out = md('<p><A HREF="/x">Link text</A> <IMG SRC="/i.png" ALT="Pic"></p>');
    expect(out).toContain('[Link text](https://example.test/x)');
    expect(out).toContain('https://example.test/i.png');
  });

  it('of two names that differ only in case, the first one counts', () => {
    expect(md('<div STYLE="display:none" style="color:red">FIRSTHIDES</div>')).not.toContain('FIRSTHIDES');
    expect(md('<div style="color:red" STYLE="display:none">FIRSTSHOWS</div>')).toContain('FIRSTSHOWS');
  });
});

describe('htmlparser2: core and linkedom share the 10.1.0 the depth cap was written against', () => {
  const versionAt = (entry: string): string => {
    for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
      const file = join(dir, 'package.json');
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        if (pkg.name === 'htmlparser2') return `${pkg.version} ${dir}`;
      }
    }
    return 'not found';
  };
  it('one copy, version 10.1.0', () => {
    const req = createRequire(import.meta.url);
    const fromCore = versionAt(req.resolve('htmlparser2'));
    const fromLinkedom = versionAt(createRequire(req.resolve('linkedom')).resolve('htmlparser2'));
    expect(fromLinkedom).toBe(fromCore);
    expect(fromCore.split(' ')[0]).toBe('10.1.0');
  });
});
