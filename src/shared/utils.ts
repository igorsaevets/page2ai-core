// Pure utilities: no DOM access, no shared state.
// Ported from Rev-032v2 prototype (Sections 7-10, 16-17, 21-22, 35).

import { PII_VALUE_PATTERNS, PII_KEY_PATTERNS, SOCIAL_DOMAIN_RE } from './constants.js';
import type { ClassifiedLink, ResolvedConfig } from './types.js';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Race a Promise against a hard wall-clock timeout. On timeout resolves to
// `onTimeout` (default null) — never rejects, so callers can treat "no capture"
// and "timed out" uniformly. Does NOT abort the racing work: if `p` is a slow
// synchronous computation (e.g. renderNode on a big DOM), it keeps running to
// completion in the background but its result is discarded. Guards only real
// async waits (network fetches, MutationObserver settles inside clickAndWait).
export const withHardTimeout = <T>(
  p: Promise<T>,
  ms: number,
  onTimeout: T | null = null,
): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T | null>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  return Promise.race([
    p.then((v) => {
      if (timer) clearTimeout(timer);
      return v;
    }),
    timeout,
  ]);
};

export const slugify = (t: string | null | undefined): string =>
  (t || 'page')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'page';

export const absUrl = (u: string | null | undefined, base?: string): string => {
  const resolvedBase = base ?? globalThis.location?.href;
  try {
    return new URL(u || '', resolvedBase).href;
  } catch {
    return u || '';
  }
};

export const cleanInline = (t: string | null | undefined): string =>
  (t || '').replace(/\u00a0/g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();

export const cleanBlock = (t: string | null | undefined): string =>
  (t || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

export const stripNoisyHtmlAttributes = (t: string | null | undefined): string => {
  if (!t) return t || '';
  return String(t)
    .replace(/\s*data-od-[a-z0-9_-]*\s*=\s*"[^"]*"/gi, '')
    .replace(/\s*data-od-[a-z0-9_-]*\s*=\s*'[^']*'/gi, '')
    .replace(/\s*data-(?:dominant-color|has-transparency)\s*=\s*"[^"]*"/gi, '')
    .replace(/\s*data-(?:dominant-color|has-transparency)\s*=\s*'[^']*'/gi, '')
    .replace(/\s*style\s*=\s*"[^"]*"/gi, '')
    .replace(/\s*style\s*=\s*'[^']*'/gi, '')
    .replace(/\s*(?:loading|decoding|fetchpriority)\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
};

export const escapeMd = (t: string | null | undefined, stripNoisy = false): string => {
  if (!t) return '';
  let c = cleanInline(t);
  if (stripNoisy) c = stripNoisyHtmlAttributes(c);
  return c
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
};

export const escapeMdTableCell = (t: string | null | undefined): string => {
  if (!t) return '';
  return String(t)
    .replace(/\u00a0/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .replace(/[ \t]+/g, ' ')
    .trim();
};

export const stripOuterBlankLines = (t: string | null | undefined): string =>
  (t || '').replace(/\u00a0/g, ' ').replace(/^\s*\n/, '').replace(/\n\s*$/, '');

export const longestRun = (t: string | null | undefined, c: '`' | '~'): number => {
  const e = c === '`' ? '\\`' : '\\~';
  const m = String(t || '').match(new RegExp(`${e}+`, 'g')) || [];
  return m.reduce((mx, r) => Math.max(mx, r.length), 0);
};

export const chooseCodeFence = (t: string | null | undefined): string => {
  const b = longestRun(t, '`');
  const tl = longestRun(t, '~');
  if (b < 3) return '```';
  if (tl < b) return '~'.repeat(Math.max(3, tl + 1));
  return '`'.repeat(Math.max(3, b + 1));
};

// --- PII masking (Section 16) ---

export const maskString = (s: string): string => {
  let r = s;
  for (const { name, re } of PII_VALUE_PATTERNS) r = r.replace(re, `<MASKED:${name}>`);
  return r;
};

export const maskPii = (v: unknown, enabled: boolean, d = 0): unknown => {
  if (!enabled) return v;
  if (d > 12) return '<MASKED:depth-limit>';
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return maskString(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => maskPii(x, enabled, d + 1));
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (PII_KEY_PATTERNS.some((re: RegExp) => re.test(k))) o[k] = '<MASKED:by-key>';
      else o[k] = maskPii(x, enabled, d + 1);
    }
    return o;
  }
  return v;
};

// --- Form field sanitization (Section 17) ---

export const sanitizeFormFieldValue = (
  name: string | null | undefined,
  value: string | null | undefined,
  type: string,
  config: Pick<ResolvedConfig, 'maskFormFieldNamePatterns' | 'maxHiddenFormValueLength'>,
): string => {
  if (!value) return value || '';
  const sn = String(name || '');
  const sv = String(value);
  if (config.maskFormFieldNamePatterns.some((re: RegExp) => re.test(sn))) {
    return `<MASKED:by-name, len=${sv.length}>`;
  }
  if (type === 'hidden' && sv.length > config.maxHiddenFormValueLength) {
    return `${sv.slice(0, 30)}<TRUNCATED:total=${sv.length}-chars>`;
  }
  return sv;
};

// --- Link helpers (Sections 21-22) ---

export const isWordPressNoiseLink = (
  href: string | null | undefined,
  config: Pick<ResolvedConfig, 'filterWordPressNoiseLinks' | 'wordpressNoiseLinkPatterns'>,
): boolean => {
  if (!config.filterWordPressNoiseLinks || !href) return false;
  return config.wordpressNoiseLinkPatterns.some((p: RegExp) => p.test(href));
};

export const cleanMailtoTelLabel = (href: string, rawLabel: string): string => {
  if (!href) return rawLabel;
  const isMailto = href.startsWith('mailto:');
  const isTel = href.startsWith('tel:');
  if (!isMailto && !isTel) return rawLabel;

  const address = href.replace(/^(?:mailto:|tel:)/, '').trim();
  if (!rawLabel || rawLabel.length === 0) return address;
  if (rawLabel.includes(address)) return address;
  if (/^(icon|иконка|логотип|значок|logo|figure|picture)\b/i.test(rawLabel)) return address;
  return rawLabel;
};

export const classifyLink = (
  href: string | null | undefined,
  alt: string | null | undefined,
  hasImg: boolean,
): ClassifiedLink => {
  const url = String(href || '');
  const as = String(alt || '');
  if (url.startsWith('mailto:')) return { type: 'mailto', label: as || url.replace(/^mailto:/, '') };
  if (url.startsWith('tel:')) return { type: 'tel', label: as || url.replace(/^tel:/, '') };
  const sm = url.match(SOCIAL_DOMAIN_RE);
  if (sm) {
    const d = sm[1].replace(/^www\./, '').replace(/^m\./, '');
    return { type: 'social', label: d };
  }
  if (hasImg && /\.(jpe?g|png|webp|gif|svg|bmp|ico|avif)(?:\?|#|$)/i.test(url)) {
    if (as.length >= 10) return { type: 'linked-image', label: as };
  }
  return { type: 'link', label: as };
};

export const isStepNumberLike = (t: string | null | undefined): boolean =>
  /^(0?\d{1,3}|step\s*\d{1,3}|№\s*\d{1,3})$/i.test(cleanInline(t));
