// The package root's export surface (P2A-009, reported 2026-10-15 from real use):
// `import { findIpBlockReason } from '@page2ai/core'` failed in 0.1.11 although the function sat in
// the published .d.ts, and a deep import was refused by the `exports` map. 0.1.12 exports it, but
// every test imported the guard by its source path, so removing the export again would have
// passed the whole suite (T121 panel: codex, grokbuild, ocspark13go, agy38flash).
//
// The root entry is src/node/index.ts, built to the file the `exports` map names; both halves of
// that chain are pinned here.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as root from '../../src/node/index.js';

describe('@page2ai/core public API', () => {
  it.each([
    'htmlToMarkdown',
    'fetchAndConvert',
    'assertSafeUrl',
    'assertSafeUrlResolved',
    'findIpBlockReason',
    'fetchProtected',
    'SsrfBlockedError',
    'FetchProtectionError',
    'LinkedomAdapter',
  ])('the package root exports %s', (name) => {
    expect(typeof (root as Record<string, unknown>)[name]).toBe('function');
  });

  it('the root entry blocks the CGNAT range through the exported helper', () => {
    expect(root.findIpBlockReason('100.64.1.1')).not.toBeNull();
    expect(root.findIpBlockReason('93.184.216.34')).toBeNull();
  });

  it('the exports map points "." and "./node" at the build of src/node/index.ts', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports['.'].import).toBe('./dist/node/index.js');
    expect(pkg.exports['./node'].import).toBe('./dist/node/index.js');
    // `npm run build` is `tsc -p tsconfig.build.json`: src/node/index.ts -> dist/node/index.js.
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.build.json');
    const build = readFileSync(new URL('../../tsconfig.build.json', import.meta.url), 'utf8');
    expect(build).toMatch(/"outDir"\s*:\s*"\.\/dist"/);
    expect(build).toMatch(/"rootDir"\s*:\s*"\.\/src"/);
  });
});
