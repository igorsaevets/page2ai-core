import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchProtectionError, fetchAndConvert, type FetchAndConvertOptions } from '../../src/node/index.js';

// BL-49 (Igor, 2026-10-17): the content comes only from the page the caller named. Until 0.1.13
// fetchAndConvert first probed `<url>.md` and sent an Accept header that listed text/markdown, so
// docs platforms that negotiate (Fumadocs, Mintlify, Vercel, Supabase) answered their own Markdown
// copy, which can be older than the page. The server below behaves like them: it offers llms.txt,
// a `.md` twin of the page, and Markdown to any request whose Accept header names text/markdown.
//
// A URL that is itself a Markdown or text file is the page: it is still returned as is
// (source 'markdown-response'), whatever text type the server labels it. Regression of 2026-07-25
// (page2ai-benchmark RETRACTION): a Markdown body must never reach the HTML parser, which returns
// an empty document for it, and a text/plain one comes out as a single line (T137).

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

const md = (body: string, type = 'text/markdown; charset=utf-8'): Response =>
  new Response(body, { status: 200, headers: { 'content-type': type } });
const html = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

const stub = (answer: (url: string, accept: string) => Response): Seen[] => {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const accept = new Headers(init?.headers).get('accept') ?? '';
      seen.push({ url, accept });
      return answer(url, accept);
    }),
  );
  return seen;
};

// mode 'negotiating': a docs platform with an HTML page and a Markdown copy of it.
// mode 'markdown-file': every URL is a Markdown file (served text/markdown whatever Accept says).
// mode 'lying-type': HTML served with a text/markdown content type.
const serve = (mode: 'negotiating' | 'markdown-file' | 'lying-type'): Seen[] =>
  stub((url, accept) => {
    if (mode === 'markdown-file') return md(PAGE_MARKDOWN);
    if (mode === 'lying-type') return md(PAGE_HTML);
    const path = new URL(url).pathname;
    if (/llms(?:-full)?\.txt$/.test(path)) return md(LLMS_TXT, 'text/plain');
    if (path.endsWith('.md') || /text\/markdown/i.test(accept)) return md(TWIN_MD);
    return html(PAGE_HTML);
  });

