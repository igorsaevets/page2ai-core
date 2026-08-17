# Contributing to @page2ai/core

Thanks for your interest. This is a small, focused library. Contributions that keep it small and focused are the easiest to accept.

## Ground rules

- For extraction-behavior changes, open an issue first with a URL (or a minimal HTML snippet) that shows the problem.
- One change per PR, with a test.
- Runtime dependencies stay minimal (currently `linkedom` and `css.escape`). A new runtime dependency needs a strong case.
- AI-assisted contributions are welcome and must be declared in the PR template. You should understand every line you submit.

## Dev setup

Node 20 or newer.

```bash
npm ci
npm run typecheck
npm test          # vitest, fixtures under tests/
npm run build
```

## What makes an extraction PR easy to accept

1. A failing test first: add a fixture under `tests/` that reproduces the page.
2. The smallest fix that makes it pass.
3. The whole suite stays green, with no fixture regressions.
4. Note in the PR if output on real sites may shift. Changes here propagate to the [browser extension](https://github.com/igorsaevets/page2ai-extension), the [MCP server](https://github.com/igorsaevets/page2ai-mcp) and the [public benchmark](https://github.com/igorsaevets/page2ai-benchmark).

## Releases

The maintainer publishes to npm (`prepublishOnly` runs build and tests). Please do not bump the version in a PR.

## Security

Never report vulnerabilities in public issues. See [SECURITY.md](./SECURITY.md).
