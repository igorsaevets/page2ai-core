// @page2ai/core browser entry point.
//
// SCOPE: exports the BrowserAdapter only. The full extract() pipeline
// still lives in the Page2AI extension repo (lib/core/*). A later release may
// migrate the extension to import from this package.

export { BrowserAdapter } from './browser-adapter.js';
export type {
  AdapterCapabilities,
  ComputedStyleLike,
  PageAdapter,
} from '../shared/page-adapter.js';
