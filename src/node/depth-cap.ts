// A cap on how deep the parsed document can nest, applied to the HTML text BEFORE linkedom parses it (P2A-033, P2A-036).
//
// Two costs grow with nesting depth, and a page of a few hundred KB can be nested 100,000 deep:
//  - the parse: htmlparser2 10.1.0 (linkedom's parser) keeps its stack of open elements at the FRONT of an array, so
//    every start and end tag costs O(depth): 100,000 nested <div> took 15 s, 100,000 nested tables 116 s (P2A-036;
//    fixed on htmlparser2 master, in no release, and linkedom requires ^10.1.0);
//  - core's own walks recurse once or more per level: in Chrome 157's dedicated worker (where the online converter runs
//    core) a page of nested tables failed at 347 levels, of <blockquote>, <figure> or hidden tab panels at about 390,
//    and in Node at about 800 (T259, cold runs); the whole page became the «extraction failed» document (P2A-033).
// A pass after parsing comes too late for the first cost, so this one runs on the text.
//
// It replays htmlparser2 10.1.0's Parser over htmlparser2's own Tokenizer (the one linkedom's parse runs), so it sees
// the stack the parse will build: the implied closes of `openImpliesClose` (a start tag closes only the run of matching
// elements on TOP of the stack), void elements, `/>` closing an element only in svg/math context (`foreignContext`,
// including its quirks: an integration element's or a math/svg end tag pops that context even when nothing matches, and
// `<svg/>` leaves its entry behind), an end tag closing the nearest open element of its name and everything above it,
// and the stray `</p>` and `</br>` (each makes an empty leaf, one level below the deepest open element, which the
// depth here does not count). Browsers bound the tree the same way (HTML parser limit 512 in Blink, WebKit and Gecko:
// whatwg/html#3732) while their stack of open elements, which matches end tags, stays unbounded; this pass keeps both
// too: the stack of the INPUT decides which end tags belong to a removed element, the stack of the OUTPUT decides what
// may open.
//
// A document whose parse never goes deeper than the cap comes back as the same string, unchanged, so its Markdown is
// byte-identical by construction (the deepest of 1,065 saved real pages is 42). The depth counts the whole document:
// <html> and <body> are 2 of the 200, and a fragment is measured inside the shell parseDocument wraps it in. Deeper, the
// start tag of every element that would open below the cap is removed with its end tag, and its text stays where it
// was, in the element at the cap, as one run of text: `<span>a</span><span>b</span>` reads `ab` there, the text a
// browser shows, without the space the renderer puts between two inline elements. A removed block tag (div, p, li,
// td...) becomes a <br> when text came since the last one, so lines stay apart. Any other becomes nothing, or an empty
// comment where the text before it ends in `<` or in an unfinished character reference (`&`, `&am`, `&#6`): text joined
// across a removed tag must not open a tag or a reference that the page did not have (T259 panel). Browsers keep such
// elements as siblings at the limit instead; here their attributes go (links, image wrappers, headings below the cap),
// so a page nested deeper than 200 loses that structure below 200, never its shown words: on 0.4.16 such a page still
// converted whole up to about 347 levels in Chrome's worker and about 800 in Node.
// An element that hides what it holds (the `hidden` attribute, inline display:none or visibility:hidden, or a tag the
// renderer skips: <select>, <template>, <noscript>, <svg>, a self-closed <script/>...) is removed past the cap WITH its
// content: removing only its tag would show hidden text, which the renderer keeps out as a channel for instructions the
// reader never sees (0.4.17 showed it all: T260). The hidden kinds the renderer does show (tab panels, code, React
// segments, until-found) are dropped too past the cap: none sit that deep on a real page.
// Void elements that close nothing (<br>, <img>...) stay at any depth: they never touch a stack. The tags of <xmp>, a
// raw-text element whose text the renderer shows (the Tokenizer reads its content as text), always stay too, so the
// text is tokenized exactly as before; it holds no elements. The other raw-text elements (script, style, title,
// textarea) are skipped by the renderer and take the depth rule: past the cap they go with their text.
// The pass is linear: each element is pushed and popped once on each stack, an end tag finds its element through a count
// per name, an implied close looks at the top of the stack only, and the output is written as it goes (0.4.17 kept
// every cut in a list: about 190 bytes each, 570 MB for 9 MB of tags).
import { Tokenizer } from 'htmlparser2';
import { SKIP_TAGS, STYLE_HIDDEN_RE } from './basic-renderer.js';

