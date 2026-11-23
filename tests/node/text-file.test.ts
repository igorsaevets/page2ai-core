import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchProtectionError, fetchAndConvert } from '../../src/node/index.js';

// P2A-090 (found in Page2AI T295, fixed in 0.4.26): a text/plain response that is not a .md or .txt
// file went to the HTML parser. Readability.js from raw.githubusercontent.com (2,812 lines, served
// `text/plain; charset=utf-8`) came out as 4 lines of Markdown and one `![image](...)` made from an
// `<img` inside a JavaScript string. A browser shows a text/plain response as its text, every line
// kept, and never as HTML (MIME Sniffing Standard §7.1-7.2). In Markdown that is a fenced code block.

const respond = (body: string, type = 'text/plain; charset=utf-8'): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': type } })),
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const bare = { includeFrontmatter: false };

const JS_FILE = [
  '/* A file that looks like Readability.js */',
  'function grabArticle(page) {',
  '  // keep <img src=x> out of the article',
  '  const html = \'<img src="pic.png" alt="pic"><a href="/next">next</a>\';',
  '  return page.innerHTML.replace(/<script[^>]*>/g, "");',
  '}',
  '',
  'module.exports = grabArticle;',
].join('\n');

describe('P2A-090: a text/plain file comes back as its text, in a fence', () => {
  it('returns a .js file served as text/plain line for line, in a javascript fence', async () => {
    respond(JS_FILE);
    const result = await fetchAndConvert('https://example.com/owner/repo/main/grab.js', bare);

    expect(result.source).toBe('text-response');
    expect(result.title).toBe('grab.js');
    expect(result.markdown).toBe('```javascript\n' + JS_FILE + '\n```\n');
  });

  it('invents no image or link from markup inside the file', async () => {
    respond(JS_FILE);
    const { markdown } = await fetchAndConvert('https://example.com/owner/repo/main/grab.js', bare);

    expect(markdown).not.toContain('![');
    expect(markdown).not.toContain('](');
    expect(markdown).toContain('<img src="pic.png" alt="pic"><a href="/next">next</a>');
  });

  it('keeps all 2,812 lines of a long file (the Readability.js case)', async () => {
    const lines = Array.from({ length: 2812 }, (_, i) => `  var line${i} = "<p>${i}</p>"; // ${i}`);
    respond(lines.join('\n') + '\n');
    const { markdown } = await fetchAndConvert('https://example.com/mozilla/readability/main/Readability.js', bare);

    const inner = markdown.split('\n').slice(1, -2);
    expect(inner).toEqual(lines);
  });

  it('keeps a Python file\'s # comments as code, not as headings', async () => {
    const py = '# Configuration loader\nimport os\n\n# Read the path\nPATH = os.environ.get("X", "*default*")\n';
    respond(py);
    const { markdown } = await fetchAndConvert('https://example.com/a/b/config.py', bare);

    expect(markdown).toBe('```python\n' + py.trimEnd() + '\n```\n');
  });

  it('opens a fence longer than any run of backticks inside the file', async () => {
    const doc = 'const a = `x`;\nconst md = "```js\\n```";\n````\nfour\n````\n';
    respond(doc);
    const { markdown } = await fetchAndConvert('https://example.com/a/fences.ts', bare);

    expect(markdown.startsWith('`````typescript\n')).toBe(true);
    expect(markdown.endsWith('\n`````\n')).toBe(true);
    expect(markdown).toContain(doc.trimEnd());
  });

  it.each([
    ['https://example.com/a/data.json', '{"a": 1}', 'json'],
    ['https://example.com/a/.github/workflows/ci.yml', 'on: push', 'yaml'],
    ['https://example.com/a/Cargo.toml', '[package]', 'toml'],
    ['https://example.com/a/main.go', 'package main', 'go'],
    ['https://example.com/a/Dockerfile', 'FROM node:22', 'dockerfile'],
    ['https://example.com/a/Makefile', 'all:\n\techo hi', 'makefile'],
    ['https://example.com/install', '#!/bin/sh\necho install', 'bash'],
    ['https://example.com/tools/run', '#!/usr/bin/env -S python3 -u\nprint(1)', 'python'],
    ['https://example.com/tools/serve', '#!/usr/bin/node\nconsole.log(1)', 'javascript'],
    ['https://example.com/a/notes.unknownkind', 'plain words', ''],
    ['https://example.com/a/LICENSE', 'MIT License', ''],
    ['https://example.com/', 'plain words at a page address', ''],
  ])('%s (body %j) gets the fence language %j', async (url, body, language) => {
    respond(body);
    const { markdown } = await fetchAndConvert(url, bare);

    expect(markdown).toBe('```' + language + '\n' + body + '\n```\n');
  });

  it('returns a page address answered with text/plain as its text, not as one paragraph', async () => {
    // docs.jina.ai answers a non-browser User-Agent with a text/plain document (measured T297);
    // 0.4.25 joined its lines and read its `# ` lines as headings.
    const text = 'You are an AI engineer.\n\n# Core principles\n\n0. Assume the user wants the API.\n1. Keep it short.';
    respond(text);
    const result = await fetchAndConvert('https://www.example.com/', bare);

    expect(result.source).toBe('text-response');
    expect(result.markdown).toBe('```\n' + text + '\n```\n');
  });

  it('turns CRLF into \\n, drops blank lines around the text and keeps the first line\'s indentation', async () => {
    respond('\r\n\r\n    indented first\r\nsecond\rthird\r\n\r\n');
    const { markdown } = await fetchAndConvert('https://example.com/a/settings.cfg', bare);

    expect(markdown).toBe('```ini\n    indented first\nsecond\nthird\n```\n');
  });

  it('returns an empty file as an empty fence', async () => {
    respond('');
    const { markdown, source } = await fetchAndConvert('https://example.com/a/empty.js', bare);

    expect(source).toBe('text-response');
    expect(markdown).toBe('```javascript\n```\n');
  });

  it('writes the frontmatter with extractor_source text-response and the decoded file name as title', async () => {
    respond(JS_FILE);
    const result = await fetchAndConvert('https://example.com/a/my%20grab.js');

    expect(result.title).toBe('my grab.js');
    expect(result.markdown).toContain('title: "my grab.js"');
    expect(result.markdown).toContain('extractor_source: "text-response"');
    expect(result.markdown).toContain('\n```javascript\n' + JS_FILE + '\n```\n');
    expect(result.charCount).toBe(result.markdown.length);
  });

  it('refuses a text/plain body whose first bytes are binary (a mislabelled binary file)', async () => {
    const zip = 'PK' + String.fromCharCode(3, 4, 20, 0) + 'payload';
    respond(zip);
    const call = fetchAndConvert('https://example.com/a/archive.dat', bare);

    await expect(call).rejects.toBeInstanceOf(FetchProtectionError);
    respond(zip);
    await expect(fetchAndConvert('https://example.com/a/archive.dat', bare)).rejects.toThrow(/not text/);
  });

  it('keeps a terminal escape (ESC) in a log: it is not a binary byte', async () => {
    const log = 'build ' + String.fromCharCode(27) + '[32mok' + String.fromCharCode(27) + '[0m';
    respond(log);
    const { markdown } = await fetchAndConvert('https://example.com/a/build.log', bare);

    expect(markdown).toBe('```\n' + log + '\n```\n');
  });
});

describe('P2A-090: what stays as it was', () => {
  it('still converts HTML served as text/plain as HTML (a body that starts with <!doctype or <html>)', async () => {
    respond('<!doctype html><html><head><title>T</title></head><body><main><h1>Title</h1><p>Body text.</p></main></body></html>');
    const result = await fetchAndConvert('https://example.com/owner/repo/main/index.html', bare);

    expect(result.source).toBe('html-parse');
    expect(result.markdown).toContain('# Title');
    expect(result.markdown).toContain('Body text.');
  });

  it('still returns a .txt file served as text/plain as is, without a fence', async () => {
    respond('# Site\n\n- [Docs](https://example.com/docs)\n');
    const result = await fetchAndConvert('https://example.com/llms.txt', bare);

    expect(result.source).toBe('markdown-response');
    expect(result.markdown).toBe('# Site\n\n- [Docs](https://example.com/docs)\n');
  });

  it('still converts a text/html page whatever its address names', async () => {
    respond('<html><body><main><p>From HTML.</p></main></body></html>', 'text/html; charset=utf-8');
    const result = await fetchAndConvert('https://example.com/a/page.js', bare);

    expect(result.source).toBe('html-parse');
    expect(result.markdown.trim()).toBe('From HTML.');
  });
});
