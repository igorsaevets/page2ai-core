// P2A-014: label/value grids built from sibling DIVs (k/v, label/value) with short
// texts should render as "Label: value" instead of two paragraphs. Heuristic in
// src/node/basic-renderer.ts (isKvGrid / getKvPairs): class-gated, short ≤30.
// This test pins the fixed output; before the fix these three cases produced
// "Plan\n\nstarter", "Recordings\n\n5", "Plan\n\nstarter\n\nRenewal\n\nmonthly".
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/node/index.js';

const md = (html: string): string =>
  htmlToMarkdown(html, { baseUrl: 'https://example.test/', includeFrontmatter: false }).markdown.trim();
const page = (body: string): string => `<html><body><main>${body}</main></body></html>`;

describe('P2A-014: label/value pairing (k/v, label/value ≤30 → "Label: value")', () => {
  it('k/v single pair under heading', () => {
    expect(md(page('<h3>Billing</h3><div class="kv"><div class="k">Plan</div><div class="v">starter</div></div>'))).toBe(
      '### Billing\n\nPlan: starter',
    );
  });

  it('label/value metric tile', () => {
    expect(md(page('<div class="tile"><div class="label">Recordings</div><div class="value">5</div></div>'))).toBe(
      'Recordings: 5',
    );
  });

  it('k/v two pairs in one grid', () => {
    expect(
      md(
        page(
          '<div class="kv"><div class="k">Plan</div><div class="v">starter</div><div class="k">Renewal</div><div class="v">monthly</div></div>',
        ),
      ),
    ).toBe('Plan: starter\nRenewal: monthly');
  });

  // Negative: no class hint → stays two paragraphs (no false pairing of nav/badge divs)
  it('does not pair generic short divs without label/value class', () => {
    expect(md(page('<div><div>One</div><div>Two</div></div>'))).toBe('One\n\nTwo');
    expect(md(page('<div class="nav"><div>Home</div><div>About</div></div>'))).toBe('Home\n\nAbout');
  });

  it('does not pair when texts are long (>30)', () => {
    const longLabel = 'This is a very long label that exceeds thirty chars';
    expect(
      md(page(`<div class="kv"><div class="k">${longLabel}</div><div class="v">starter</div></div>`)),
    ).toBe(`${longLabel}\n\nstarter`);
  });

  it('does not pair odd number of children', () => {
    expect(
      md(page('<div class="kv"><div class="k">Plan</div><div class="v">starter</div><div class="k">Extra</div></div>')),
    ).toBe('Plan\n\nstarter\n\nExtra');
  });

  it('preserves inline markup inside label/value', () => {
    expect(
      md(page('<div class="kv"><div class="k"><strong>Plan</strong></div><div class="v"><a href="/s">starter</a></div></div>')),
    ).toBe('**Plan**: [starter](https://example.test/s)');
  });

  it('pairs via row wrappers', () => {
    expect(
      md(
        page(
          '<div class="kv"><div class="row"><div class="k">Plan</div><div class="v">starter</div></div><div class="row"><div class="k">Renewal</div><div class="v">monthly</div></div></div>',
        ),
      ),
    ).toBe('Plan: starter\nRenewal: monthly');
  });

  it('does not pair when container has stray text', () => {
    expect(md(page('<div class="kv">intro<div class="k">Plan</div><div class="v">starter</div></div>'))).toBe(
      'intro\n\nPlan\n\nstarter',
    );
  });
});
