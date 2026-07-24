// BrowserAdapter: PageAdapter implementation for real browsers (Chrome/Firefox
// extensions). Thin wrapper around window.getComputedStyle, HTMLElement.innerText,
// Element.shadowRoot, HTMLImageElement.currentSrc, CSS.escape, location.href.
//
// Per-instance computedStyleCache (Spark P20 fix — the extension previously had
// a module-level WeakMap which leaked in long-lived contexts and races on
// concurrent extractions). Callers should create ONE BrowserAdapter per
// extraction call and discard when done.

import type {
  AdapterCapabilities,
  ComputedStyleLike,
  PageAdapter,
} from '../shared/page-adapter.js';

export class BrowserAdapter implements PageAdapter {
  readonly capabilities: Readonly<AdapterCapabilities> = Object.freeze({
    canComputeStyle: true,
    canPseudoContent: true,
    canShadowDom: true,
    canInnerText: true,
    canCurrentSrc: true,
  });

  private cache = new WeakMap<Element, CSSStyleDeclaration>();

  getComputedStyle(el: Element): ComputedStyleLike {
    let s = this.cache.get(el);
    if (!s) {
      s = window.getComputedStyle(el);
      this.cache.set(el, s);
    }
    return {
      display: s.display,
      visibility: s.visibility,
      opacity: s.opacity,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
    };
  }

  getPseudoContent(el: Element, pseudo: '::before' | '::after'): string {
    try {
      const s = window.getComputedStyle(el, pseudo);
      let c = s.getPropertyValue('content') || '';
      if (!c || c === 'none' || c === 'normal') return '';
      c = c.trim();
      if ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) {
        c = c.slice(1, -1);
      }
      if (/counter\(|counters\(/i.test(c)) return '';
      return c.replace(/ /g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
    } catch {
      return '';
    }
  }

  innerText(el: Element): string {
    return (el as HTMLElement).innerText || el.textContent || '';
  }

  shadowRoot(el: Element): ShadowRoot | null {
    return el.shadowRoot ?? null;
  }

  currentSrc(img: Element): string {
    return (img as HTMLImageElement).currentSrc || '';
  }

  baseUrl(): string {
    return location.href;
  }

  cssEscape(s: string): string {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return s.replace(/([^\w-])/g, '\\$1');
  }

  document(): Document {
    return document;
  }

  resetCache(): void {
    this.cache = new WeakMap();
  }
}
