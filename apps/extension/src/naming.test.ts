/**
 * The brand lists here are the real ones. Chrome's includes a deliberately
 * absurd decoy entry designed to break code like this, and Edge and Brave
 * report Chrome's brand alongside their own, so an implementation that took the
 * first brand would call three different browsers "Chrome".
 */

import { describe, expect, it } from 'vitest';

import { browserNameFrom } from './naming.js';

describe('browserNameFrom', () => {
  it('names Chrome on Windows from the hints Chrome actually sends', () => {
    expect(
      browserNameFrom({
        brands: [{ brand: 'Not(A:Brand' }, { brand: 'Chromium' }, { brand: 'Google Chrome' }],
        platform: 'Windows',
      }),
    ).toBe('Google Chrome on Windows');
  });

  it('names Edge and Brave rather than the Chrome brand they also report', () => {
    expect(browserNameFrom({ brands: [{ brand: 'Not_A Brand' }, { brand: 'Chromium' }, { brand: 'Microsoft Edge' }], platform: 'macOS' })).toBe(
      'Microsoft Edge on macOS',
    );
    expect(browserNameFrom({ brands: [{ brand: 'Chromium' }, { brand: 'Brave' }, { brand: 'Not.A/Brand' }], platform: 'Linux' })).toBe('Brave on Linux');
  });

  it('falls back to the user-agent string when there are no hints, and puts the imposters first', () => {
    const chromium = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    expect(browserNameFrom({ userAgent: `${chromium} Edg/140.0.0.0` })).toBe('Microsoft Edge on Windows');
    expect(browserNameFrom({ userAgent: chromium })).toBe('Chrome on Windows');
  });

  it('reads the platform out of the user agent when the hint does not say', () => {
    expect(browserNameFrom({ brands: [{ brand: 'Google Chrome' }], userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe(
      'Google Chrome on macOS',
    );
  });

  it('gives a product on its own rather than inventing a platform it cannot read', () => {
    expect(browserNameFrom({ brands: [{ brand: 'Vivaldi' }] })).toBe('Vivaldi');
    expect(browserNameFrom({})).toBe('Browser');
  });
});
