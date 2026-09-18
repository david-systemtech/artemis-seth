/**
 * A clock that runs only while something is happening.
 *
 * Elapsed time is the one reading on screen that changes when nothing has
 * happened, and that makes it the one reading that must not live in a store.
 * A `turnElapsedMs` in `ConversationState` would be a write, a new snapshot
 * and a re-render of every subscriber once a second, for ever, to move a
 * single digit — and it would keep doing it while the terminal sat idle. What
 * the store carries instead is the fixed point (`turnStartedAt`), and the
 * component that draws a duration owns the clock that subtracts from it.
 *
 * `active` gates the interval rather than the reading, so an idle terminal is
 * genuinely idle: no timer, no wakeups, nothing for Ink to re-render. The tick
 * is one second because that is the resolution of every duration drawn from
 * it; anything faster is work nobody can see.
 *
 * `DelegatedStrip` has kept a private copy of exactly this since before it was
 * shared, and that copy should collapse into this one the next time that file
 * is opened.
 */

import { useEffect, useState } from 'react';

/** How often the clock moves. The durations drawn from it are whole seconds. */
const TICK_MS = 1_000;

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    // Read once on the way in as well. The value held while inactive is as old
    // as the last time this was switched off, so a turn that starts between
    // ticks would otherwise read as having started in the past — or, worse, in
    // the future — until the first interval fires a second later.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
