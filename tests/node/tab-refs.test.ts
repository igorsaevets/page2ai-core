// Page2AI T244, from the T243 review panel: three defects around tab references, all on core 0.4.9.
// P2A-039: 0.4.9's id index was built with querySelectorAll('[id]'), which in linkedom jumps over a <template>'s
// children, while getElementById (what 0.4.8 called) finds them: tab panels kept in a <template> (an Alpine x-if panel)
// lost their content. The index also stayed in a module-level Map until the next render, holding the whole document.
// P2A-040: a space before or after the ids in aria-labelledby made an empty token, and linkedom's getElementById('')
// answers <html>, so the panel was named with the whole page's text (every version with data-state tabs).
// P2A-041: n panels naming one label computed its text n times (6,000 such panels took 3.6 s, 21 s with a larger one).

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { renderBasicMarkdown } from '../../src/node/basic-renderer.js';
import { htmlToMarkdown } from '../../src/node/convert.js';
import { LinkedomAdapter } from '../../src/node/linkedom-adapter.js';

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
  // Parse, render and return only a WeakRef, so no frame of the test holds the document.
  const renderAndForget = (): WeakRef<object> => {
    const { document } = parseHTML(
      `<html><body><main>${tablist([['t1', 'A'], ['t2', 'B']])}<div id="t1">1</div><div id="t2">2</div></main></body></html>`,
    );
    const doc = document as unknown as Document;
    const adapter = new LinkedomAdapter(doc, 'https://example.com/');
    const md = renderBasicMarkdown(doc, adapter, {
      baseUrl: 'https://example.com/', includeFrontmatter: false, includeImages: true, includeHidden: false,
    });
    expect(md).toContain('### Tab: B');
    return new WeakRef(document);
  };

  it('the renderer holds no reference to a document once it has rendered it (0.4.9 held the last one)', async () => {
    // The switch Jest uses for its leak check: --expose-gc set at run time, gc taken from a new context.
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const ref = renderAndForget();
    // A WeakRef keeps its target alive until the current job ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    gc();
    expect(ref.deref()).toBeUndefined();
  });
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

// Page2AI T252, from the T244 review panel (P2A-042) and found while measuring it (P2A-043); all fail on 0.4.10.
const sharing = (labels: string[], selected = ''): string =>
  `<div role="tablist">${labels
    .map((l) => `<button role="tab"${l === selected ? ' aria-selected="true"' : ''} aria-controls="shared">${l}</button>`)
    .join('')}</div>`;

describe('a tab panel named by several tabs is written once (P2A-042)', () => {
  it('every tab keeps its heading, and the panel goes under the selected tab (0.4.10 wrote it under each)', () => {
    const out = convert(sharing(['One', 'Two', 'Three'], 'Two') + '<div id="shared" role="tabpanel"><p>output of step two</p></div>');
    expect(count(out, 'output of step two')).toBe(1);
    expect(out).toContain('### Tab: One\n\n### Tab: Two\n\noutput of step two\n\n### Tab: Three');
  });

  it('with no tab selected, the panel goes under the first tab that names it', () => {
    const out = convert(sharing(['One', 'Two']) + '<div id="shared" role="tabpanel"><p>the panel</p></div>');
    expect(count(out, 'the panel')).toBe(1);
    expect(out).toContain('### Tab: One\n\nthe panel\n\n### Tab: Two');
  });

  it('two tab lists naming the same panels (a desktop and a mobile bar) write each panel and heading once', () => {
    const out = convert(
      tablist([['a', 'npm'], ['b', 'yarn']]) + tablist([['a', 'npm'], ['b', 'yarn']]) +
        '<div id="a" role="tabpanel">npm i x</div><div id="b" role="tabpanel">yarn add x</div>',
    );
    expect(count(out, 'npm i x')).toBe(1);
    expect(count(out, 'yarn add x')).toBe(1);
    expect(count(out, '### Tab: npm')).toBe(1);
    expect(count(out, '### Tab: yarn')).toBe(1);
  });

  it('200 tabs naming one panel of 2,000 spans: linear output and time (2.1 s and 805,000 characters on 0.4.10)', () => {
    const { ms, markdown } = timed(
      tablist(Array.from({ length: 200 }, (_, i): [string, string] => ['big', `T${i}`])) +
        `<div id="big" role="tabpanel">${'<span>x</span> '.repeat(2_000)}<b>end-of-panel</b></div>`,
    );
    expect(count(markdown, 'end-of-panel')).toBe(1);
    expect(count(markdown, '### Tab: T')).toBe(200);
    expect(markdown.length).toBeLessThan(20_000);
    expect(ms).toBeLessThan(1000);
  }, 120_000);
});

