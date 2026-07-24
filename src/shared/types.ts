// Page2AI core types.
// Ported from Rev-032v2 prototype (Sequential AI Markdown Exporter).

export type ProfileName =
  | 'dashboard'
  | 'docs'
  | 'marketing'
  | 'wordpress-marketing'
  | 'research';

export type AutoProfile = ProfileName | 'auto';

export type InteractionMode = 'none' | 'safe-tabs-and-details' | 'aggressive';
export type LazyLoadMode = 'none' | 'safe' | 'full';
export type TabPanelStrategy = 'safe' | 'balanced' | 'aggressive';
export type VisualMarkersMode = 'none' | 'important-only' | 'all';
export type OfficialMarkdownMode =
  | 'never'
  | 'always'
  | 'page-specific'
  | 'trusted-docs-only';
export type StructuredDataPosition = 'never-emit' | 'before-content' | 'after-content';
export type OutputMode = 'clean' | 'debug';

// Full extractor configuration. DEFAULTS in lib/constants.ts provides every field;
// profiles and user overrides are Partial<ExtractorConfig>.
export interface ExtractorConfig {
  fileExtension: string;
  interactionMode: InteractionMode;
  lazyLoadMode: LazyLoadMode;
  lazyScrollSteps: number;
  lazySafeViewports: number;
  lazyScrollWaitMs: number;
  lazyScrollExtraIdleMs: number;
  restoreScrollAfterExport: boolean;
  tabPanelStrategy: TabPanelStrategy;
  visualMarkersMode: VisualMarkersMode;
  minLargeFontPx: number;
  minBoldWeight: number;
  outputMode: OutputMode;
  officialMarkdownMode: OfficialMarkdownMode;
  trustedOfficialMarkdownHosts: string[];
  officialMarkdownMinRatio: number;
  extractJsonLd: boolean;
  extractOpenGraph: boolean;
  extractMicrodata: boolean;
  structuredDataPosition: StructuredDataPosition;
  extractInternalState: boolean;
  internalStateMaskingEnabled: boolean;
  traverseShadowDom: boolean;
  extractIframeSources: boolean;
  emitImageSrcsetCandidatesComment: boolean;
  typeLinkedImages: boolean;
  includeHiddenMeaningfulText: boolean;
  maxTextNodeLength: number;
  includeVisibleAriaHiddenText: boolean;
  minAriaHiddenTextLength: number;
  longAriaHiddenThreshold: number;
  preserveCodeWhitespace: boolean;
  includePseudoBeforeText: boolean;
  includePseudoAfterText: boolean;
  extractTabs: boolean;
  tabClickWaitMs: number;
  tabSettleMs: number;
  maxTabGroups: number;
  maxButtonsPerTabGroup: number;
  minTabButtonTextLength: number;
  maxTabButtonTextLength: number;
  maxTabPanelChars: number;
  skipCapturedTabPanelsInMainRender: boolean;
  abortTabCaptureOnUrlDrift: boolean;
  tabFallbackMaxBodyRatio: number;
  // Hard wall-clock cap on a single tab click+capture (defense in depth against
  // future async hangs — clickAndWait is already bounded by waitForDomToSettle's
  // tMs, so today's synchronous renderNode is not stopped by this timeout).
  perTabHardTimeoutMs: number;
  // Cumulative budget across ALL tab groups in one extraction. When exceeded,
  // remaining groups are skipped (state.tabCaptureAborted becomes sticky). This
  // is the real protection against pages with dozens of tab groups where the
  // per-click cost is small but the total wall time blows past 60 s.
  tabPhaseBudgetMs: number;
  dropdownClickWaitMs: number;
  dropdownSettleMs: number;
  maxDropdownButtons: number;
  maxDropdownPanelChars: number;
  skipCapturedDropdownPanelsInMainRender: boolean;
  restoreDetailsAfterExport: boolean;
  enableFailSafeDownload: boolean;
  qualityCheckEnabled: boolean;
  minMainRenderToBodyRatio: number;
  maxMainRenderToBodyRatio: number;
  dedupeConsecutiveDuplicates: boolean;
  minConsecutiveDuplicatesToCollapse: number;
  collapseShortAdjacentLines: boolean;
  shortLineCollapseMaxChars: number;
  cleanupPunctuation: boolean;
  dedupeAdjacentLinks: boolean;
  aggressiveCleanup: boolean;
  aggressiveCleanupMaxLinkTextLength: number;
  aggressiveCleanupHtmlTagPattern: RegExp;
  stripNoisyAttributesInLinkText: boolean;
  filterDecorativeImages: boolean;
  decorativeImageFilenamePatterns: RegExp[];
  filterDecorativeAlt: boolean;
  decorativeAltPattern: RegExp;
  decorativeAltMaxWords: number;
  suppressRepeatedImages: boolean;
  suppressRepeatedImageThreshold: number;
  filterWordPressNoiseLinks: boolean;
  wordpressNoiseLinkPatterns: RegExp[];
  compactLinkLabels: boolean;
  maxLinkLabelChars: number;
  maxHiddenFormValueLength: number;
  maskFormFieldNamePatterns: RegExp[];
  emitAppendix: boolean;
  emitNoscriptFallback: boolean;
  noscriptOnlyIfMainRenderShort: boolean;
  detectBadges: boolean;
  maxBadgeTextLength: number;
  badgeClassPattern: RegExp;
  unsafeTabButtonTextPatterns: RegExp[];
  skipSelectors: string[];
}

