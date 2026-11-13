// The package root's export surface (P2A-009, reported 2026-10-15 from real use):
// `import { findIpBlockReason } from '@page2ai/core'` failed in 0.1.11 although the function sat in
// the published .d.ts, and a deep import was refused by the `exports` map. 0.1.12 exports it, but
// every test imported the guard by its source path, so removing the export again would have
// passed the whole suite (T121 panel: codex, grokbuild, ocspark13go, agy38flash).
//
// The root entry is src/node/index.ts, built to the file the `exports` map names; both halves of
// that chain are pinned here.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as root from '../../src/node/index.js';
import * as htmlEntry from '../../src/node/convert.js';

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

// '@page2ai/core/html' (0.4.5) is htmlToMarkdown without the guarded fetch, for a browser tab or a Web
// Worker (the docs site's online converter). Its promise is an import graph a browser bundler can take
// as is: the moment a renderer file imports undici or a `node:` module, a browser build breaks or ships
// a stub that throws, while every Node test stays green. So the graph itself is pinned here.
const STATIC_FROM = /^(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT = /^import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

// The bare specifiers (packages, `node:` modules) reached from a source file through relative imports.
const bareImports = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const re of [STATIC_FROM, SIDE_EFFECT, DYNAMIC]) {
      for (const m of src.matchAll(re)) {
        const spec = m[1]!;
        if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
        else bare.add(spec);
      }
    }
  };
  visit(fileURLToPath(new URL(entry, import.meta.url)));
  return bare;
};

describe('@page2ai/core/html, the network-free entry', () => {
  it('the exports map points "./html" at the build of src/node/convert.ts', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports['./html']).toEqual({ types: './dist/node/convert.d.ts', import: './dist/node/convert.js' });
  });

  it('the package root re-exports the very same htmlToMarkdown, so both entries give one Markdown', () => {
    expect(root.htmlToMarkdown).toBe(htmlEntry.htmlToMarkdown);
  });

  it('reaches linkedom and css.escape only: no undici, no node: module', () => {
    expect([...bareImports('../../src/node/convert.ts')].sort()).toEqual(['css.escape', 'linkedom']);
  });

  it('the same walk from the package root finds the fetch stack, so the walker is not blind', () => {
    const bare = bareImports('../../src/node/index.ts');
    expect(bare.has('undici')).toBe(true);
    expect([...bare].filter((s) => s.startsWith('node:')).sort()).toEqual(
      expect.arrayContaining(['node:async_hooks', 'node:dns/promises', 'node:net']),
    );
  });
});
