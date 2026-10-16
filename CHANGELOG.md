# Changelog

All notable changes to `@page2ai/core`.

## Unreleased

Output changes on most pages; the extension, the MCP server and the benchmark numbers move with it.
On the 14-page benchmark corpus no word, code fence, table row, heading or list item of the 0.1.11
output is lost, `f_score` stays 0.916, and 9 pages gain text that 0.1.11 dropped. A six-model
review of that change found the defects listed after the first five entries; each was reproduced on
the build before it was fixed, and Markdown claims were checked with a CommonMark parser.

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
