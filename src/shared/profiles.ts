// Profiles, auto-detection and config resolution.
// Ported from Rev-032v2 prototype (Sections 2, 2.1, 4).

import { DEFAULTS } from './constants.js';
import type {
  DerivedFlags,
  ExtractOptions,
  ProfileName,
  ProfileSettings,
  ProgressCallback,
  ResolvedConfig,
} from './types.js';

export const PROFILES: Record<ProfileName, ProfileSettings> = {
  'dashboard': {
    interactionMode: 'none',
    lazyLoadMode: 'none',
    tabPanelStrategy: 'safe',
    visualMarkersMode: 'none',
    officialMarkdownMode: 'never',
    structuredDataPosition: 'never-emit',
    extractInternalState: false,
    extractMicrodata: false,
    extractJsonLd: false,
    extractOpenGraph: false,
    collapseShortAdjacentLines: false,
    stripNoisyAttributesInLinkText: false,
    typeLinkedImages: false,
    filterDecorativeImages: false,
    filterDecorativeAlt: false,
    suppressRepeatedImages: false,
    outputMode: 'clean',
  },
  'docs': {
    interactionMode: 'safe-tabs-and-details',
    lazyLoadMode: 'full',
    lazyScrollSteps: 12,
    lazyScrollWaitMs: 250,
    lazyScrollExtraIdleMs: 600,
    tabPanelStrategy: 'aggressive',
    visualMarkersMode: 'important-only',
    officialMarkdownMode: 'trusted-docs-only',
    structuredDataPosition: 'before-content',
    extractInternalState: false,
    extractMicrodata: false,
    extractJsonLd: false,
    extractOpenGraph: false,
    collapseShortAdjacentLines: false,
    stripNoisyAttributesInLinkText: false,
    typeLinkedImages: false,
    filterDecorativeImages: true,
    filterDecorativeAlt: true,
    suppressRepeatedImages: true,
    outputMode: 'clean',
  },
  'marketing': {
    interactionMode: 'safe-tabs-and-details',
    lazyLoadMode: 'safe',
    tabPanelStrategy: 'balanced',
    visualMarkersMode: 'important-only',
    officialMarkdownMode: 'never',
    structuredDataPosition: 'after-content',
    extractInternalState: false,
    extractMicrodata: false,
    collapseShortAdjacentLines: true,
    stripNoisyAttributesInLinkText: false,
    typeLinkedImages: false,
    filterDecorativeImages: true,
    filterDecorativeAlt: true,
    suppressRepeatedImages: true,
    outputMode: 'clean',
  },
  'wordpress-marketing': {
    interactionMode: 'safe-tabs-and-details',
    lazyLoadMode: 'safe',
    lazyScrollWaitMs: 350,
    lazyScrollExtraIdleMs: 500,
    tabPanelStrategy: 'balanced',
    visualMarkersMode: 'important-only',
    officialMarkdownMode: 'never',
    structuredDataPosition: 'after-content',
    extractInternalState: false,
    extractMicrodata: false,
    collapseShortAdjacentLines: true,
    stripNoisyAttributesInLinkText: true,
    typeLinkedImages: true,
    filterDecorativeImages: true,
    filterDecorativeAlt: true,
    suppressRepeatedImages: true,
    filterWordPressNoiseLinks: true,
    outputMode: 'clean',
  },
  'research': {
    interactionMode: 'aggressive',
    lazyLoadMode: 'full',
    tabPanelStrategy: 'aggressive',
    visualMarkersMode: 'all',
    officialMarkdownMode: 'page-specific',
    structuredDataPosition: 'before-content',
    extractInternalState: true,
    extractMicrodata: true,
    extractJsonLd: true,
    extractOpenGraph: true,
    emitImageSrcsetCandidatesComment: true,
    collapseShortAdjacentLines: false,
    stripNoisyAttributesInLinkText: false,
    typeLinkedImages: false,
    filterDecorativeImages: false,
    filterDecorativeAlt: false,
    suppressRepeatedImages: false,
    outputMode: 'debug',
  },
};

