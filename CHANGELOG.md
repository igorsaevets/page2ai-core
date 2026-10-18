# Changelog

All notable changes to `@page2ai/core`.

## 0.3.0 - 2026-10-18

SSRF guard hardening (BL-22): closes the DNS rebinding window on the public endpoint and extends
the IP blocklists to cover every range the T99 audit flagged. `htmlToMarkdown` is unchanged;
`fetchProtected` is the only affected entry point.

### Security

- **DNS pinning:** `fetchProtected` now resolves DNS once, validates every returned address, and
  pins the TCP connection to those addresses via an undici `Agent`. Previously, Node's `fetch()`
  re-resolved the hostname independently, so a DNS record that flipped between the guard's lookup
  and the connect (DNS rebinding) could reach an internal address. The check-then-connect window
  is closed.
- **Extended IPv4 blocklist:** multicast (224.0.0.0/4), reserved/broadcast (240.0.0.0/4),
  TEST-NET-1/2/3 (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), benchmarking (198.18.0.0/15),
  IETF Protocol Assignments (192.0.0.0/24), deprecated 6to4 relay anycast (192.88.99.0/24).
- **Extended IPv6 blocklist:** NAT64 well-known and local-use (64:ff9b::/96, 64:ff9b:1::/48),
  6to4 (2002::/16), documentation (2001:db8::/32), Teredo (2001::/32), discard-only (100::/64).

### Added

- `undici` is now a runtime dependency (zero transitive dependencies).
- `resolveAndValidate(hostname, rawUrl)` is exported from `ssrf-guard` for callers that need the
  validated addresses (e.g. to build their own pinned dispatcher).

## 0.2.2 - 2026-10-17

Only the Node renderer's button rule changes, so `htmlToMarkdown` and `fetchAndConvert` change the same way. A review
of the 0.2.1 rule (P2A-019) by three external models, each shape run on npm 0.2.0, 0.2.1 and a build that drops every
button. The 53-page corpus converts as in 0.2.1, byte for byte apart from `extractor_version`, with default options,
`includeImages: false` and `includeHidden: true`.

- Fixed: a page with thousands of sibling buttons took seconds: every button scanned its whole run of siblings, so
  3,000 buttons in one paragraph took 4 to 5 s (0.2.0: about 30 ms). The run is now computed once per container.
- Fixed: 0.2.1 dropped the text of buttons that hold it: an accordion question with neither `aria-expanded` nor a heading
  (`<button>Question?</button><div><p>Answer.</p></div>`, also in a list item), a definition term, a question under
  `role="heading"`, a link written inside a button, and a command whose button is named "Copy command: <the command>".
- Fixed: a custom element is a block unless its container has text of its own, as the converter already renders it,
  so a card's action row (`<mat-card-actions><button>LIKE</button>`) no longer counts the card's text as its sentence.
- Still dropped, as in 0.2.1: buttons with no text of the page around them that hold options, cards or a value in a
  `<span>` or `<div>` (sizes, quiz answers, chapter lists, card grids), a question in a wrapper of its own before the
  answer, a title button beside a heading's link, and a copy-the-command button that carries its command only as its
  own text: the neon.com page named in 0.2.1 still loses `npx neon@latest init`.

## 0.2.1 - 2026-10-17

Only the Node renderer changes, in how it treats `<button>`, so `htmlToMarkdown` and `fetchAndConvert` change the
same way. Measured on npm 0.2.0 against this release's code with default options, `includeImages: false` and
`includeHidden: true`; each changed line was read.

### Fixed

