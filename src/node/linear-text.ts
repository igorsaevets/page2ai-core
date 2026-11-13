// Linear-time stand-ins for three regexes a page could stall (Page2AI T241, from the T240 review panel).
//
// Each regex retried every start position, or every way to split a run, before it failed: its time grew with the
// square of a run of blanks or letters, or doubled with each HTML comment. 40 comments at the top of a page that has
// no <html> tag ran for hours, and a heading or an aria-label holding a few hundred thousand blanks or letters for
// minutes, all of it synchronous, so the MCP server answered nothing else meanwhile. Each function below returns what
// its regex returned (tests/node/linear-text.test.ts compares the two on generated strings), except where
// opensWithHeadOrBody follows HTML more closely; its comment says where.

const BLANKS = /\s*/y;
const HEAD_OR_BODY = /<(?:head|body)[\s>]/iy;

/**
 * Whether `s` starts with a `<head` or `<body` tag once leading whitespace and HTML comments are skipped. Replaces
 * `/^\s*(?:<!--[\s\S]*?-->\s*)*<(?:head|body)[\s>]/i`. A comment ends at its first `-->`, as in HTML; the regex could
 * also stretch a comment over a later `-->`, so it read `<!--a-->text--><head>` as a document that starts with <head>.
 */
export const opensWithHeadOrBody = (s: string): boolean => {
  let i = 0;
  for (;;) {
    BLANKS.lastIndex = i;
    BLANKS.test(s);
    i = BLANKS.lastIndex;
    if (!s.startsWith('<!--', i)) break;
    const end = s.indexOf('-->', i + 4);
    if (end < 0) return false;
    i = end + 3;
  }
  HEAD_OR_BODY.lastIndex = i;
  return HEAD_OR_BODY.test(s);
};

// `s.replace(/\s*\n\s*/g, ' ')` in one pass: each run of whitespace that holds a line break becomes one space.
export const lineBreakRunsToSpace = (s: string): string =>
  s.replace(/\s+/g, (run) => (run.includes('\n') ? ' ' : run));

/**
 * `/\p{L}.*:\s*$/u.test(s)` in one pass: once its trailing whitespace is gone `s` ends with a colon, and the line of
 * that colon holds a letter before it (`.` stops at a line terminator). `trimEnd` strips exactly what `\s` matches.
 */
export const endsWithLetteredColon = (s: string): boolean => {
  const t = s.trimEnd();
  if (!t.endsWith(':')) return false;
  const line = t.slice(0, -1).split(/[\n\r\u2028\u2029]/).pop() ?? '';
  return /\p{L}/u.test(line);
};
