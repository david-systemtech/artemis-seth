/**
 * A parked request's unsent answer, kept for as long as the request is.
 *
 * `useState`'s shape — a value, and a setter taking a value or an updater — so
 * each card swaps one call and nothing else. The value lives in
 * `lib/askDrafts`, not in the component, and that is the whole point: the card
 * is unmounted by a session switch or a minimised strip long before its request
 * is answered. See that file.
 *
 * The setter reads what is stored at the moment it is called, not what this
 * render saw, so an updater always gets the latest draft — including when two
 * writes land inside one batch, which is the case the question card's
 * `setOptions` takes an updater for.
 *
 * `empty` is what comes back while nothing is stored, and it must be a stable
 * value — `''`, or a constant declared outside the component — because it is
 * returned on every render until the first write.
 */

import { useCallback, useSyncExternalStore, type SetStateAction } from 'react';

import { recallAskDraft, rememberAskDraft, subscribeAskDraft } from '../lib/askDrafts';

export function useAskDraft<T>(
  requestId: string,
  empty: T,
): readonly [T, (action: SetStateAction<T>) => void] {
  const subscribe = useCallback(
    (notify: () => void) => subscribeAskDraft(requestId, notify),
    [requestId],
  );
  const stored = useSyncExternalStore(subscribe, () => recallAskDraft(requestId));

  const set = useCallback(
    (action: SetStateAction<T>) => {
      const held = recallAskDraft(requestId);
      const current = held === undefined ? empty : (held as T);
      rememberAskDraft(
        requestId,
        typeof action === 'function' ? (action as (previous: T) => T)(current) : action,
      );
    },
    [requestId, empty],
  );

  return [stored === undefined ? empty : (stored as T), set];
}
