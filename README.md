# @page2ai/core

> Webpage-to-Markdown extraction engine for LLM context (ChatGPT, Claude, Gemini).
> The engine of the [`@page2ai/mcp` server](https://github.com/igorsaevets/page2ai-mcp). The
> [Page2AI Chrome & Firefox extensions](https://github.com/igorsaevets/page2ai-extension) run their own
> pipeline in the browser (see below).
> Preserves code blocks with language hints, tables, and reading structure.
> Zero telemetry, MIT-licensed.

Works in Node.js (via linkedom) and in browsers.

- **Node.js**: `htmlToMarkdown(html, opts)` or `fetchAndConvert(url, opts)` — zero external API calls, uses linkedom for parsing
- **Browser**: exports `BrowserAdapter` and the `PageAdapter` interface; the full extract pipeline lives in the extension repo (a migration is planned)
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
- `opts.includeImages` (boolean) — emit image links (default: `true`). Inside a table cell, a layout table's included, an image is written as its alt text either way, and an image with an empty alt or `aria-hidden="true"` adds nothing
- `opts.includeHidden` (boolean) — also convert content under the HTML `hidden` attribute, which a browser does not show (default: `false`). Tab panels, `hidden="until-found"` sections and React streaming segments are converted either way, and a hidden block that holds code contributes its code blocks and nothing else. Code, link names and tab labels never take text from a hidden element. A `<main>` under `hidden` is not taken as the page's main content while a visible one exists, and one inside a hidden tab panel or `until-found` section never is. The default is not a security boundary: those kept kinds are set by the page's own attributes, so a page can still put text a reader does not see into the output that way, and the converter reads no CSS (`display: none` is converted)

Returns `{ markdown, title, baseUrl, charCount, extractedAt }`. When nothing can be extracted the Markdown says so with `<!-- AI: page has no extractable body content -->` instead of coming back empty.

### `fetchAndConvert(url, opts?)`

Fetches a URL and converts it to Markdown. Async.

- `url` (string) — the URL to fetch
- `opts.timeoutMs` (number) — abort after N ms (default: `15000`)
- `opts.userAgent` (string) — custom user agent (default: `page2ai-core/0.1`)
- ...all `htmlToMarkdown` options

Uses Node 18+ built-in `fetch()`. Follows redirects; passes the final URL to `htmlToMarkdown` as `baseUrl` unless overridden. It requests only the URL you pass: no `<url>.md` twin, no `llms.txt`, and the Accept header is the one Firefox sends when it opens a page (`text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`), so a docs platform that negotiates (Fumadocs, Mintlify, Vercel, Supabase, Stripe, the Claude docs) answers with the page a person sees, not its own Markdown copy, which can be older than the page. A URL whose path names a Markdown or text file (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`, `.txt`) is the page and is returned as is, whether the server sends it as `text/markdown`, `text/x-markdown`, `text/plain` (GitHub raw does) or `application/octet-stream`. Markdown sent for any other address is refused with a `FetchProtectionError`: the request asked for HTML, so that Markdown is the site's copy, not the page. `source` in the result says which way it came (`html-parse` or `markdown-response`), and `includeFrontmatter` applies on both. The body is decoded as UTF-8 whatever charset the server declares, so a page in another encoding comes out garbled.

The fetch refuses anything that is not public, on the URL and on every redirect hop, after DNS resolution: `localhost`, loopback `127.0.0.0/8` and `::1`, `0.0.0.0/8`, private `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local `169.254.0.0/16` (cloud metadata) and `fe80::/10`, CGNAT `100.64.0.0/10` (this includes Tailscale addresses), IPv6 unique-local `fc00::/7`, IPv4-mapped IPv6, the unspecified address `::`, and the hostnames `metadata` and `metadata.google.internal`. So a page on your own intranet or tailnet cannot be fetched this way: fetch the HTML yourself and pass it to `htmlToMarkdown`. `assertSafeUrlResolved(url)` runs the same check without fetching, and `findIpBlockReason(address)` applies its address rule; both are exported.

## What it does

- Parses HTML with [linkedom](https://github.com/WebReflection/linkedom) (fast, browser-DOM-fidelity, no layout engine)
- Places React streaming content first. A page streamed by React (Next.js App Router, Remix, Mintlify) sends a fallback such as "Loading..." where content will go and the content itself later, hidden at the end of the page; the page's own inline scripts (`$RC`, `$RR`, `$RS`) move it into place in a browser. The converter runs no scripts, so it makes those moves itself, in document order, and drops the fallback, only where a browser runs the call: in a classic script (not one with `src`, `nomodule` or a non-JavaScript `type`, not inside `<noscript>` or `<template>`), as a statement of its own, on nodes parsed before that script and on the markup React writes for them. What a script would do when run is not checked: call text in a script that redefines `$RC` still moves a segment. A segment whose boundary is gone is dropped, as React drops it. A hidden segment that no call places stays where it stands: inside the content root it is converted there, outside it is left out. React's external runtime (`<template data-rci>`, an opt-in that no page we sampled uses) is not replayed
- Picks a content root: `<main>` (else `[role="main"]`, else `<body>`), replaced by its largest `<article>` when that article holds at least half of the root's text or is three times larger than every other `<article>`. Text outside the root (beside `<main>`, or beside such an article) is not converted
- Emits: headings (`# `), paragraphs, lists (ordered/unordered, nested), links `[text](url)`, images `![alt](src)`, code blocks (with language tag when detectable), tables (`| a | b |`; a cell spanning columns or rows leaves empty cells, so every value stays under its header; a span ends with its row group, as browsers lay it out, and a table whose spans would cover more than 100,000 cells is written in the plain layout, cells in source order), blockquotes, definition lists (`**term**` then `: definition`), inline formatting (bold, italic, code). Text sitting directly in a `<div>`, `<section>` or `<span>` is kept as its own paragraph, so dashboards and admin pages built from bare `<div>`s convert too
- Converts a layout table, `role="presentation"` or `role="none"` (the role takes the table semantics away; HTML e-mails are built from nested ones), as the blocks in its cells, in source order, not as a Markdown table. A data table inside it stays a table. Only the first token of a `role` list is read
- Leaves out interface buttons. A `<button>` is a control, so its label («Copy page», «Search», a feedback «Yes», a code-sample switcher) is not converted, and neither is an icon-font glyph inside it. A button that holds the page's text is converted: the whole text of a heading or a table cell (an accordion's question, a sortable column's name), a button holding block content or an image that is not `aria-hidden`, a button inside a link or holding one, the term of a definition list or a `role="heading"` element it fills, an accordion's question that stands alone right before its panel, a label that the button's accessible name acts on (`aria-label="Copy command: npx …"` on a button showing the command), a disclosure's label (`aria-expanded` without `aria-haspopup`), a word of a sentence (a tooltip), and the selected tab of a tab list whose panels the converter cannot pair with it (the other tabs name content that is not in the page). The extension labels buttons instead (`[Button: …]`)
- Extracts metadata into YAML frontmatter: `title`, `source`, `captured_at`, `language`, `description`, `canonical`, `og_title`, `og_description`, `author`, `published`, `extractor`, `extractor_version`

## What it does NOT do

- No tab/dropdown expansion (browser-only interactive machinery)
- No lazy-load activation (Node has no runtime images)
- No `<details>` clicking, and none is needed: the body of a closed `<details>` is in the HTML and is converted with the rest of the page
- No computed-style-based visibility filtering (linkedom has no layout engine)
- No badge detection via font weight
- No shadow DOM traversal (linkedom has no shadow DOM support)
- No pseudo-element `::before` / `::after` content

**All the above ship with the Chrome/Firefox extension**, which runs the full `lib/core/*` pipeline against a live browser DOM. See [github.com/igorsaevets/page2ai-extension](https://github.com/igorsaevets/page2ai-extension).

## Roadmap

- **Now** — Node basic renderer, browser adapter interface published; `fetchAndConvert` reads only the page (0.2.0, BL-49)
- **Next** — full port of `lib/core/html-to-md.ts` via PageAdapter, browser entry migrated from extension repo
- **Later** — headless-browser adapter (Playwright or Puppeteer) for React/Vue/SPA rendering, profile auto-detection in Node path, structured-data extraction. A client-rendered page that ships a nearly empty `<div id="root">` in its static HTML produces a graceful fallback error until then; the docs platforms above render on the server and convert today.

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
└── browser/          # BrowserAdapter; extract() comes with the port
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
