// Page2AI T244, from the T243 review panel: three defects around tab references, all on core 0.4.9.
// P2A-039: 0.4.9's id index was built with querySelectorAll('[id]'), which in linkedom jumps over a <template>'s
// children, while getElementById (what 0.4.8 called) finds them: tab panels kept in a <template> (an Alpine x-if panel)
// lost their content. The index also stayed in a module-level Map until the next render, holding the whole document.
// P2A-040: a space before or after the ids in aria-labelledby made an empty token, and linkedom's getElementById('')
// answers <html>, so the panel was named with the whole page's text (every version with data-state tabs).
// P2A-041: n panels naming one label computed its text n times (6,000 such panels took 3.6 s, 21 s with a larger one).

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/convert.js';

const convert = (body: string): string =>
  htmlToMarkdown(`<html><body><main>${body}</main></body></html>`, {
    baseUrl: 'https://example.com/',
    includeFrontmatter: false,
  }).markdown;
const timed = (body: string): { ms: number; markdown: string } => {
  const t = performance.now();
  const markdown = convert(body);
  return { ms: performance.now() - t, markdown };
};
const count = (s: string, needle: string): number => s.split(needle).length - 1;
const tablist = (tabs: Array<[string, string]>): string =>
  `<div role="tablist">${tabs.map(([id, label]) => `<button role="tab" aria-controls="${id}">${label}</button>`).join('')}</div>`;

describe('a tab panel or label inside a <template> is found, as getElementById finds it (P2A-039)', () => {
  it('an Alpine x-if panel keeps its tab and its code', () => {
    const out = convert(
      tablist([['tab-npm', 'npm'], ['tab-yarn', 'yarn']]) +
        '<div id="tab-npm" role="tabpanel"><pre>npm i x</pre></div>' +
        `<template x-if="tab === 'yarn'"><div id="tab-yarn" role="tabpanel"><pre>yarn add x</pre></div></template>`,
    );
    expect(out).toContain('### Tab: npm');
    expect(out).toContain('### Tab: yarn');
    expect(out).toContain('yarn add x');
  });

  it('a panel in a nested <template>', () => {
    const out = convert(
      tablist([['n1', 'One'], ['n2', 'Two']]) +
        '<div id="n1" role="tabpanel">one</div>' +
        '<template><template><div id="n2" role="tabpanel">two-in-a-nested-template</div></template></template>',
    );
    expect(out).toContain('### Tab: Two');
    expect(out).toContain('two-in-a-nested-template');
  });

  it('an aria-labelledby that names an element in a <template>', () => {
    const out = convert(
      '<template><div id="inside">Template label</div></template>' +
        '<div><div role="tabpanel" data-state="active" aria-labelledby="inside">panel-a</div>' +
        '<div role="tabpanel" data-state="inactive" aria-labelledby="inside">panel-b</div></div>',
    );
    expect(count(out, '### Tab: Template label')).toBe(2);
  });

  it('the first element with the id in document order wins, a <template> child included, as in 0.4.8', () => {
    const out = convert(
      '<template><div id="p0">from-the-template</div></template>' +
        tablist([['p0', 'A'], ['p1', 'B']]) +
        '<div role="tabpanel" id="p0">visible-0</div><div role="tabpanel" id="p1">visible-1</div>',
    );
    expect(out).toContain('### Tab: A\n\nfrom-the-template');
    expect(out).toContain('### Tab: B\n\nvisible-1');
  });
});

describe('a converted document is not kept after the conversion (P2A-039)', () => {
  it('a page of 40,000 ids and a tab list leaves under 20 MB of heap after a gc (45.7 MB on 0.4.9)', () => {
    // The same switch Jest uses for its leak check: --expose-gc set at run time, gc taken from a new context.
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const body =
      Array.from({ length: 40_000 }, (_, i) => `<p id="q${i}">paragraph ${i} with some words</p>`).join('') +
      tablist([['t1', 'A'], ['t2', 'B']]) +
      '<div id="t1">1</div><div id="t2">2</div>';
    gc();
    gc();
    const before = process.memoryUsage().heapUsed;
    let markdown: string | null = convert(body);
    expect(markdown.length).toBeGreaterThan(1_000_000);
    expect(markdown).toContain('### Tab: B');
    markdown = null;
    gc();
    gc();
    const retainedMb = (process.memoryUsage().heapUsed - before) / 1_048_576;
    expect(retainedMb).toBeLessThan(20);
  }, 60_000);
});

describe('spaces around the ids in aria-labelledby (P2A-040)', () => {
  it('each panel is named by its label, not by the whole page', () => {
    const out = convert(
      '<h1>Title of the page</h1><p>Body paragraph one.</p><span id="la">Label A</span><span id="lb">Label B</span>' +
        '<div><div role="tabpanel" data-state="active" aria-labelledby=" la">panel-a</div>' +
        '<div role="tabpanel" data-state="inactive" aria-labelledby="lb ">panel-b</div></div>' +
        '<p>Body paragraph two.</p>',
    );
    expect(out).toContain('### Tab: Label A\n');
    expect(out).toContain('### Tab: Label B\n');
    expect(out).not.toMatch(/### Tab: .*Title of the page/);
  });

  it('two ids, one of them missing, and runs of spaces', () => {
    const out = convert(
      '<span id="la">Label</span><span id="lc">A</span>' +
        '<div><div role="tabpanel" data-state="active" aria-labelledby="  la   lc  ">panel-a</div>' +
        '<div role="tabpanel" data-state="inactive" aria-labelledby="la nope">panel-b</div></div>',
    );
    expect(out).toContain('### Tab: Label A\n\npanel-a');
    expect(out).toContain('### Tab: Label\n\npanel-b');
  });

  it('3,000 panels with a padded aria-labelledby convert in linear time (3.6 s and 9 MB of headings on 0.4.9)', () => {
    const { ms, markdown } = timed(
      '<span id="x">L</span><div>' +
        '<div role="tabpanel" data-state="inactive" aria-labelledby=" x">x</div>'.repeat(3_000) +
        '</div>',
    );
    expect(count(markdown, '### Tab: L\n')).toBe(3_000);
    expect(ms).toBeLessThan(1000);
  }, 120_000);
});

describe('panels that name one label compute its text once (P2A-041)', () => {
  it('6,000 panels naming one label of 6,000 hidden spans (3.6 s on 0.4.9)', () => {
    const { ms, markdown } = timed(
      `<div id="lab">Shared label${'<span hidden>h</span>'.repeat(6_000)}</div><div>` +
        '<div role="tabpanel" data-state="inactive" aria-labelledby="lab">p</div>'.repeat(6_000) +
        '</div>',
    );
    expect(count(markdown, '### Tab: Shared label\n')).toBe(6_000);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('separate tab groups each print their own panels', () => {
    const group = (i: number): string =>
      `<div>${tablist([[`a${i}`, `A${i}`], [`b${i}`, `B${i}`]])}<div id="a${i}">first-${i}</div><div id="b${i}">second-${i}</div></div>`;
    const out = convert(group(1) + '<p>between <b>bold</b> text</p>' + group(2));
    expect(out).toContain('### Tab: A1\n\nfirst-1');
    expect(out).toContain('### Tab: B2\n\nsecond-2');
    expect(out).toContain('between **bold** text');
  });
});