// How deep the parse may nest (html = 1). Below the shallowest failure measured (Chrome 157's worker: nested tables
// 347 levels, blockquotes ~390): room for shapes not measured, other browsers' workers and frames added later; 4.8x the
// deepest real page saved. Walks see at most this + 8 (boundTreeDepth).
export const MAX_PARSE_DEPTH = 200;

// htmlparser2 10.1.0, dist/esm/Parser.js (openImpliesClose, voidElements, foreignContextElements,
// htmlIntegrationElements). tests/node/depth-cap.test.ts compares this replay with the parser itself.
const P = new Set(['p']);
const FORM = new Set(['input', 'option', 'optgroup', 'select', 'button', 'datalist', 'textarea']);
const TABLE_SECTION = new Set(['thead', 'tbody']);
const DDT = new Set(['dd', 'dt']);
const RTP = new Set(['rt', 'rp']);
const IMPLIES_CLOSE = new Map<string, Set<string>>([
  ['tr', new Set(['tr', 'th', 'td'])],
  ['th', new Set(['th'])],
  ['td', new Set(['thead', 'th', 'td'])],
  ['body', new Set(['head', 'link', 'script'])],
  ['li', new Set(['li'])],
  ['p', P], ['h1', P], ['h2', P], ['h3', P], ['h4', P], ['h5', P], ['h6', P],
  ['select', FORM], ['input', FORM], ['output', FORM], ['button', FORM], ['datalist', FORM], ['textarea', FORM],
  ['option', new Set(['option'])],
  ['optgroup', new Set(['optgroup', 'option'])],
  ['dd', DDT], ['dt', DDT],
  ['address', P], ['article', P], ['aside', P], ['blockquote', P], ['details', P], ['div', P], ['dl', P],
  ['fieldset', P], ['figcaption', P], ['figure', P], ['footer', P], ['form', P], ['header', P], ['hr', P],
  ['main', P], ['nav', P], ['ol', P], ['pre', P], ['section', P], ['table', P], ['ul', P],
  ['rt', RTP], ['rp', RTP],
  ['tbody', TABLE_SECTION], ['tfoot', TABLE_SECTION],
]);
const VOID = new Set([
  'area', 'base', 'basefont', 'br', 'col', 'command', 'embed', 'frame', 'hr', 'img', 'input', 'isindex', 'keygen',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const FOREIGN = new Set(['math', 'svg']);
const INTEGRATION = new Set(['mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml', 'foreignobject', 'desc', 'title']);
// The Tokenizer's own raw-text elements (Tokenizer.js, startSpecial): its content is text up to the matching end tag,
// unless the start tag ends with `/>`.
const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea', 'xmp']);
// Laid out as blocks by a browser's default style sheet: a removed one separates lines.
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'dir', 'div',
  'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hgroup', 'html', 'legend', 'li', 'listing', 'main', 'menu', 'nav', 'ol', 'optgroup', 'option', 'p', 'plaintext',
  'pre', 'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'xmp',
]);
// A container whose own text the renderer does not write, with the children that hold its text: one of those may open
// past the cap, so a list at the cap keeps its item and a table its row and cell, and the text below lands in them.
// Without it a list or a table at the cap lost every word under it (T259: nested ul>li, ol>li, tables).
const LI = new Set(['li']);
const ROW = new Set(['tr']);
const HOLDS = new Map<string, Set<string>>([
  ['ul', LI], ['ol', LI], ['menu', LI], ['dir', LI],
  ['table', new Set(['caption', 'thead', 'tbody', 'tfoot', 'tr'])],
  ['thead', ROW], ['tbody', ROW], ['tfoot', ROW],
  ['tr', new Set(['td', 'th'])],
]);
const NON_SPACE = /[^\t\n\f\r ]/;
// A tag the renderer never writes the content of (basic-renderer.ts SKIP_TAGS), by the Tokenizer's lower-case name.
const SKIPPED = new Set([...SKIP_TAGS].map((t) => t.toLowerCase()));

interface Stack {
  names: string[];
  counts: Map<string, number>;
  // htmlparser2's `foreignContext`, its top at the END here (the parser unshifts and reads [0]).
  fc: Array<boolean | undefined>;
}

const newStack = (): Stack => ({ names: [], counts: new Map(), fc: [false] });

const push = (s: Stack, name: string): void => {
  s.names.push(name);
  s.counts.set(name, (s.counts.get(name) ?? 0) + 1);
};

const pop = (s: Stack): string => {
  const name = s.names.pop() as string;
  s.counts.set(name, (s.counts.get(name) as number) - 1);
  return name;
};

const top = (s: Stack): string | undefined => s.names[s.names.length - 1];

