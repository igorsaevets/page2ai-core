// P2A-019: a <button> is a control, so its label is not page content. Mintlify, Vercel and the Claude docs printed the
// header's "Copy page" twice, the code-sample switcher ("cURL CLI Python ... Ruby") and an icon-font glyph (U+E056) as
// paragraphs. The buttons that hold the page's own text stay: each kept case below was measured on the T142 corpus
// against a build that dropped every button (it lost 27 headings, a table column's name, a word of a sentence, a
// zoomable image and a changelog's section labels).
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (html: string, extra: Record<string, unknown> = {}): string =>
  htmlToMarkdown(html, { baseUrl: 'https://example.test/', includeFrontmatter: false, ...extra }).markdown.trim();
const page = (body: string): string => `<html><body><main>${body}</main></body></html>`;
const PRIVATE_USE = /[-]/;

describe('P2A-019: interface buttons stay out', () => {
  it('the bug file repro: the header\'s Copy page with its glyph and the listbox switcher', () => {
    const out = md('<!doctype html><html><head><title>Messages - Example Docs</title></head><body><main>'
      + '<div class="header"><h1 id="page-title">Messages</h1><div id="page-context-menu">'
      + '<button id="page-context-menu-button" aria-label="Copy page"><span class="icon">&#xE056;</span><span>Copy page</span></button></div></div>'
      + '<div class="lang-picker"><button type="button" aria-haspopup="listbox">cURL <svg width="8" height="8"></svg></button></div>'
      + '<p>Send a structured list of input messages.</p></main></body></html>');
    expect(out).toBe('# Messages - Example Docs\n\n# Messages\n\nSend a structured list of input messages.');
    expect(out).not.toMatch(PRIVATE_USE);
  });

  it.each([
    ['a tab list the discovery could not pair with panels keeps only the selected tab, which names the sample shown',
      '<div role="tablist"><button role="tab" aria-selected="false">cURL</button><button role="tab" aria-selected="true">Python</button>'
        + '<button role="tab" aria-selected="false">Go</button></div><pre><code class="language-python">print(1)</code></pre>',
      'Python\n\n```python\nprint(1)\n```'],
    ['a row of plain buttons acting as tabs, with no selection marked',
      '<div><button data-active="true">npm</button><button data-active="false">yarn</button></div><pre><code>npm i x</code></pre>',
      '```\nnpm i x\n```'],
    ['a feedback row under its question',
      '<p>Was this page helpful?</p><div><button>Yes</button><button>No</button></div>', 'Was this page helpful?'],
    ['a search button beside the nav links: links are not the words of a sentence',
      '<div><button type="button"><svg></svg><kbd>⌘K</kbd></button><a href="/docs">Docs</a> <a href="/blog">Blog</a></div>',
      '[Docs](https://example.test/docs)\n[Blog](https://example.test/blog)'],
    ['an anchor-link button after a heading\'s linked text',
      '<h2 id="o"><a href="#o">Overview</a><button aria-live="polite"><svg></svg><span>Copy Anchor Link</span></button></h2>',
      '## [Overview](https://example.test/#o)'],
    ['a copy-link button after a heading\'s text, its glyph aria-hidden',
      '<h2>Pricing<span><button aria-label="Copy link"><span aria-hidden="true">&#xE09A;</span></button></span></h2>', '## Pricing'],
    ['a form\'s submit button', '<form><input name="q"><button type="submit">Search</button></form><p>Body.</p>', 'Body.'],
    ['a menu opener that is also a disclosure', '<div><button aria-haspopup="menu" aria-expanded="false">v4.3</button></div><p>Body.</p>', 'Body.'],
  ])('%s', (_label, body, expected) => {
    expect(md(page(body))).toBe(expected);
  });
});

