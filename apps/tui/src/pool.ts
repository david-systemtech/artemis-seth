/**
 * Several conversations alive, one on screen.
 *
 * `app.tsx` holds a pool of `Conversation`s so that a turn can go on working
 * after the person has switched to another conversation — see the note there
 * on why the engine never needed the old one-at-a-time rule. These are the
 * decisions the pool makes, kept pure so they can be pinned without a
 * renderer and so the component that uses them stays a wiring diagram.
 */

import type { ConversationStatus } from './conversation.js';
import type { RailActivity } from './components/Sidebar.js';

export interface Pruned<T> {
  /** Still alive, in a stable order, with `next` last if it was not already present. */
  readonly kept: readonly T[];
  /** To be disposed by the caller. */
  readonly dropped: readonly T[];
}

/**
 * Who survives a switch to `next`.
 *
 * The one being switched to always does. Of the rest, only a conversation
 * still working is worth keeping: an idle one's transcript is already in the
 * store and costs one read to bring back, whereas a working one's run is
 * still producing events that only it is listening for. Bounded by
 * construction — nothing idle accumulates.
 */
export function prunePool<T>(pool: readonly T[], next: T, isLive: (conversation: T) => boolean): Pruned<T> {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const conversation of pool) {
    if (conversation === next || isLive(conversation)) kept.push(conversation);
    else dropped.push(conversation);
  }
  if (!kept.includes(next)) kept.push(next);
  return { kept, dropped };
}

export interface ActivityInput {
  readonly sessionId?: string | undefined;
  readonly status: ConversationStatus;
  readonly pendingPermissions: readonly unknown[];
}

/**
 * What the rail says each conversation is doing, by session id.
 *
 * Read off the conversation's own status rather than asked of the registry:
 * between Enter and the provider's first event the run is `starting` and the
 * registry does not know it yet, so "is this run active" said no about a
 * conversation that was, to the person, plainly working. A question waiting
 * for an answer outranks running, because it is the one state a parked
 * conversation cannot get out of on its own.
 */
export function railActivityFor(conversations: Iterable<ActivityInput>): ReadonlyMap<string, RailActivity> {
  const map = new Map<string, RailActivity>();
  for (const { sessionId, status, pendingPermissions } of conversations) {
    if (sessionId === undefined) continue;
    if (pendingPermissions.length > 0) map.set(sessionId, 'awaiting');
    else if (status !== 'idle') map.set(sessionId, 'running');
  }
  return map;
}

/* -------------------------------------------------------------------------- */
/* Who wants you back                                                         */
/* -------------------------------------------------------------------------- */

/** Why a conversation wants a person back. */
export type NeedKind = 'awaiting' | 'finished';

/**
 * What the question "does this one need me" depends on.
 *
 * `key` is whatever the caller already knows a conversation by and is the only
 * thing that comes back out, so this module never has to hold a `Conversation`
 * to answer a question about one. A session id is the obvious choice and the
 * wrong one on its own: a conversation nothing has been sent in yet has no
 * session and can still be sitting on a finished turn from before it was
 * forked, so `app.tsx` hands out a key of its own and this stays incurious
 * about what is in it.
 */
export interface NeedInput {
  readonly key: string;
  readonly status: ConversationStatus;
  readonly pendingPermissions: readonly unknown[];
  /** Host clock when its last turn ended. Absent until one has. */
  readonly finishedAt?: number | undefined;
}

export interface Needing {
  readonly key: string;
  readonly kind: NeedKind;
}

/**
 * Every conversation with a claim on the person, most pressing first.
 *
 * Two bands, and the order between them is the whole of the judgement. A
 * conversation stopped on a permission is *blocked* — it cannot get out of
 * that state on its own, and every second it sits there is a second nothing
 * happens — so all of those come before any of the second band. A conversation
 * whose turn ended while you were reading somebody else's is merely *unread*:
 * worth going back to, and worth going back to after the ones that are stuck.
 * Within each band the caller's order is kept, which is how `app.tsx` gets a
 * cycle that runs down the rail rather than jumping about it.
 *
 * "Since you last looked at it" is the second band's whole definition, and it
 * is why `seenAt` is a parameter rather than a field: a conversation on the
 * screen is being looked at *now*, whatever was last written down about it, and
 * only the caller knows which one that is.
 *
 * A turn still in flight is in neither band. Its glyph in the rail says so, it
 * will ask for the person itself when it stops, and a list that included it
 * would send somebody to a screen with nothing on it yet. A returned list is
 * also the count the status line draws — one answer, so the number beside the
 * composer and the conversation Ctrl+] goes to can never disagree.
 */
export function needsYou(states: readonly NeedInput[], seenAt: ReadonlyMap<string, number>): readonly Needing[] {
  const blocked: Needing[] = [];
  const unread: Needing[] = [];
  for (const state of states) {
    if (state.pendingPermissions.length > 0) {
      blocked.push({ key: state.key, kind: 'awaiting' });
      continue;
    }
    if (state.status !== 'idle' || state.finishedAt === undefined) continue;
    if (state.finishedAt > (seenAt.get(state.key) ?? 0)) unread.push({ key: state.key, kind: 'finished' });
  }
  return [...blocked, ...unread];
}
