import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_VERSION } from '../../src/shared/constants.js';
import { DEFAULT_UA } from '../../src/node/fetch-protected.js';

describe('version sync', () => {
  it('CORE_VERSION matches package.json (npm version only bumps the latter)', () => {
    // Regression: 0.1.9 shipped with CORE_VERSION still '0.1.8', so every
    // frontmatter mislabeled the extractor — seen live in ChatGPT output.
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    );
    expect(CORE_VERSION).toBe(pkg.version);
  });

  it('DEFAULT_UA contains the current CORE_VERSION, not a stale literal', () => {
    // Regression: the UA was hardcoded as 'page2ai-core/0.1' while the package
    // was at 0.4.0 — every HTTP request identified the wrong version.
    expect(DEFAULT_UA).toContain(`page2ai-core/${CORE_VERSION}`);
    expect(DEFAULT_UA).not.toContain('page2ai-core/0.1 ');
  });
});