// A character that can continue a character reference after `&`: a name, `#`, a number.
const isRefChar = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 35;

// Spaces as the HTML tokenizer means them (NON_SPACE), for a decoded character reference.
const isSpaceCp = (cp: number): boolean => cp === 32 || cp === 9 || cp === 10 || cp === 12 || cp === 13;

interface Scan {
  html: string;
  // the deepest the parse of the INPUT goes (html = 1)
  depth: number;
  // start and end tags removed, and ranges dropped with what they hid
  removed: number;
}

const scan = (html: string, cap: number): Scan => {
  const input = newStack();
  const kept: boolean[] = []; // beside input.names: did this element's start tag stay?
  let removedOpen = 0; // open elements of the input whose start tag was removed
  const output = newStack();
  let depth = 0;
  // the output, written as the tokens go by: the parts before `at`, and what replaced the last removed range
  const parts: string[] = [];
  let at = 0;
  let lastTo = -1;
  let removed = 0;
  let textSinceBreak = false;
  let tagName = '';
  let tagFrom = -1;
  let tagHides = false; // the start tag being read has `hidden` or a hiding inline style
  let attrName = '';
  let attrValue = '';
  // a removed element whose content goes with it: its place in the input stack (1-based), where its start tag began
  let drop: { at: number; from: number; name: string } | null = null;

  const emit = (from: number, to: number, by: string): void => {
    if (from > at) parts.push(html.slice(at, from));
    if (by) parts.push(by);
    at = to;
    lastTo = to;
    removed++;
  };

  // Does the text the parser reads just before `from` end in `<`, or in `&` and the start of a reference? Then text
  // joined across a cut there would open a tag or a reference the page did not have. A replacement right before `from`
  // ends the question: '' only follows text that does not end so, `<br>` and `<!---->` end in `>`.
  const opensBefore = (from: number): boolean => {
    if (from === lastTo) return false;
    const lo = Math.max(lastTo, 0);
    let i = from;
    while (i > lo && isRefChar(html.charCodeAt(i - 1))) i--;
    if (i === lo) return false;
    const c = html.charCodeAt(i - 1);
    return c === 38 /* & */ || (i === from && c === 60 /* < */);
  };

  const replacement = (from: number, name: string): string => {
    if (BLOCK.has(name) && textSinceBreak) {
      textSinceBreak = false;
      return '<br>';
    }
    return opensBefore(from) ? '<!---->' : '';
  };

  const remove = (from: number, to: number, name: string): void => emit(from, to, replacement(from, name));

  // `end`: where the content of a dropped element ends if this pop ends it (its end tag's end, or the start of the
  // token that closes it implicitly).
  const popInput = (end: number): boolean => {
    pop(input);
    const k = kept.pop() as boolean;
    if (!k) removedOpen--;
    if (drop && input.names.length < drop.at) {
      const d = drop;
      drop = null;
      emit(d.from, end, replacement(d.from, d.name));
    }
    return k;
  };

  const openTag = (to: number, selfClosing: boolean): void => {
    const name = tagName;
    const from = tagFrom;
    const hides = tagHides;
    tagName = '';
    // the input's implied closes (Parser.emitOpenTag)
    const closes = IMPLIES_CLOSE.get(name);
    if (closes) while (input.names.length && closes.has(top(input) as string)) popInput(from);
    const inDrop = drop !== null;
    const isVoid = VOID.has(name);
    let keep: boolean;
    if (inDrop) keep = false;
    // raw text the renderer shows (<xmp>) stays at any depth; the others (script, style, title, textarea) take the
    // depth rule and, past the cap, go with their text: kept inside a removed element, a <textarea> closed the
    // <select> on top of the OUTPUT that the input still had open, and what followed showed (T260 soups)
    else if (RAW_TEXT.has(name) && !selfClosing && !SKIPPED.has(name)) keep = true;
    // a void element that closes nothing never touches either stack: <br>, <img> and the rest stay at any depth
    else if (isVoid && !closes) keep = true;
    else if (removedOpen > 0) keep = false;
    else if (isVoid) keep = true;
    else {
      let k = output.names.length;
      if (closes) while (k > 0 && closes.has(output.names[k - 1])) k--;
      keep = k < cap || (k > 0 && HOLDS.get(output.names[k - 1])?.has(name) === true);
    }
    let startsDrop = false;
    if (!isVoid) {
      push(input, name);
      kept.push(keep);
      if (!keep) removedOpen++;
      if (input.names.length > depth) depth = input.names.length;
      if (FOREIGN.has(name)) input.fc.push(true);
      else if (INTEGRATION.has(name)) input.fc.push(false);
      if (!keep && !inDrop && (hides || SKIPPED.has(name))) {
        drop = { at: input.names.length, from, name };
        startsDrop = true;
      }
    }
    // Parser.onselfclosingtag → closeCurrentTag: `/>` closes the element only in a foreign context
    const inClosed = selfClosing && input.fc[input.fc.length - 1] === true && top(input) === name;
    if (inClosed) popInput(to);
    if (!keep) {
      // inside a dropped range, or starting one, nothing is written until it ends
      if (!inDrop && !startsDrop) remove(from, to, name);
      return;
    }
    if (closes) while (output.names.length && closes.has(top(output) as string)) pop(output);
    if (!isVoid) {
      push(output, name);
      if (FOREIGN.has(name)) output.fc.push(true);
      else if (INTEGRATION.has(name)) output.fc.push(false);
    }
    // The output's foreign context can differ from the input's (a removed <svg> pushed only the input's, and a stray
    // context end tag pops each at its top), so `/>` may close a kept element in one parse and not the other. The
    // output follows the input: an explicit end tag, or `>` for `/>`. Otherwise an element open in the output only
    // let a later stray end tag close the hidden <head> it sat under, and the head's text showed (T260 soups).
    const outClosed = selfClosing && output.fc[output.fc.length - 1] === true && top(output) === name;
    if (inClosed && !outClosed && !isVoid) {
      emit(to, to, `</${name}>`);
      pop(output);
      if (FOREIGN.has(name) || INTEGRATION.has(name)) output.fc.pop();
    // (not for a raw-text name: `<xmp>` without the slash would read the rest of the page as its text)
    } else if (outClosed && !inClosed && !RAW_TEXT.has(name)) emit(to - 2, to, '>');
    else if (outClosed) pop(output);
  };

  const closeTag = (name: string, from: number, to: number): void => {
    const context = FOREIGN.has(name) || INTEGRATION.has(name);
    if (context) input.fc.pop();
    let keep = true;
    let closesDrop = false;
    // Parser.onclosetag: the nearest open element of that name closes with everything above it; with none open, a
    // `</p>` opens and closes an empty <p> and a `</br>` makes a <br>, neither of which moves the stack.
    if (!VOID.has(name) && (input.counts.get(name) ?? 0) > 0) {
      for (;;) {
        const isName = top(input) === name;
        const before = drop;
        const k = popInput(isName ? to : from);
        if (isName) {
          keep = k;
          closesDrop = before !== null && drop === null && before.at === input.names.length + 1;
          break;
        }
      }
    }
    // an end tag inside a dropped range, or the one that ends it, went with it
    if (drop !== null || closesDrop) return;
    if (!keep) {
      remove(from, to, name);
      return;
    }
    if (context) output.fc.pop();
    if (!VOID.has(name) && (output.counts.get(name) ?? 0) > 0) while (pop(output) !== name);
  };

  const noop = (): void => undefined;
  const tokenizer = new Tokenizer(
    { xmlMode: false, decodeEntities: true },
    {
      onopentagname(start: number, end: number) {
        tagName = html.slice(start, end).toLowerCase();
        tagFrom = start - 1;
        tagHides = false;
      },
      onopentagend(end: number) {
        openTag(end + 1, false);
      },
      onselfclosingtag(end: number) {
        openTag(end + 1, true);
      },
      onclosetag(start: number, end: number) {
        // the Tokenizer skips spaces between `</` and the name (stateBeforeClosingTagName), then to the next `>`
        const lt = html.lastIndexOf('<', start);
        const gt = html.indexOf('>', end);
        closeTag(html.slice(start, end).toLowerCase(), lt, gt === -1 ? html.length : gt + 1);
      },
      ontext(start: number, end: number) {
        if (!drop && !textSinceBreak && NON_SPACE.test(html.slice(start, end))) textSinceBreak = true;
      },
      ontextentity(cp: number) {
        if (!drop && !isSpaceCp(cp)) textSinceBreak = true;
      },
      onattribname(start: number, end: number) {
        attrName = html.slice(start, end).toLowerCase();
        attrValue = '';
        if (attrName === 'hidden') tagHides = true;
      },
      onattribdata(start: number, end: number) {
        if (attrName === 'style') attrValue += html.slice(start, end);
      },
      onattribentity(cp: number) {
        if (attrName === 'style') attrValue += String.fromCodePoint(cp);
      },
      onattribend() {
        if (attrName === 'style' && STYLE_HIDDEN_RE.test(attrValue)) tagHides = true;
        attrName = '';
      },
      oncdata: noop,
      oncomment: noop,
      ondeclaration: noop,
      onend: noop,
      onprocessinginstruction: noop,
    },
  );
  tokenizer.write(html);
  tokenizer.end();
  if (drop) {
    const d = drop as { at: number; from: number; name: string };
    drop = null;
    emit(d.from, html.length, replacement(d.from, d.name));
  }
  if (!removed) return { html, depth, removed: 0 };
  if (at < html.length) parts.push(html.slice(at));
  return { html: parts.join(''), depth, removed };
};

