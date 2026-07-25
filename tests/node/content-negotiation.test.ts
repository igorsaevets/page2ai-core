import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAndConvert } from '../../src/node/index.js';

// Regression tests for the bug found by page2ai-benchmark on 2026-07-25.
//
// fetchAndConvert sends an Accept header that lists text/markdown. Fumadocs,
// Mintlify, Vercel and Supabase all honour it and answer with the page already
// converted to Markdown. The v0.1.0 code handed that body to linkedom, which
// found no <article> and returned frontmatter with an empty document, so a
// perfectly good response looked like a total extraction failure.

const PAGE_MARKDOWN = `# Fumadocs (Framework Mode): Next.js

Install the package and add the config.

\`\`\`bash
npm install fumadocs-ui
\`\`\`
`;

const PAGE_HTML =
  '<html><head><title>Real HTML</title></head><body><article><h1>Real HTML</h1><p>Converted.</p></article></body></html>';

const mockFetch = (body: string, contentType: string): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      // The .md-suffix probe runs first; make it miss so the HTML path is exercised.
      if (url.endsWith('.md')) {
        return new Response('<!doctype html><html><body>not markdown</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response(body, { status: 200, headers: { 'content-type': contentType } });
    }),
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAndConvert — content negotiation', () => {
  it('returns the body unchanged when the server answers with text/markdown', async () => {
    mockFetch(PAGE_MARKDOWN, 'text/markdown');
    const result = await fetchAndConvert('https://example.com/docs/page');

    expect(result.source).toBe('content-negotiation');
    expect(result.title).toBe('Fumadocs (Framework Mode): Next.js');
    expect(result.markdown).toContain('```bash');
    expect(result.markdown).toContain('npm install fumadocs-ui');
    expect(result.charCount).toBeGreaterThan(0);
  });

  it('labels the channel in the frontmatter so callers can tell fetch from conversion', async () => {
    mockFetch(PAGE_MARKDOWN, 'text/markdown; charset=utf-8');
    const { markdown } = await fetchAndConvert('https://example.com/docs/page');

    expect(markdown).toContain('extractor_source: "content-negotiation"');
  });

  it('still parses HTML when the server answers with text/html', async () => {
    mockFetch(PAGE_HTML, 'text/html; charset=utf-8');
    const result = await fetchAndConvert('https://example.com/docs/page');

    expect(result.source).toBe('html-parse');
    expect(result.markdown).toContain('# Real HTML');
    expect(result.markdown).toContain('Converted.');
  });

  it('does not treat an HTML body as Markdown even if the content type lies', async () => {
    mockFetch(PAGE_HTML, 'text/markdown');
    const result = await fetchAndConvert('https://example.com/docs/page');

    expect(result.source).toBe('html-parse');
    expect(result.markdown).toContain('# Real HTML');
  });
});
