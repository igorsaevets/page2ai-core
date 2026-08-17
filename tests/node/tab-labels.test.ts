import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

// Regression: data-state tab panels used the raw aria-labelledby IDREF as the
// visible tab heading, emitting machine ids like "### Tab: trigger-py" on
// Radix-style docs pages. The IDREF must be dereferenced to the labelling
// element's text.
describe('tab labels from aria-labelledby', () => {
  it('uses the labelling element text, not the raw id', () => {
    const html = `
      <html><body><article>
        <h1>Install</h1>
        <div>
          <div role="tabpanel" data-state="active" aria-labelledby="trigger-py">pip install page2ai</div>
          <div role="tabpanel" data-state="inactive" aria-labelledby="trigger-ts">npm install page2ai</div>
        </div>
        <button id="trigger-py">Python</button>
        <button id="trigger-ts">TypeScript</button>
      </article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { includeFrontmatter: false });
    expect(markdown).toContain('Tab: Python');
    expect(markdown).toContain('Tab: TypeScript');
    expect(markdown).not.toContain('trigger-py');
    expect(markdown).not.toContain('trigger-ts');
  });
});
