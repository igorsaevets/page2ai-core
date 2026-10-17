import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAndConvert, type FetchAndConvertOptions } from '../../src/node/index.js';

// BL-49 (Igor, 2026-10-17): the content comes only from the page the caller named. Until 0.1.13
// fetchAndConvert first probed `<url>.md` and sent an Accept header that listed text/markdown, so
// docs platforms that negotiate (Fumadocs, Mintlify, Vercel, Supabase) answered their own Markdown
// copy, which can be older than the page. The server below behaves like them: it offers llms.txt,
// a `.md` twin of the page, and Markdown to any request whose Accept header names text/markdown.
//
// A URL that is itself Markdown (a .md file) is the page: it is still returned as is
// (source 'markdown-response'). Regression of 2026-07-25 (page2ai-benchmark RETRACTION): a
// Markdown body must never reach the HTML parser, which returns an empty document for it.

const PAGE_HTML =
  '<html><head><title>Real HTML</title></head><body><article><h1>Real HTML</h1>' +
  '<p>PAGE_ONLY_MARKER, converted from the page.</p></article></body></html>';

const TWIN_MD = `# Real HTML\n\nTWIN_ONLY_MARKER: the platform's own Markdown copy.\n\n${'Twin text. '.repeat(20)}\n`;

const LLMS_TXT = '# Site\n\n- [Real HTML](https://example.com/docs/page.md)\n';

const PAGE_MARKDOWN = `# Fumadocs (Framework Mode): Next.js

Install the package and add the config.

\`\`\`bash
npm install fumadocs-ui
\`\`\`
`;

interface Seen {
  url: string;
  accept: string;
}

// mode 'negotiating': a docs platform with an HTML page and a Markdown copy of it.
// mode 'markdown-file': every URL is a Markdown file (served text/markdown whatever Accept says).
// mode 'lying-type': HTML served with a text/markdown content type.
const serve = (mode: 'negotiating' | 'markdown-file' | 'lying-type'): Seen[] => {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const accept = new Headers(init?.headers).get('accept') ?? '';
      seen.push({ url, accept });
      const md = (body: string): Response =>
        new Response(body, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
      if (mode === 'markdown-file') return md(PAGE_MARKDOWN);
      if (mode === 'lying-type') return md(PAGE_HTML);
      const path = new URL(url).pathname;
      if (/llms(?:-full)?\.txt$/.test(path)) {
        return new Response(LLMS_TXT, { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      if (path.endsWith('.md') || /text\/markdown/i.test(accept)) return md(TWIN_MD);
      return new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }),
  );
  return seen;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAndConvert reads only the page (BL-49)', () => {
  it('requests only the URL it was given, never a .md twin or llms.txt, and converts the HTML', async () => {
    const seen = serve('negotiating');
    const result = await fetchAndConvert('https://example.com/docs/page');

    expect(seen.map((s) => s.url)).toEqual(['https://example.com/docs/page']);
    expect(result.source).toBe('html-parse');
    expect(result.markdown).toContain('PAGE_ONLY_MARKER');
    expect(result.markdown).not.toContain('TWIN_ONLY_MARKER');
  });

  it('does not ask for Markdown in the Accept header, and ranks HTML first', async () => {
    const seen = serve('negotiating');
    await fetchAndConvert('https://example.com/docs/page');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.accept).not.toMatch(/markdown/i);
    expect(seen[0]!.accept.split(',')[0]).toBe('text/html');
  });

  it('ignores an old tryMdSuffixFirst: true (the option is gone)', async () => {
    const seen = serve('negotiating');
    const old = { tryMdSuffixFirst: true } as unknown as FetchAndConvertOptions;
    const result = await fetchAndConvert('https://example.com/docs/page', old);

    expect(seen.map((s) => s.url)).toEqual(['https://example.com/docs/page']);
    expect(result.markdown).not.toContain('TWIN_ONLY_MARKER');
  });

  it('returns a URL that is itself Markdown as is: that file is the page', async () => {
    const seen = serve('markdown-file');
    const result = await fetchAndConvert('https://example.com/docs/README.md');

    expect(seen.map((s) => s.url)).toEqual(['https://example.com/docs/README.md']);
    expect(result.source).toBe('markdown-response');
    expect(result.title).toBe('Fumadocs (Framework Mode): Next.js');
    expect(result.markdown).toContain('```bash');
    expect(result.markdown).toContain('npm install fumadocs-ui');
    expect(result.markdown).toContain('extractor_source: "markdown-response"');
  });

  it('does not treat an HTML body as Markdown even if the content type lies', async () => {
    serve('lying-type');
    const result = await fetchAndConvert('https://example.com/docs/page');

    expect(result.source).toBe('html-parse');
    expect(result.markdown).toContain('# Real HTML');
  });

  // T121 panel (codex), measured on npm 0.1.12: the Markdown path prepended the frontmatter whatever
  // includeFrontmatter said, and counted only the body, while htmlToMarkdown counts the whole
  // returned Markdown.
  it('honours includeFrontmatter on the Markdown path, and charCount is the returned length', async () => {
    serve('markdown-file');
    const off = await fetchAndConvert('https://example.com/docs/README.md', { includeFrontmatter: false });
    expect(off.markdown).toBe(PAGE_MARKDOWN.trim() + '\n');
    expect(off.charCount).toBe(off.markdown.length);

    serve('markdown-file');
    const on = await fetchAndConvert('https://example.com/docs/README.md');
    expect(on.markdown.startsWith('---\n')).toBe(true);
    expect(on.charCount).toBe(on.markdown.length);
  });
});
