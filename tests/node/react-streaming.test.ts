// BL-39 (T126): React streaming SSR. Next.js App Router, Remix and Mintlify send the shell with a Suspense fallback,
// `<!--$?--><template id="B:0"></template>fallback<!--/$-->`, and the late content at the end of <body> as
// `<div hidden id="S:0">` plus `<script>$RC("B:0","S:0")</script>`, which moves it into the boundary in a browser.
// Measured: the benchmark's docs.anthropic.com page (captured 2026-07-28) printed 212 characters of "Loading..." for a
// 12,270-character article; 7 of 16 fresh Next.js / Mintlify / Remix pages stream this way, and on vercel.com/docs the
// code tabs and the framework picker inside <main> arrive as segments. Chromium served each saved page with only its
// inline scripts gave, through the converter, byte for byte what the replay gives (8 of 8 pages; audit
// `.memory/audits/T126-2026-10-16/scripts/stream_oracle.mjs`). The guards below pass on the old build as well.

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (html: string, extra: Record<string, unknown> = {}): string =>
  htmlToMarkdown(html, { baseUrl: 'https://example.test/', includeFrontmatter: false, ...extra }).markdown.trim();

const page = (main: string, tail = ''): string =>
  `<html><body><header><p>Site</p></header><main>${main}</main>${tail}</body></html>`;
const BOUNDARY = '<!--$?--><template id="B:0"></template><p>Loading...</p><!--/$-->';
const LATE = '<div hidden id="S:0"><h1>Title</h1><p>Body</p></div>';
const RC = '<script>$RC("B:0","S:0")</script>';

describe('BL-39: a streamed segment goes where the page\'s own script puts it', () => {
  it.each([
    ['the Mintlify shape: the article after <main> fills its boundary, the fallback goes',
      page(`<p>Before</p>${BOUNDARY}<p>After</p>`, LATE + RC), 'Before\n\n# Title\n\nBody\n\nAfter'],
    ['the call after React 19.2\'s runtime in the same script',
      page(BOUNDARY, LATE + '<script>$RB=[];$RC=function(a,b){if(b=document.getElementById(b))(a=document.getElementById(a))'
        + '?(a.previousSibling.data="$~",$RB.push(a,b)):b.parentNode.removeChild(b)};$RC("B:0","S:0")</script>'),
      '# Title\n\nBody'],
    ['a fallback holding a finished boundary goes up to its own closing comment',
      page('<!--$?--><template id="B:0"></template><!--$--><p>inner</p><!--/$--><p>fallback</p><!--/$--><p>After</p>',
        LATE + RC), '# Title\n\nBody\n\nAfter'],
    ['an identifierPrefix, and boundary and segment numbers that differ',
      page('<!--$?--><template id="app-B:1"></template><p>Loading...</p><!--/$-->',
        '<div hidden id="app-S:2a"><p>Late</p></div><script>$RC("app-B:1","app-S:2a")</script>'), 'Late'],
    ['a boundary inside a streamed segment, filled in stream order',
      page(BOUNDARY, '<div hidden id="S:0"><p>Outer</p><!--$?--><template id="B:1"></template><p>Loading 2</p><!--/$--></div>'
        + RC + '<div hidden id="S:1"><p>Inner</p></div><script>$RC("B:1","S:1")</script>'), 'Outer\n\nInner'],
    ['$RS puts a segment on its placeholder',
      page('<p>A</p><template id="P:1"></template><p>C</p>', '<div hidden id="S:1"><p>B</p></div><script>$RS("S:1","P:1")</script>'),
      'A\n\nB\n\nC'],
    ['$RR (a boundary waiting for stylesheets) fills it like $RC',
      page(BOUNDARY, LATE + '<script>$RR("B:0","S:0",[["/a.css","high"]])</script>'), '# Title\n\nBody'],
    ['rows streamed into a table body',
      page('<table><thead><tr><th>h</th></tr></thead><tbody><!--$?--><template id="B:0"></template><!--/$--></tbody></table>',
        '<table hidden><tbody id="S:0"><tr><td>v</td></tr></tbody></table>' + RC), '| h |\n| --- |\n| v |'],
    ['a segment whose boundary is gone is dropped, as React drops it',
      page('<p>A</p><div hidden id="S:0"><p>orphan</p></div>', '<script>$RC("B:9","S:0")</script>'), 'A'],
  ])('%s', (_label, html, expected) => {
    expect(md(html)).toBe(expected);
  });

  it('includeHidden: true places it the same way', () => {
    expect(md(page(`<p>Before</p>${BOUNDARY}<p>After</p>`, LATE + RC), { includeHidden: true }))
      .toBe('Before\n\n# Title\n\nBody\n\nAfter');
  });

  it.each([
    ['a call inside an escaped string (an RSC payload)',
      page(BOUNDARY, LATE + '<script>self.__next_f.push([1,"$RC(\\"B:0\\",\\"S:0\\")"])</script>'), 'Loading...'],
    ['$RX (client rendering) keeps the fallback', page(BOUNDARY, LATE + '<script>$RX("B:0","digest")</script>'), 'Loading...'],
    ['a visible element with a segment id is not moved',
      page(`<div id="S:0"><p>Visible</p></div>${BOUNDARY}`, RC), 'Visible\n\nLoading...'],
    ['a template with no pending comment before it is no boundary',
      page('<template id="B:0"></template><p>Kept</p><!--/$-->', LATE + RC), 'Kept'],
    ['a boundary with no closing comment removes nothing',
      page('<!--$?--><template id="B:0"></template><p>Kept</p>', LATE + RC), 'Kept'],
    ['a segment holding its own boundary is left alone',
      page('<p>A</p>', '<div hidden id="S:0"><!--$?--><template id="B:0"></template><!--/$--><p>x</p></div>' + RC), 'A'],
  ])('guard: %s', (_label, html, expected) => {
    expect(md(html)).toBe(expected);
  });
});
