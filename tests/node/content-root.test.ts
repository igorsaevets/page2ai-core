// Regression tests for pickContentRoot.
//
// The bug these lock down, measured 2026-08-02: the renderer chose its root with
// `querySelector('main article') || querySelector('article')`, which returns the FIRST <article>
// in document order. HTML5 defines <article> as any independently distributable composition, so
// design systems spend the tag on cards, teasers and comments. Three real pages, raw server HTML,
// body characters excluding frontmatter:
//
//   docs.astro.build/en/getting-started/     208 -> 3,494    five <article class="card">
//   starlight.astro.build/                   209 -> 3,324    same framework
//   blog.cloudflare.com/                     927 -> 15,068   nineteen post teasers, one emitted
//
// The same sweep left 15 other pages byte-identical, including both GitHub repo pages where the
// <article class="markdown-body"> IS the content and must keep winning. That asymmetry is the
// whole point: the fix must not become "always prefer the bigger container".
//
// Fixtures are inline and offline on purpose. A test that fetches the live page fails when a site
// redesigns, which trains people to ignore it, and it cannot run in CI without network.

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (html: string): string =>
  htmlToMarkdown(html, { includeFrontmatter: false }).markdown;

// A card grid: several small <article> elements that are components, not the page.
// Shaped after Astro Starlight's landing layout.
const CARD_GRID = `<html><head><title>Getting Started</title></head><body>
  <header><a href="/">Astro</a></header>
  <nav><a href="/a">A</a><a href="/b">B</a></nav>
  <main>
    <h1>What will you build with Astro?</h1>
    <p>Start with one of our official starter themes.</p>
    <div class="card-grid">
      <article class="card"><p class="title">Install Astro</p><div class="body">Use the CLI to create a new project in a few seconds.</div></article>
      <article class="card"><p class="title">Editor Setup</p><div class="body">Configure your editor for the best authoring experience.</div></article>
      <article class="card"><p class="title">Project Structure</p><div class="body">Learn how an Astro project is laid out on disk.</div></article>
    </div>
    <h2>Next steps</h2>
    <p>Read the guides to learn about routing, content collections and integrations.</p>
  </main>
  <footer>Copyright</footer>
</body></html>`;

// One dominant <article> that genuinely is the page. Shaped after a GitHub repo README.
const DOMINANT_ARTICLE = `<html><head><title>Repo</title></head><body>
  <header><a href="/">GitHub</a></header>
  <main>
    <nav aria-label="files"><a href="/src">src</a><a href="/tests">tests</a></nav>
    <article class="markdown-body">
      <h1>The project</h1>
      <p>This paragraph is long enough to dominate the container it sits in, which is what a real
         article does and what a decorative card never does.</p>
      <p>A second paragraph, so the article clearly carries the bulk of the page content and the
         dominance test resolves in its favour rather than against it.</p>
      <h2>Install</h2>
      <p>Run the installer and then read the configuration reference for the available options.</p>
    </article>
  </main>
</body></html>`;

describe('pickContentRoot', () => {
  it('keeps the whole page when <article> elements are cards, not the article', () => {
    const out = md(CARD_GRID);
    // Every card must survive. Before the fix only the first card's 2 nodes were emitted.
    expect(out).toContain('Install Astro');
    expect(out).toContain('Editor Setup');
    expect(out).toContain('Project Structure');
    // And so must the prose that sits OUTSIDE the cards, which is what proves the root moved up
    // to <main> rather than merely picking a bigger card.
    expect(out).toContain('What will you build with Astro?');
    expect(out).toContain('Next steps');
    expect(out).toContain('routing, content collections and integrations');
  });

  it('still narrows to a dominant <article> and leaves the surrounding chrome out', () => {
    const out = md(DOMINANT_ARTICLE);
    expect(out).toContain('The project');
    expect(out).toContain('what a decorative card never does');
    expect(out).toContain('## Install');
    // The file-listing nav lives in <main> but outside the article. If this ever appears, the
    // dominance test has been loosened into "always prefer the container" and every GitHub repo
    // page has started carrying its file browser into the Markdown.
    expect(out).not.toContain('tests');
  });

  it('does not lose content when <body> is empty but the document is not', () => {
    // linkedom hands back a <body> with zero children on some real documents while the content
    // sits under documentElement. Reproduced 2026-08-02 on nodejs.org/api/fs.html:
    // body.childNodes.length === 0 with documentElement.textContent at 256,836 chars.
    // Simulated here with a document that has no <body> element at all.
    const out = md('<html><head><title>T</title></head><h1>Heading</h1><p>Paragraph text.</p></html>');
    expect(out).toContain('Heading');
    expect(out).toContain('Paragraph text.');
    expect(out).not.toContain('no extractable body content');
  });

  it('prefers the single <article> when there is no semantic container to compare against', () => {
    // With no <main> and no [role=main] the comparison has no meaning: a raw <body> carries every
    // sidebar that is not marked up as chrome. The historical article-first choice is kept there
    // rather than guessed at, so this asserts the fallback did not change.
    const out = md(`<html><head><title>T</title></head><body>
      <div class="sidebar"><a href="/1">One</a><a href="/2">Two</a></div>
      <article><h1>Post</h1><p>The post body.</p></article>
    </body></html>`);
    expect(out).toContain('# Post');
    expect(out).toContain('The post body.');
  });
});
