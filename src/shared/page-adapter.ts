// PageAdapter interface: abstracts browser-only DOM APIs so the renderer
// can run in both browsers (real DOM) and Node.js (via linkedom).
//
// Callers MUST route every browser-only lookup (window.getComputedStyle,
// HTMLElement.innerText, Element.shadowRoot, HTMLImageElement.currentSrc,
// CSS.escape, location.href, ::before/::after content) through PageAdapter.
// Direct globals break tree-shaking and force the Node build to ship JSDOM.
//
// Design note (Spark P20): the interface also exposes CAPABILITIES so the
// renderer can BRANCH on real fidelity instead of receiving plausible-looking
// stub data. Example: badge detection uses fontSize; on Node the adapter
// declares canComputeStyle=false and the renderer falls back to class-name
// pattern detection instead of trusting a stubbed 16px.

export interface ComputedStyleLike {
  display: string;       // '', 'none', 'block', 'flex', etc.
  visibility: string;    // '', 'hidden', 'visible', 'collapse'
  opacity: string;       // '' or '0'-'1' as string
  fontSize: string;      // '16px' etc.
  fontWeight: string;    // '400', 'normal', 'bold', etc.
}

// Capabilities: what THIS adapter can actually deliver at runtime.
// Renderers should check these instead of trusting stub values.
export interface AdapterCapabilities {
  canComputeStyle: boolean;   // real getComputedStyle available
  canPseudoContent: boolean;  // ::before / ::after content resolvable
  canShadowDom: boolean;      // shadowRoot traversal supported
  canInnerText: boolean;      // layout-aware innerText available
  canCurrentSrc: boolean;     // HTMLImageElement.currentSrc populated
}

export interface PageAdapter {
  capabilities: Readonly<AdapterCapabilities>;

  // Computed style for an element. Node stub returns defaults (visible, 16px, 400)
  // BUT capabilities.canComputeStyle is false so callers should not trust these.
  getComputedStyle(el: Element): ComputedStyleLike;

  // Pseudo-element content string (with outer quotes stripped). Empty when
  // capabilities.canPseudoContent is false.
  getPseudoContent(el: Element, pseudo: '::before' | '::after'): string;

  // Layout-aware inner text. Node adapter implements a polyfill that walks
  // childNodes: skips <script>/<style>/aria-hidden, emits '\n' for BLOCK tags
  // and <br>, best-effort skip of inline style display:none/visibility:hidden.
  // Callers should PREFER this over Element.textContent for user-visible text.
  innerText(el: Element): string;

  // Shadow DOM root. Null when capabilities.canShadowDom is false.
  shadowRoot(el: Element): unknown | null;

  // Browser-selected image src (srcset-resolved). Empty when capabilities.canCurrentSrc is false.
  currentSrc(img: Element): string;

  // Base URL for absUrl() resolution. Browser: location.href (with <base href>
  // override applied). Node: injected via constructor (respects response.url +
  // <base href> in the parsed document).
  baseUrl(): string;

  // Escape a string for use in a CSS selector (attribute value context).
  // Browser: CSS.escape. Node: uses the `css.escape` npm polyfill.
  cssEscape(s: string): string;

  // Document ref for querySelector calls.
  document(): Document;
}
