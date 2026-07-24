// Markdown post-processing: pure string transforms over the composed document.
// Ported from Rev-032v2 prototype (Sections 10-11 + aggressive cleanup pass).

import type { ProgressCallback, ResolvedConfig } from './types.js';

export interface FenceTracker {
  readonly inFence: boolean;
  check(trimmedLine: string): boolean;
}

export const createFenceTracker = (): FenceTracker => {
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  return {
    get inFence() {
      return inFence;
    },
    check(trimmedLine: string) {
      const m = trimmedLine.match(/^(`{3,}|~{3,})/);
      if (!m) return false;
      const c = m[1][0];
      const l = m[1].length;
      if (!inFence) {
        inFence = true;
        fenceChar = c;
        fenceLen = l;
      } else if (c === fenceChar && l >= fenceLen) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
      return true;
    },
  };
};

// Preserves leading whitespace on non-blank lines; collapses only internal runs.
export const normalizeMarkdownPreserveCode = (text: string | null | undefined): string => {
  const lines = String(text || '').replace(/\u00a0/g, ' ').split('\n');
  const out: string[] = [];
  const fence = createFenceTracker();
  let blankCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (fence.check(trimmed)) {
      out.push(line.trimEnd());
      blankCount = 0;
      continue;
    }
    if (fence.inFence) {
      out.push(line.replace(/\s+$/g, ''));
      continue;
    }

    if (trimmed === '') {
      blankCount += 1;
      if (blankCount <= 2) out.push('');
      continue;
    }
    blankCount = 0;

    const m = line.match(/^(\s*)(.*?)$/);
    const lead = m ? m[1] : '';
    const rest = (m ? m[2] : line).replace(/[ \t]+/g, ' ').trimEnd();
    out.push(lead + rest);
  }
  return out.join('\n').replace(/^\n+|\n+$/g, '');
};

export const dedupeConsecutiveDuplicateLines = (
  text: string,
  config: Pick<ResolvedConfig, 'dedupeConsecutiveDuplicates' | 'minConsecutiveDuplicatesToCollapse'>,
): string => {
  if (!config.dedupeConsecutiveDuplicates) return text;
  const threshold = Math.max(2, config.minConsecutiveDuplicatesToCollapse);
  const lines = String(text || '').split('\n');
  const out: string[] = [];
  const fence = createFenceTracker();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (fence.check(trimmed)) {
      out.push(line);
      i++;
      continue;
    }
    if (fence.inFence) {
      out.push(line);
      i++;
      continue;
    }
    if (trimmed.length > 0) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === trimmed) j++;
      if (j - i >= threshold) {
        out.push(line);
        out.push(`<!-- AI: collapsed ${j - i - 1} consecutive duplicate line(s) -->`);
        i = j;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
};

// Protects YAML frontmatter from collapsing.
export const collapseShortAdjacentLines = (
  text: string,
  config: Pick<ResolvedConfig, 'collapseShortAdjacentLines' | 'shortLineCollapseMaxChars'>,
): string => {
  if (!config.collapseShortAdjacentLines) return text;
  const maxLen = config.shortLineCollapseMaxChars;
  const lines = String(text || '').split('\n');
  const out: string[] = [];
  const fence = createFenceTracker();
  let buffer: string[] = [];
  let inFrontmatter = false;
  let seenFirstDashes = false;

  const isStructural = (l: string): boolean => {
    const t = l.trimStart();
    return /^#{1,6}\s/.test(t) || /^[-*+]\s/.test(t) || /^\d+\.\s/.test(t) ||
      /^>\s/.test(t) || /^\|/.test(t) || /^!\[/.test(t) || /^\[/.test(t) ||
      /^<!--/.test(t) || /^<\w/.test(t) || /^[*_]{2}/.test(t) || /^---/.test(t) || /^===/.test(t);
  };
  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      out.push(buffer[0]);
      buffer = [];
      return;
    }
    // If every buffered line starts with an uppercase letter, digit, or emoji —
    // these are separate items (security features, stats, etc.), not fragments
    // of a broken sentence. Don't collapse them.
    const allStartWithUpper = buffer.every((s) => /^[\p{Lu}\d\p{Emoji}]/u.test(s.trim()));
    if (allStartWithUpper) {
      buffer.forEach((s) => out.push(s));
    } else {
      out.push(buffer.map((s) => s.trim()).join(' '));
    }
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '---') {
      flush();
      out.push(line);
      if (!seenFirstDashes && i <= 1) {
        inFrontmatter = true;
        seenFirstDashes = true;
      } else if (inFrontmatter) {
        inFrontmatter = false;
      }
      continue;
    }
    if (inFrontmatter) {
      flush();
      out.push(line);
      continue;
    }

    if (fence.check(trimmed)) {
      flush();
      out.push(line);
      continue;
    }
    if (fence.inFence) {
      flush();
      out.push(line);
      continue;
    }
    if (trimmed === '') {
      flush();
      out.push(line);
      continue;
    }
    if (isStructural(line)) {
      flush();
      out.push(line);
      continue;
    }
    if (trimmed.length < maxLen) {
      buffer.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join('\n');
};

// Punctuation cleanup (space before period, comma, etc.).
export const cleanupPunctuation = (
  text: string,
  config: Pick<ResolvedConfig, 'cleanupPunctuation'>,
): string => {
  if (!config.cleanupPunctuation) return text;
  const lines = String(text || '').split('\n');
  const out: string[] = [];
  const fence = createFenceTracker();
  let inFrontmatter = false;
  let seenFirstDashes = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '---') {
      if (!seenFirstDashes && i <= 1) {
        inFrontmatter = true;
        seenFirstDashes = true;
      } else if (inFrontmatter) {
        inFrontmatter = false;
      }
      out.push(line);
      continue;
    }
    if (inFrontmatter) {
      out.push(line);
      continue;
    }
    if (fence.check(trimmed)) {
      out.push(line);
      continue;
    }
    if (fence.inFence) {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith('|')) {
      out.push(line);
      continue;
    }

    out.push(line.replace(/\s+([.,!?;:])/g, '$1'));
  }
  return out.join('\n');
};

// Dedupe adjacent identical markdown links.
export const dedupeAdjacentLinks = (
  text: string,
  config: Pick<ResolvedConfig, 'dedupeAdjacentLinks'>,
): string => {
  if (!config.dedupeAdjacentLinks) return text;
  const lines = String(text || '').split('\n');
  const out: string[] = [];
  const fence = createFenceTracker();
  const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;

  const extractLinkSigs = (line: string): string[] => {
    const sigs: string[] = [];
    let m: RegExpExecArray | null;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(line)) !== null) sigs.push(m[1] + '|' + m[2]);
    return sigs;
  };

  let prevSigs: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (fence.check(trimmed)) {
      out.push(line);
      prevSigs = [];
      continue;
    }
    if (fence.inFence) {
      out.push(line);
      continue;
    }

    if (trimmed === '') {
      out.push(line);
      prevSigs = [];
      continue;
    }

    const curSigs = extractLinkSigs(trimmed);
    if (
      curSigs.length > 0 &&
      curSigs.length === prevSigs.length &&
      curSigs.every((s, idx) => s === prevSigs[idx])
    ) {
      continue;
    }

    // Also handle inline duplicates: [A](url) [A](url) on same line.
    const seen = new Set<string>();
    const cleaned = line
      .replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, label: string, url: string) => {
        const sig = label + '|' + url;
        if (seen.has(sig)) return '';
        seen.add(sig);
        return match;
      })
      .replace(/\s{2,}/g, ' ')
      .trimEnd();

    out.push(cleaned);
    prevSigs = extractLinkSigs(cleaned.trim());
  }
  return out.join('\n');
};

// Suppress repeated images (same src, generic alt, threshold+ times).
export const suppressRepeatedImages = (
  text: string,
  config: Pick<ResolvedConfig, 'suppressRepeatedImages' | 'suppressRepeatedImageThreshold'>,
): string => {
  if (!config.suppressRepeatedImages) return text;
  const threshold = config.suppressRepeatedImageThreshold;
  const lines = String(text || '').split('\n');
  const imgRe = /^(\s*)!\[([^\]]*)\]\(([^)]+)\)\s*$/;

  const srcCounts = new Map<string, number>();
  for (const line of lines) {
    const m = line.match(imgRe);
    if (m) {
      const alt = m[2];
      const src = m[3];
      const isGeneric = !alt || alt === 'image' || alt === 'Image link';
      if (isGeneric) srcCounts.set(src, (srcCounts.get(src) || 0) + 1);
    }
  }

  const srcSeen = new Map<string, number>();
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(imgRe);
    if (m) {
      const alt = m[2];
      const src = m[3];
      const isGeneric = !alt || alt === 'image' || alt === 'Image link';
      if (isGeneric && (srcCounts.get(src) || 0) >= threshold) {
        const seen = srcSeen.get(src) || 0;
        srcSeen.set(src, seen + 1);
        if (seen === 0) {
          out.push(line);
          out.push(
            `<!-- AI: this decorative image repeats ${srcCounts.get(src)} times; subsequent occurrences suppressed -->`,
          );
        }
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
};

export const compactLinkLabels = (
  text: string,
  config: Pick<ResolvedConfig, 'compactLinkLabels' | 'maxLinkLabelChars'>,
): string => {
  if (!config.compactLinkLabels) return text;
  const max = config.maxLinkLabelChars;
  const fence = createFenceTracker();
  const lines = String(text || '').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (fence.check(trimmed)) {
      out.push(line);
      continue;
    }
    if (fence.inFence) {
      out.push(line);
      continue;
    }
    out.push(
      line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label: string, url: string) => {
        if (label.length > max) return `[${label.slice(0, max)}…](${url})`;
        return match;
      }),
    );
  }
  return out.join('\n');
};

// Collapse repeated blocks (marquee/carousel loops): a sequence of N lines
// (N>=3) repeating K times (K>=2) consecutively keeps only the first copy.
export const dedupeRepeatedBlocks = (text: string): string => {
  const lines = String(text || '').split('\n');
  const out: string[] = [];
  const fence = createFenceTracker();
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (fence.check(trimmed)) {
      out.push(lines[i]);
      i++;
      continue;
    }
    if (fence.inFence) {
      out.push(lines[i]);
      i++;
      continue;
    }

    let collapsed = false;
    for (let blockSize = 3; blockSize <= 15 && i + blockSize * 2 <= lines.length; blockSize++) {
      const block = lines.slice(i, i + blockSize).map((l) => l.trim()).join('\n');
      if (!block || block.length < 10) continue;

      let repeats = 1;
      let j = i + blockSize;
      while (j + blockSize <= lines.length) {
        const nextBlock = lines.slice(j, j + blockSize).map((l) => l.trim()).join('\n');
        if (nextBlock === block) {
          repeats++;
          j += blockSize;
        } else break;
      }

      if (repeats >= 2) {
        for (let k = i; k < i + blockSize; k++) out.push(lines[k]);
        out.push(`<!-- AI: repeated block (${blockSize} lines × ${repeats} times) collapsed -->`);
        i = j;
        collapsed = true;
        break;
      }
    }

    if (!collapsed) {
      out.push(lines[i]);
      i++;
    }
  }

  return out.join('\n');
};

// Remove tab panel content that also appears in the main flow.
export const dedupeTabPanelDuplicates = (text: string): string => {
  const lines = String(text || '').split('\n');
  const normForDedup = (s: string): string =>
    s.trim().replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim();

  const panelTexts: Array<Set<string>> = [];
  let inPanel = false;
  let panelLines: string[] = [];

  for (const line of lines) {
    if (/<!-- AI: TAB PANEL START:/.test(line)) {
      inPanel = true;
      panelLines = [];
      continue;
    }
    if (/<!-- AI: TAB PANEL END:/.test(line)) {
      if (panelLines.length) {
        const normalized = panelLines.map((l) => normForDedup(l)).filter(Boolean);
        if (normalized.length >= 1) panelTexts.push(new Set(normalized));
      }
      inPanel = false;
      continue;
    }
    if (inPanel) panelLines.push(line);
  }

  if (!panelTexts.length) return text;

  const out: string[] = [];
  inPanel = false;
  let matchBuffer: string[] = [];
  let matchedPanelIdx = -1;

  const flushMatch = () => {
    if (matchBuffer.length >= 3 && matchedPanelIdx >= 0) {
      out.push('<!-- AI: TAB PANEL CONTENT ALREADY EXPORTED ABOVE (deduplicated) -->');
    } else {
      matchBuffer.forEach((l) => out.push(l));
    }
    matchBuffer = [];
    matchedPanelIdx = -1;
  };

  for (const line of lines) {
    if (/<!-- AI: TAB PANEL START:/.test(line)) {
      flushMatch();
      inPanel = true;
      out.push(line);
      continue;
    }
    if (/<!-- AI: TAB PANEL END:/.test(line)) {
      inPanel = false;
      out.push(line);
      continue;
    }
    if (inPanel) {
      out.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushMatch();
      out.push(line);
      continue;
    }

    const norm = normForDedup(line);
    let found = -1;
    for (let p = 0; p < panelTexts.length; p++) {
      if (panelTexts[p].has(norm)) {
        found = p;
        break;
      }
    }

    if (found >= 0) {
      if (matchBuffer.length === 0) matchedPanelIdx = found;
      if (matchedPanelIdx === found) {
        matchBuffer.push(line);
      } else {
        flushMatch();
        matchBuffer.push(line);
        matchedPanelIdx = found;
      }
    } else {
      flushMatch();
      out.push(line);
    }
  }

  flushMatch();
  return out.join('\n');
};

export const aggressiveCleanup = (
  text: string,
  config: Pick<
    ResolvedConfig,
    'aggressiveCleanup' | 'aggressiveCleanupMaxLinkTextLength' | 'aggressiveCleanupHtmlTagPattern'
  >,
  progress?: ProgressCallback,
): string => {
  if (!config.aggressiveCleanup) return text;
  const lines = String(text || '').split('\n');
  const out: string[] = [];
  const fence = createFenceTracker();
  const maxLT = config.aggressiveCleanupMaxLinkTextLength;
  const htmlP = config.aggressiveCleanupHtmlTagPattern;
  let sc = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (fence.check(trimmed)) {
      out.push(line);
      continue;
    }
    if (fence.inFence) {
      out.push(line);
      continue;
    }
    const cleaned = line.replace(
      /(\[)([^\]]*?)(\]\()([^)]+)(\))/g,
      (match, _o: string, lt: string, _m: string, url: string) => {
        if (lt.length > maxLT || htmlP.test(lt)) {
          sc++;
          return `[link](${url})`;
        }
        return match;
      },
    );
    out.push(cleaned);
  }
  if (sc > 0) progress?.('postprocess', `aggressive cleanup stripped ${sc} link(s)`);
  return out.join('\n');
};

// Full post-processing chain in prototype order (Section 41).
export const postProcessMarkdown = (
  text: string,
  config: ResolvedConfig,
  progress?: ProgressCallback,
): string => {
  let md = normalizeMarkdownPreserveCode(text);
  md = dedupeConsecutiveDuplicateLines(md, config);
  md = dedupeRepeatedBlocks(md);
  md = dedupeTabPanelDuplicates(md);
  md = collapseShortAdjacentLines(md, config);
  md = cleanupPunctuation(md, config);
  md = dedupeAdjacentLinks(md, config);
  md = suppressRepeatedImages(md, config);
  md = aggressiveCleanup(md, config, progress);
  md = compactLinkLabels(md, config);
  return md;
};
