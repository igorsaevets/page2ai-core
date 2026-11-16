// A cap on how deep the parsed document can nest, applied to the HTML text BEFORE linkedom parses it (P2A-033, P2A-036).
//
// Two costs grow with nesting depth, and a page of a few hundred KB can be nested 100,000 deep:
//  - the parse: htmlparser2 10.1.0 (linkedom's parser) keeps its stack of open elements at the FRONT of an array, so
//    every start and end tag costs O(depth): 100,000 nested <div> took 15 s, 100,000 nested tables 116 s (P2A-036;
//    fixed on htmlparser2 master, in no release, and linkedom requires ^10.1.0);
//  - core's own walks recurse once or more per level: in Chrome 157's dedicated worker (where the online converter runs
//    core) a page of nested <blockquote>, <figure> or hidden tab panels failed at about 390 levels, at about 800 in Node
//    (T259, cold runs), and the whole page became the «extraction failed» document (P2A-033).
// A pass after parsing comes too late for the first cost, so this one runs on the text.
//
// It replays htmlparser2 10.1.0's Parser over htmlparser2's own Tokenizer (the one linkedom's parse runs), so it sees
// the stack the parse will build: the implied closes of `openImpliesClose` (a start tag closes only the run of matching
// elements on TOP of the stack), void elements, `/>` closing an element only in svg/math context (`foreignContext`,
// including its quirks: an integration element's or a math/svg end tag pops that context even when nothing matches, and
// `<svg/>` leaves its entry behind), an end tag closing the nearest open element of its name and everything above it,
// and the stray `</p>` and `</br>`. Browsers bound the tree the same way (HTML parser limit 512 in Blink, WebKit and
// Gecko: whatwg/html#3732) while their stack of open elements, which matches end tags, stays unbounded; this pass keeps
// both too: the stack of the INPUT decides which end tags belong to a removed element, the stack of the OUTPUT decides
// what may open.
//
// A page whose parse never goes deeper than the cap comes back as the same string, unchanged, so its Markdown is
// byte-identical by construction (the deepest of 1,065 saved real pages is 42). Deeper, the start tag of every element
// that would open below the cap is removed with its end tag, and its text stays where it was, in the element at the
// cap. A removed block tag (div, p, li, td...) becomes a <br> when text came since the last one, so lines stay apart;
// any other becomes nothing (a space after a `<`, which could otherwise start a new tag). Browsers keep such elements
// as siblings at the limit instead; here their attributes go (links below the cap), which only pages that failed or
// stalled until now can lose. Void elements that close nothing (<br>, <img>...) stay at any depth: they never touch
// a stack. The tags of raw-text elements (script, style, title, textarea, xmp: the Tokenizer reads their content as
// text) always stay too, so the text is tokenized exactly as before; they hold no elements.
// The pass is linear: each element is pushed and popped once on each stack, an end tag finds its element through a count
// per name, and an implied close looks at the top of the stack only.
import { Tokenizer } from 'htmlparser2';

// How deep the parse may nest (html = 1). About half of the shallowest failure measured (Chrome's worker, ~390 levels),
// for shapes not measured, other browsers' workers and frames added later; 4.8x the deepest real page saved.
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

interface Scan {
  html: string;
  // the deepest the parse of the INPUT goes (html = 1)
  depth: number;
  // start and end tags removed
  removed: number;
}

