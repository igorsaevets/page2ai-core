# Changelog

All notable changes to `@page2ai/core`.

## 0.4.22

P2A-081 (filed by the T279 review panel) and what measuring it found (T285). Each browser case was loaded in Chrome 158
with React's own runtimes; every new test fails on 0.4.21.

- **A React streaming segment that no call reveals is no longer printed (P2A-081).** The renderer printed a hidden
  element with a React segment id (`<div hidden id="S:0">`, a `<table hidden>` segment) as shown: a recovery from before
  the streaming replay, for pages whose calls cannot be replayed. Chrome never shows such a segment, so any page could
  put text there that no reader sees and an AI reads. On the 1,065 saved pages and 35 live Next.js, Mintlify and Remix
  pages (12 of them stream: 29 segments, each revealed by a call) the output is the same without the recovery.
- **A `<main>` inside such a segment is no longer the root (P2A-082).** With no other `<main>` on the page, 0.4.21
  took that one and printed only the hidden text: the visible page was dropped.
- **React's external runtime is replayed.** With `unstable_externalRuntimeSrc` (in Next.js the App Router flag that a
  canary took on 2026-11-02, vercel/next.js#97570, for a Content-Security-Policy without `unsafe-inline`) React sends
  the calls as `<template data-rci>`, `data-rri` and `data-rsi`; they now run in document order as its script runs
  them, and `data-rxi` keeps the fallback. On the page react-dom's own renderer writes, 0.4.21 printed the fallbacks
  ("Loading") and lost the late section and table row, which arrive outside `<main>`; 0.4.22 gives Chrome's text. Two
  shapes React never writes differ from Chrome: templates with no runtime script are replayed (as inline calls are),
  and a template placed before its segment keeps the fallback.

## 0.4.21

Found by the T279 review panel (P2A-076..080) and measured again before the fix (T280): each browser case was loaded
in Chrome 158 with react-dom 19.3.1's own inline runtime and read once React's reveal had run. Every new test fails on
0.4.20.

- **Attribute names are fixed in one pass (P2A-076).** 0.4.20 removed every attribute of an element whose names needed
  lowercasing and set them back, and linkedom walks an element's attribute list for each name: one element with 20,000
  upper-case attributes took 0.9 s, 40,000 took 5.3 s (0.4.19 did the same for HTML elements; 0.4.20 added SVG ones).
  Names are now renamed where they stand: 80,000 attributes take 0.26-0.38 s.
- **No call finds an element inside `<noscript>`, `<iframe>`, `<noembed>`, `<noframes>` or `<xmp>` (P2A-077).** A
  browser that runs scripts reads their content as text, so React's calls cannot reach a segment there; 0.4.20 moved a
  segment out of a `<noscript>` into the page, text that Chrome never shows.
