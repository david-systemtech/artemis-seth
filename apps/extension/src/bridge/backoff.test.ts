import { describe, expect, it } from 'vitest';

import { backoffDelay, BACKOFF_CEILING_MS, BACKOFF_FIRST_MS } from './backoff.js';

describe('backoffDelay', () => {
  it('doubles from a second up to the ceiling and stays there', () => {
    const plain = [0, 1, 2, 3, 4, 5, 6, 12, 40].map((attempt) => backoffDelay(attempt, 0));
    expect(plain).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000]);
    expect(plain[0]).toBe(BACKOFF_FIRST_MS);
  });

  it('never waits longer than the ceiling, whatever the jitter', () => {
    for (const jitter of [0, 0.5, 0.999, 1, 2, -1]) {
      expect(backoffDelay(50, jitter)).toBeLessThanOrEqual(BACKOFF_CEILING_MS);
    }
  });

  it('shortens the wait rather than lengthening it, so the ceiling stays a promise', () => {
    expect(backoffDelay(3, 1)).toBe(6_400);
    expect(backoffDelay(3, 0)).toBe(8_000);
  });
});