// The HTML, with every element that would open deeper than `cap` levels removed (its shown text kept). A page that
// never nests deeper comes back as the same string.
export const capNesting = (html: string, cap: number = MAX_PARSE_DEPTH): string => scan(html, cap).html;

// How deep htmlparser2 10.1.0 nests this HTML (html = 1), and how many tags and ranges capNesting would remove: for
// tests.
export const nestingDepth = (html: string, cap: number = MAX_PARSE_DEPTH): { depth: number; removed: number } => {
  const { depth, removed } = scan(html, cap);
  return { depth, removed };
};

// An element the renderer never shows the content of, as the tree has it (basic-renderer.ts hiddenKind, SKIP_TAGS).
const hidesInTree = (el: Element): boolean =>
  SKIP_TAGS.has(el.tagName.toUpperCase()) || el.hasAttribute('hidden') || STYLE_HIDDEN_RE.test(el.getAttribute('style') || '');

// What an element too deep for the walks leaves in its place, in document order: its text and other non-element nodes,
// its void elements (<br>, <img>: leaves), and a <br> where a block began or ended after text, as the text pass does;
// nothing from an element that hides its content. Iterative: the element may be thousands deep.
const flatten = (el: Element, doc: Document): Node[] => {
  const held: Node[] = [];
  const prev = el.previousSibling;
  let textSince = prev !== null && (prev.nodeType === 1
    ? (prev as Element).tagName.toUpperCase() !== 'BR'
    : prev.nodeType === 3 && NON_SPACE.test(prev.textContent || ''));
  const brk = (): void => {
    if (textSince) {
      held.push(doc.createElement('br'));
      textSince = false;
    }
  };
  const stack: Array<[Node, boolean]> = [[el, false]];
  while (stack.length) {
    const [n, leaving] = stack.pop() as [Node, boolean];
    if (n.nodeType !== 1) {
      held.push(n);
      if (n.nodeType === 3 && NON_SPACE.test(n.textContent || '')) textSince = true;
      continue;
    }
    const e = n as Element;
    const name = e.tagName.toLowerCase();
    if (leaving) {
      if (BLOCK.has(name)) brk();
      continue;
    }
    if (hidesInTree(e)) continue;
    if (VOID.has(name)) {
      held.push(e);
      if (name === 'br') textSince = false;
      continue;
    }
    if (BLOCK.has(name)) brk();
    stack.push([e, true]);
    for (let c = e.lastChild; c; c = c.previousSibling) stack.push([c, false]);
  }
  return held;
};