// Auto-detects docs/wordpress/marketing/dashboard from page characteristics.
export const detectProfile = (
  doc: Document = document,
  loc: Location = location,
): ProfileName => {
  const hostname = loc.hostname.toLowerCase();
  const pathname = loc.pathname.toLowerCase();
  const generator = (
    doc.querySelector<HTMLMetaElement>('meta[name="generator"]')?.content || ''
  ).toLowerCase();

  // 1) Known docs engines by meta[name="generator"]
  if (
    generator.includes('mintlify') || generator.includes('docusaurus') ||
    generator.includes('gitbook') || generator.includes('readthedocs') ||
    generator.includes('mkdocs') || generator.includes('nextra') ||
    generator.includes('vitepress') || generator.includes('hugo')
  ) {
    return 'docs';
  }

  // 2) Known docs DOM signatures
  if (
    doc.querySelector(
      '[data-mintlify], .docusaurus-wrapper, .gitbook-root, ' +
        '.nextra-container, .vp-doc, [data-docs-component]',
    )
  ) {
    return 'docs';
  }

  // 3) Known documentation hostname patterns
  const docsHostPatterns = [
    /^docs?\./, /\.docs?\./, /^(api|reference|sdk)\./,
    /^developer[s]?\./, /^learn\./, /^guide[s]?\./,
  ];
  if (docsHostPatterns.some((p) => p.test(hostname))) return 'docs';

  // 4) URL path patterns for documentation
  if (/^\/(docs|api|reference|guide|sdk|manual|handbook|tutorial|learn)\b/i.test(pathname)) {
    return 'docs';
  }

  // 5) Multiple code blocks + tablists = likely dev docs
  const preCount = doc.querySelectorAll('pre code, pre > code').length;
  const tablistCount = doc.querySelectorAll('[role="tablist"]').length;
  if (preCount >= 4 && tablistCount >= 2) return 'docs';

  // 6) WordPress detection
  if (
    generator.includes('wordpress') ||
    doc.querySelector(
      'meta[name="wp-parsely_version"], link[href*="wp-content"], link[href*="wp-includes"]',
    )
  ) {
    return 'wordpress-marketing';
  }

  // 7) Dashboard / app detection
  if (
    doc.querySelector('[role="application"], [data-reactroot]') &&
    !doc.querySelector('article, .post, .entry-content')
  ) {
    if (
      pathname.includes('/app') || pathname.includes('/dashboard') || pathname.includes('/settings')
    ) {
      return 'dashboard';
    }
  }

  return 'marketing';
};

export const resolveConfig = (
  options: ExtractOptions = {},
  progress?: ProgressCallback,
): ResolvedConfig => {
  let profileName = options.profile || 'auto';
  if (profileName === 'auto') {
    profileName = detectProfile();
    progress?.('profile', `auto-detected profile="${profileName}"`);
  }
  const activeProfile: ProfileName = profileName in PROFILES ? profileName : 'marketing';
  const profileSettings = PROFILES[activeProfile];
  return {
    ...DEFAULTS,
    ...profileSettings,
    ...(options.overrides || {}),
    activeProfile,
  };
};

export const deriveFlags = (config: ResolvedConfig): DerivedFlags => {
  const allowClickTabs = config.interactionMode !== 'none';
  const allowOpenDetails =
    config.interactionMode === 'safe-tabs-and-details' || config.interactionMode === 'aggressive';
  const allowDropdownClicks = config.interactionMode === 'aggressive';
  const visualImportanceEnabled = config.visualMarkersMode === 'all';
  const stepMarkersEnabled =
    config.visualMarkersMode === 'important-only' || config.visualMarkersMode === 'all';
  const ariaHiddenMarkersEnabled =
    config.visualMarkersMode === 'important-only' || config.visualMarkersMode === 'all';
  const badgesEnabled =
    config.detectBadges &&
    (config.visualMarkersMode === 'important-only' || config.visualMarkersMode === 'all');
  return {
    allowClickTabs,
    allowOpenDetails,
    allowDropdownClicks,
    visualImportanceEnabled,
    stepMarkersEnabled,
    ariaHiddenMarkersEnabled,
    badgesEnabled,
  };
};
