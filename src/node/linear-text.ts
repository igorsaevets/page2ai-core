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

// The last code point of a text sits in its last two code units, so this test needs no more of a text than that.
const WORD_END = /[\p{L}\p{N}]$/u;

// How many backslashes end `s.slice(0, end)`.
const backslashesEndingAt = (s: string, end: number): number => {
  let i = end;
  while (i > 0 && s.charCodeAt(i - 1) === 92 /* \ */) i--;
  return end - i;
};

/**
 * The text renderInlineNodes builds part by part, answering what it asks about the text's END without reading the
 * text (Page2AI T242, P2A-035). In V8 a string grown with `+=` is a rope, and any read of it (a regex, `endsWith`,
 * `charCodeAt`, `slice`) first copies the whole rope into one string: the old accumulator read itself once per
 * appended part, so an element with n inline children cost O(n²). A paragraph of 40,000 links took 9 s on core 0.4.7,
 * and a page of a few MB could hold the converter for minutes. Here every part but the last goes into an array that is
 * joined once, and each question reads only the last part, which is never empty, plus two facts kept about the text
 * before it. Each method names the expression on the whole text it answers; tests/node/linear-text.test.ts compares
 * the two after every step of generated sequences.
 */
export class InlineText {
  private readonly head: string[] = [];
  private last = '';
  // The last code unit of the text before `last`, and how many backslashes end that text.
  private headEnd = '';
  private headBackslashes = 0;

  /** Appends `part`; an empty part changes nothing. */
  append(part: string): void {
    if (!part) return;
    if (this.last) {
      const run = backslashesEndingAt(this.last, this.last.length);
      this.headBackslashes = run === this.last.length ? this.headBackslashes + run : run;
      this.headEnd = this.last.slice(-1);
      this.head.push(this.last);
    }
    this.last = part;
  }

  /** `text === ''` */
  get isEmpty(): boolean {
    return !this.last;
  }

  /** `/\s$/.test(text)`: every code point `\s` matches is one code unit. */
  endsWithSpace(): boolean {
    return /\s/.test(this.last.slice(-1));
  }

  /** `text.endsWith('*')` */
  endsWithStar(): boolean {
    return this.last.endsWith('*');
  }

  /** `/[\p{L}\p{N}]$/u.test(text)` */
  endsWithWordChar(): boolean {
    return WORD_END.test(this.last.length >= 2 ? this.last.slice(-2) : this.headEnd + this.last);
  }

  /** `/(?:^|[^\\])(?:\\\\)*\\$/.test(text)`: an odd run of backslashes ends the text, so its last one escapes what follows. */
  endsWithOpenEscape(): boolean {
    return this.backslashesBefore(this.last.length) % 2 === 1;
  }

  /** `/(?:^|[^\\])(?:\\\\)*!$/.test(text)`: the text ends with a `!` that no backslash escapes. */
  endsWithBareBang(): boolean {
    return this.last.endsWith('!') && this.backslashesBefore(this.last.length - 1) % 2 === 0;
  }

  /** `text = text.slice(0, -1) + s`: the last code unit is always in `last`. */
  replaceLastChar(s: string): void {
    this.last = this.last.slice(0, -1) + s;
  }

  /** The whole text. It joins every part, so it is called once, at the end. */
  toString(): string {
    return this.head.join('') + this.last;
  }

  // The run of backslashes that ends at `end` in the last part, continued into the text before it when the run
  // fills the part up to `end`.
  private backslashesBefore(end: number): number {
    const run = backslashesEndingAt(this.last, end);
    return run === end ? run + this.headBackslashes : run;
  }
}
