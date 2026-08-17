# Changelog

All notable changes to `@page2ai/core`.

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
