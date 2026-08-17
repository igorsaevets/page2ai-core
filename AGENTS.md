# AGENTS.md

Instructions for AI coding agents working in this repository. Humans: see [CONTRIBUTING.md](./CONTRIBUTING.md).

## What this is

`@page2ai/core`: HTML to Markdown extraction library. Two adapters over one shared pipeline: `src/node/` (linkedom) and `src/browser/` (native DOM). Shared logic lives in `src/shared/`.

## Commands

- Install: `npm ci`
- Typecheck: `npm run typecheck`
- Test: `npm test` (vitest; fixtures under `tests/`)
- Build: `npm run build`

Run typecheck plus the full test suite before proposing any change. All must pass.

## Constraints

- Do not add runtime dependencies. The only runtime dependencies are `linkedom` and `css.escape`.
- Extraction-behavior changes need a fixture test that fails before the change and passes after it.
- Keep `src/shared/` platform-neutral: no `window`, no Node builtins there.
- Do not bump the package version; the maintainer releases.
- Output changes ripple into the browser extension, the MCP server and the published benchmark numbers. Say so in the PR description whenever output can shift.

## Gotchas

- Content-root selection has hard-won rules for `<article>` handling (real articles hold most of their container's text; card grids do not). Read `tests/node/content-root.test.ts` before touching it.
- The benchmark repo (`igorsaevets/page2ai-benchmark`) is the ground truth for regressions on real pages.
