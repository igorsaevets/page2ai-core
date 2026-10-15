# @page2ai/core

> Webpage-to-Markdown extraction engine for LLM context (ChatGPT, Claude, Gemini).
> Same engine that powers the [Page2AI Chrome & Firefox extensions](https://github.com/igorsaevets/page2ai-extension)
> and the [`@page2ai/mcp` server](https://github.com/igorsaevets/page2ai-mcp).
> Preserves code blocks with language hints, tables, and reading structure.
> Zero telemetry, MIT-licensed.

Works in Node.js (via linkedom) and in browsers.

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

- `html` (string) — the HTML to parse: a whole document or a fragment (an HTMX partial, a template snippet, plain text)
- `opts.baseUrl` (string) — URL used to resolve relative links (default: `'about:blank'`)
- `opts.profile` (string) — accepted, but **ignored by the Node build in this version**: `'dashboard'`, `'marketing'` and the rest produce the same output here. The profiles switch the browser extension's live-page pipeline (clicking tabs, waiting for lazy content), which the Node renderer does not run
- `opts.includeFrontmatter` (boolean) — emit YAML frontmatter block (default: `true`)
- `opts.includeImages` (boolean) — emit image links (default: `true`)

Returns `{ markdown, title, baseUrl, charCount, extractedAt }`. When nothing can be extracted the Markdown says so with `<!-- AI: page has no extractable body content -->` instead of coming back empty.

### `fetchAndConvert(url, opts?)`

Fetches a URL and converts it to Markdown. Async.

- `url` (string) — the URL to fetch
- `opts.timeoutMs` (number) — abort after N ms (default: `15000`)
- `opts.userAgent` (string) — custom user agent (default: `page2ai-core/0.1`)
- ...all `htmlToMarkdown` options

Uses Node 18+ built-in `fetch()`. Follows redirects; passes the final URL to `htmlToMarkdown` as `baseUrl` unless overridden.

The fetch refuses anything that is not public, on the URL and on every redirect hop, after DNS resolution: `localhost`, loopback `127.0.0.0/8` and `::1`, `0.0.0.0/8`, private `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local `169.254.0.0/16` (cloud metadata) and `fe80::`, CGNAT `100.64.0.0/10` (this includes Tailscale addresses), IPv6 unique-local `fc00::/7`, IPv4-mapped IPv6, and `metadata.google.internal`. So a page on your own intranet or tailnet cannot be fetched this way: fetch the HTML yourself and pass it to `htmlToMarkdown`. `assertSafeUrlResolved(url)` runs the same check without fetching, and `findIpBlockReason(address)` applies its address rule; both are exported.

## What it does

- Parses HTML with [linkedom](https://github.com/WebReflection/linkedom) (fast, browser-DOM-fidelity, no layout engine)
- Picks a content root (`main article` > `article` > `main` > `[role="main"]` > `body`)
- Emits: headings (`# `), paragraphs, lists (ordered/unordered, nested), links `[text](url)`, images `![alt](src)`, code blocks (with language tag when detectable), tables (`| a | b |`), blockquotes, definition lists (`**term**` then `: definition`), inline formatting (bold, italic, code). Text sitting directly in a `<div>`, `<section>` or `<span>` is kept as its own paragraph, so dashboards and admin pages built from bare `<div>`s convert too
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


## Build provenance

Releases from v0.1.1 onward are published from GitHub Actions with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements). Each published
version carries a Sigstore attestation recording which commit and which workflow run produced
the tarball, logged in the public Rekor transparency ledger. npmjs.com shows a provenance badge
next to the version, linking to both.

Verify it yourself, without trusting this README:

```bash
npm audit signatures
npm view @page2ai/core --json | jq '.dist.attestations'
```

The point is that the link between the source you can read and the artifact you install is
checkable by a third party rather than asserted here.

## License

MIT — Copyright (c) 2026 Igor Saevets. See [LICENSE](./LICENSE).
