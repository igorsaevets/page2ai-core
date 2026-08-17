import { describe, expect, it } from 'vitest';
import { detectProfile, resolveConfig } from '../../src/shared/profiles.js';

// Regression: detectProfile used `doc: Document = document` default params.
// In Node there is no global `document`, so resolveConfig({profile:'auto'})
// threw ReferenceError through the public "./shared/profiles" export.
describe('profiles in a DOM-less environment', () => {
  it('detectProfile() without arguments returns a neutral profile, not a throw', () => {
    expect(detectProfile()).toBe('marketing');
  });

  it("resolveConfig({profile:'auto'}) resolves instead of throwing", () => {
    const cfg = resolveConfig({ profile: 'auto' });
    expect(cfg.activeProfile).toBe('marketing');
  });
});