- **Interface buttons no longer print as paragraphs** (P2A-019). Since 0.2.0 converts the pages of Mintlify, Vercel and the Claude docs, their output carried the header's «Copy page» twice, the code-sample switcher («cURL CLI Python TypeScript C# Go Java PHP Ruby») and icon-font glyphs. A `<button>` is now treated as a control: its label is left out, and so is an `aria-hidden` icon inside a button that is kept. A button stays when it holds the page's text: all the text of a heading or a table cell (an accordion's question, a sortable column's name), block content or an image that is not `aria-hidden` (a zoomable image, a video card), a link around it, a disclosure's label (`aria-expanded` without `aria-haspopup`: a changelog's «Fixes» above its list), a word of a sentence (a tooltip), and the selected tab of a tab list whose panels the converter cannot pair with it. Measured on 53 saved pages (the 21-page corpus, 17 server snapshots of docs sites, 15 pages saved from live sites on 2026-10-17 and 2026-10-18): 34 change, 399 lines go out and 114 come in (a heading without its glyph, «Python» for the tab strip); every heading and code block stays, and the private-use glyphs fall from 153 to 24 (the 24 left are outside buttons: breadcrumb separators and callout icons on the Claude docs). A build that dropped every button lost 27 headings, a table column's name, a word of a sentence and a changelog's section labels; this one keeps them. Known cost: a copy-the-command widget that shows its command in a `<span>` inside the button (neon.com) loses the command.

## 0.2.0 - 2026-10-17

`htmlToMarkdown` is unchanged: on the 21 corpus pages its output is byte-identical to 0.1.13. What
changes is what `fetchAndConvert` reads, measured live on 2026-10-17 with npm 0.1.13 against this
release's code. On seven documentation platforms (Fumadocs, Mintlify, Vercel, Supabase, Cloudflare,
Stripe, the Claude docs) 0.1.13 returned the site's `.md` copy of the page and 0.2.0 converts the
page itself, 1,301 to 57,887 characters. Every heading and code block of those copies is in the
0.2.0 output, except a «Related pages» list on Vercel, an «On this page» list and the page's JSON-LD
on Cloudflare, and the `[#anchor]` suffixes of Fumadocs headings.
On the Claude docs the copy was 160,435 characters with 36 headings and 6 code blocks; the page
gives 57,887 with 59 and 20. A `README.md` from raw.githubusercontent.com now comes back as the file,
11,408 of 11,408 characters (0.1.13: 3,468 characters, no heading), and an `llms.txt` you name keeps
its 235 lines.

### Changed (breaking)

