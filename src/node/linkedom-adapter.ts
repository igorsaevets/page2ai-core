// LinkedomAdapter: PageAdapter implementation for Node.js.
// Uses linkedom for HTML parsing. Silently degrades browser-only features
// AND exposes those degradations via capabilities.can* flags so the renderer
// can branch on real fidelity rather than trusting stub values.

import cssEscapePolyfill from 'css.escape';
import type {
  AdapterCapabilities,
  ComputedStyleLike,
  PageAdapter,
} from '../shared/page-adapter.js';

const DEFAULT_STYLE: ComputedStyleLike = Object.freeze({
  display: '',
  visibility: '',
  opacity: '1',
  fontSize: '16px',
  fontWeight: '400',
});

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIALOG',
  'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL',
  'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH',
  'THEAD', 'TR', 'UL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

const HIDDEN_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

export class LinkedomAdapter implements PageAdapter {
  readonly capabilities: Readonly<AdapterCapabilities> = Object.freeze({
    canComputeStyle: false,
    canPseudoContent: false,
    canShadowDom: false,
    canInnerText: true,     // via polyfill
    canCurrentSrc: false,
  });

  private readonly doc: Document;
  private readonly base: string;

  constructor(doc: Document, baseUrl: string) {
    this.doc = doc;
    this.base = LinkedomAdapter.resolveBase(doc, baseUrl);
  }

  static resolveBase(doc: Document, injected: string): string {
    const baseHref = doc.querySelector('base[href]')?.getAttribute('href');
    if (!baseHref) return injected;
    try {
      return new URL(baseHref, injected).href;
    } catch {
      return injected;
    }
  }

  getComputedStyle(_el: Element): ComputedStyleLike {
    return DEFAULT_STYLE;
  }

  getPseudoContent(_el: Element, _pseudo: '::before' | '::after'): string {
    return '';
  }

  // Best-effort innerText polyfill. linkedom textContent includes <script>,
  // hidden aria-hidden text, and ignores <br> line breaks, which corrupts
  // tables and forms. This walk:
  //  - skips <script>, <style>, <noscript>, <template>
  //  - skips aria-hidden="true"
  //  - best-effort skips inline style display:none / visibility:hidden
  //  - emits '\n' for BR
  //  - wraps BLOCK tags with '\n' padding
  //  - preserves TEXT_NODE content
  innerText(el: Element): string {
    const parts: string[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === 3 /* TEXT_NODE */) {
        parts.push(node.textContent || '');
        return;
      }
      if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
      const e = node as Element;
      const tag = e.tagName;
      if (HIDDEN_TAGS.has(tag)) return;
      if (e.getAttribute('aria-hidden') === 'true') return;
      const inlineStyle = e.getAttribute('style') || '';
      if (/display\s*:\s*none/i.test(inlineStyle)) return;
      if (/visibility\s*:\s*hidden/i.test(inlineStyle)) return;
      if (tag === 'BR') { parts.push('\n'); return; }
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) parts.push('\n');
      for (const c of e.childNodes) walk(c);
      if (isBlock) parts.push('\n');
    };
    walk(el);
    return parts.join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  shadowRoot(_el: Element): null {
    return null;
  }

  currentSrc(_img: Element): string {
    return '';
  }

  baseUrl(): string {
    return this.base;
  }

  cssEscape(s: string): string {
    return cssEscapePolyfill(s);
  }

  document(): Document {
    return this.doc;
  }
}
