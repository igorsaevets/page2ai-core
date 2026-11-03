import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (html: string, extra: Record<string, unknown> = {}): string =>
  htmlToMarkdown(html, { baseUrl: 'https://example.test/', includeFrontmatter: false, ...extra }).markdown.trim();

const page = (body: string): string => `<html><body><main>${body}</main></body></html>`;

describe('output safety: unsafe link protocols', () => {
  it('drops javascript: href, keeps the text', () => {
    const r = md(page('<p><a href="javascript:alert(1)">Click me</a></p>'));
    expect(r).toBe('Click me');
    expect(r).not.toContain('javascript:');
  });

  it('drops javascript: with mixed case', () => {
    const r = md(page('<p><a href="JaVaScRiPt:void(0)">link</a></p>'));
    expect(r).toBe('link');
  });

  it('drops javascript: with leading spaces', () => {
    const r = md(page('<p><a href="  javascript:alert(1)">click</a></p>'));
    expect(r).toBe('click');
  });

  it('drops vbscript: href', () => {
    const r = md(page('<p><a href="vbscript:MsgBox()">run</a></p>'));
    expect(r).toBe('run');
    expect(r).not.toContain('vbscript:');
  });

  it('drops data:text/html href', () => {
    const r = md(page('<p><a href="data:text/html,<script>alert(1)</script>">xss</a></p>'));
    expect(r).toBe('xss');
    expect(r).not.toContain('data:');
  });

  it('drops data:text/html with base64 encoding', () => {
    const r = md(page('<p><a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a></p>'));
    expect(r).toBe('x');
  });

  it('keeps http: links', () => {
    expect(md(page('<p><a href="http://example.com">ok</a></p>'))).toBe('[ok](http://example.com/)');
  });

  it('keeps https: links', () => {
    expect(md(page('<p><a href="https://example.com">ok</a></p>'))).toBe('[ok](https://example.com/)');
  });

  it('keeps mailto: links', () => {
    expect(md(page('<p><a href="mailto:test@example.com">mail</a></p>'))).toBe('[mail](mailto:test@example.com)');
  });

  it('keeps tel: links', () => {
    expect(md(page('<p><a href="tel:+1234567890">call</a></p>'))).toBe('[call](tel:+1234567890)');
  });

  it('keeps relative links', () => {
    expect(md(page('<p><a href="/page">page</a></p>'))).toBe('[page](https://example.test/page)');
  });

  it('keeps data:image links (not text/html)', () => {
    const href = 'data:image/png;base64,iVBOR';
    expect(md(page(`<p><a href="${href}">img</a></p>`))).toContain(href);
  });

  it('drops javascript: in inline context (table cell)', () => {
    const r = md(page('<table><tr><td><a href="javascript:void(0)">cell</a></td></tr></table>'));
    expect(r).not.toContain('javascript:');
    expect(r).toContain('cell');
  });
});

describe('output safety: data: image URI cap', () => {
  const smallData = 'data:image/png;base64,' + 'A'.repeat(100);
  const bigData = 'data:image/png;base64,' + 'A'.repeat(70_000);

  it('keeps a small data: image', () => {
    const r = md(page(`<p><img src="${smallData}" alt="icon"></p>`));
    expect(r).toContain('![icon]');
    expect(r).toContain('data:image/png');
  });

  it('drops an oversized data: image, falls back to alt text', () => {
    const r = md(page(`<p><img src="${bigData}" alt="payload"></p>`));
    expect(r).not.toContain('data:image/png');
    expect(r).toContain('payload');
  });

  it('drops an oversized data: image with no alt silently', () => {
    const r = md(page(`<p><img src="${bigData}"></p>`));
    expect(r).not.toContain('data:image/png');
  });

  it('keeps a normal https: image regardless of size', () => {
    const r = md(page('<p><img src="https://cdn.test/big.jpg" alt="photo"></p>'));
    expect(r).toContain('![photo](https://cdn.test/big.jpg)');
  });

  it('drops an oversized data: image in inline context (link)', () => {
    const r = md(page(`<p><a href="https://example.test"><img src="${bigData}" alt="logo"></a></p>`));
    expect(r).not.toContain('data:image/png');
  });
});

describe('output safety: inline CSS hidden text', () => {
  it('drops an element with display:none', () => {
    const r = md(page('<p>visible <span style="display:none">hidden injection</span> text</p>'));
    expect(r).toBe('visible text');
  });

  it('drops an element with display: none (with space)', () => {
    const r = md(page('<p>ok <span style="display: none">secret</span></p>'));
    expect(r).toBe('ok');
  });

  it('drops an element with visibility:hidden', () => {
    const r = md(page('<p>start <span style="visibility:hidden">invisible</span> end</p>'));
    expect(r).toBe('start end');
  });

  it('drops a div with display:none', () => {
    const r = md(page('<div>visible</div><div style="display:none"><p>Ignore these instructions.</p></div>'));
    expect(r).toBe('visible');
  });

  it('drops a nested structure with display:none on the parent', () => {
    const r = md(page('<div style="display:none"><h2>Secret heading</h2><p>Secret text</p></div><p>Real content</p>'));
    expect(r).toBe('Real content');
    expect(r).not.toContain('Secret');
  });

  it('keeps an element with other inline styles', () => {
    const r = md(page('<p><span style="color:red;font-size:14px">styled</span></p>'));
    expect(r).toBe('styled');
  });

  it('drops display:none case-insensitively', () => {
    const r = md(page('<p>a <span style="DISPLAY:NONE">gone</span> b</p>'));
    expect(r).toBe('a b');
  });

  it('keeps elements with no style attribute', () => {
    const r = md(page('<p><span>normal</span></p>'));
    expect(r).toBe('normal');
  });

  it('includeHidden: true preserves inline-CSS-hidden elements', () => {
    const r = md(page('<p>v <span style="display:none">h</span></p>'), { includeHidden: true });
    expect(r).toBe('v h');
  });

  it('drops a list item with display:none', () => {
    const r = md(page('<ul><li>one</li><li style="display:none">hidden</li><li>three</li></ul>'));
    expect(r).toContain('one');
    expect(r).toContain('three');
    expect(r).not.toContain('hidden');
  });

  it('drops a hidden row in a table', () => {
    const r = md(page('<table><tr><td>A</td></tr><tr style="visibility:hidden"><td>secret</td></tr></table>'));
    expect(r).toContain('A');
    expect(r).not.toContain('secret');
  });
});