describe('P2A-019: buttons that hold the page\'s text stay', () => {
  it.each([
    ['an accordion\'s question inside a heading, its caret glyph left out',
      '<h3><button aria-expanded="false"><span>Do I need X?</span><span aria-hidden="true">&#xE02A;</span></button></h3><div><p>Answer.</p></div>',
      '### Do I need X?\n\nAnswer.'],
    ['an accordion written with the heading inside the button',
      '<button aria-expanded="false"><h3>Question two?</h3></button><p>Answer two.</p>', '### Question two?\n\nAnswer two.'],
    ['a disclosure\'s label above the list it opens',
      '<div><button aria-expanded="false"><svg></svg>Fixes</button></div><div><ul><li>Fixed a crash</li></ul></div>', 'Fixes\n\n- Fixed a crash'],
    ['a tooltip on a word of a sentence',
      '<p>Every page has a file stored in your <button type="button"><span>repository</span></button>.</p>',
      'Every page has a file stored in your repository.'],
    ['a sortable column\'s name and a cell value written as buttons',
      '<table><thead><tr><th>Name</th><th><button aria-label="Capabilities column information"><span>Capabilities</span></button></th></tr></thead>'
        + '<tbody><tr><td>A</td><td><button>2/4</button></td></tr></tbody></table>',
      '| Name | Capabilities |\n| --- | --- |\n| A | 2/4 |'],
    ['a zoomable image', '<button aria-label="Open image in full screen" aria-haspopup="dialog"><img alt="Architecture diagram" src="/d.png"></button>',
      '![Architecture diagram](https://example.test/d.png)'],
    ['a button inside a link, which is named by it', '<p><a href="/start"><button>Get started</button></a></p>', '[Get started](https://example.test/start)'],
    ['a card with paragraphs', '<button data-card="true"><p>Support</p><p>For billing questions, contact our team</p></button>',
      'Support\n\nFor billing questions, contact our team'],
  ])('%s', (_label, body, expected) => {
    expect(md(page(body))).toBe(expected);
  });

  it('a tab group the discovery pairs with its panels still labels each panel', () => {
    expect(md(page('<div><div role="tablist"><button role="tab" aria-selected="true" aria-controls="p1">npm</button>'
      + '<button role="tab" aria-selected="false" aria-controls="p2">yarn</button></div>'
      + '<div role="tabpanel" id="p1"><pre><code>npm i x</code></pre></div><div role="tabpanel" id="p2" hidden><pre><code>yarn add x</code></pre></div></div>')))
      .toBe('### Tab: npm\n\n```\nnpm i x\n```\n\n### Tab: yarn\n\n```\nyarn add x\n```');
  });
});

// T144, the T143 panel's shapes (grok, spark, gemini flash): 0.2.1 dropped each kept case below and printed the card
// actions; 3,000 sibling buttons took seconds.
describe('P2A-019 review: questions, terms and labelled values stay; card actions and code-block buttons go', () => {
  it.each([
    ['an accordion question with no aria-expanded and no heading, right before its panel (W3Schools)',
      '<button class="accordion">What is your return policy?</button><div class="panel"><p>Thirty days.</p></div>',
      'What is your return policy?\n\nThirty days.'],
    ['the same question as a list item', '<ul><li><button>How do I reset?</button><div><p>Use the form.</p></div></li></ul>',
      '- How do I reset?\n\n   Use the form.'],
    ['a definition term written as a button', '<dl><dt><button>API key</button></dt><dd>A secret token.</dd></dl>', '**API key**\n: A secret token.'],
    ['a question under role="heading"', '<div role="heading" aria-level="3"><button>Is there a free plan?</button></div><div><p>Yes.</p></div>',
      'Is there a free plan?\n\nYes.'],
    ['a link written inside a button', '<p><button><a href="/start">Get started</a></button></p>', '[Get started](https://example.test/start)'],
    ['a command whose accessible name is an action on it (neon.com)',
      '<div><button aria-label="Copy command: npx example@latest init"><span aria-hidden="true">$</span><span>npx example@latest init</span></button></div><p>Then run it.</p>',
      'npx example@latest init\n\nThen run it.'],
  ])('%s', (_label, body, expected) => {
    expect(md(page(body))).toBe(expected);
  });

  it.each([
    ['a custom card\'s action row', '<div><mat-card><mat-card-content><p>A small spitz breed.</p></mat-card-content>'
      + '<mat-card-actions><button>LIKE</button><button>SHARE</button></mat-card-actions></mat-card></div>', 'A small spitz breed.'],
    ['a Copy button that starts a code sample\'s wrapper', '<div><button>Copy</button><pre><code>npm i x</code></pre></div>', '```\nnpm i x\n```'],
    ['a feedback Yes beside a hidden No, before a details popover (Microsoft Learn)',
      '<p>Was this page helpful?</p><div><button>Yes</button><button hidden>No</button><details><summary>No</summary><div role="dialog"><p>Need help?</p></div></details></div>',
      'Was this page helpful?\n\nNo\n\nNeed help?'], // the popover's own summary and text print, as in 0.2.1; "Yes" does not
    ['pagination named "Go to page 2" (no action on a label with letters)',
      '<p>Body.</p><div><button aria-label="Go to page 2">2</button><button aria-label="Go to page 3">3</button></div>', 'Body.'],
    ['a button named like its label', '<div><button aria-label="Copy page"><span>Copy page</span></button></div><p>Body.</p>', 'Body.'],
  ])('%s', (_label, body, expected) => {
    expect(md(page(body))).toBe(expected);
  });

  it('3,000 sibling buttons render in linear time', () => {
    const many = '<p>' + Array.from({ length: 3000 }, (_, i) => `<span><button>b${i}</button></span>`).join('') + '</p>';
    const t = performance.now();
    md(page(many));
    expect(performance.now() - t).toBeLessThan(1500); // 0.2.1: 4 to 5 s on the T144 machine, this build: 50 ms
  });
});