- **A first move is not counted against the replay's budget (P2A-078).** Each node is moved for the first time at most
  once, so only moving it again can repeat. 0.4.20 counted every child, so after a chain of fills had spent the budget a
  fresh segment of more than 64 children (200 paragraphs, in the panel's case) kept its fallback where Chrome showed it.
  0.4.20's note that no budget cuts legitimate fills short was wrong for that case. A chain that moves the same children
  again and again still stops where the budget does: Chrome makes all of those moves, and the work grows with the square
  of the chain, so there the replay keeps that chain's fallback.
- **A segment that a call reached and did not reveal stays hidden (P2A-079).** After a reveal that throws in the browser
  (a segment holding its own boundary), the later queued segments stay hidden in Chrome; 0.4.20 printed them, and also a
  segment refused for cost next to its fallback. Segments that no replayed call names are still printed, as before.
- **`$RC` marks whatever stands before the boundary's `<template>`; a call that throws ends its script (P2A-080).**
  React's `$RC` sets `.data` on the previous sibling without checking it, so Chrome fills a boundary opened by `$!`, `&`,
  another comment, an element or a space (the space then reads `$`); 0.4.20 required a `$?`/`$~` comment and kept the
  fallback. With nothing before the template `$RC` throws, as does `$RS` on a missing segment or placeholder, and the
  rest of that script does not run; 0.4.20 went on with it.

## 0.4.20

Found by the T277 review panel (P2A-072..075). What a browser does was measured first (T279): each case was loaded in
Chrome 158 with react-dom 19.3.1's own inline runtime and read once React's reveal had run.

- **The streaming replay works the way React's runtime does, and no budget cuts legitimate fills short (P2A-072).**
  React's `$RC` only looks its two elements up as its script runs and queues the pair; the runtime reveals the queue
  once the page is parsed, in call order, and each reveal removes every node from the boundary to its end comment (to
  the end of the parent when there is none). The replay now runs the same way: every call in document order, `$RS` at
  once, then the queued fills. A fill removes every node it scans, so the scans add up to the page, and 0.4.19's
  budget (128 steps per element, counting comments and text too) no longer stops the replay: 40 fills whose fallbacks
  hold 8,000 comments each all happen (0.4.19: 6 of 40), and a valid fill after 1,000 or 4,000 boundaries with no end
  comment prints its content (0.4.19: the fallback). What can still repeat (the test that a segment does not hold its
  own boundary, and children moved again through nested segments) counts against 4 steps per byte of the page; past
  that a fill may spend 64 steps, and one that needs more keeps its fallback while the later fills go on.
- **Crafted pages print what Chrome shows.** A boundary with no end comment takes every later sibling in its parent and
  gets the content at the end (0.4.18 and 0.4.19 kept the fallback); a `$RC` script that a fill removes still counts,
  because it ran when it was parsed (P2A-073: 0.4.19 skipped it); a segment that an earlier fill removed still fills its
  own boundary; calls naming one segment id all get the first segment, which fills the first boundary while the others
  lose their fallback (P2A-074: the lookup no longer copies the id's list per call either, so 40,000 such calls take
  1.0 s instead of 2.8 s); a segment that holds its own boundary is dropped and no later fill is made (in Chrome the
  move throws HierarchyRequestError, or never ends when the boundary is the segment's own child).
- **Attribute names on SVG and MathML elements are lowercased too (P2A-075),** ASCII letters only, keeping the first of
  two names that then match and restoring SVG's 58 camelCase names (`viewBox`...) and MathML's `definitionURL`, as
  Chrome parses them: an uppercase `<svg ARIA-HIDDEN STYLE>` segment wrapper is found, and U+212A KELVIN SIGN no
  longer becomes `k`.
- Real pages are unchanged: all 1,065 saved pages (4 of them stream) and 8 live streaming pages (Next.js, Vercel,
  Claude docs, Supabase, shadcn/ui, Turborepo, Cursor, Remix; fetched 2026-11-20) convert byte for byte as on 0.4.19.
- README: the order of the replay; text under `aria-hidden="true"` past the depth cap stays (it is on screen).

## 0.4.19

Found while re-measuring the T261 review panel's claims (T277).

- **A chain of streaming fills no longer takes a minute (P2A-061).** The React streaming replay looked each element up
  with linkedom's `isConnected` and refused a segment that holds its own boundary with `contains`; both walk to the
  root, once per call. A page whose fills chain (each segment holds a few nested elements around the next boundary)
  therefore cost the square of its length in every version with the replay: 16,000 fills (4.6 MB) took 64 s, 4,000
  fills 190 levels apart (8.9 MB) 51 s. An element the replay detaches is now remembered, so a lookup needs no walk,
  and the containment test walks up from the boundary and through the segment in step, so it costs the shorter walk:
  1.0 s and 1.8 s, the same Markdown. A script whose `<template>`/`<noscript>` ancestor, or a segment row whose table,
  would lie more than 208 levels up is not replayed, and the replay stops once its steps pass 128 per element of the
  page; the segments not moved by then stay where they stand, as on a page whose scripts did not run. No saved page
  comes near either limit: all 1,065 convert as on 0.4.18 except the six below.
- **Attribute names are read whatever their case (P2A-071).** linkedom keeps attribute names as the page wrote them and
  compares them exactly, so `<div HIDDEN>`, `<p STYLE="display:none">` and `<div Aria-Hidden="true">` were printed at
  every depth in every version (a browser hides the first two), `<a HREF>` and `<img SRC ALT>` lost their link, image
  and alt text, and React's `colSpan`/`rowSpan` were ignored. Names on HTML elements are now lowercased after parsing,
  the first of two that differ only in case kept, as a browser parses HTML (SVG keeps `viewBox` and the like). Six of
  1,065 saved pages change: five gain link targets or image names that were lost, and a pricing table's header lines up
  with its columns again.
- A test checks that core and linkedom resolve one copy of htmlparser2, version 10.1.0: the depth cap replays that
  version's stack rules, and a second copy or another major would make the two disagree without an error.
- README: past the depth cap every hidden kind is left out, with `includeHidden` or without; an inline `display:none` or
  `visibility:hidden` hides, a style sheet is not read.

Known and open: past the cap, a stray `</desc>` or `</svg>` inside a removed element can leave the rest of the page in
another parse context, so a few words that the same markup hides at depth 3 still show (P2A-062; two minimal repros
from the T261 panel). Text under `aria-hidden` shows past the cap, as in 0.4.17 and 0.4.18.

## 0.4.18

Fixes in the 0.4.17 depth cap, found by re-measuring the T259 review panel's claims (T260).

- **Hidden text no longer shows past the cap.** 0.4.17 removed the tags of elements deeper than 200 levels and kept
  their text, so text the renderer keeps out (the `hidden` attribute, inline `display:none` or `visibility:hidden`,
  `<template>`, `<noscript>`, `<select>`, `<svg>`, a self-closed `<script/>`) was written into the Markdown once a page
  wrapped it in 200 elements; 0.4.16 wrote none of it at any depth. Such an element is now removed past the cap
  together with its content, by the text pass and by the tree bound. The hidden kinds the renderer does show (tab
  panels, code in a hidden block, React segments, `until-found`) are dropped too past the cap.
- `<script>`, `<style>`, `<title>` and `<textarea>` follow the depth rule like other elements (past the cap they go with
  their text); only `<xmp>` stays at any depth. A `<textarea>` kept inside a removed element closed a `<select>` in the
  output that the input still had open, and what followed it showed.
- Where `/>` closes a kept element in one parse and not the other (a removed `<svg>` changed the output's foreign
  context), the output now follows the input: an explicit end tag, or `>` for `/>` (not for raw-text names). On 5,000
  seeded tag soups with a cap of 6, the text shown outside hiding elements is identical before and after the cap except
  for 5 words in 4 soups (0.4.17: every hidden element past the cap).
- Text joined across a removed tag no longer forms a character reference or a tag the page did not have:
  `X&<b>amp;</b>Y` read `X&Y`, `Q&#6<b>5;</b>R` read `QAR`, and `a<<b>div>` read `a< div>`; an empty comment now
  separates them. An end tag with spaces after `</` (`</ div>`) no longer leaves `<` or `</` in the text. `&#32;` before
  a removed block no longer counts as text.
- The tree bound (208 levels, after the React streaming replay) kept only text: blocks ran together (`W1 oneW2 two`),
  and `<br>` and `<img>` were lost. It now writes a `<br>` where a block began or ended after text, keeps void elements,
  and drops hidden content.
- The text pass writes its output as it goes: 0.4.17 kept every cut in a list, about 570 MB for 9 MB of nested tags.
- Corrections to the 0.4.17 notes: a page nested deeper than 200 levels loses its structure below 200 (links, headings,
  tables), and pages between 201 and the old limits (Chrome's worker: nested tables 347 levels, blockquotes ~390; Node
  ~800) converted whole on 0.4.16, so it is not only pages that failed. The depth counts `<html>` and `<body>`, and a
  fragment is measured inside its shell. Past the cap, inline elements join as the browser shows their text
  (`<span>a</span><span>b</span>` reads `ab`, without the space the renderer puts between two inline elements). The
  pass costs about 6 ms per MB of prose and up to about 28 ms per MB of tag-dense markup.

## 0.4.17

### Fixed

- **Deeply nested pages convert, with their text, in linear time (P2A-033, P2A-036).** A page nested past about 800
  levels (about 390 in Chrome's Web Worker, where the online converter runs core: nested `<blockquote>`, `<figure>` or
  hidden tab panels) became the «extraction failed» document, because the walks recurse per level; and the parse alone
  cost the square of the depth (htmlparser2 10.1.0, linkedom's parser, keeps its stack at the front of an array:
  100,000 nested `<div>` took 15 s, 100,000 nested tables 116 s, before any core code ran). A pass over the HTML text
  now caps nesting at 200 levels BEFORE linkedom parses it (`src/node/depth-cap.ts`). It replays htmlparser2's own
  Parser over its own Tokenizer (implied closes, void elements, `/>` in svg/math, raw text, stray `</p>` and `</br>`),
  so it sees the stack the parse will build: on all 1,065 saved real pages its depth equals the parser's (deepest 42),
  and a page no deeper than 200 comes back as the same string, so its Markdown is byte-identical. Deeper, the start
  tag of every element that would open past the cap is removed with its end tag; its text stays, in the element at the
  cap; a removed block tag becomes a line break when text came since the last one; `<br>`, `<img>` and raw-text
  elements stay; a list or a table at the cap keeps one item, row and cell so its text is written. As in browsers
  (whatwg/html#3732), the stack that matches end tags is unbounded and only the tree is capped. 18 shapes at 10,000
  and 40,000 levels convert with their innermost text in time linear in the page; 100,000 nested `<div>` take about
  50 ms. The pass costs about 6 ms per MB. After the parse, a second bound on the tree (208 levels) catches what the
  text pass cannot see: the React streaming replay stacking a segment into another segment's boundary.
- The P2A-044 test now nests 190 tab lists around 25,000 tabs (0.4.11: 2.8 s): 1,000 nested lists are past the cap,
  where their tabs are plain text.

### Tests

- The 0.4.16 frame test (P2A-055) counted every stack line that contained «renderNodeWithTabs», so a helper with that
  name in its own hid its frame (T256 panel, Hy4: four frames, 13% less depth), and it built three of the chains through
  which the walk goes one level deeper, so a frame added on a list item, a `<dl>` or a tab list that is itself a
  second-walk panel passed too (GLM). T257 measured each of the four on a copy of the renderer. The test now counts
  frames of `renderNodeWithTabs` only, in V8's own stack format, and builds a chain for each place where the walk
  recurses (nine), each held to the frames it had on 0.4.16. It fails on 0.4.13, 0.4.14 and 0.4.15, and on five copies
  of the renderer that each add one frame on one path.

### Corrections to the 0.4.16 entry

- 0.4.16 also fixed a tab list that is itself a panel of a hidden tab list: 0.4.13 / 0.4.15 / 0.4.16 convert 1,038 /
  743 / 1,160 levels (0.4.15 seven frames a level, 0.4.16 four; T256 panel: DeepSeek, GLM, Hy4, AGY). The depth figures
  of both entries are Node 24.21.0's: on Node 20 the same chains convert deeper (T256 panel, GLM: 878 plain `<div>`s),
  so only figures from one Node version compare. The frame count does not fix a chain's depth: a chain of `<details>`
  has the four frames of a chain of `<div>`s and converts 1,495 levels, and nested inline elements 1,872.

## 0.4.16 - 2026-11-15

### Fixed

- **A chain of tab groups or of second-walk panels still survived ~13% less nesting than on 0.4.13 (P2A-055, left by
  0.4.15).** 0.4.15 took the extra stack frame off the plain path only: each level of a chain of tab groups still went
  through `writeGroup` and its `forEach` callback, and each level of a chain of panels written where they stand (second
  walk) through `renderInPlace`. Levels that convert in a fresh process, 0.4.13 / 0.4.15 / 0.4.16: tab groups each in the
  first panel of the last 1,005 / 871 / 1,108; panels of hidden tab lists each in the last 798 / 690 / 804; plain `<div>`,
  `<ul><li>` and `<blockquote>` chains as on 0.4.15 within the search step of 3 (801, 942, 801).
  `writeGroup` loops without a callback, and an in-place panel is marked and unmarked by two small calls that return
  before the walk goes deeper. A test counts the stack frames between two levels at the innermost element: four for
  plain `<div>`s (0.4.14 had five) and no more for a chain of tab groups (0.4.13 five, 0.4.15 six) or of second-walk
  panels (0.4.15 five). The depth limit itself is P2A-033.

### Corrections to the 0.4.15 entry

- «One stack frame per level again» and «are functions of their own again» held for the plain path only: in 0.4.13 the
  group write was inside `renderNodeWithTabs` and a second-walk panel went through `renderNode` like any element, so
  0.4.15 added a frame on those paths (T255 panel: Grok, Hy4, DeepSeek and GLM measured it). The warm figures (1,734 and
  2,181) depend on what the warm-up optimised and do not reproduce elsewhere; only the cold, fresh-process figures
  compare.

### Known, not fixed here

- The text after a tab widget reads as the last tab's content, and after a bare last heading as that tab's only content
  (P2A-056, every version). A second tab bar naming the same panels under other labels has its labels written nowhere
  (P2A-057, since 0.4.11).

## 0.4.15 - 2026-11-15

### Fixed

- **A page survived ~13% less nesting depth on 0.4.14 (P2A-053, new in 0.4.14).** 0.4.14 put one more function between
  `renderNodeWithTabs` and `renderNode` for every element, not only for tab groups, so each level of nesting cost one more
  stack frame, and a deeper page became the «extraction failed» document. Nested `<div>`s that convert in a fresh process:
  0.4.13 793, 0.4.14 691, 0.4.15 799; after a warm-up, in one build tree, 0.4.14 1,734 and 0.4.15 2,181 (binary search,
  each trial a fresh process). The in-place panel and the group write are functions of their own again, called only for
  such an element. The depth limit itself is P2A-033.
- **A tab whose panel a nested tab list already wrote lost its heading, and with it its label (P2A-054, new in 0.4.14).**
  0.4.14 left out, heading included, a panel written since its group started. An unselected tab is a control, so the label
  is written only in its heading: in `[Alpha][Beta]` whose panel B the inner list `[Bee][Cee]` wrote, «Beta» appeared
  nowhere. Such a tab keeps a bare `### Tab: Beta` again, as before 0.4.14 and as a second tab naming the same panel does
  (P2A-042).

### Corrections to the 0.4.14 entry

- The test «3,000 tab lists hanging off one chain» and the «4,000 lists: 312 → 42 ms» above timed a page too deep to
  convert: both arms returned the «extraction failed» document (T254 panel: Hy4, DeepSeek). At a depth that converts
  (300 levels, 6,000 lists) 0.4.13 costs 1.37× the same `<div>`s and 0.4.14 1.12×. The test now converts a 300-deep chain
  and checks its Markdown.
- All ten new 0.4.14 tests fail on 0.4.13, not nine: the aria-hidden test fails there too (KTEXT twice). The timing test's
  verdict on 0.4.13 depends on the machine.
- `aria-selected` without trim also changes a tab outside any group: a lone `role="tab"` whose value is ` false ` or a
  lone space is selected, so its label is written where 0.4.13 skipped it as a control. As in Chrome 157, and as WAI-ARIA
  1.2 §9.2 says («Treat any other value as true»).
- «The code tabs keep their headings» holds when the tab list comes before its panels. A panel written where it stands
  BEFORE its tab list (a list after its panels, a list inside its own panels, an inline panel) is written once without
  its heading, and that list's labels are not written (filed under P2A-050). The second walk runs on none of the 1,065
  saved pages.

### Known, not fixed here

- A tab panel that is a list item, a table cell, a caption or a dt/dd, or sits in a heading or alone in a link, is
  written twice in every version (P2A-051). A panel that is itself a `<pre>`, link, list or table loses that formatting
  when its group writes it (P2A-052).

## 0.4.14 - 2026-11-15

### Fixed

- **A tab widget inside a panel of an unreached tab list was written twice (P2A-050, new in 0.4.13).** 0.4.13's second
  walk wrote such panels where they stand, and a tab list it reached inside one of them wrote its own panels, which the
  walk then wrote again where they stand: code tabs inside a panel of a hidden tab bar came out twice, three levels
  three times, and a tab list inside the four nested panels it names wrote the innermost one five times. A panel is now
  written once, by its group or in its place, whichever comes first; the code tabs keep their headings. 0.4.12 lost
  this text instead.
- **`aria-selected` is not trimmed (P2A-049).** Chrome 157 selects ` false `, `false ` and a lone space; only `false`
  in any case is not selected. 0.4.13 trimmed, so a shared panel went under the first tab when the second said
  ` false `. The case is folded in ASCII only, as Chrome folds it.
- **Lists hanging off one chain inside an outer tab list climbed it again each (P2A-046).** 0.4.13 recorded only «no
  list above», so 4,000 such lists (199 KB) took 312 ms; each element is now climbed past once: 42 ms.

### Changed

- On 1,065 saved pages the output is byte-identical to 0.4.13, and the second walk runs on none of them: the changed
  paths are reached only by the shapes in `tests/node/tab-refs.test.ts`. The 0.4.13 entry below said «trimmed» and «all
  caches are reset»: the button, text and id caches and the written-panels set are reset; the tab groups are kept.

## 0.4.13 - 2026-11-15

### Fixed

- **The panels of a tab list the walk never reaches were lost (P2A-047).** A tab list in a hidden block (the `hidden`
  attribute or `display:none` on the list or on a wrapper) still claimed its panels, so they were skipped where they
  stand and never written: a page whose tab list stays hidden until a script runs lost every visible panel. Such panels
  are now written where they stand, without the hidden tab labels (the page is walked a second time, only when a group
  wrote nothing). Every version with tab groups had it.
- **Nested tab lists whose tabs name no panel each collected every tab inside them (P2A-046).** 0.4.12 skipped a nested
  list only inside a list that formed a group, so lists whose tabs name no panel still cost k × n: 500 lists around
  20,000 tabs took 7.9 s. A list inside any list is now skipped (the outer one holds every tab below it), and a tab's
  label is read only once its `aria-controls` names a panel: 2.1 s, what the same buttons cost in 500 nested `<div>`s
  (each button climbs its ancestors, a cost of depth tracked as P2A-033).
- **`aria-selected` is read as Chrome reads it (P2A-049):** trimmed and case-insensitive; `false` is not selected, an
  empty value and `undefined` are no state, and any other value is selected (Chrome 157, measured through its
  accessibility tree). `True` from a template put a shared panel under the wrong tab and dropped a selected tab's label.

### Changed

- **A repeated id in `aria-labelledby` is read each time**, as accname 1.2 (step 2B) and Chrome 157 read it: `x x x`
  names a panel «Save Save Save»; 0.4.11 read it once. The bound stays: a label's text is computed once, and the heading
  stops past 300 characters. No saved page repeats an id.
- On 1,065 saved pages the output is byte-identical to 0.4.12 (20 s against 19 s in all): the
  new paths are reached only by the shapes in `tests/node/tab-refs.test.ts`.

## 0.4.12 - 2026-11-15

### Fixed

- **Nested tab lists each collected every tab inside them (P2A-044).** Every `role="tablist"` gathered all the tabs
  below it, so k lists nested around n tabs built k × n entries and computed a name for each: 1,000 lists around 5,000
  tabs (273 KB) took 2.3 s and 413 MB, 2,000 around 10,000 (548 KB) 11.8 s and 1.6 GB; the output was two panels. A
  list inside a list that is already a tab group is skipped: the outer list holds every tab below it, so it is a group
  whenever the inner one would be, and writing it replaces its whole subtree, so the inner group was never written.
  The 548 KB page now takes 0.13 s and 32 MB.
- Found while looking for other super-linear paths after P2A-042. Two new tests (`tests/node/tab-refs.test.ts`): the
  timing one fails on 0.4.11, the other pins that an inner list's tabs still print through the outer list. On 1,065
  saved pages the Markdown is byte-identical to 0.4.11 (37 have tab lists, 90 in all; one has 5 nested lists).

## 0.4.11 - 2026-11-15

### Fixed

- **A tab panel named by several tabs was written once per tab (P2A-042).** Each tab whose `aria-controls` names the
  panel printed it again under its own heading: 200 tabs naming one panel of 2,000 words took 2.1 s and wrote 805,000
  characters, 500 tabs and a 115 KB panel 26 s and 6M characters, and a second tab list naming the same panels (a
  desktop and a mobile bar) wrote every panel twice. Every tab keeps its heading, and the panel is written once, under
  the tab that is selected (`aria-selected="true"`), else the first that names it: the page holds what that tab
  shows. On bun.html five tour steps name one terminal, and 0.4.10 printed the first step's output under all five. A
  tab whose panel another tab list already wrote is left out with its heading.
- **A tab label could be any length, and was written once per reference (P2A-042).** One `aria-labelledby` naming a
  label 4,000 times wrote a 48M-character heading (2.8 GB of memory), and 6,000 panels naming one 12,000-character
  label wrote 72M characters. A tab heading keeps at most 300 characters of its label, cut with `…` and never inside a
  surrogate pair, and an id repeated in one `aria-labelledby` is read once. The longest tab heading on 1,065 saved
  pages is 189 characters.
- **A tab list inside a panel that names that panel failed the whole page (P2A-043).** Writing the panel reached its
  tab list, which wrote the panel again, until `Maximum call stack size exceeded`: a page of a few hundred bytes came
  back as «Page2AI extraction failed», its other text lost. A panel is marked as written before its content is walked.
- Found by the review panel on 0.4.10 (P2A-042) and while measuring it (P2A-043). Nine new tests
  (`tests/node/tab-refs.test.ts`); all nine fail on 0.4.10. On 1,065 saved pages the Markdown is byte-identical to
  0.4.10 except bun.html, whose four repeated copies of the step-01 terminal are gone (1,120 characters), in both
  option sets. The tab-group index is now emptied with the other per-render caches.

## 0.4.10 - 2026-11-14

### Fixed

- **A tab panel kept in a `<template>` was lost in 0.4.9, and the last converted document stayed in memory
  (P2A-039).** 0.4.9's id index came from `querySelectorAll('[id]')`, which in linkedom jumps over the children of a
  `<template>`, while `getElementById`, which 0.4.8 called, finds them. A tab whose panel sits in a `<template>` (an
  Alpine `x-if` panel) lost it: 0.4.8 printed `### Tab: yarn` and its code block, 0.4.9 neither. The index now walks
  every element in document order, as `getElementById` does, and lives in a `WeakMap` per document: 0.4.9 kept the
  last document until the next conversion (45.7 MB of heap after a 1.3 MB page; 5.7 MB on 0.4.8 and 0.4.10).
- **A space before or after the ids in `aria-labelledby` named a tab panel with the whole page's text (P2A-040).**
  The id list was split with its empty tokens, and linkedom's `getElementById('')` answers the `<html>` element.
  Empty tokens are dropped now, as HTML splits a token list, and an empty id names nothing. 3,000 such panels took
  3.6 s and wrote 9 MB of headings.
- **Panels that name one label, and pages of thousands of tab groups, took time that grew with the square of their
  number (P2A-041).** The label's text was computed again for every panel naming it (6,000 panels naming one label of
  6,000 hidden spans: 3.6 s; with a 12,000-character label 21 s), and the list of tab groups was scanned for every
  element (48,000 groups, 9 MB: 9.7 s). Each label's text is computed once per render, and a container's group is a map
  lookup. A label shared by n panels is still written n times.
- Found by the review panel on 0.4.9. Ten new tests (`tests/node/tab-refs.test.ts`); nine fail on 0.4.9. On 1,065
  saved pages the Markdown is byte-identical to 0.4.9 (26 have tab references, 6 have 29 ids inside a `<template>`,
  none a padded `aria-labelledby`), and on those pages the new index answered like `getElementById` for all 72,690
  ids. The 36 block, hidden and ARIA shapes of 0.4.9's sweep stay linear (at most 0.34 s at 12,000 entries); 48,000
  tab groups take 2.1 s (9.6 s on 0.4.9). Still open: deep nesting (a few thousand levels fail whole, P2A-033).

## 0.4.9 - 2026-11-14

### Fixed

- **A page of many code blocks, tabs or hidden rows could hold the converter for a minute.** 0.4.8 swept only the
  inline children of one element; block children had their own quadratic paths, each a question asked of a shared
  ancestor or of the whole document once per child. For every `<pre>`, the language rule counted the `<pre>` elements
  under each of its three nearest ancestors (an ancestor holding more than one gives no language), so a container of
  n code blocks was searched n times: 8,000 sibling blocks (96 KB) took 20 s, and 12,000 blocks under one
  `language-*` wrapper 108 s (867 KB). Every tab's `aria-controls` and every panel's `aria-labelledby` was looked up
  with linkedom's `getElementById`, which walks the whole tree: 12,000 tabs with their panels took 25 s. Every table
  row and article asked each hidden ancestor whether it holds a `<pre>` (a hidden block with one is printed as code):
  12,000 rows of a hidden `<tbody>` took 19 s. Each answer is now computed once per element and render (an id index
  built on the first lookup keeps `getElementById`'s first-in-document-order answer), and the same pages take 0.1 to
  0.3 s. A sweep of 36 block, hidden and ARIA shapes at 3,000 and 12,000 entries found 9 quadratic on 0.4.8 and none
  on 0.4.9. On 1,065 saved pages the Markdown is byte-identical to 0.4.8; 33 of them have an ancestor holding two or
  more `<pre>`, 26 have tab references and 59 hidden elements.

### Tests

- Eight pages with 6,000 to 12,000 code blocks, tabs, tab panels, hidden rows or hidden articles are timed (6 to 20 s
  each on 0.4.8; the budget is 1 s), and the language rule is tested for an ancestor around one and two code blocks.

## 0.4.8 - 2026-11-13

### Fixed

- **An element with many inline children could still hold the converter for minutes.** 0.4.7 replaced three regular
  expressions a page could stall; two more paths had the same effect without one. The inline renderer read the text
  it was building (a regular expression, `endsWith`, `slice`) once per child, and V8 copies a string grown with `+=`
  whole on every such read, so the time grew with the square of the element's text. On 0.4.7 a paragraph of 40,000
  links took 9 s, and 40,000 links each after a `!` (which the renderer escapes) 130 s, from an 800 KB page; a table
  nested in a cell re-read its growing row line once per cell the same way (80,000 header/data pairs: 11.6 s). The
  renderer now keeps what it asks about the end of that text beside the text (`InlineText` in
  `src/node/linear-text.ts`, and a flag in the nested-table row), and those pages take 0.27 s, 0.28 s and 0.8 s. A
  test compares every answer `InlineText` gives with the old expression on the whole text, after each step of 20,000
  generated sequences. A sweep of 136 shapes (16 containers by 10 kinds of child, 10,000 and 40,000 children) found
  none whose time grows faster than its size; the 8 it flagged in one process, slowed by the heap of earlier runs, were
  linear when re-run alone. On 1,065 saved pages the Markdown is byte-identical to 0.4.7.

### Tests

- Five pages with 5,000 to 10,000 children are timed (4 to 25 s each on 0.4.7; the budget is 1 s).
- The test of a `<dl>` whose `<div>` group holds 150,000 children counts every description, as the test of the plain
  list does; it checked only the first two and the last.

## 0.4.7 - 2026-11-13

### Fixed

- **A page could hold the converter for minutes or hours.** Three regular expressions on the conversion path took
  time that grew with the square of a run in the page, or doubled per HTML comment, and they run synchronously, so
  the MCP server answered nothing else meanwhile. A page with no `<html>` tag whose first 30 nodes are comments took
  about 16 s and 40 comments took hours (the check whether a fragment opens with `<head>` or `<body>`, there since
  0.1.12); a heading holding 100,000 ideographic spaces took about 5 s and an `aria-label` of 100,000 letters about
  3 s, growing with the square of the run. Each check is now one pass (`src/node/linear-text.ts`) and returns what
  the regex returned, which tests compare on generated strings; the one difference follows HTML: a comment ends at
  its first `-->`, while the old pattern let one run past it. Tests time all four pages (each took 7 to 20 s on
  0.4.6; the budget is 1 s). A scan of the 308 regex literals in `src/` on long runs of blanks, punctuation and
  letters found ten more that are quadratic in isolation; none is reachable from a page: two see text whose blanks
  were already collapsed, and the conversion never calls the other eight (helpers in `src/shared/utils.ts`).

### Tests

- The long-page tests of 0.4.6 passed on the 0.4.5 renderer, bug included, in Vitest's `threads` pool, whose
  workers get a 4 MB stack instead of Node's default; only the source check caught it. A new test fails when the
  runtime no longer overflows on a 150,000-argument call, so such a run fails instead of passing quietly.
- The source check also catches `f['apply'](t, xs)`, `(f.apply)(t, xs)`, `Reflect.construct(C, xs)` and
  `Function.prototype.apply.call(f, t, xs)`, scans `.js`, `.mjs`, `.cjs`, `.mts`, `.cts` and `.tsx` files too, and
  is itself tested against every form it must catch and every spread it must leave alone.

## 0.4.6 - 2026-11-13

### Fixed

- **A very long page failed whole with «Maximum call stack size exceeded».** A page that renders to about
  120,000 Markdown lines or more (a huge table, log or list) came back as the error document «Page2AI
  extraction failed» instead of its content, from `htmlToMarkdown`, `fetchAndConvert`, the MCP server and the
  online converter alike: a 4.95 MB page of 90,000 short rows was enough. The renderer spread page-sized
  arrays into call arguments (`push(...lines)`, `Math.max(...widths)`), and V8 refuses a call with that many
  arguments. The calls now append in a loop: the body's lines, a definition list's lines and the children
  of its `<div>` groups, a table's column count, and the frontmatter. That page now converts in about 2 s;
  a 150,000-row table, a `<dl>` with 75,000 pairs and a `<dl>` group with 150,000 children have their own
  tests, each of which fails when its one call is put back. Another test parses `src/` with the TypeScript
  compiler and fails on any call-argument spread or `.apply` with an argument list. Every other page converts
  as before: 1,065 saved pages (30 of ours and 1,035 from trafilatura's test set) came out byte for byte the
  same as 0.4.5.
- Still open: a page nested about 1,000 levels deep (blockquotes; lists about 2,000, `<div>`s about 4,000)
  exhausts the stack in the recursive walk itself. Chrome's HTML parser stops nesting at about 512 levels
  (measured in Chrome 157), so a page a browser parsed does not reach it; the limits are the same as in 0.4.5
  and tracked separately.

### Dependencies

- The lockfile moved linkedom from 0.18.14 to 0.18.15, whose CSS parser is now `cssomnom` (GoogleChromeLabs,
  Apache-2.0); the renderer reads no CSSOM. The published range `^0.18.11` did not change, so installs already got
  0.18.15, and the 1,065 saved pages came out the same on both versions. (Added to this entry in 0.4.7.)

## 0.4.5 - 2026-11-13

### Added

- **`@page2ai/core/html`: the converter alone, for a browser tab or a Web Worker.** `htmlToMarkdown` moved
  from `src/node/index.ts` into `src/node/convert.ts`, whose imports are linkedom, css.escape and the
  renderer only. Until now any bundle of `htmlToMarkdown` pulled in the guarded fetch (undici,
  `node:async_hooks`, `node:net`, `node:dns/promises`), so it could run only in Node, and the browser entry
  offered no conversion at all. The package root re-exports the same function, so `import { htmlToMarkdown }
  from '@page2ai/core'` is unchanged, and `fetchAndConvert` converts what it fetched with it. A test walks
  the new entry's import graph and fails on any `node:` module or undici. The Markdown is unchanged: no
  renderer line moved or changed.

## 0.4.4 - 2026-11-12

### Fixed

- **Sites behind Cloudflare's bot checks answered 403 to every fetch.** npmjs.com, openai.com and medium.com
  challenged the TLS handshake Node.js makes by default (`cf-mitigated: challenge`), whatever the User-Agent
  said, while curl got the same pages with the same User-Agent. Connections now offer the cipher list of
  Mozilla's "intermediate" TLS configuration (guidelines 6.0: the TLS 1.3 suites, plus ECDHE with AES-GCM or
  ChaCha20 for TLS 1.2) instead of Node's default list, which also offers CBC and DHE suites. Measured
  2026-11-12 on Node 20, 22, 24 and 26: those three sites went from 403 to the page, and Wikipedia, MDN,
  GitHub Docs, the Claude Code docs and example.com came out byte for byte the same. The User-Agent does not
  change (`page2ai-core/<version>`): a site still sees page2ai by name and can refuse it by name. Stack
  Overflow still answers 403; it wants a browser (the MCP server's Agent Bridge, or the `html` argument).
- **A server that speaks none of those suites** (TLS 1.2 with CBC or DHE suites only) refuses the handshake.
  The same request is then made once more with Node's default list; checked on cbc.badssl.com and
  dh2048.badssl.com. Certificate errors are not retried.
- An IP-literal URL now goes through an undici `Agent` of its own, which carries the cipher list, instead of
  Node's global dispatcher.

## 0.4.3 - 2026-11-09

### Added

- **Fetch policy for servers that fetch on behalf of others.** `fetchProtected` and `fetchAndConvert`
  take `allowedPorts` (checked on the URL and on every redirect hop, before DNS) and `extraBlockedIps`
  (single addresses or CIDR ranges, checked on IP literals and on every resolved address of every hop).
  Without the options they read `PAGE2AI_ALLOWED_PORTS` and `PAGE2AI_EXTRA_BLOCKED_IPS`
  (comma-separated). Both only restrict, and a value that does not parse fails the fetch instead of
  dropping the rule. A refusal for a listed address does not name the address a hostname resolved to.
- **Abort signal.** `signal` option on both functions, and `runWithFetchSignal(signal, fn)`, which makes
  a signal reach every fetch inside `fn` (for a server whose client went away, through code that does
  not pass options along). An abort ends the fetch as its timeout does, with an `AbortError`.
- **Three more IANA special-purpose IPv4 ranges refused:** `192.31.196.0/24` (AS112-v4),
  `192.52.193.0/24` (AMT), `192.175.48.0/24` (Direct Delegation AS112 Service).

## 0.4.1 - 2026-11-03

### Fixed

- **User-Agent version was stale.** The `User-Agent` header sent on every fetch was hardcoded as
  `page2ai-core/0.1` since the first release, while the package was already at 0.4.0. It now tracks
  `CORE_VERSION` automatically (`page2ai-core/0.4.1`), and a test pins the two values together so
  they cannot drift again.

### Added

- **Per-host rate limiting.** Back-to-back fetches to the same hostname are spaced at least 1 second
  apart (plus random jitter), preventing a looping agent from hammering a single site. The delay
  applies only between separate `fetchProtected` calls — redirect hops within one call are not
  throttled. The throttle state lives in the process, so it persists across MCP tool calls for the
  lifetime of the server. `_resetHostThrottle()` is exported for tests.

## 0.4.0 - 2026-11-02

### Breaking

- **Node.js >=20.18.1 required.** The `engines.node` field is raised from `>=18.17.0` to `>=20.18.1`.
  Node 18 has been end-of-life since April 2025. The CI matrix already ran only Node 20 and 24.

### Features

- **Proxy support:** `fetchProtected` honours the `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`
  environment variables (lowercase takes precedence, matching curl/wget/Node convention). When a
  proxy is configured, the request routes through an undici `ProxyAgent`. The SSRF guard's
  string-level checks and advisory DNS resolution still run — a hostname resolving to a private IP
  is blocked even through a proxy. When `NO_PROXY` matches the target, the request goes direct with
  full DNS pinning as before. `getProxyForUrl(url)` is exported for consumers who need to check
  proxy state.

### Dependencies

- **undici** upgraded from 6.29.1 to 7.30.1 (major). The `Agent({ connect: { lookup } })` API
  used for SSRF DNS pinning is unchanged. Fixes CVE-2026-87018 (High: DoS via TLS 1.2
  renegotiation).

## 0.3.2 - 2026-10-30

- Fixed: a label / value pair built from sibling `<div>`s printed as two paragraphs, so the pairing the page showed was
  lost. The Node renderer has no CSS, so nothing in the DOM told it two `<div>`s sit side by side; each block child
  became its own paragraph (P2A-014: `<div class="kv"><div class="k">Plan</div><div class="v">starter</div></div>`
  rendered as `Plan\n\nstarter`, hiding the pair). A grid of consecutive two-cell rows is now paired as `Label: value`
  (one per line); a metric tile with a label-and-value pair converts the same way (`Recordings: 5`). A key with its
  own link keeps the bold form, `**Plan**: [starter](https://example.test/s)`, so no formatting is lost. A `<dl>`
  (`<dt>` + `<dd>`) still converts to its own pair, unchanged. Pinned by `tests/node/p2a-014-kv.test.ts` (9 cases)
  and the metric-tile and key / value grid tests in `tests/node/bare-text.test.ts`.

## 0.3.1 - 2026-10-20

- Fixed: a layout table, `<table role="presentation">` or `role="none"`, became a Markdown table, so an HTML e-mail
  (built from nested ones) came out as one cell on one line, its heading and paragraphs run together (P2A-024: the
  IronMemo letter, one 1,415-character cell holding its `<h1>` and 14 paragraphs). Such a table now converts as the
  blocks in its cells, in source order; a data table inside it stays a table. Its images keep the table-cell rule: an
  image is written as its alt text, and a spacer or an open-tracking pixel (empty alt) adds nothing, so no image URL
  that was left out before appears. Only the first token of a `role` list is read. Measured on 45 e-mail renders (7
  languages): 0 table rows instead of 1, 11 to 17 paragraphs instead of 1. The 53-page corpus changes on one page
  (Wikipedia's article message box) with default options, `includeImages: false` and `includeHidden: true`.

## 0.3.0 - 2026-10-18

SSRF guard hardening (BL-22): closes the DNS rebinding window on the public endpoint and extends
the IP blocklists to cover every range the T99 audit flagged. `htmlToMarkdown` is unchanged;
`fetchProtected` is the only affected entry point.

### Security

- **DNS pinning:** `fetchProtected` now resolves DNS once, validates every returned address, and
  pins the TCP connection to those addresses via an undici `Agent`. Previously, Node's `fetch()`
  re-resolved the hostname independently, so a DNS record that flipped between the guard's lookup
  and the connect (DNS rebinding) could reach an internal address. The check-then-connect window
  is closed.
- **Extended IPv4 blocklist:** multicast (224.0.0.0/4), reserved/broadcast (240.0.0.0/4),
  TEST-NET-1/2/3 (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), benchmarking (198.18.0.0/15),
  IETF Protocol Assignments (192.0.0.0/24), deprecated 6to4 relay anycast (192.88.99.0/24).
- **Extended IPv6 blocklist:** NAT64 well-known and local-use (64:ff9b::/96, 64:ff9b:1::/48),
  6to4 (2002::/16), documentation (2001:db8::/32), Teredo (2001::/32), discard-only (100::/64).

### Added

- `undici` ^6.29.1 is now a runtime dependency (zero transitive dependencies).
- Minimum Node version raised from 18.0 to 18.17 (undici 6.x requirement).
- `resolveAndValidate(hostname, rawUrl)` is exported from `ssrf-guard` for callers that need the
  validated addresses (e.g. to build their own pinned dispatcher).

## 0.2.2 - 2026-10-17

Only the Node renderer's button rule changes, so `htmlToMarkdown` and `fetchAndConvert` change the same way. A review
of the 0.2.1 rule (P2A-019) by three external models, each shape run on npm 0.2.0, 0.2.1 and a build that drops every
button. The 53-page corpus converts as in 0.2.1, byte for byte apart from `extractor_version`, with default options,
`includeImages: false` and `includeHidden: true`.

- Fixed: a page with thousands of sibling buttons took seconds: every button scanned its whole run of siblings, so
  3,000 buttons in one paragraph took 4 to 5 s (0.2.0: about 30 ms). The run is now computed once per container.
- Fixed: 0.2.1 dropped the text of buttons that hold it: an accordion question with neither `aria-expanded` nor a heading
  (`<button>Question?</button><div><p>Answer.</p></div>`, also in a list item), a definition term, a question under
  `role="heading"`, a link written inside a button, and a command whose button is named "Copy command: <the command>".
- Fixed: a custom element is a block unless its container has text of its own, as the converter already renders it,
  so a card's action row (`<mat-card-actions><button>LIKE</button>`) no longer counts the card's text as its sentence.
- Still dropped, as in 0.2.1: buttons with no text of the page around them that hold options, cards or a value in a
  `<span>` or `<div>` (sizes, quiz answers, chapter lists, card grids), a question in a wrapper of its own before the
  answer, a title button beside a heading's link, and a copy-the-command button that carries its command only as its
  own text: the neon.com page named in 0.2.1 still loses `npx neon@latest init`.

## 0.2.1 - 2026-10-17

Only the Node renderer changes, in how it treats `<button>`, so `htmlToMarkdown` and `fetchAndConvert` change the
same way. Measured on npm 0.2.0 against this release's code with default options, `includeImages: false` and
`includeHidden: true`; each changed line was read.

### Fixed

- **Interface buttons no longer print as paragraphs** (P2A-019). Since 0.2.0 converts the pages of Mintlify, Vercel and the Claude docs, their output carried the header's «Copy page» twice, the code-sample switcher («cURL CLI Python TypeScript C# Go Java PHP Ruby») and icon-font glyphs. A `<button>` is now treated as a control: its label is left out, and so is an `aria-hidden` icon inside a button that is kept. A button stays when it holds the page's text: all the text of a heading or a table cell (an accordion's question, a sortable column's name), block content or an image that is not `aria-hidden` (a zoomable image, a video card), a link around it, a disclosure's label (`aria-expanded` without `aria-haspopup`: a changelog's «Fixes» above its list), a word of a sentence (a tooltip), and the selected tab of a tab list whose panels the converter cannot pair with it. Measured on 53 saved pages (the 21-page corpus, 17 server snapshots of docs sites, 15 pages saved from live sites on 2026-10-17 and 2026-10-18): 34 change, 399 lines go out and 114 come in (a heading without its glyph, «Python» for the tab strip); every heading and code block stays, and the private-use glyphs fall from 153 to 24 (the 24 left are outside buttons: breadcrumb separators and callout icons on the Claude docs). A build that dropped every button lost 27 headings, a table column's name, a word of a sentence and a changelog's section labels; this one keeps them. Known cost: a copy-the-command widget that shows its command in a `<span>` inside the button (neon.com) loses the command.

## 0.2.0 - 2026-10-17

`htmlToMarkdown` is unchanged: on the 21 corpus pages its output is byte-identical to 0.1.13. What
changes is what `fetchAndConvert` reads, measured live on 2026-10-17 with npm 0.1.13 against this
release's code. On seven documentation platforms (Fumadocs, Mintlify, Vercel, Supabase, Cloudflare,
Stripe, the Claude docs) 0.1.13 returned the site's `.md` copy of the page and 0.2.0 converts the
page itself, 1,301 to 57,887 characters. Every heading and code block of those copies is in the
0.2.0 output, except a «Related pages» list on Vercel, an «On this page» list and the page's JSON-LD
on Cloudflare, and the `[#anchor]` suffixes of Fumadocs headings.
On the Claude docs the copy was 160,435 characters with 36 headings and 6 code blocks; the page
gives 57,887 with 59 and 20. A `README.md` from raw.githubusercontent.com now comes back as the file,
11,408 of 11,408 characters (0.1.13: 3,468 characters, no heading), and an `llms.txt` you name keeps
its 235 lines.

### Changed (breaking)

- **`fetchAndConvert` reads only the page you name** (BL-49). It no longer asks for `<url>.md` first, and its Accept header is now the one Firefox sends when it opens a page, `text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`: no `text/markdown` and no `text/plain`, because servers match those words and ignore q-values (measured 2026-10-17: `text/html,text/markdown;q=0` still got Markdown from platform.claude.com, and `text/html,text/plain` got it from fumadocs.dev). Fumadocs, Mintlify, Vercel, Supabase, Stripe and the Claude docs now answer with the HTML page instead of their own Markdown copy, which can be older than the page, and the output on those sites is converted from the page. Content shown only to agents (Mintlify `<Visibility for="agents">`) is no longer there, and what the page shows people is.
- **Markdown sent for a page address is refused** with `FetchProtectionError` ("the server answered with Markdown ... for a page address"). The request asks for HTML as a browser does, so a server that still answers Markdown chose its copy by something else (User-Agent, a cache). 0.1.13 returned it as the page.
- `FetchAndConvertOptions.tryMdSuffixFirst` is removed; a value passed anyway is ignored (TypeScript reports it on an object literal).
- The official-Markdown settings are gone from the shared exports (`@page2ai/core/shared/types`, `@page2ai/core/shared/profiles`): `OfficialMarkdownMode`, `OfficialMarkdownResult`, the `ExtractorConfig` fields `officialMarkdownMode`, `trustedOfficialMarkdownHosts` and `officialMarkdownMinRatio` (and so the profiles' `officialMarkdownMode`), the `ExtractStatus` value `'official-md'`, and `ExtractResult.officialMarkdownUrl` and `officialMarkdownRatio`. No code in core read them; they described the extension's own lookup, which its next release removes too.
- `ConversionResult.source` is `'html-parse' | 'markdown-response'`: `'md-suffix'` and `'content-negotiation'` are gone, and so is `'llms-txt'`, which nothing ever returned. The frontmatter of a Markdown response says `extractor_source: "markdown-response"`.

### Fixed

- **A Markdown or text file comes back as written.** A URL whose path names a Markdown or text file (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`, `.txt`) is returned as is whether it is served as `text/markdown`, `text/x-markdown`, `text/plain` or `application/octet-stream`. In 0.1.13 a `README.md` from raw.githubusercontent.com (`text/plain`) went through the HTML parser and came out as one line that began in the middle of the file, with no heading and no code block: 3,035 characters of 10,940. An `llms.txt` you named lost its line breaks, and `text/x-markdown` and `application/octet-stream` were refused. A body with a NUL byte is refused as not text.

## 0.1.13 - 2026-10-16

Output changes on 4 of the 21 corpus pages, measured on npm 0.1.12 against the release build with
default options, `includeImages: false` and `includeHidden: true`; each change was read and each is
one of the fixes below. On the 14-page benchmark corpus `f_score` moves from 0.916 to 0.933 and
`f_prose` from 0.842 to 0.859, all of it on one page, Anthropic's extended-thinking docs
(docs.anthropic.com, which redirects to platform.claude.com; 0.000 to 0.233). That
page's ground truth was made by a static pass that never saw its article and counts the article's
text as boilerplate, so the score understates the change. No code block, table, heading or list
item of the 0.1.12 output is lost. The words that go are 16 `Loading...` placeholders, Emotion CSS
that a `<style>` put inside a docs.sentry.io code block, and `cd my-websitenpx`, two Docusaurus
code lines that 0.1.12 printed as one.

### Fixed

- **React streaming pages print the article instead of its loading placeholder** (#31, #32). React
  streaming SSR (Next.js App Router, Remix, Mintlify) sends a Suspense fallback where late content
  goes, then the content, hidden at the end of `<body>`, with an inline `$RC("B:0","S:0")` that
  moves it into place. The converter runs no scripts, so the root printed the fallback: the
  Anthropic page gave 212 characters of `Loading...` for a 12,270-character article. The
  `$RC`, `$RR` and `$RS` calls are now replayed in document order before the root is picked, and
  only where a browser runs them: in a classic inline script (no `src`, `nomodule`, module, JSON or
  text type, nothing inside `<template>` or `<noscript>`), at a statement start, on a segment,
  boundary and placeholder parsed before the script, on React's own segment wrappers. `$RX` keeps
  the fallback, and a segment whose boundary is gone is dropped, as React drops it. Chromium,
  running only each saved page's inline scripts, gave the converter the same page as the replay,
  byte for byte, on 8 of 8 streaming pages; 25 of 28 adversarial cases from a review equal the
  browser, and the other 3 redefine or omit `$RC` (see the README). A page with 16,000 calls
  converts in 0.12 s.
- **Hidden text no longer reaches the output through code, link names or the content root**
  (#29, #30). On 0.1.12 a link whose content rendered empty took its name from `textContent`,
  hidden spans included; inline code and code blocks read `textContent` too, so a hidden span or a
  `<style>` inside code printed (two lines of Emotion CSS on the docs.sentry.io corpus page); a
  hidden `<main>` became the root and printed its whole text; a hidden block kept for its `<pre>`
  printed all its prose. Code, link names and tab labels now take no text from a hidden element of
  any kind, nor from `<style>`, `<noscript>`, `<canvas>` fallbacks or SVG `<defs>` / `<desc>`, and
  `<br hidden>` breaks no line. The root is the first `<main>` under no `hidden` (one inside a
  React segment only when there is no other, never one in a hidden tab panel or an `until-found`
  section). A hidden block that holds code gives its code blocks and no prose, and a tab panel
  outside the root is not printed. A hidden block is kept as a React streaming segment only when
  it is one, React's wrapper with an id ending in `S:` and a hex number: `S:evil` and
  `<img hidden id="S:0">` no longer pass.
- **Table cells stay under their headers** (#29, #30). `colspan` and `rowspan` are laid out as the
  HTML table model lays them out, so the cells after a span keep their columns; a span ends with
  its row group and `rowspan="0"` spans the rest of it; columns where no cell starts are dropped
  (`colspan="100"` adds no empty columns); past a budget of covered slots the plain layout is used.
  An empty cell under a header row keeps its place in a nested table.
- **Line breaks in code survive** (#29). A `<br>` in code is a line break: every Docusaurus code
  block ends each line with a `<br>` and no newline, so `cd my-website` and `npx docusaurus start`
  printed as one line. A `<pre>` in a table cell keeps its lines, one code span per line (8 cells
  on the Wikipedia corpus page). A `<br>` in a heading is a space.
- **An image in a table cell is written as its alt text** (#29), which also names an image-only
  link there; 0.1.12 left such a cell empty (2 cells on the Wikipedia corpus page). An image with
  `aria-hidden="true"` adds nothing to its cell.
- **`fetchAndConvert` honours `includeFrontmatter: false` on its Markdown fast paths** (#26). The
  `.md`-suffix and `text/markdown` paths prepended the frontmatter whatever the option said and
  counted only the body (`charCount` 144 for a 336-character result), so the MCP server's
  `include_frontmatter: false` was ignored on every docs site that answers `text/markdown`. Both
  paths now honour the option and count the returned Markdown, as `htmlToMarkdown` does.

### Docs

- README: what `includeImages` does in a table cell; what `includeHidden` converts either way, and
  that the default is not a security boundary (a page's own attributes decide the kept kinds, and
  no CSS is read); `tryMdSuffixFirst`; the `text/markdown` pass-through; how React streaming
  content is placed and when a page keeps its fallback; the content-root rule as the code applies
  it; spanning cells; a closed `<details>` needs no clicking.

### Tests

- The package root's exports and its `exports` map are pinned (P2A-009), and the P2A-001 key/value
  grid is pinned exactly. The streaming tests run React 19.2.0's and React 18's own inline
  runtimes; 14 of 14 rule mutations fail a test.

## 0.1.12 - 2026-10-16

Output changes on most pages; the extension, the MCP server and the benchmark numbers move with it.
On the 14-page benchmark corpus `f_score` stays 0.916 and no code block, table or heading of the
0.1.11 output is lost. The words that go are `<br>` markup 0.1.11 left in table cells; the one list
item that goes (MDN) was a `*` in the page's text, now escaped. On 7 more pages the other words that
go are CSS from `<style>` elements inside Wikipedia's table cells and letter-spaced text now joined
into its word (`a d v e r t i s e m e n t s`). A six-model review of the first change found the
defects listed after the first five entries; each was reproduced on the build before it was fixed,
and Markdown claims were checked with a CommonMark parser.

### Fixed

- **Text outside a recognised block tag is no longer dropped.** The Node renderer walked element
  children only, so text sitting directly in a `<div>`, `<section>`, `<span>` or `<blockquote>`,
  beside a `<br>`, or in a `<dt>`, `<figcaption>` or `<summary>` vanished while every heading and
  table survived: on a server-rendered admin page 25 of 26 key/value labels and 10 of 12 metric
  tiles were missing. Such text now renders as its own paragraph. A row of links or images with no
  text between them still renders one per line, as before.
- **`<dl>` renders as definition-list Markdown** (`**term**`, then `: definition`), the format the
  extension uses. A `<dd>` that holds blocks (paragraphs, code, tables, as in every Sphinx API
  entry) is walked, not flattened. A `<dl>` with no `<dt>`/`<dd>` is treated as a plain container.
- **Entities inside words no longer split them.** linkedom yields `account&#39;s` as three text
  nodes and the inline renderer joined parts with a space, giving `account ' s`; the same broke
  `AT&amp;T`, `caf&eacute;` and every quote entity. Inline parts now keep the source's whitespace,
  which also removes the space before punctuation after a link (`[docs](url) .`). Emphasis moves
  its edge whitespace outside the delimiters.
- **HTML fragments convert.** Input without `<html>` (an HTMX partial, `<h1>T</h1><p>x</p>`, a
  snippet starting with `<style>`) came back as an empty string, and plain text or `""` came back
  as "extraction failed" with a linkedom TypeError. Such input is now parsed inside an html/body
  shell.
- An empty extraction now says `<!-- AI: page has no extractable body content -->` instead of
  returning nothing.
- **A `<dl>` no longer drops its other children.** With any `<dt>`/`<dd>` present, a note, heading
  or bare text inside the list vanished, text 0.1.11 had printed. It now renders in place.
- **Page text that looks like Markdown stays text.** A line starting with `#`, `>`, `1.`, `-`,
  `---`, `<tag` or a code fence became that block; an unclosed fence in a `<div>` put the rest of
  the page inside a code block. Such line starts are escaped.
- **Adjacent elements are no longer spaced inside a token.** `$`+`19.99`, `19`+`.99`,
  `user`+`@x.test` and CJK characters came out as `$ 19.99`, `19 .99`, `user @x.test`, `東 京`.
  Words in a flex row (`Plan`+`starter`) still get their space.
- **Markup glued to text parses as written.** `Hey!` before a link made an image, a backslash before
  one broke it, and bold ending in punctuation before a letter (`**Note:**text`) was literal stars.
- **Link text is Markdown.** Code, bold and images inside a link were escaped into literal
  backticks, stars and brackets (`[\`x\`](u)`), which also put backslashes into image URLs; only the
  brackets and backslashes of the link's own text are escaped now.
- **Code spans holding a backtick** use a longer fence (`` ``a`b`` ``) instead of closing early.
- **Table cells**: template indentation no longer becomes `<br>` in every cell, `a<br>b` and two
  `<div>` lines no longer glue into one word, `<script>` and icon `<title>` text stay out, and the
  `<caption>` is printed.
- A custom element between words (`<relative-time>`) stays in its sentence; a tab panel nested in a
  `<span>` prints once; `aria-hidden="True"` is honoured like `"true"`; an icon's `<svg><title>` is
  no longer taken for the page title; a fragment with `<body>` in the middle keeps the text before it.
- **SSRF guard: link-local is `fe80::/10`.** Only the `fe80:` prefix was blocked, so `fe90::1`
  through `febf::` passed.
- **Blocks inside a list item stay in the item.** A code block, table, `<dl>`, quote or paragraph
  group inside an `<li>` started at column 0 after a blank line, which ends the list in CommonMark:
  the command of every numbered "1. Install:" step left its step and the numbering restarted, an
  item that starts with a block printed a bare `-` and a blank line (an empty item), list items
  after a callout became an indented code block, and text above a nested item that starts with a
  block turned into a `##` heading. Each item now indents what it holds under its marker, a block
  that opens the item goes on the marker line (`- ```js`), and a list nests under `10.` and later
  (four spaces). Checked with micromark 4 + GFM: on 7 step-by-step pages (GitHub, Docker,
  Kubernetes, ArchWiki docs among them) 81 code blocks are back inside their steps and no code
  text or word changed; of the 14 benchmark pages only python-docs changes (5 code blocks).
- **Link destinations with an unpaired `(` or `)`** are percent-encoded (`https://x.test/a)b` ended
  the link after `a`, an image with such a `src` did not render at all); only the unpaired
  parenthesis is encoded, so `/wiki/Foo_(bar)` stays as written even with a stray `)` later in the
  URL. ASCII control characters in a destination that cannot be resolved are encoded too.
- **Text after a stray `</body>` or `</html>` is kept**, as a browser keeps it: what linkedom leaves
  beside `<body>` or `<html>` is moved into the body after parsing. The same characters inside a
  `<title>` or `<xmp>` stay text.
- **Paragraphs inside a list item stay separate.** `<li><p>A</p><p>B</p></li>` printed `- A` and
  `   B` with no blank line, which a parser reads as one paragraph "A B"; text before or after a
  `<p>` in an item was joined the same way. On 21 pages 4 change, by blank lines only.
- **A rule that opens a bulleted item** printed `- ---`, which is a thematic break, so the item's
  content left the list; it is written `- ***`. A block after a nested list in the same item (a
  figure, for one) is separated by a blank line instead of joining that list's last item. Both
  checked on GitHub's renderer and pandoc.
- **A table nested in a cell stays in that cell.** The outer table took every descendant row and
  cell, so the inner rows came out again as outer rows and the row holding the inner table widened by
  its cells: a 2-column table became 5 columns, one row printed the inner text twice. The inner table
  now becomes lines of its cell, `k: v<br>k2: v2` for header/value rows, ` · ` between other cells.
  A nested table's `<caption>` no longer becomes the outer table's caption.
- **Table cells keep their links, code and emphasis.** A cell was plain text, so every row of a users
  list lost its link and API tables lost their code formatting (`flex-<number>` even read as an HTML
  tag). Cells now render inline Markdown like a paragraph, `|` escaped as `\|`; images stay out of
  cells and adjacent elements get no added space, as before. On the benchmark corpus 3 pages gain
  links and code in cells, `f_score` is unchanged.

### Changed

- **Content under the `hidden` attribute is left out**, as a browser and the extension leave it out
  (a details-on-demand grid printed all 30 closed detail rows; hidden text is also a way to put
  instructions in front of a model that the person reading the page never sees). Kept: tab panels,
  `hidden="until-found"` sections, hidden blocks holding code (unmarked code tabs such as the yarn and
  pnpm variants on docs.sentry.io), and React streaming segments (`<div hidden id="S:0">`). A hidden
  list item takes no number. `includeHidden: true` restores the old behaviour. On the 21-page corpus
  no page changes from this rule.

- **Two changes a downstream Markdown renderer can show.** A code block inside a list item now stays
  in the item, indented under it; Python-Markdown (MkDocs without SuperFences) renders such a fence
  as inline code, because its `fenced_code` extension works only at the document root (0.1.11 put
  the fence outside the list). An `<li>` whose only block renders empty is left out instead of
  printed as an empty item, so a renderer numbers the items after it one lower; the Markdown keeps
  the source numbers.

- `<select>`, `<datalist>`, `<textarea>`, `<iframe>`, `<object>`, `<embed>`, `<audio>` and
  `<video>` are skipped: option lists and "your browser does not support" fallbacks are not page
  text. Elements that render empty no longer fall back to their raw `textContent` (except a link's
  name), which had let script, style and SVG title text into paragraphs.

### Added

- `assertSafeUrlResolved` and `findIpBlockReason` are exported: the exact check `fetchAndConvert`
  runs on a URL and on each redirect hop, so a caller can learn before fetching whether a URL will
  be refused. Both were already in the published type declarations without being importable.

### Docs

- README: `profile` is accepted but ignored by the Node build in this version; the fetch's blocked
  address ranges are listed, CGNAT `100.64.0.0/10` (Tailscale) included.

## 0.1.11 - 2026-10-11

### Changed

- **Releases are published through npm trusted publishing (OIDC).** The
  publish workflow no longer reads a stored npm token: npm trusts
  `.github/workflows/publish.yml` of this repository, exchanges the job's
  GitHub OIDC token for a short-lived publish token, and records GitHub
  Actions as the publisher. A post-publish step fails the release when the
  registry shows any other publisher. Provenance attestations continue as
  before.
- README header leads with the LLM context use case (ChatGPT, Claude,
  Gemini) and names the extraction features.

Extraction is unchanged; only the `extractor_version` reported in
frontmatter moves to 0.1.11.

## 0.1.10 - 2026-08-30

### Fixed

- **Frontmatter `extractor_version` said 0.1.8 on the 0.1.9 release.**
  `CORE_VERSION` in `src/shared/constants.ts` is a hand-bumped literal and the
  0.1.9 release bumped only `package.json` — seen live in ChatGPT connector
  output. Synced, and a new `version-sync` test fails the suite whenever the
  constant and `package.json` disagree, so this class of drift cannot ship
  again.

## 0.1.9 - 2026-08-30

### Fixed

- **`includeImages: false` leaked images in inline positions.** The block-level
  `<img>` branch honored the option, but the inline renderer — an image inside
  a list item, table cell or link — emitted `![…](…)` unconditionally, so
  pages whose images sit in linked or list contexts (MDN diagrams, Wikipedia
  portal bars) kept some or all of them. Found by running the hosted-endpoint
  submission test cases against production: on one MDN page the option changed
  nothing (5 images in both arms, byte-identical output). Both branches now
  share the same `includeImages` contract; regression test covers both
  positions.

## 0.1.8 - 2026-08-30

### Fixed

- **Duplicate H1 when the page's own `<h1>` equals the document title** (#9).
  The renderer emits a title-derived heading, then walked the DOM and rendered
  the page's identical `<h1>` again — the most common page shape there is.
  The first heading the walk meets is now skipped when it normalizes to the
  same string as the title (case, punctuation and anchor-link glyphs ignored);
  the dedupe window closes at that first heading, so an identical heading
  later in the page is treated as content and always renders. Matching runs
  against the suffix-stripped title, so `<title>Page - Site</title>` pages
  dedupe correctly too.

  Benchmark A/B over the 14-page v2 corpus (published 0.1.7 vs this fix, same
  cached bytes, all six tools re-run): 11 pages each lost exactly the one
  duplicate heading line and nothing else; every recall / leak / f-score
  metric unchanged to 4 decimals; the other five tools' outputs byte-identical
  between arms. Only `bytes_out` (smaller) and `compression` in the 4th
  decimal moved, on exactly the 11 affected pages.

## 0.1.7 - 2026-08-17

Packaging-only release; extraction output is byte-identical to 0.1.6.
(This entry was added retroactively in 0.1.8 — the 0.1.7 release shipped
without a changelog section.)

### Removed

- `src/shared/md-postprocess.ts` and its test: fixed in 0.1.6 but never wired
  into any product path (not exported, not imported). Panel verdict was
  unanimous — strip or wire. The extension keeps its own, used copy.

### Changed

- CODE_OF_CONDUCT enforcement contact routed through the GitHub handle
  instead of a personal email address.

## 0.1.6 - 2026-08-17

Security and correctness release driven by a full code audit. Extraction output
on the benchmark corpus is byte-identical to 0.1.5 (verified over all 14 stored
pages before release), so published benchmark numbers still apply.

### Security

- **SSRF guard now resolves DNS.** `assertSafeUrlResolved` looks up the
  hostname and rejects the request when ANY resolved address is loopback,
  private, link-local, CGNAT or a metadata endpoint. Previously only IP-literal
  hosts were checked, so a public name pointing at `127.0.0.1` or
  `169.254.169.254` passed the guard.
- **Redirects are now followed manually** (max 10 hops) and every hop is
  validated (string checks + DNS) BEFORE it is requested. Previously
  `redirect: 'follow'` delivered the request to a redirect target first and
  validated after, so a public page redirecting into an internal address was
  actually fetched; and a redirect chain ending on the original URL skipped the
  check entirely.
- **Trailing-dot hostnames are normalized** before the blocklist check.
  `metadata.google.internal.` (with the FQDN dot) previously bypassed the
  hostname blocklist.
- Remaining, documented limitation: the check-then-connect window. `fetch()`
  re-resolves the name itself, so a DNS record that flips between our lookup
  and the connect can still reach an internal address. Closing it needs a
  pinned-IP dispatcher (undici as a runtime dependency), declined for now.

### Fixed

- `detectProfile` / `resolveConfig` (public `./shared/profiles` export) no
  longer throw `ReferenceError` in Node: the old default parameters read the
  bare `document` / `location` globals. With no DOM available they now fall
  back to the `marketing` profile.
- Tab discovery: `aria-labelledby` on `data-state` tab panels is an IDREF and
  is now dereferenced to the labelling element's text. Previously the raw id
  (`tab-panel-3-label`) was emitted as the visible `Tab:` heading.
- Markdown post-processing link regexes no longer cut URLs at an inner `)`:
  Wikipedia-style `/Foo_(bar)` URLs survive `dedupeAdjacentLinks`,
  `compactLinkLabels` and `aggressiveCleanup` intact. The old capture corrupted
  the output (stray `)` fragments) and failed to dedupe such links.
  (These functions are not yet wired into the default pipeline; the fix
  matters for direct callers and for v0.2.)

### Tests

- 17 -> 37 tests: new suites for the SSRF guard (DNS layer mocked, redirect
  hops, fail-closed on resolver errors), parenthesised-URL post-processing,
  DOM-less profiles, and aria-labelledby tab labels. A stale test comment
  claiming anchors are not resolved against `baseUrl` was corrected (they are,
  and the test now asserts it).

## 0.1.5 - 2026-08-03

- List-item document order, site-suffix title cleanup, wide language-label
  detection.

## 0.1.4 - 2026-08-02

- Content-root selection: an `<article>` wins only if it holds at least half
  of its container's text or dwarfs every sibling `<article>` 3x. Fixes
  card-grid pages (Astro, Starlight, Cloudflare blog) extracting a ~200-char
  card instead of the page content.

## 0.1.3 - 2026-08-02

- Content-negotiation fixes from the T53 defect sweep.

## 0.1.2 - 2026-08-02

- Extraction defect fixes on real AI-docs pages.

## 0.1.1 - 2026-07-27

- First public release: Node (linkedom) + browser adapters, basic renderer,
  static tab discovery, SSRF-guarded `fetchAndConvert`.
