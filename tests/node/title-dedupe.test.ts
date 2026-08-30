import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

// Issue #9: the renderer emits a title-derived H1, then walks the DOM and renders the
// page's own <h1> — identical on most well-formed pages. The first heading the walk
// meets is skipped when it normalizes to the title; the window closes there.
describe('htmlToMarkdown — duplicate title heading (#9)', () => {
  const h1Lines = (md: string): string[] => md.split('\n').filter((l) => /^# /.test(l));

  it('emits one H1 when the page h1 equals the title (example.com shape)', () => {
    const { markdown } = htmlToMarkdown(
      '<html><head><title>Example Domain</title></head><body><div><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents.</p></div></body></html>',
      { includeFrontmatter: false },
    );
    expect(h1Lines(markdown)).toEqual(['# Example Domain']);
    expect(markdown).toContain('illustrative examples');
  });

  it('keeps both headings when title and h1 differ', () => {
    const { markdown } = htmlToMarkdown(
      '<html><head><title>Hi</title></head><body><article><h1>Hello</h1><p>World</p></article></body></html>',
      { includeFrontmatter: false },
    );
    expect(markdown).toContain('# Hi');
    expect(markdown).toContain('# Hello');
  });

  it('dedupes across case and punctuation differences', () => {
    const { markdown } = htmlToMarkdown(
      '<html><head><title>Example Domain</title></head><body><div><h1>Example domain!</h1><p>Body text here.</p></div></body></html>',
      { includeFrontmatter: false },
    );
    expect(h1Lines(markdown)).toEqual(['# Example Domain']);
  });

  it('skips only the first heading; an identical heading later is content', () => {
    const { markdown } = htmlToMarkdown(
      '<html><head><title>Docs</title></head><body><div><h1>Docs</h1><p>Intro.</p><h2>Docs</h2><p>Section about the docs.</p></div></body></html>',
      { includeFrontmatter: false },
    );
    expect(h1Lines(markdown)).toEqual(['# Docs']);
    expect(markdown).toContain('## Docs');
  });

  it('does not skip a matching heading that is not the first heading', () => {
    // Conservative by design: the dedupe window closes at the first heading, matching
    // or not. A title-equal <h1> buried mid-page keeps both copies.
    const { markdown } = htmlToMarkdown(
      '<html><head><title>Docs</title></head><body><div><h2>Intro</h2><p>Lede.</p><h1>Docs</h1><p>Body.</p></div></body></html>',
      { includeFrontmatter: false },
    );
    expect(markdown).toContain('## Intro');
    expect(h1Lines(markdown)).toEqual(['# Docs', '# Docs']);
  });

  it('renders the body h1 untouched when the page has no title', () => {
    const { markdown } = htmlToMarkdown(
      '<html><head></head><body><div><h1>Standalone</h1><p>Body.</p></div></body></html>',
      { includeFrontmatter: false },
    );
    expect(h1Lines(markdown)).toEqual(['# Standalone']);
  });

  it('dedupes after the site suffix is stripped from the title', () => {
    // <title>Page - Site</title> with the brand repeated in chrome strips to "Page";
    // the body h1 "Page" must then match the STRIPPED title, not the raw one.
    const { markdown } = htmlToMarkdown(
      '<html><head><title>Getting Started - AcmeDocs</title></head><body><header><span>AcmeDocs</span></header><main><h1>Getting Started</h1><p>Install the thing and run it.</p></main></body></html>',
      { includeFrontmatter: false },
    );
    expect(h1Lines(markdown)).toEqual(['# Getting Started']);
  });
});
