/**
 * How long to wait before dialling Artemis again.
 *
 * Artemis not running is the *normal* state of this extension: a browser is
 * open all day and Artemis is open for part of it. So the reconnect loop is not
 * error handling, it is the main loop, and what it must not do is spend a
 * laptop's battery knocking on a closed port every second for eight hours.
 *
 * Exponential from one second to a thirty-second ceiling, which is also the
 * period of the keepalive alarm — past that point the alarm is what wakes a
 * stopped worker anyway, so a longer delay would buy nothing and only make
 * starting Artemis feel slow. The jitter is a fraction the caller supplies
 * (`Math.random()` in the worker, a fixed number in the tests) and spreads the
 * retries of a machine that has several browsers paired to the same Artemis.
 */

/** The wait after the first failed dial. */
export const BACKOFF_FIRST_MS = 1_000;

/** The longest wait between dials, matching the keepalive alarm's period. */
export const BACKOFF_CEILING_MS = 30_000;

/**
 * The delay before attempt number `attempt`, counting the first failure as 0.
 *
 * `jitter` is in `[0, 1)` and shortens the delay by up to a fifth, rather than
 * lengthening it: the ceiling is a promise about the worst case and a jitter
 * that could exceed it would break that promise.
 */
export function backoffDelay(attempt: number, jitter: number): number {
  const steps = Math.max(0, Math.min(attempt, 30));
  const plain = Math.min(BACKOFF_FIRST_MS * 2 ** steps, BACKOFF_CEILING_MS);
  return Math.round(plain * (1 - 0.2 * Math.max(0, Math.min(jitter, 1))));
}
