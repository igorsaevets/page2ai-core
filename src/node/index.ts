// @page2ai/core — Node.js entry point.
//
// Public API:
//   htmlToMarkdown(html, opts?)  — convert an HTML string to Markdown. It lives in convert.ts, which
//                                  is also published alone as '@page2ai/core/html' (no network code).
//   fetchAndConvert(url, opts?)  — SSRF-guarded fetch + convert
//
// What the conversion covers: the SCOPE note at the top of convert.ts.

import { htmlToMarkdown } from './convert.js';
import type { ConversionResult, HtmlToMarkdownOptions } from './convert.js';
import { FetchProtectionError, fetchProtected } from './fetch-protected.js';
import type { FetchPolicyOptions } from './fetch-policy.js';
import { assertSafeUrl } from './ssrf-guard.js';
import { CORE_VERSION } from '../shared/constants.js';

export interface FetchAndConvertOptions extends HtmlToMarkdownOptions, FetchPolicyOptions {
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  // Stops the fetch like its timeout does (fetch-policy.ts: also reaches it through runWithFetchSignal).
  signal?: AbortSignal;
}

type ResponseSource = 'markdown-response' | 'text-response';

// Wrap a raw markdown response in the frontmatter block so downstream consumers
// see the same shape as html-to-md output. `extractor_source` says that no
// conversion happened, because a caller measuring conversion quality needs to know.
const wrapMdWithFrontmatter = (raw: string, url: string, title: string, source: ResponseSource): string => {
  const yq = (s: string): string => '"' + String(s).replace(/"/g, '\\"') + '"';
  const fm = [
    '---',
    `title: ${yq(title)}`,
    `source: ${yq(url)}`,
    `captured_at: ${yq(new Date().toISOString())}`,
    `extractor: ${yq('page2ai-core')}`,
    `extractor_version: ${yq(CORE_VERSION)}`,
    `extractor_source: ${yq(source)}`,
    '---',
    '',
  ];
  return fm.join('\n') + raw.replace(/^﻿/, '').trim() + '\n';
};

// The Markdown path honours includeFrontmatter and counts characters the way htmlToMarkdown
// does (the whole returned Markdown). Until 0.1.12 it always prepended the frontmatter and
// counted only the body, so `include_frontmatter: false` in the MCP server was ignored
// (T121 panel, codex).
const mdResponseMarkdown = (
  raw: string,
  url: string,
  title: string,
  opts: FetchAndConvertOptions,
  source: ResponseSource = 'markdown-response',
): string =>
  (opts.includeFrontmatter ?? true)
    ? wrapMdWithFrontmatter(raw, url, title, source)
    : raw.replace(/^﻿/, '').trim() + '\n';

// A Markdown body must never reach the HTML parser. linkedom will happily accept
// it, find no <article> or <main>, and return an empty document, which reads as
// "extraction failed" when in fact the server handed over exactly what was asked
// for. See page2ai-benchmark RETRACTION-2026-07-25.md. Plain text fares no better: its line
// breaks collapse into one paragraph (T137: a README.md from raw.githubusercontent.com, served as
// text/plain, came out as one line with no heading and no code block, in 0.1.13 as well).
const MARKDOWN_CONTENT_TYPE = /^(text\/markdown|text\/x-markdown)/i;
const HTML_CONTENT_TYPE = /^(text\/html|application\/xhtml\+xml)/i;

// A path that names a Markdown file (.md, .markdown, .mdown, .mkd, .mdx) or a plain-text one (.txt,
// llms.txt among them). A browser shows such a file as its text whatever text type the server
// gives it: GitHub raw serves .md as text/plain, object stores often as application/octet-stream.
// That file is the page, so it is returned as is.
const TEXT_FILE_PATH = /\.(?:md|markdown|mdown|mkd|mdx|txt)$/i;
const TEXT_FILE_TYPES =
  /^(text\/html|application\/xhtml\+xml|text\/markdown|text\/x-markdown|text\/plain|application\/octet-stream|binary\/octet-stream)/i;

const pathOf = (u: string): string => {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
};

const looksLikeHtml = (s: string): boolean => /^\s*<(!doctype|html)\b/i.test(s);

// Any other text/plain response (source code, JSON, YAML, CSV, a log, a script) is shown by a browser
// as its text, every line kept, and never as HTML: the MIME Sniffing Standard (§7.1, §7.2) only checks
// a text/plain body for binary bytes, and Chrome trusts the type otherwise. Markdown has one way to say
// «this text as it is»: a fenced code block. Left bare, the file's lines would join into paragraphs, its
// `#` lines would become headings and markup inside it would become links, images or raw HTML (P2A-090:
// Readability.js from raw.githubusercontent.com, 2,812 lines, came out as 4 lines and an invented image).
const PLAIN_TEXT_CONTENT_TYPE = /^\s*text\/plain\s*(?:;|$)/i;

// A «binary data byte» of the MIME Sniffing Standard; a text/plain body whose first 1,445 bytes hold
// one is a binary file mislabelled as text, and a browser downloads it instead of showing it.
const BINARY_DATA_BYTE = /[\x00-\x08\x0B\x0E-\x1A\x1C-\x1F]/;
const RESOURCE_HEADER_LENGTH = 1445;

// The fence's language, from the file's extension (or its name, or a #! line): a hint for the reader
// and for syntax highlighting. An unknown kind gets a fence without one.
const FENCE_LANGUAGE: Readonly<Record<string, string>> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  py: 'python', pyi: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', pl: 'perl', pm: 'perl', lua: 'lua', r: 'r', dart: 'dart', ex: 'elixir',
  exs: 'elixir', sh: 'bash', bash: 'bash', zsh: 'zsh', fish: 'fish', ps1: 'powershell', psm1: 'powershell',
  bat: 'bat', cmd: 'bat', sql: 'sql', json: 'json', jsonc: 'jsonc', json5: 'json5', jsonl: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', svg: 'xml', xsl: 'xml', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less', csv: 'csv', tsv: 'tsv', ini: 'ini', cfg: 'ini', diff: 'diff',
  patch: 'diff', graphql: 'graphql', gql: 'graphql', proto: 'protobuf', tf: 'hcl', hcl: 'hcl', vue: 'vue',
  svelte: 'svelte', gradle: 'groovy', groovy: 'groovy',
  dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile',
};
const SHEBANG_LANGUAGE: Readonly<Record<string, string>> = {
  sh: 'bash', bash: 'bash', dash: 'bash', ksh: 'bash', zsh: 'zsh', python: 'python', node: 'javascript',
  deno: 'typescript', bun: 'javascript', ruby: 'ruby', perl: 'perl', pwsh: 'powershell', php: 'php',
};

