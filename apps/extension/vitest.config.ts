import { defineConfig } from 'vitest/config';

/**
 * Test configuration for the extension.
 *
 * Two things only, both because of the end-to-end suite. The timeout is
 * generous because that suite builds the package, starts a browser and drives
 * every verb through it, and a build on a cold machine is not fast. And the
 * files run one at a time: the suite spawns a Chromium, and several of them at
 * once is how a shared build box gets its test run killed for memory rather
 * than failed for a reason.
 *
 * The unit tests are unaffected by both — they run in milliseconds and share
 * nothing.
 */
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