export type ProfileSettings = Partial<ExtractorConfig>;

export interface ResolvedConfig extends ExtractorConfig {
  activeProfile: ProfileName;
}

export interface ExtractOptions {
  profile?: AutoProfile;
  overrides?: ProfileSettings;
}

export type ProgressLevel = 'info' | 'warn' | 'error';
export type ProgressCallback = (step: string, message: string, level?: ProgressLevel) => void;

// Interaction flags derived from config (Section 4 of the prototype).
export interface DerivedFlags {
  allowClickTabs: boolean;
  allowOpenDetails: boolean;
  allowDropdownClicks: boolean;
  visualImportanceEnabled: boolean;
  stepMarkersEnabled: boolean;
  ariaHiddenMarkersEnabled: boolean;
  badgesEnabled: boolean;
}

export type TabCaptureSource =
  | 'aria-controls'
  | 'panel-after-group'
  | 'content-delta'
  | 'root-without-tab-buttons';

export interface TabPanelCapture {
  label?: string;
  lines?: string[];
  text?: string;
  source: TabCaptureSource;
}

export interface DropdownPanelCapture {
  label: string;
  lines: string[];
  source: 'dropdown-panel';
}

export interface FormFieldRecord {
  tag: string;
  type: string;
  label: string;
  name: string;
  placeholder: string;
  rawValue: string;
  aria: string;
  text: string;
  required: boolean;
  autocomplete: string;
  sanitizedValue: string;
}

export interface FormRecord {
  action: string;
  method: string;
  formName: string;
  visibleFields: FormFieldRecord[];
  hiddenFields: FormFieldRecord[];
}

export interface IframeRecord {
  src: string;
  title: string;
}

export interface FooterLinkRecord {
  text: string;
  href: string;
}

export interface CapturedTabRecord {
  label: string;
  source: TabCaptureSource;
}

export interface AppendixData {
  forms: FormRecord[];
  iframes: IframeRecord[];
  footerLinks: FooterLinkRecord[];
  capturedTabs: CapturedTabRecord[];
  images: number;
  headings: number;
  links: number;
  codeBlocks: number;
}

export interface TouchedDetailsRecord {
  el: HTMLDetailsElement;
  hadOpen: boolean;
  originalName: string | null;
  hadName: boolean;
}

// Mutable per-run state (Section 6 of the prototype).
export interface ExtractorState {
  tabPanelsByButtonId: Map<string, TabPanelCapture>;
  dropdownPanelsByButtonId: Map<string, DropdownPanelCapture>;
  capturedTabPanelElements: WeakSet<Element>;
  capturedDropdownPanelElements: WeakSet<Element>;
  capturedTabPanelTextSignatures: Set<string>;
  knownTabButtonIds: Set<string>;
  touchedDetailsElements: TouchedDetailsRecord[];
  taggedExporterAttrElements: Set<HTMLElement>;
  originalScrollPosition: { x: number; y: number } | null;
  baselineBodyText: string;
  initialUrl: string;
  // Set to true when tab capture must halt for the WHOLE page — e.g. URL drift
  // after a tab click that history.back() cannot restore. Local `aborted` flags
  // were only skipping the inner button loop, leaving remaining tab groups to
  // hang on the same navigated page (session #8 field-test bug).
  tabCaptureAborted: boolean;
  // Wall-clock timestamp when extractTabPanels() started, used for the
  // cumulative phase budget (config.tabPhaseBudgetMs). Null before Phase runs.
  tabPhaseStartMs: number | null;
}

// Everything a render/capture function needs, replacing the prototype's closures.
export interface ExtractContext {
  config: ResolvedConfig;
  flags: DerivedFlags;
  state: ExtractorState;
  appendix: AppendixData;
  progress: ProgressCallback;
}

export interface RenderOptions {
  expandTabs?: boolean;
  expandDropdowns?: boolean;
  includeRegionMarkers?: boolean;
  skipCapturedTabPanels?: boolean;
  skipCapturedDropdownPanels?: boolean;
  listType?: 'ul' | 'ol' | null;
  listIndex?: number | null;
}

export interface TabGroup {
  container: Element;
  buttons: HTMLElement[];
  reason: string;
  signature: string;
}

export type LinkType = 'mailto' | 'tel' | 'social' | 'linked-image' | 'link';

export interface ClassifiedLink {
  type: LinkType;
  label: string;
}

export interface SrcResolution {
  src: string;
  candidates: string[];
}

export interface OfficialMarkdownResult {
  url: string;
  markdown: string;
}

export type QualityRatioStatus = 'OK' | 'UNDER-EXTRACTED' | 'OVER-EXTRACTED-NOISE';

export interface QualityReport {
  mainRenderChars: number;
  baselineChars: number;
  ratio: number;
  ratioStatus: QualityRatioStatus;
  headings: number;
  links: number;
  images: number;
  forms: number;
  iframes: number;
  codeBlocks: number;
  capturedTabs: number;
  footerLinks: number;
  domPreCount: number;
  codeGroupTablists: number;
}

export type ExtractStatus = 'ok' | 'official-md' | 'fallback-after-crash';

export interface ExtractResult {
  status: ExtractStatus;
  markdown: string;
  filename: string;
  profile: ProfileName;
  officialMarkdownUrl?: string;
  officialMarkdownRatio?: number;
  quality?: QualityReport;
  tabsCaptured: number;
  dropdownsCaptured: number;
  error?: { name: string; message: string };
}
