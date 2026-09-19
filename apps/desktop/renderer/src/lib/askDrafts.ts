/**
 * What the user has put into a parked request's card and not yet sent.
 * ============================================================================
 *
 * The three cards that answer a parked request — a question, an approval, a
 * plan — held what had been picked or typed in `useState`, which lasts exactly
 * as long as the card. The card does not last as long as the request. Opening
 * another conversation moves this one's pane out of the grid: the pane is kept,
 * with its run still parked, but everything drawn inside it is unmounted, and
 * coming back draws a fresh card from nothing. Reported on 2026-09-19 — answers
 * clicked on a question, a switch to another session before sending, and every
 * choice gone on the way back. Hiding the pinned strip above the prompt box
 * lost them the same way without leaving the conversation at all.
 *
 * So the draft is kept here, against the request, and a card drawn again reads
 * it back.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REQUEST ID IS THE KEY
 * ---------------------------------------------------------------------------
 *
 * It is the one identity a card and its request share across every way the
 * card can be torn down and drawn again. The pane is not enough: a served run
 * that is re-attached empties the pane's queue and replays the parked request
 * into it. The id survives that — it is `<run id>:perm:<n>` with a UUID run id,
 * or for a served run the server's own id, passed through unchanged — so a
 * replay names the same request, and no two conversations can collide in a map
 * shared by the whole window.
 *
 * ---------------------------------------------------------------------------
 * WHY A MODULE MAP, AND NOT PERSISTED
 * ---------------------------------------------------------------------------
 *
 * For the reason `foldMemory` gives: a note is written a keystroke at a time,
 * and both stores fan every write out to everything subscribed to them. Here a
 * write re-renders the one card reading that request, and nothing else.
 *
 * Not written to disk. A local run's parked request does not outlive the app,
 * so there would be nothing to put a restored draft back onto; the honest scope
 * is the app's run, as it is for the folds.
 *
 * ---------------------------------------------------------------------------
 * WHEN AN ENTRY GOES
 * ---------------------------------------------------------------------------
 *
 * When the request settles, wherever the answer came from. The store's
 * `dropPermissionRequest` forgets it, and that is the one path a sent answer, a
 * `permission.resolved` from the server or another window, and a request the
 * provider withdrew all take. Not when a run ends with the request still
 * queued: a served run's stream can end and be re-attached with the same
 * request parked, and forgetting there would bring back the loss this file
 * exists to stop. A request that dies with its run leaves a few strings behind
 * for the rest of the app's run.
 */

const drafts = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

function notify(requestId: string): void {
  for (const listener of listeners.get(requestId) ?? []) listener();
}

/** What was left in this request's card, or `undefined` if nothing was. */
export function recallAskDraft(requestId: string): unknown {
  return drafts.get(requestId);
}

/** Record the card's draft. Called from its setter, never from a render. */
export function rememberAskDraft(requestId: string, draft: unknown): void {
  if (Object.is(drafts.get(requestId), draft)) return;
  drafts.set(requestId, draft);
  notify(requestId);
}

/** The request has settled, so there is nothing left for its draft to answer. */
export function forgetAskDraft(requestId: string): void {
  if (!drafts.delete(requestId)) return;
  notify(requestId);
}

export function subscribeAskDraft(requestId: string, listener: () => void): () => void {
  const set = listeners.get(requestId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(requestId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(requestId);
  };
}

/**
 * Forget every draft.
 *
 * For tests, which share a module registry across the cases in a file and
 * reuse request ids. Nothing in the app calls it: leaving a conversation is
 * exactly the moment a draft must not be forgotten.
 */
export function forgetAskDrafts(): void {
  drafts.clear();
}