const fileNameOf = (u: string): string => {
  const last = pathOf(u).split('/').filter(Boolean).pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

const fenceLanguage = (name: string, text: string): string => {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const byName = FENCE_LANGUAGE[dot > 0 ? lower.slice(dot + 1) : lower];
  if (byName) return byName;
  if (dot > 0) return '';
  // No extension: a script's #! line names its interpreter (`#!/usr/bin/env python3`, `#!/bin/sh`).
  const shebang = /^#![ \t]*(\S+)([^\n]*)/.exec(text);
  if (!shebang) return '';
  let program = (shebang[1] ?? '').split('/').pop() ?? '';
  if (program === 'env') program = (shebang[2] ?? '').trim().split(/\s+/).find((w) => !w.startsWith('-')) ?? '';
  return SHEBANG_LANGUAGE[program.replace(/[\d.]+$/, '').toLowerCase()] ?? '';
};

// The file's text in a fence longer than any run of backticks inside it, so no line of the file can
// close it (CommonMark: a closing fence is at least as long as the opening one). Line endings become
// \n and blank lines around the text go; the first line's indentation stays.
const fencedText = (text: string, language: string): string => {
  const body = text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  let longest = 0;
  const runs = /`+/g;
  for (let m = runs.exec(body); m; m = runs.exec(body)) {
    if (m[0].length > longest) longest = m[0].length;
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${body}${body ? '\n' : ''}${fence}`;
};

export const fetchAndConvert = async (
  url: string,
  opts: FetchAndConvertOptions = {},
): Promise<ConversionResult> => {
  assertSafeUrl(url);
  // Only the URL the caller named is fetched: no `<url>.md` twin, no llms.txt, and the Accept
  // header is a browser's (BL-49, Igor 2026-10-17: such copies are often stale).
  const resp = await fetchProtected(url, {
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    userAgent: opts.userAgent,
    allowedPorts: opts.allowedPorts,
    extraBlockedIps: opts.extraBlockedIps,
    signal: opts.signal,
    acceptContentTypes: TEXT_FILE_PATH.test(pathOf(url)) ? TEXT_FILE_TYPES : undefined,
  });

  if (!HTML_CONTENT_TYPE.test(resp.contentType) && !looksLikeHtml(resp.text)) {
    // The URL names a Markdown or text file: that file is the page. Handing it to the HTML parser
    // would wreck it, so it is returned as is and labelled.
    if (TEXT_FILE_PATH.test(pathOf(resp.finalUrl))) {
      if (resp.text.includes('\u0000')) {
        throw new FetchProtectionError('the file is not text (its body holds a NUL byte)', resp.finalUrl);
      }
      const raw = resp.text.replace(/^﻿/, '').trim();
      const title = (raw.match(/^#\s+(.+)$/m)?.[1] || '').trim();
      const markdown = mdResponseMarkdown(raw, resp.finalUrl, title, opts);
      return {
        markdown,
        title,
        baseUrl: resp.finalUrl,
        charCount: markdown.length,
        extractedAt: new Date().toISOString(),
        source: 'markdown-response',
      };
    }
    // Markdown for a page address, although the request asked for HTML as a browser does: the
    // server picked a Markdown copy by something other than Accept (User-Agent, a cache). That copy
    // is what BL-49 removed, so it is refused, not returned as the page (T136 panel: spark13cont,
    // grokbuild and goog38flash each named this path).
    if (MARKDOWN_CONTENT_TYPE.test(resp.contentType)) {
      throw new FetchProtectionError(
        `the server answered with Markdown (${resp.contentType.split(';')[0]!.trim()}) for a page address ` +
          'although the request asked for HTML as a browser does; page2ai returns only the page, never a ' +
          'Markdown copy of it. If the address is a Markdown file, pass its .md URL',
        resp.finalUrl,
      );
    }
    // Any other text/plain body is a text file (P2A-090): its text, every line kept, in a fence. Until
    // 0.4.25 it went to the HTML parser, which joined its lines and read markup inside it as tags.
    if (PLAIN_TEXT_CONTENT_TYPE.test(resp.contentType)) {
      if (BINARY_DATA_BYTE.test(resp.text.slice(0, RESOURCE_HEADER_LENGTH)) || resp.text.includes('\u0000')) {
        throw new FetchProtectionError('the file is not text (its first bytes hold binary data)', resp.finalUrl);
      }
      const name = fileNameOf(resp.finalUrl);
      const fenced = fencedText(resp.text, fenceLanguage(name, resp.text));
      const markdown = mdResponseMarkdown(fenced, resp.finalUrl, name, opts, 'text-response');
      return {
        markdown,
        title: name,
        baseUrl: resp.finalUrl,
        charCount: markdown.length,
        extractedAt: new Date().toISOString(),
        source: 'text-response',
      };
    }
  }

  return htmlToMarkdown(resp.text, { ...opts, baseUrl: opts.baseUrl ?? resp.finalUrl });
};

// htmlToMarkdown and its types come from convert.ts, the network-free module behind '@page2ai/core/html'.
export { htmlToMarkdown } from './convert.js';
export type { ConversionResult, HtmlToMarkdownOptions } from './convert.js';
// Re-export public types + errors for consumers (MCP server catches these).
export type { ProfileName } from '../shared/types.js';
export { LinkedomAdapter } from './linkedom-adapter.js';
// assertSafeUrlResolved is the exact check fetchAndConvert runs on the URL and on every redirect
// hop, so a caller can learn before fetching whether a URL will be refused; findIpBlockReason is
// its address rule. Both sat in the published .d.ts without being importable (P2A-009).
export { SsrfBlockedError, assertSafeUrl, assertSafeUrlResolved, findIpBlockReason } from './ssrf-guard.js';
export { DEFAULT_UA, FetchProtectionError, fetchProtected, getProxyForUrl, _resetHostThrottle } from './fetch-protected.js';
export { runWithFetchSignal, resolveFetchPolicy, effectivePort } from './fetch-policy.js';
export type { FetchPolicyOptions } from './fetch-policy.js';