- **`fetchAndConvert` reads only the page you name** (BL-49). It no longer asks for `<url>.md` first, and its Accept header is now the one Firefox sends when it opens a page, `text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`: no `text/markdown` and no `text/plain`, because servers match those words and ignore q-values (measured 2026-10-17: `text/html,text/markdown;q=0` still got Markdown from platform.claude.com, and `text/html,text/plain` got it from fumadocs.dev). Fumadocs, Mintlify, Vercel, Supabase, Stripe and the Claude docs now answer with the HTML page instead of their own Markdown copy, which can be older than the page, and the output on those sites is converted from the page. Content shown only to agents (Mintlify `<Visibility for="agents">`) is no longer there, and what the page shows people is.
- **Markdown sent for a page address is refused** with `FetchProtectionError` ("the server answered with Markdown ... for a page address"). The request asks for HTML as a browser does, so a server that still answers Markdown chose its copy by something else (User-Agent, a cache). 0.1.13 returned it as the page.
- `FetchAndConvertOptions.tryMdSuffixFirst` is removed; a value passed anyway is ignored (TypeScript reports it on an object literal).
- The official-Markdown settings are gone from the shared exports (`@page2ai/core/shared/types`, `@page2ai/core/shared/profiles`): `OfficialMarkdownMode`, `OfficialMarkdownResult`, the `ExtractorConfig` fields `officialMarkdownMode`, `trustedOfficialMarkdownHosts` and `officialMarkdownMinRatio` (and so the profiles' `officialMarkdownMode`), the `ExtractStatus` value `'official-md'`, and `ExtractResult.officialMarkdownUrl` and `officialMarkdownRatio`. No code in core read them; they described the extension's own lookup, which its next release removes too.
- `ConversionResult.source` is `'html-parse' | 'markdown-response'`: `'md-suffix'` and `'content-negotiation'` are gone, and so is `'llms-txt'`, which nothing ever returned. The frontmatter of a Markdown response says `extractor_source: "markdown-response"`.

### Fixed

- **A Markdown or text file comes back as written.** A URL whose path names a Markdown or text file (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`, `.txt`) is returned as is whether it is served as `text/markdown`, `text/x-markdown`, `text/plain` or `application/octet-stream`. In 0.1.13 a `README.md` from raw.githubusercontent.com (`text/plain`) went through the HTML parser and came out as one line that began in the middle of the file, with no heading and no code block: 3,035 characters of 10,940. An `llms.txt` you named lost its line breaks, and `text/x-markdown` and `application/octet-stream` were refused. A body with a NUL byte is refused as not text.

## 0.1.13 - 2026-10-16

Output changes on 4 of the 21 corpus pages, measured on npm 0.1.12 against the release build with
default options, `includeImages: false` and `includeHidden: true`; each change was read and each is
one of the fixes below. On the 14-page benchmark corpus `f_score` moves from 0.916 to 0.933 and
`f_prose` from 0.842 to 0.859, all of it on one page, Anthropic's extended-thinking docs
(docs.anthropic.com, which redirects to platform.claude.com; 0.000 to 0.233). That
page's ground truth was made by a static pass that never saw its article and counts the article's
text as boilerplate, so the score understates the change. No code block, table, heading or list
item of the 0.1.12 output is lost. The words that go are 16 `Loading...` placeholders, Emotion CSS
that a `<style>` put inside a docs.sentry.io code block, and `cd my-websitenpx`, two Docusaurus
code lines that 0.1.12 printed as one.

### Fixed

- **React streaming pages print the article instead of its loading placeholder** (#31, #32). React
  streaming SSR (Next.js App Router, Remix, Mintlify) sends a Suspense fallback where late content
  goes, then the content, hidden at the end of `<body>`, with an inline `$RC("B:0","S:0")` that
  moves it into place. The converter runs no scripts, so the root printed the fallback: the
  Anthropic page gave 212 characters of `Loading...` for a 12,270-character article. The
  `$RC`, `$RR` and `$RS` calls are now replayed in document order before the root is picked, and
  only where a browser runs them: in a classic inline script (no `src`, `nomodule`, module, JSON or
  text type, nothing inside `<template>` or `<noscript>`), at a statement start, on a segment,
  boundary and placeholder parsed before the script, on React's own segment wrappers. `$RX` keeps
  the fallback, and a segment whose boundary is gone is dropped, as React drops it. Chromium,
  running only each saved page's inline scripts, gave the converter the same page as the replay,
  byte for byte, on 8 of 8 streaming pages; 25 of 28 adversarial cases from a review equal the
  browser, and the other 3 redefine or omit `$RC` (see the README). A page with 16,000 calls
  converts in 0.12 s.
- **Hidden text no longer reaches the output through code, link names or the content root**
  (#29, #30). On 0.1.12 a link whose content rendered empty took its name from `textContent`,
  hidden spans included; inline code and code blocks read `textContent` too, so a hidden span or a
  `<style>` inside code printed (two lines of Emotion CSS on the docs.sentry.io corpus page); a
  hidden `<main>` became the root and printed its whole text; a hidden block kept for its `<pre>`
  printed all its prose. Code, link names and tab labels now take no text from a hidden element of
  any kind, nor from `<style>`, `<noscript>`, `<canvas>` fallbacks or SVG `<defs>` / `<desc>`, and
  `<br hidden>` breaks no line. The root is the first `<main>` under no `hidden` (one inside a
  React segment only when there is no other, never one in a hidden tab panel or an `until-found`
  section). A hidden block that holds code gives its code blocks and no prose, and a tab panel
  outside the root is not printed. A hidden block is kept as a React streaming segment only when
  it is one, React's wrapper with an id ending in `S:` and a hex number: `S:evil` and
  `<img hidden id="S:0">` no longer pass.
- **Table cells stay under their headers** (#29, #30). `colspan` and `rowspan` are laid out as the
  HTML table model lays them out, so the cells after a span keep their columns; a span ends with
  its row group and `rowspan="0"` spans the rest of it; columns where no cell starts are dropped
  (`colspan="100"` adds no empty columns); past a budget of covered slots the plain layout is used.
  An empty cell under a header row keeps its place in a nested table.
- **Line breaks in code survive** (#29). A `<br>` in code is a line break: every Docusaurus code
  block ends each line with a `<br>` and no newline, so `cd my-website` and `npx docusaurus start`
  printed as one line. A `<pre>` in a table cell keeps its lines, one code span per line (8 cells
  on the Wikipedia corpus page). A `<br>` in a heading is a space.
- **An image in a table cell is written as its alt text** (#29), which also names an image-only
  link there; 0.1.12 left such a cell empty (2 cells on the Wikipedia corpus page). An image with
  `aria-hidden="true"` adds nothing to its cell.
- **`fetchAndConvert` honours `includeFrontmatter: false` on its Markdown fast paths** (#26). The
  `.md`-suffix and `text/markdown` paths prepended the frontmatter whatever the option said and
  counted only the body (`charCount` 144 for a 336-character result), so the MCP server's
  `include_frontmatter: false` was ignored on every docs site that answers `text/markdown`. Both
  paths now honour the option and count the returned Markdown, as `htmlToMarkdown` does.

### Docs

- README: what `includeImages` does in a table cell; what `includeHidden` converts either way, and
  that the default is not a security boundary (a page's own attributes decide the kept kinds, and
  no CSS is read); `tryMdSuffixFirst`; the `text/markdown` pass-through; how React streaming
  content is placed and when a page keeps its fallback; the content-root rule as the code applies
  it; spanning cells; a closed `<details>` needs no clicking.

### Tests

- The package root's exports and its `exports` map are pinned (P2A-009), and the P2A-001 key/value
  grid is pinned exactly. The streaming tests run React 19.2.0's and React 18's own inline
  runtimes; 14 of 14 rule mutations fail a test.

## 0.1.12 - 2026-10-16

Output changes on most pages; the extension, the MCP server and the benchmark numbers move with it.
On the 14-page benchmark corpus `f_score` stays 0.916 and no code block, table or heading of the
0.1.11 output is lost. The words that go are `<br>` markup 0.1.11 left in table cells; the one list
item that goes (MDN) was a `*` in the page's text, now escaped. On 7 more pages the other words that
go are CSS from `<style>` elements inside Wikipedia's table cells and letter-spaced text now joined
into its word (`a d v e r t i s e m e n t s`). A six-model review of the first change found the
defects listed after the first five entries; each was reproduced on the build before it was fixed,
and Markdown claims were checked with a CommonMark parser.

### Fixed

- **Text outside a recognised block tag is no longer dropped.** The Node renderer walked element
  children only, so text sitting directly in a `<div>`, `<section>`, `<span>` or `<blockquote>`,
  beside a `<br>`, or in a `<dt>`, `<figcaption>` or `<summary>` vanished while every heading and
  table survived: on a server-rendered admin page 25 of 26 key/value labels and 10 of 12 metric
  tiles were missing. Such text now renders as its own paragraph. A row of links or images with no
  text between them still renders one per line, as before.
- **`<dl>` renders as definition-list Markdown** (`**term**`, then `: definition`), the format the
  extension uses. A `<dd>` that holds blocks (paragraphs, code, tables, as in every Sphinx API
  entry) is walked, not flattened. A `<dl>` with no `<dt>`/`<dd>` is treated as a plain container.
- **Entities inside words no longer split them.** linkedom yields `account&#39;s` as three text
  nodes and the inline renderer joined parts with a space, giving `account ' s`; the same broke
  `AT&amp;T`, `caf&eacute;` and every quote entity. Inline parts now keep the source's whitespace,
  which also removes the space before punctuation after a link (`[docs](url) .`). Emphasis moves
  its edge whitespace outside the delimiters.
- **HTML fragments convert.** Input without `<html>` (an HTMX partial, `<h1>T</h1><p>x</p>`, a
  snippet starting with `<style>`) came back as an empty string, and plain text or `""` came back
  as "extraction failed" with a linkedom TypeError. Such input is now parsed inside an html/body
  shell.
- An empty extraction now says `<!-- AI: page has no extractable body content -->` instead of
  returning nothing.
- **A `<dl>` no longer drops its other children.** With any `<dt>`/`<dd>` present, a note, heading
  or bare text inside the list vanished, text 0.1.11 had printed. It now renders in place.
- **Page text that looks like Markdown stays text.** A line starting with `#`, `>`, `1.`, `-`,
  `---`, `<tag` or a code fence became that block; an unclosed fence in a `<div>` put the rest of
  the page inside a code block. Such line starts are escaped.
- **Adjacent elements are no longer spaced inside a token.** `$`+`19.99`, `19`+`.99`,
  `user`+`@x.test` and CJK characters came out as `$ 19.99`, `19 .99`, `user @x.test`, `東 京`.
  Words in a flex row (`Plan`+`starter`) still get their space.
- **Markup glued to text parses as written.** `Hey!` before a link made an image, a backslash before
  one broke it, and bold ending in punctuation before a letter (`**Note:**text`) was literal stars.
- **Link text is Markdown.** Code, bold and images inside a link were escaped into literal
  backticks, stars and brackets (`[\`x\`](u)`), which also put backslashes into image URLs; only the
  brackets and backslashes of the link's own text are escaped now.
- **Code spans holding a backtick** use a longer fence (`` ``a`b`` ``) instead of closing early.
- **Table cells**: template indentation no longer becomes `<br>` in every cell, `a<br>b` and two
  `<div>` lines no longer glue into one word, `<script>` and icon `<title>` text stay out, and the
  `<caption>` is printed.
- A custom element between words (`<relative-time>`) stays in its sentence; a tab panel nested in a
  `<span>` prints once; `aria-hidden="True"` is honoured like `"true"`; an icon's `<svg><title>` is
  no longer taken for the page title; a fragment with `<body>` in the middle keeps the text before it.
- **SSRF guard: link-local is `fe80::/10`.** Only the `fe80:` prefix was blocked, so `fe90::1`
  through `febf::` passed.
- **Blocks inside a list item stay in the item.** A code block, table, `<dl>`, quote or paragraph
  group inside an `<li>` started at column 0 after a blank line, which ends the list in CommonMark:
  the command of every numbered "1. Install:" step left its step and the numbering restarted, an
  item that starts with a block printed a bare `-` and a blank line (an empty item), list items
  after a callout became an indented code block, and text above a nested item that starts with a
  block turned into a `##` heading. Each item now indents what it holds under its marker, a block
  that opens the item goes on the marker line (`- ```js`), and a list nests under `10.` and later
  (four spaces). Checked with micromark 4 + GFM: on 7 step-by-step pages (GitHub, Docker,
  Kubernetes, ArchWiki docs among them) 81 code blocks are back inside their steps and no code
  text or word changed; of the 14 benchmark pages only python-docs changes (5 code blocks).
- **Link destinations with an unpaired `(` or `)`** are percent-encoded (`https://x.test/a)b` ended
  the link after `a`, an image with such a `src` did not render at all); only the unpaired
  parenthesis is encoded, so `/wiki/Foo_(bar)` stays as written even with a stray `)` later in the
  URL. ASCII control characters in a destination that cannot be resolved are encoded too.
- **Text after a stray `</body>` or `</html>` is kept**, as a browser keeps it: what linkedom leaves
  beside `<body>` or `<html>` is moved into the body after parsing. The same characters inside a
  `<title>` or `<xmp>` stay text.
- **Paragraphs inside a list item stay separate.** `<li><p>A</p><p>B</p></li>` printed `- A` and
  `   B` with no blank line, which a parser reads as one paragraph "A B"; text before or after a
  `<p>` in an item was joined the same way. On 21 pages 4 change, by blank lines only.
- **A rule that opens a bulleted item** printed `- ---`, which is a thematic break, so the item's
  content left the list; it is written `- ***`. A block after a nested list in the same item (a
  figure, for one) is separated by a blank line instead of joining that list's last item. Both
  checked on GitHub's renderer and pandoc.
- **A table nested in a cell stays in that cell.** The outer table took every descendant row and
  cell, so the inner rows came out again as outer rows and the row holding the inner table widened by
  its cells: a 2-column table became 5 columns, one row printed the inner text twice. The inner table
  now becomes lines of its cell, `k: v<br>k2: v2` for header/value rows, ` · ` between other cells.
  A nested table's `<caption>` no longer becomes the outer table's caption.
- **Table cells keep their links, code and emphasis.** A cell was plain text, so every row of a users
  list lost its link and API tables lost their code formatting (`flex-<number>` even read as an HTML
  tag). Cells now render inline Markdown like a paragraph, `|` escaped as `\|`; images stay out of
  cells and adjacent elements get no added space, as before. On the benchmark corpus 3 pages gain
  links and code in cells, `f_score` is unchanged.

### Changed

- **Content under the `hidden` attribute is left out**, as a browser and the extension leave it out
  (a details-on-demand grid printed all 30 closed detail rows; hidden text is also a way to put
  instructions in front of a model that the person reading the page never sees). Kept: tab panels,
  `hidden="until-found"` sections, hidden blocks holding code (unmarked code tabs such as the yarn and
  pnpm variants on docs.sentry.io), and React streaming segments (`<div hidden id="S:0">`). A hidden
  list item takes no number. `includeHidden: true` restores the old behaviour. On the 21-page corpus
  no page changes from this rule.

- **Two changes a downstream Markdown renderer can show.** A code block inside a list item now stays
  in the item, indented under it; Python-Markdown (MkDocs without SuperFences) renders such a fence
  as inline code, because its `fenced_code` extension works only at the document root (0.1.11 put
  the fence outside the list). An `<li>` whose only block renders empty is left out instead of
  printed as an empty item, so a renderer numbers the items after it one lower; the Markdown keeps
  the source numbers.

- `<select>`, `<datalist>`, `<textarea>`, `<iframe>`, `<object>`, `<embed>`, `<audio>` and
  `<video>` are skipped: option lists and "your browser does not support" fallbacks are not page
  text. Elements that render empty no longer fall back to their raw `textContent` (except a link's
  name), which had let script, style and SVG title text into paragraphs.

### Added

- `assertSafeUrlResolved` and `findIpBlockReason` are exported: the exact check `fetchAndConvert`
  runs on a URL and on each redirect hop, so a caller can learn before fetching whether a URL will
  be refused. Both were already in the published type declarations without being importable.

### Docs

- README: `profile` is accepted but ignored by the Node build in this version; the fetch's blocked
  address ranges are listed, CGNAT `100.64.0.0/10` (Tailscale) included.

## 0.1.11 - 2026-10-11

### Changed

- **Releases are published through npm trusted publishing (OIDC).** The
  publish workflow no longer reads a stored npm token: npm trusts
  `.github/workflows/publish.yml` of this repository, exchanges the job's
  GitHub OIDC token for a short-lived publish token, and records GitHub
  Actions as the publisher. A post-publish step fails the release when the
  registry shows any other publisher. Provenance attestations continue as
  before.
- README header leads with the LLM context use case (ChatGPT, Claude,
  Gemini) and names the extraction features.

Extraction is unchanged; only the `extractor_version` reported in
frontmatter moves to 0.1.11.

## 0.1.10 - 2026-08-30

### Fixed

- **Frontmatter `extractor_version` said 0.1.8 on the 0.1.9 release.**
  `CORE_VERSION` in `src/shared/constants.ts` is a hand-bumped literal and the
  0.1.9 release bumped only `package.json` — seen live in ChatGPT connector
  output. Synced, and a new `version-sync` test fails the suite whenever the
  constant and `package.json` disagree, so this class of drift cannot ship
  again.

## 0.1.9 - 2026-08-30

### Fixed

- **`includeImages: false` leaked images in inline positions.** The block-level
  `<img>` branch honored the option, but the inline renderer — an image inside
  a list item, table cell or link — emitted `![…](…)` unconditionally, so
  pages whose images sit in linked or list contexts (MDN diagrams, Wikipedia
  portal bars) kept some or all of them. Found by running the hosted-endpoint
  submission test cases against production: on one MDN page the option changed
  nothing (5 images in both arms, byte-identical output). Both branches now
  share the same `includeImages` contract; regression test covers both
  positions.

## 0.1.8 - 2026-08-30

### Fixed

- **Duplicate H1 when the page's own `<h1>` equals the document title** (#9).
  The renderer emits a title-derived heading, then walked the DOM and rendered
  the page's identical `<h1>` again — the most common page shape there is.
  The first heading the walk meets is now skipped when it normalizes to the
  same string as the title (case, punctuation and anchor-link glyphs ignored);
  the dedupe window closes at that first heading, so an identical heading
  later in the page is treated as content and always renders. Matching runs
  against the suffix-stripped title, so `<title>Page - Site</title>` pages
  dedupe correctly too.

  Benchmark A/B over the 14-page v2 corpus (published 0.1.7 vs this fix, same
  cached bytes, all six tools re-run): 11 pages each lost exactly the one
  duplicate heading line and nothing else; every recall / leak / f-score
  metric unchanged to 4 decimals; the other five tools' outputs byte-identical
  between arms. Only `bytes_out` (smaller) and `compression` in the 4th
  decimal moved, on exactly the 11 affected pages.

## 0.1.7 - 2026-08-17

Packaging-only release; extraction output is byte-identical to 0.1.6.
(This entry was added retroactively in 0.1.8 — the 0.1.7 release shipped
without a changelog section.)

### Removed

- `src/shared/md-postprocess.ts` and its test: fixed in 0.1.6 but never wired
  into any product path (not exported, not imported). Panel verdict was
  unanimous — strip or wire. The extension keeps its own, used copy.

### Changed

- CODE_OF_CONDUCT enforcement contact routed through the GitHub handle
  instead of a personal email address.

## 0.1.6 - 2026-08-17

Security and correctness release driven by a full code audit. Extraction output
on the benchmark corpus is byte-identical to 0.1.5 (verified over all 14 stored
pages before release), so published benchmark numbers still apply.

### Security

- **SSRF guard now resolves DNS.** `assertSafeUrlResolved` looks up the
  hostname and rejects the request when ANY resolved address is loopback,
  private, link-local, CGNAT or a metadata endpoint. Previously only IP-literal
  hosts were checked, so a public name pointing at `127.0.0.1` or
  `169.254.169.254` passed the guard.
- **Redirects are now followed manually** (max 10 hops) and every hop is
  validated (string checks + DNS) BEFORE it is requested. Previously
  `redirect: 'follow'` delivered the request to a redirect target first and
  validated after, so a public page redirecting into an internal address was
  actually fetched; and a redirect chain ending on the original URL skipped the
  check entirely.
- **Trailing-dot hostnames are normalized** before the blocklist check.
  `metadata.google.internal.` (with the FQDN dot) previously bypassed the
  hostname blocklist.
- Remaining, documented limitation: the check-then-connect window. `fetch()`
  re-resolves the name itself, so a DNS record that flips between our lookup
  and the connect can still reach an internal address. Closing it needs a
  pinned-IP dispatcher (undici as a runtime dependency), declined for now.

### Fixed

- `detectProfile` / `resolveConfig` (public `./shared/profiles` export) no
  longer throw `ReferenceError` in Node: the old default parameters read the
  bare `document` / `location` globals. With no DOM available they now fall
  back to the `marketing` profile.
- Tab discovery: `aria-labelledby` on `data-state` tab panels is an IDREF and
  is now dereferenced to the labelling element's text. Previously the raw id
  (`tab-panel-3-label`) was emitted as the visible `Tab:` heading.
- Markdown post-processing link regexes no longer cut URLs at an inner `)`:
  Wikipedia-style `/Foo_(bar)` URLs survive `dedupeAdjacentLinks`,
  `compactLinkLabels` and `aggressiveCleanup` intact. The old capture corrupted
  the output (stray `)` fragments) and failed to dedupe such links.
  (These functions are not yet wired into the default pipeline; the fix
  matters for direct callers and for v0.2.)

### Tests

- 17 -> 37 tests: new suites for the SSRF guard (DNS layer mocked, redirect
  hops, fail-closed on resolver errors), parenthesised-URL post-processing,
  DOM-less profiles, and aria-labelledby tab labels. A stale test comment
  claiming anchors are not resolved against `baseUrl` was corrected (they are,
  and the test now asserts it).

## 0.1.5 - 2026-08-03

- List-item document order, site-suffix title cleanup, wide language-label
  detection.

## 0.1.4 - 2026-08-02

- Content-root selection: an `<article>` wins only if it holds at least half
  of its container's text or dwarfs every sibling `<article>` 3x. Fixes
  card-grid pages (Astro, Starlight, Cloudflare blog) extracting a ~200-char
  card instead of the page content.

## 0.1.3 - 2026-08-02

- Content-negotiation fixes from the T53 defect sweep.

## 0.1.2 - 2026-08-02

- Extraction defect fixes on real AI-docs pages.

## 0.1.1 - 2026-07-27

- First public release: Node (linkedom) + browser adapters, basic renderer,
  static tab discovery, SSRF-guarded `fetchAndConvert`.