const scan = (html: string, cap: number): Scan => {
  const input = newStack();
  const kept: boolean[] = []; // beside input.names: did this element's start tag stay?
  let removedOpen = 0; // open elements of the input whose start tag was removed
  const output = newStack();
  let depth = 0;
  // byte ranges to replace, in order: [from, to) and the replacement
  const cuts: Array<[number, number, string]> = [];
  let textSinceBreak = false;
  let tagName = '';
  let tagFrom = -1;

  const popInput = (): boolean => {
    pop(input);
    const k = kept.pop() as boolean;
    if (!k) removedOpen--;
    return k;
  };

  const remove = (from: number, to: number, name: string): void => {
    let by = '';
    if (BLOCK.has(name) && textSinceBreak) {
      by = '<br>';
      textSinceBreak = false;
    } else {
      // the last character the parser will see before this point: a `<` there followed by a name would open a tag
      const prev = cuts.length && cuts[cuts.length - 1][1] === from ? cuts[cuts.length - 1][2] : html.slice(from - 1, from);
      if (prev.endsWith('<')) by = ' ';
    }
    cuts.push([from, to, by]);
  };

  const openTag = (to: number, selfClosing: boolean): void => {
    const name = tagName;
    const from = tagFrom;
    tagName = '';
    // the input's implied closes (Parser.emitOpenTag)
    const closes = IMPLIES_CLOSE.get(name);
    if (closes) while (input.names.length && closes.has(top(input) as string)) popInput();
    const isVoid = VOID.has(name);
    let keep: boolean;
    if (RAW_TEXT.has(name) && !selfClosing) keep = true;
    // a void element that closes nothing never touches either stack: <br>, <img> and the rest stay at any depth
    else if (isVoid && !closes) keep = true;
    else if (removedOpen > 0) keep = false;
    else if (isVoid) keep = true;
    else {
      let k = output.names.length;
      if (closes) while (k > 0 && closes.has(output.names[k - 1])) k--;
      keep = k < cap || (k > 0 && HOLDS.get(output.names[k - 1])?.has(name) === true);
    }
    if (!isVoid) {
      push(input, name);
      kept.push(keep);
      if (!keep) removedOpen++;
      if (input.names.length > depth) depth = input.names.length;
      if (FOREIGN.has(name)) input.fc.push(true);
      else if (INTEGRATION.has(name)) input.fc.push(false);
    }
    // Parser.onselfclosingtag → closeCurrentTag: `/>` closes the element only in a foreign context
    if (selfClosing && input.fc[input.fc.length - 1] && top(input) === name) popInput();
    if (!keep) {
      remove(from, to, name);
      return;
    }
    if (closes) while (output.names.length && closes.has(top(output) as string)) pop(output);
    if (!isVoid) {
      push(output, name);
      if (FOREIGN.has(name)) output.fc.push(true);
      else if (INTEGRATION.has(name)) output.fc.push(false);
    }
    if (selfClosing && output.fc[output.fc.length - 1] && top(output) === name) pop(output);
  };

  const closeTag = (name: string, from: number, to: number): void => {
    const context = FOREIGN.has(name) || INTEGRATION.has(name);
    if (context) input.fc.pop();
    let keep = true;
    // Parser.onclosetag: the nearest open element of that name closes with everything above it; with none open, a
    // `</p>` opens and closes an empty <p> and a `</br>` makes a <br>, neither of which moves the stack.
    if (!VOID.has(name) && (input.counts.get(name) ?? 0) > 0) {
      for (;;) {
        const isName = top(input) === name;
        const k = popInput();
        if (isName) {
          keep = k;
          break;
        }
      }
    }
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
      },
      onopentagend(end: number) {
        openTag(end + 1, false);
      },
      onselfclosingtag(end: number) {
        openTag(end + 1, true);
      },
      onclosetag(start: number, end: number) {
        // the Tokenizer skips to the next `>` after the name (stateAfterClosingTagName)
        const gt = html.indexOf('>', end);
        closeTag(html.slice(start, end).toLowerCase(), start - 2, gt === -1 ? html.length : gt + 1);
      },
      ontext(start: number, end: number) {
        if (!textSinceBreak && NON_SPACE.test(html.slice(start, end))) textSinceBreak = true;
      },
      ontextentity() {
        textSinceBreak = true;
      },
      onattribdata: noop,
      onattribentity: noop,
      onattribend: noop,
      onattribname: noop,
      oncdata: noop,
      oncomment: noop,
      ondeclaration: noop,
      onend: noop,
      onprocessinginstruction: noop,
    },
  );
  tokenizer.write(html);
  tokenizer.end();
  if (!cuts.length) return { html, depth, removed: 0 };
  const parts: string[] = [];
  let at = 0;
  for (const [from, to, by] of cuts) {
    parts.push(html.slice(at, from), by);
    at = to;
  }
  parts.push(html.slice(at));
  return { html: parts.join(''), depth, removed: cuts.length };
};

// The HTML, with every element that would open deeper than `cap` levels removed (its text kept). A page that never
// nests deeper comes back as the same string.
export const capNesting = (html: string, cap: number = MAX_PARSE_DEPTH): string => scan(html, cap).html;

// How deep htmlparser2 10.1.0 nests this HTML (html = 1), and how many tags capNesting would remove: for tests.
export const nestingDepth = (html: string, cap: number = MAX_PARSE_DEPTH): { depth: number; removed: number } => {
  const { depth, removed } = scan(html, cap);
  return { depth, removed };
};

// After the parse, a second bound on the tree itself, for what the text pass cannot see: the React streaming replay
// (convert.ts) moves a segment's children into its boundary, so a segment that holds the boundary of the next one
// stacks their depths, and stray nodes after </body> move into the body. Every element deeper than `cap` (html = 1) is
// replaced by the text and other nodes it holds, in document order. After the text pass a tree is at most
// MAX_PARSE_DEPTH + 5 deep (+3 for a table's section, row and cell past the cap, +1 for a raw-text or void leaf, +1 for
// strays moved into the body), so the margin keeps this a no-op for it. Iterative: the tree may be that deep. Returns
// the number of elements replaced.
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
  for (const el of tooDeep) {
    const parent = el.parentNode;
    if (!parent) continue;
    const held: Node[] = [];
    const stack: Node[] = [el];
    while (stack.length) {
      const n = stack.pop() as Node;
      if (n.nodeType !== 1) held.push(n);
      else for (let c = n.lastChild; c; c = c.previousSibling) stack.push(c);
    }
    for (const n of held) parent.insertBefore(n, el);
    parent.removeChild(el);
  }
  return tooDeep.length;
};
