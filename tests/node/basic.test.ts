import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

describe('htmlToMarkdown — basic', () => {
  it('extracts a heading and paragraph', () => {
    const { markdown } = htmlToMarkdown(
      '<html><head><title>Hi</title></head><body><article><h1>Hello</h1><p>World</p></article></body></html>',
      { includeFrontmatter: false },
    );
    expect(markdown).toContain('# Hi');
    expect(markdown).toContain('# Hello');
    expect(markdown).toContain('World');
  });

  it('emits frontmatter by default', () => {
    const { markdown } = htmlToMarkdown(
      '<html lang="en"><head><title>My Doc</title><meta name="description" content="A doc."></head><body><p>Body.</p></body></html>',
      { baseUrl: 'https://example.com/x' },
    );
    expect(markdown).toMatch(/^---\ntitle: "My Doc"/);
    expect(markdown).toContain('source: "https://example.com/x"');
    expect(markdown).toContain('description: "A doc."');
    expect(markdown).toContain('language: "en"');
  });

  it('renders unordered lists', () => {
    const { markdown } = htmlToMarkdown(
      '<article><ul><li>Alpha</li><li>Beta</li></ul></article>',
      { includeFrontmatter: false },
    );
    expect(markdown).toContain('- Alpha');
    expect(markdown).toContain('- Beta');
  });

  it('renders code blocks with language hint', () => {
    const { markdown } = htmlToMarkdown(
      '<article><pre><code class="language-python">print("hi")</code></pre></article>',
      { includeFrontmatter: false },
    );
    expect(markdown).toContain('```python');
    expect(markdown).toContain('print("hi")');
  });

  it('renders tables', () => {
    const { markdown } = htmlToMarkdown(
      '<article><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></article>',
      { includeFrontmatter: false },
    );
    expect(markdown).toContain('| A | B |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| 1 | 2 |');
  });

  it('resolves relative links against baseUrl', () => {
    const { markdown } = htmlToMarkdown(
      '<article><a href="/api">API</a></article>',
      { baseUrl: 'https://docs.example.com/guide', includeFrontmatter: false },
    );
    // Anchors ARE resolved against baseUrl (measured on the shipped build; an
    // earlier comment here claimed the opposite and documented a behavior the
    // renderer never had).
    expect(markdown).toContain('[API](https://docs.example.com/api)');
  });
});
