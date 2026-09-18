/**
 * The one plan reading this process holds per account.
 *
 * A gauge is a fact about an *account*, and this terminal can have several
 * conversations open on one — a second tab on the same profile, a conversation
 * left in the rail, the failover picker probing every account it could move to.
 * Each of those used to hold its own copy on the `Conversation` itself, written
 * only by whatever that conversation happened to read or fold, so one tab could
 * sit at the figure from before a 5-hour window reset while the tab beside it
 * showed the figure after. Holding the reading once makes that impossible
 * rather than unlikely.
 *
 * Merging rather than replacing, for the reason `mergePlanUsage` documents: two
 * readings of one account are rarely the same age *throughout* — a poll re-reads
 * every window, a `plan.limit` verdict refreshes one — so ordering whole
 * snapshots throws away a freshly-read percentage whenever anything else about
 * the other side is newer.
 *
 * Its own module rather than a part of `host.ts` so that `conversation.ts` can
 * hold one without importing the composition root (and through it the provider
 * registry, the profile store and every adapter). The process's instance is
 * still built by the host — see `TuiHost.planUsage`.
 */

import {
  PLAN_USAGE_MAX_AGE_MS,
  mergePlanUsage,
  type PlanUsage,
  type ProfileId,
} from '@rx-artemis/protocol';

export interface PlanUsageStore {
  /** What is known about this account, or `null` while nothing is. */
  get(profileId: ProfileId): PlanUsage | null;
  /**
   * Fold a reading in and answer with the account's reading afterwards.
   *
   * `null` is "nothing was learned" and changes nothing — it is what a failed
   * read and an absent disk seed both amount to, and neither is evidence that
   * the account has no limits.
   */
  merge(profileId: ProfileId, usage: PlanUsage | null): PlanUsage | null;
  /** Hear about every account whose reading actually moved. */
  subscribe(listener: (profileId: ProfileId) => void): () => void;
}

/**
 * A reading remembered from the last launch, if it is still worth showing.
 *
 * The line under the composer opens on whatever the last session read, so the
 * account's numbers are there before the fresh read — one CLI call — comes back
 * a second later. That bargain only holds while the remembered figure is still
 * roughly true. It was allowed to be a *day* old, which meant a launch opened on
 * last night's percentages and then jumped when the real reading landed: two
 * numbers for one account, a second apart, which is the complaint in miniature.
 *
 * {@link PLAN_USAGE_MAX_AGE_MS} is the protocol's own bar — three missed poll
 * cycles, the same one the desktop holds a recommendation to. Past it there is
 * nothing honest to draw, and a blank second is the correct answer: a 5-hour
 * window may have rolled over twice since.
 */
export function seedablePlanUsage(
  remembered: { readonly at: number; readonly value: PlanUsage } | undefined,
  now: number = Date.now(),
): PlanUsage | null {
  if (remembered === undefined) return null;
  // Clamped at zero, as `recommendProfile` clamps it: a reading from the future
  // is a clock disagreeing with itself, not an infinitely stale reading.
  return Math.max(0, now - remembered.at) < PLAN_USAGE_MAX_AGE_MS ? remembered.value : null;
}

/** Build a {@link PlanUsageStore}. One per process; exported for tests. */
export function createPlanUsageStore(): PlanUsageStore {
  const held = new Map<ProfileId, PlanUsage>();
  const listeners = new Set<(profileId: ProfileId) => void>();

  return {
    get: (profileId) => held.get(profileId) ?? null,
    merge: (profileId, usage) => {
      const previous = held.get(profileId) ?? null;
      if (usage === null) return previous;
      const merged = mergePlanUsage(previous, usage);
      /*
        Identity, which `mergePlanUsage` promises. A reading that restated what
        was already held is not news, and waking every conversation for it would
        redraw the screen to show the same numbers — which on a terminal is a
        visible flicker rather than a wasted render.
      */
      if (merged === previous) return previous;
      held.set(profileId, merged);
      // Copied before iterating: a listener may unsubscribe itself mid-call.
      for (const listener of [...listeners]) listener(profileId);
      return merged;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