// How real servers pick the Markdown copy from the Accept header. T137 measured these live on
// 2026-10-17 with GET and core's own User-Agent, except the two rules quoted from source.
const ranges = (accept: string): Array<{ type: string; q: number }> =>
  accept
    .split(',')
    .map((part) => {
      const [type = '', ...params] = part.trim().toLowerCase().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { type: type.trim(), q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((r) => r.type);
const NEGOTIATORS: Record<string, (accept: string) => boolean> = {
  // Fumadocs isMarkdownPreferred (packages/core/src/negotiation): text/plain, text/markdown and
  // text/x-markdown vote Markdown; text/html, text/* and */* vote HTML; Markdown wins a tie.
  // fumadocs.dev served Markdown to `text/html,text/plain`.
  fumadocs: (accept) => {
    const best = (types: string[]): number => Math.max(0, ...ranges(accept).filter((r) => types.includes(r.type)).map((r) => r.q));
    const m = best(['text/plain', 'text/markdown', 'text/x-markdown']);
    return m > 0 && m >= best(['text/html', 'text/*', '*/*']);
  },
  // A rewrite that matches the word and ignores q: platform.claude.com served Markdown to
  // `text/html,application/xhtml+xml,text/markdown;q=0,*/*;q=0.1`; Vercel's blog shows the
  // rule `has: [{ type: 'header', key: 'accept', value: '(.*)text/markdown(.*)' }]`.
  'word text/markdown': (accept) => /text\/markdown/i.test(accept),
  // A published implementation guide: `if (acceptHeader.includes("text/plain"))` serve the copy.
  'word text/plain': (accept) => accept.includes('text/plain'),
  // A rewrite on `.*text/(markdown|\*).*` (supabase.com's www app, read by the T136 panel).
  'text/markdown or text/*': (accept) => /text\/(markdown|\*)/i.test(accept),
  // The first range decides: mintlify.com and docs.stripe.com served Markdown to `text/plain`
  // alone and HTML when text/html came first.
  'first range': (accept) => /^(text\/plain|text\/markdown)$/.test(ranges(accept)[0]?.type ?? ''),
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

  it('sends a browser Accept header: HTML first, no Markdown, no text/plain, no text/*', async () => {
    const seen = serve('negotiating');
    await fetchAndConvert('https://example.com/docs/page');

    expect(seen).toHaveLength(1);
    const accept = seen[0]!.accept;
    expect(accept.split(',')[0]).toBe('text/html');
    expect(accept).not.toMatch(/markdown/i);
    expect(accept).not.toMatch(/text\/plain/i);
    expect(accept).not.toMatch(/text\/\*/i);
  });

  it.each(Object.keys(NEGOTIATORS))('gets the page, not the copy, from a server that negotiates by %s', async (name) => {
    const prefersMarkdown = NEGOTIATORS[name]!;
    const seen = stub((_url, accept) => (prefersMarkdown(accept) ? md(TWIN_MD) : html(PAGE_HTML)));
    const result = await fetchAndConvert('https://example.com/docs/page');

    expect(seen).toHaveLength(1);
    expect(result.source).toBe('html-parse');
    expect(result.markdown).toContain('PAGE_ONLY_MARKER');
    expect(result.markdown).not.toContain('TWIN_ONLY_MARKER');
  });

  it('ignores an old tryMdSuffixFirst: true (the option is gone)', async () => {
    const seen = serve('negotiating');
    const old = { tryMdSuffixFirst: true } as unknown as FetchAndConvertOptions;
    const result = await fetchAndConvert('https://example.com/docs/page', old);

    expect(seen.map((s) => s.url)).toEqual(['https://example.com/docs/page']);
    expect(result.markdown).not.toContain('TWIN_ONLY_MARKER');
  });

  it('refuses Markdown served for a page address instead of returning it as the page', async () => {
    // A server that picks its copy by something other than Accept (User-Agent, a cache) answers
    // Markdown although the request asked for HTML. Until T137 that copy came back as the page.
    stub(() => md(TWIN_MD));
    const call = fetchAndConvert('https://example.com/docs/page');

    await expect(call).rejects.toBeInstanceOf(FetchProtectionError);
    await expect(fetchAndConvert('https://example.com/docs/page')).rejects.toThrow(/answered with Markdown/);
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

  // T137, measured on npm 0.1.13 and on main 488d2d0: README.md from raw.githubusercontent.com
  // (text/plain) came out as one line, no heading, no code block; text/x-markdown and
  // application/octet-stream were refused by the content-type guard.
  it.each(['text/plain; charset=utf-8', 'text/x-markdown', 'application/octet-stream'])(
    'returns a .md file served as %s as is, line for line',
    async (type) => {
      stub(() => md(PAGE_MARKDOWN, type));
      const result = await fetchAndConvert('https://example.com/owner/repo/main/README.md', { includeFrontmatter: false });

      expect(result.source).toBe('markdown-response');
      expect(result.title).toBe('Fumadocs (Framework Mode): Next.js');
      expect(result.markdown).toBe(PAGE_MARKDOWN.trim() + '\n');
    },
  );

  it('returns a .txt file named by the caller as is (llms.txt is the page when you name it)', async () => {
    stub(() => md(LLMS_TXT, 'text/plain; charset=utf-8'));
    const result = await fetchAndConvert('https://example.com/llms.txt', { includeFrontmatter: false });

    expect(result.source).toBe('markdown-response');
    expect(result.markdown).toBe(LLMS_TXT.trim() + '\n');
  });

  it('refuses a .md URL whose body is not text', async () => {
    stub(() => md('PK\u0003\u0004\u0000\u0000binary', 'application/octet-stream'));
    await expect(fetchAndConvert('https://example.com/file.md')).rejects.toThrow(/not text/);
  });

  it('converts the HTML page that a .md address serves as HTML (a rendered README)', async () => {
    stub(() => html('<!doctype html>' + PAGE_HTML));
    const result = await fetchAndConvert('https://example.com/owner/repo/blob/main/README.md');

    expect(result.source).toBe('html-parse');
    expect(result.markdown).toContain('PAGE_ONLY_MARKER');
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