// After the parse, a second bound on the tree itself, for what the text pass cannot see: the React streaming replay
// (convert.ts) moves a segment's children into its boundary, so a segment that holds the boundary of the next one
// stacks their depths, and stray nodes after </body> move into the body. Every element deeper than `cap` (html = 1)
// is replaced by what flatten leaves of it. After the text pass a tree is at most MAX_PARSE_DEPTH + 5 deep (+3 for a
// table's section, row and cell past the cap, +1 for a raw-text or void leaf, +1 for strays moved into the body), so
// the margin keeps this a no-op for it. Iterative: the tree may be that deep. Returns the number of elements replaced.
export const boundTreeDepth = (doc: Document, cap: number = MAX_PARSE_DEPTH + 8): number => {
  const root = doc.documentElement;
  if (!root) return 0;
  const tooDeep: Element[] = [];
  const work: Array<[Element, number]> = [[root, 1]];
  while (work.length) {
    const [el, d] = work.pop() as [Element, number];
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (d + 1 > cap) tooDeep.push(c);
      else work.push([c, d + 1]);
    }
  }
  let replaced = 0;
  for (const el of tooDeep) {
    const parent = el.parentNode;
    if (!parent || VOID.has(el.tagName.toLowerCase())) continue;
    for (const n of flatten(el, doc)) parent.insertBefore(n, el);
    parent.removeChild(el);
    replaced++;
  }
  return replaced;
};
