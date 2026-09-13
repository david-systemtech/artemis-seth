/**
 * One spinner frame, shared by everything on screen that spins.
 *
 * There are two spinners now — the status line's, and one per row of the
 * delegated strip — and the naive version gives each its own `setInterval`.
 * Intervals started a few hundred milliseconds apart never converge, so the
 * screen ends up showing the same animation at two different points in its
 * cycle: it reads as two unrelated things happening rather than as one program
 * working, which is the opposite of what a spinner is for.
 *
 * So the frame is module state, advanced by a single timer that runs only while
 * something is subscribed to it. Every consumer reads the same number on the
 * same tick and they are therefore in phase by construction rather than by
 * luck. A spinner that nothing is watching costs nothing at all — the timer is
 * torn down with the last listener, which is what keeps an idle terminal from
 * waking twelve times a second forever.
 */

import { useSyncExternalStore } from 'react';

import { SPINNER, SPINNER_MS } from '../theme.js';

let frame = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    timer = setInterval(() => {
      frame = (frame + 1) % SPINNER.length;
      for (const notify of listeners) notify();
    }, SPINNER_MS);
    // Node holds the process open for a live timer, and this one never ends on
    // its own. Ink's exit would then wait on a spinner nobody is looking at.
    timer.unref?.();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const getFrame = (): number => frame;

/**
 * The current frame, or an empty string when this caller is not spinning.
 *
 * `active` gates the subscription rather than the reading, so an inactive
 * spinner is not merely invisible — it is not holding the shared timer open.
 */
export function useSpinner(active: boolean): string {
  const current = useSyncExternalStore(
    (onChange) => (active ? subscribe(onChange) : () => undefined),
    getFrame,
    getFrame,
  );
  return active ? (SPINNER[current] ?? '') : '';
}
