# @page2ai/core

Extract clean Markdown from any web page HTML. Works in Node.js (via linkedom) and in browsers. Powers the [Page2AI extension](https://github.com/igorsaevets/page2ai-extension) and the [`@page2ai/mcp` server](https://github.com/igorsaevets/page2ai-mcp).

- **Node.js**: `htmlToMarkdown(html, opts)` or `fetchAndConvert(url, opts)` — zero external API calls, uses linkedom for parsing
- **Browser**: exports `BrowserAdapter` and the `PageAdapter` interface; the full extract pipeline lives in the extension repo (planned for v0.2 migration)
- **Zero data collection**: no telemetry, no analytics, no third-party calls
- **MIT** licensed

## Install

```bash
npm install @page2ai/core
```

## Quick start

```javascript
import { htmlToMarkdown, fetchAndConvert } from '@page2ai/core';

// From an HTML string
const html = `<article><h1>Hello</h1><p>World</p></article>`;
const { markdown, title, charCount } = htmlToMarkdown(html, {
  baseUrl: 'https://example.com/hello',
  includeFrontmatter: true,
});
console.log(markdown);

// From a URL
const result = await fetchAndConvert('https://docs.anthropic.com/en/api/messages', {
  timeoutMs: 15000,
});
console.log(result.markdown);
```

## API

### `htmlToMarkdown(html, opts?)`

Converts an HTML string to Markdown. Synchronous.

- `html` (string) — the HTML to parse
- `opts.baseUrl` (string) — URL used to resolve relative links (default: `'about:blank'`)
- `opts.profile` (string) — extraction profile: `'auto' | 'docs' | 'marketing' | 'research' | 'dashboard' | 'wordpress-marketing'` (default: `'auto'`, v0.2)
- `opts.includeFrontmatter` (boolean) — emit YAML frontmatter block (default: `true`)
- `opts.includeImages` (boolean) — emit image links (default: `true`)

Returns `{ markdown, title, baseUrl, charCount, extractedAt }`.

### `fetchAndConvert(url, opts?)`

Fetches a URL and converts it to Markdown. Async.

- `url` (string) — the URL to fetch
- `opts.timeoutMs` (number) — abort after N ms (default: `15000`)
- `opts.userAgent` (string) — custom user agent (default: `page2ai-core/0.1`)
- ...all `htmlToMarkdown` options

Uses Node 18+ built-in `fetch()`. Follows redirects; passes the final URL to `htmlToMarkdown` as `baseUrl` unless overridden.

## What it does

- Parses HTML with [linkedom](https://github.com/WebReflection/linkedom) (fast, browser-DOM-fidelity, no layout engine)
- Picks a content root (`main article` > `article` > `main` > `[role="main"]` > `body`)
- Emits: headings (`# `), paragraphs, lists (ordered/unordered, nested), links `[text](url)`, images `![alt](src)`, code blocks (with language tag when detectable), tables (`| a | b |`), blockquotes, inline formatting (bold, italic, code)
- Extracts metadata into YAML frontmatter: `title`, `source`, `captured_at`, `language`, `description`, `canonical`, `og_title`, `og_description`, `author`, `published`, `extractor`, `extractor_version`

## What it does NOT do (v0.1)

- No tab/dropdown expansion (browser-only interactive machinery)
- No lazy-load activation (Node has no runtime images)
- No `<details>` auto-expansion
- No computed-style-based visibility filtering (linkedom has no layout engine)
- No badge detection via font weight
- No shadow DOM traversal (linkedom has no shadow DOM support)
- No pseudo-element `::before` / `::after` content

**All the above ship with the Chrome/Firefox extension**, which runs the full `lib/core/*` pipeline against a live browser DOM. See [github.com/igorsaevets/page2ai-extension](https://github.com/igorsaevets/page2ai-extension).

## Roadmap

- **v0.1** (current) — Node basic renderer, browser adapter interface published
- **v0.2** — full port of `lib/core/html-to-md.ts` via PageAdapter, browser entry migrated from extension repo
- **v0.3** — headless-browser adapter (Playwright or Puppeteer) for React/Vue/SPA rendering, profile auto-detection in Node path, structured-data extraction. Client-rendered pages (e.g. platform.claude.com) that ship a nearly empty `<div id="root">` from static HTML currently produce a graceful fallback error under v0.1 — the SPA adapter in v0.3 will handle them.
- **v0.4** — official-markdown fallback (llms.txt, .md sibling URLs), MDX handling

## Architecture

Two implementations behind a single `PageAdapter` interface:

```
src/
├── shared/           # No DOM assumptions — works with any adapter
│   ├── page-adapter.ts    # PageAdapter interface + defaults + nodeCssEscape
│   ├── utils.ts           # pure helpers (absUrl, escapeMd, etc.)
│   ├── md-postprocess.ts  # pure string transforms
│   ├── types.ts           # all TypeScript interfaces
│   ├── constants.ts       # DEFAULTS, BLOCK_TAGS, PII patterns
│   └── profiles.ts        # profile presets
├── node/             # LinkedomAdapter + htmlToMarkdown + basic-renderer
│   ├── index.ts
│   ├── linkedom-adapter.ts
│   └── basic-renderer.ts
└── browser/          # BrowserAdapter (v0.1) + extract() (v0.2)
    ├── index.ts
    └── browser-adapter.ts
```

## Development

```bash
git clone https://github.com/igorsaevets/page2ai-core
cd page2ai-core
npm install
npm run build     # tsc → dist/
npm test          # vitest
npm run typecheck # tsc --noEmit
```

## Related

- [Page2AI Chrome extension](https://github.com/igorsaevets/page2ai-extension) — the human-facing browser extension
- [`@page2ai/mcp`](https://github.com/igorsaevets/page2ai-mcp) — MCP server for Claude Desktop, Cursor, Windsurf, Zed
- [Software Heritage archive](https://archive.softwareheritage.org/) — SWHID `swh:1:snp:05123c51ef9e7c0aeb06f42b1263c07a8d26999a`

## License

MIT — Copyright (c) 2026 Igor Saevets. See [LICENSE](./LICENSE).