describe('a tab label is written with at most 300 characters (P2A-042)', () => {
  it('a label of 300 characters is whole; a longer one is cut at 300 with an ellipsis, never inside a surrogate pair', () => {
    const exact = 'a'.repeat(300);
    const out = convert(
      `<span id="l1">${exact}</span><span id="l2">${'b'.repeat(299)}😀${'c'.repeat(10)}</span>` +
        '<div><div role="tabpanel" data-state="active" aria-labelledby="l1">p1</div>' +
        '<div role="tabpanel" data-state="inactive" aria-labelledby="l2">p2</div></div>',
    );
    expect(out).toContain(`### Tab: ${exact}\n\np1`);
    expect(out).toContain(`### Tab: ${'b'.repeat(299)}…\n\np2`);
  });

  it('a tab button of 400 characters is cut as well', () => {
    const out = convert(tablist([['x1', 'w '.repeat(200)], ['x2', 'short']]) + '<div id="x1">one</div><div id="x2">two</div>');
    const heading = out.split('\n').find((l) => l.startsWith('### Tab: w'));
    expect(heading).toBe(`### Tab: ${'w '.repeat(150).trimEnd()}…`);
  });

  it('one aria-labelledby naming a label 1,000 times: one short heading (4M characters on 0.4.10)', () => {
    const { ms, markdown } = timed(
      `<div id="lab">${'<span>w </span>'.repeat(2_000)}</div><div>` +
        `<div role="tabpanel" data-state="active" aria-labelledby="${'lab '.repeat(1_000)}">p1</div>` +
        '<div role="tabpanel" data-state="inactive" aria-labelledby="lab2">p2</div></div><span id="lab2">two</span>',
    );
    const heading = markdown.split('\n').find((l) => l.startsWith('### Tab: w'));
    expect(heading?.length).toBeLessThanOrEqual('### Tab: '.length + 301);
    expect(heading?.endsWith('…')).toBe(true);
    expect(markdown.length).toBeLessThan(10_000);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('3,000 panels naming one label of 2,000 words: each heading is cut (30M characters on 0.4.10)', () => {
    const { ms, markdown } = timed(
      `<div id="lab">${'<span>word </span>'.repeat(2_000)}</div><div>` +
        '<div role="tabpanel" data-state="inactive" aria-labelledby="lab">p</div>'.repeat(3_000) +
        '</div>',
    );
    expect(count(markdown, '### Tab: word word')).toBe(3_000);
    expect(markdown.length).toBeLessThan(3_000 * 330 + 20_000);
    expect(ms).toBeLessThan(2000);
  }, 120_000);
});

describe('nested tab lists are collected once (P2A-044)', () => {
  it('1,000 nested tab lists around 5,000 tabs: linear time (2.3 s and 413 MB on 0.4.11, 11.8 s at 548 KB)', () => {
    const tabs = Array.from({ length: 5_000 }, (_, i) => `<button role="tab" aria-controls="${i % 2 ? 'nb' : 'na'}">t${i}</button>`);
    const { ms, markdown } = timed(
      `${'<div role="tablist">'.repeat(1_000)}${tabs.join('')}${'</div>'.repeat(1_000)}` +
        '<div id="na" role="tabpanel">panel-a</div><div id="nb" role="tabpanel">panel-b</div>',
    );
    expect(count(markdown, 'panel-a')).toBe(1);
    expect(count(markdown, 'panel-b')).toBe(1);
    expect(count(markdown, '### Tab: t')).toBe(5_000);
    // 30-130 ms on 0.4.12, 2.3-3.2 s on 0.4.11: 1.5 s keeps a margin both ways on a slow CI runner (T252 panel).
    expect(ms).toBeLessThan(1_500);
  }, 120_000);

  it('an inner list prints through the outer one, as before', () => {
    const out = convert(
      '<div role="tablist"><button role="tab" aria-controls="o1">Outer</button>' +
        '<div role="tablist"><button role="tab" aria-controls="i1">Inner one</button>' +
        '<button role="tab" aria-controls="i2">Inner two</button></div></div>' +
        '<div id="o1" role="tabpanel">outer-panel</div><div id="i1" role="tabpanel">inner-1</div>' +
        '<div id="i2" role="tabpanel">inner-2</div>',
    );
    expect(out).toContain('### Tab: Outer\n\nouter-panel');
    expect(out).toContain('### Tab: Inner one\n\ninner-1');
    expect(out).toContain('### Tab: Inner two\n\ninner-2');
  });
});

describe('a tab list inside a panel that names that panel (P2A-043)', () => {
  it('converts, and each panel is written once (0.4.10 failed the whole page: Maximum call stack size exceeded)', () => {
    const out = convert(
      '<p>Intro paragraph.</p>' +
        tablist([['p', 'A'], ['q', 'B']]) +
        `<div id="p" role="tabpanel">${tablist([['p', 'C'], ['q', 'D']])}<p>text-of-p</p></div>` +
        '<div id="q" role="tabpanel"><p>text-of-q</p></div><p>Outro paragraph.</p>',
    );
    expect(out).toContain('Intro paragraph.');
    expect(out).toContain('Outro paragraph.');
    expect(count(out, 'text-of-p')).toBe(1);
    expect(count(out, 'text-of-q')).toBe(1);
  });
});

describe('nested tab lists whose tabs name no panel are collected once (P2A-046)', () => {
  // The same buttons at the same depth in plain <div>s are the control: what is left is the walk's own cost of depth
  // (each button climbs its ancestors, P2A-033), not tab discovery. 0.4.12: 1.5 s against 0.48 s; 0.4.13: 0.52 s.
  // Both shapes run once first and then in turns, best of three: timed cold, the control ran first and slowest, which
  // leaned the ratio toward a pass (T253 panel, seven channels).
  const fastest = (bodies: string[]): Array<{ ms: number; markdown: string }> => {
    bodies.forEach((b) => convert(b));
    const best = bodies.map(() => ({ ms: Infinity, markdown: '' }));
    for (let round = 0; round < 3; round++) {
      bodies.forEach((b, i) => {
        const r = timed(b);
        if (r.ms < best[i].ms) best[i] = r;
      });
    }
    return best;
  };
  it('500 nested tab lists around 5,000 tabs that name no panel cost what 500 nested <div>s cost', () => {
    const tabs = Array.from({ length: 5_000 }, (_, i) => `<button role="tab"${i % 2 ? ' aria-controls="nowhere"' : ''}>t${i}</button>`).join('');
    const nest = (open: string): string => `<p>Before.</p>${open.repeat(500)}${tabs}${'</div>'.repeat(500)}<p>After.</p>`;
    const [divs, lists] = fastest([nest('<div>'), nest('<div role="tablist">')]);
    expect(lists.markdown).toBe(divs.markdown);
    expect(lists.ms).toBeLessThan(divs.ms * 2);
  }, 240_000);

  // Lists hanging off one chain of wrappers inside an outer list: 0.4.13 recorded only «no list above», so each of them
  // climbed the chain again (4,000 lists, 199 KB: 312 ms against 42 ms once each climb is recorded, T254).
  it('3,000 tab lists hanging off one chain inside an outer list cost what the same <div>s cost', () => {
    const hang = (inner: string): string =>
      `<div role="tablist">${`<div>${inner}<span>x</span></div>`.repeat(3_000)}${'</div>'.repeat(3_000)}</div>`;
    const [divs, lists] = fastest([hang('<div>'), hang('<div role="tablist">')]);
    expect(lists.ms).toBeLessThan(divs.ms * 2 + 20);
  }, 240_000);
});

const twoPanels = '<div id="p1" role="tabpanel"><p>P1TEXT</p></div><div id="p2" role="tabpanel"><p>P2TEXT</p></div>';
describe('the panels of a tab list the walk never reaches are written where they stand (P2A-047)', () => {
  const shapes: Array<[string, string]> = [
    ['a hidden wrapper', `<div hidden>${tablist([['p1', 'HidOne'], ['p2', 'HidTwo']])}</div>${twoPanels}`],
    ['a display:none wrapper', `<div style="display:none">${tablist([['p1', 'HidOne'], ['p2', 'HidTwo']])}</div>${twoPanels}`],
    ['a hidden tab list', `<div role="tablist" hidden><button role="tab" aria-controls="p1">HidOne</button><button role="tab" aria-controls="p2">HidTwo</button></div>${twoPanels}`],
    ['panels before the hidden list', `${twoPanels}<div hidden>${tablist([['p1', 'HidOne'], ['p2', 'HidTwo']])}</div>`],
    ['a hidden wrapper holding code', `<div hidden>${tablist([['p1', 'HidOne'], ['p2', 'HidTwo']])}<pre>code()</pre></div>${twoPanels}`],
  ];
  for (const [name, html] of shapes) {
    it(`${name}: both panels once, no hidden label`, () => {
      const out = convert(`<p>Neighbour.</p>${html}`);
      expect(out).toContain('Neighbour.');
      expect(count(out, 'P1TEXT')).toBe(1);
      expect(count(out, 'P2TEXT')).toBe(1);
      expect(out).not.toContain('HidOne');
      expect(out).not.toContain('HidTwo');
      if (html.includes('code()')) expect(count(out, 'code()')).toBe(1);
    });
  }
  it('a visible list naming the same panels still writes them under its tabs', () => {
    const out = convert(`${tablist([['p1', 'One'], ['p2', 'Two']])}<div hidden>${tablist([['p1', 'HidOne'], ['p2', 'HidTwo']])}</div>${twoPanels}`);
    expect(out).toContain('### Tab: One\n\nP1TEXT');
    expect(out).toContain('### Tab: Two\n\nP2TEXT');
    expect(count(out, 'P1TEXT')).toBe(1);
    expect(out).not.toContain('HidOne');
  });
  it('panels inside the hidden block stay out, as before', () => {
    const out = convert(`<p>Neighbour.</p><div hidden>${tablist([['p1', 'HidOne'], ['p2', 'HidTwo']])}${twoPanels}</div>`);
    expect(out).toContain('Neighbour.');
    expect(out).not.toContain('P1TEXT');
  });
});

describe('aria-selected is read as Chrome reads it (P2A-049)', () => {
  const shared = (v: string): string =>
    '<div role="tablist"><button role="tab" aria-controls="s">First</button>' +
    `<button role="tab" aria-controls="s" aria-selected="${v}">Second</button></div><div id="s" role="tabpanel"><p>SHARED</p></div>`;
  // Chrome 157 does not trim: ` false ` and a lone space are selected (T254, 0.4.13 trimmed them to «not selected»).
  for (const v of ['True', 'TRUE', ' true ', '1', ' false ', ' ']) {
    it(`aria-selected="${v}" puts a shared panel under that tab`, () => {
      expect(convert(shared(v))).toContain('### Tab: Second\n\nSHARED');
    });
  }
  for (const v of ['false', 'FALSE', '', 'undefined']) {
    it(`aria-selected="${v}" does not`, () => {
      expect(convert(shared(v))).toContain('### Tab: First\n\nSHARED');
    });
  }
  it('a selected tab outside any group keeps its label whatever the case', () => {
    expect(convert('<p>Before.</p><div><button role="tab" aria-selected="True">LoneTabLabel</button></div><p>After.</p>')).toContain('LoneTabLabel');
  });
});

describe('a tab widget inside a panel of an unreached tab list is written once (P2A-050)', () => {
  // 0.4.13's second walk wrote the panels of a group it reached inside such a panel twice (by the group, then where they
  // stand), and once more per level of nesting. Each text below was written 0 times by 0.4.12 and 2-5 times by 0.4.13.
  const hidden = (a: string, b: string): string => `<div hidden>${tablist([[a, 'HidOne'], [b, 'HidTwo']])}</div>`;
  const once = (out: string, texts: string[]): void => {
    for (const t of texts) expect(count(out, t), t).toBe(1);
    expect(out).not.toContain('HidOne');
  };
  it('code tabs in a panel of a hidden tab bar keep their headings, each panel once', () => {
    const out = convert(
      `${hidden('p', 'p2')}<div id="p"><p>PTEXT</p>${tablist([['q', 'Q1'], ['q2', 'Q2']])}` +
        '<div id="q"><p>QTEXT</p></div><div id="q2"><p>QXTWO</p></div></div><div id="p2"><p>P2TEXT</p></div>',
    );
    expect(out).toContain('### Tab: Q1\n\nQTEXT');
    expect(out).toContain('### Tab: Q2\n\nQXTWO');
    once(out, ['PTEXT', 'QTEXT', 'QXTWO', 'P2TEXT']);
  });
  it('three levels: each text once (0.4.13 wrote the innermost three times)', () => {
    const out = convert(
      `${hidden('p', 'px')}<div id="p"><p>PTEXT</p>${tablist([['q', 'Q1'], ['qx', 'Q2']])}<div id="q"><p>QTEXT</p>` +
        `${tablist([['r', 'R1'], ['rx', 'R2']])}<div id="r"><p>RTEXT</p></div><div id="rx"><p>RXTEXT</p></div></div>` +
        '<div id="qx"><p>QXTEXT</p></div></div><div id="px"><p>PXTEXT</p></div>',
    );
    once(out, ['PTEXT', 'QTEXT', 'RTEXT', 'RXTEXT', 'QXTEXT', 'PXTEXT']);
  });
  it('a hidden list naming a visible tab list: that list writes its panels once', () => {
    const out = convert(
      `${hidden('vlist', 'p2')}<div id="vlist" role="tablist"><button role="tab" aria-controls="a">VA</button>` +
        '<button role="tab" aria-controls="b">VB</button></div><div id="a" role="tabpanel"><p>ATEXT</p></div>' +
        '<div id="b" role="tabpanel"><p>BTEXT</p></div><div id="p2" role="tabpanel"><p>P2TEXT</p></div>',
    );
    expect(out).toContain('### Tab: VA\n\nATEXT');
    once(out, ['ATEXT', 'BTEXT', 'P2TEXT']);
  });
  it('the inner list after its own panels: each panel once', () => {
    const out = convert(
      `<div id="a" role="tabpanel"><p>ATEXT</p></div><div id="b" role="tabpanel"><p>BTEXT</p></div>${hidden('X', 'Y')}` +
        `<div id="X"><p>XTEXT</p>${tablist([['a', 'IA'], ['b', 'IB']])}</div><div id="Y"><p>YTEXT</p></div>`,
    );
    once(out, ['ATEXT', 'BTEXT', 'XTEXT', 'YTEXT']);
  });
  it('a tab list inside the four nested panels it names: each level once (0.4.13: the innermost five times)', () => {
    let html = tablist([0, 1, 2, 3].map((i) => [`L${i}`, `T${i}`] as [string, string]));
    for (let i = 3; i >= 0; i--) html = `<div id="L${i}"><p>LVL${i}X</p>${html}</div>`;
    const out = convert(html);
    for (const t of ['LVL0X', 'LVL1X', 'LVL2X', 'LVL3X']) expect(count(out, t), t).toBe(1);
  });
  it('an inline panel written where it stands is not written again by a group reached later', () => {
    const out = convert(
      `${hidden('X', 's')}<p>Before <span id="s">SPANTEXT</span> after.</p>` +
        `<div id="X"><p>XTEXT</p>${tablist([['s', 'S1'], ['t', 'T1']])}</div><div id="t"><p>TTEXT</p></div>`,
    );
    once(out, ['SPANTEXT', 'XTEXT', 'TTEXT']);
  });
  it('a panel skipped where it stands (aria-hidden) is still written by a group reached later', () => {
    const out = convert(
      `${hidden('X', 'h')}<div id="h" aria-hidden="true"><p>HTEXT</p></div>` +
        `<div id="X"><p>XTEXT</p>${tablist([['h', 'H1'], ['k', 'K1']])}</div><div id="k"><p>KTEXT</p></div>`,
    );
    expect(out).toContain('### Tab: H1\n\nHTEXT');
    once(out, ['HTEXT', 'XTEXT', 'KTEXT']);
  });
});

describe('a repeated id in aria-labelledby is read each time, as accname and Chrome read it (T253)', () => {
  it('"x x x" names a panel «Save Save Save»', () => {
    const out = convert(
      '<div><div role="tabpanel" data-state="active" aria-labelledby="x x x"><p>G1</p></div>' +
        '<div role="tabpanel" data-state="inactive" aria-labelledby="y"><p>G2</p></div></div><span id="x">Save</span><span id="y">Other</span>',
    );
    expect(out).toContain('### Tab: Save Save Save\n\nG1');
  });
});
