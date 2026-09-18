/**
 * Routines, as one hook — local ones and every server's.
 *
 * A routine runs in one of two places: on *this machine* (the desktop's own
 * scheduler, which fires only while the app is open) or on a *server* (which
 * fires with the app closed). The two are stored and reached completely
 * differently — the local ones over the `routines` IPC surface with a live
 * push, each server's over that server's authenticated HTTP through the
 * `serverRoutines` bridge — and this hook is the one place that knows both and
 * presents them as a single list the pane renders.
 *
 * ## Why the two sources are merged here rather than in two panes
 *
 * A person thinks in appointments, not in where the scheduler happens to live.
 * The pane shows one list; each row remembers where it runs so an edit, a
 * delete or a run-now is sent back to the right place. The local source pushes
 * (a firing updates it with no ask); the server sources do not, so they are
 * read on mount, when the set of server accounts changes, and again after any
 * mutation that could have changed them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ArtemisBridge,
  RoutineDraft,
  RoutineId,
  RoutinePatch,
  RoutineSnapshot,
} from '@rx-artemis/protocol';

import { call, resolveBridge } from '../lib/bridge';
import { useApp } from '../state/store';

/**
 * The provider id every Artemis-Server profile carries.
 *
 * A server routine is scheduled on a server, and the only profiles that name a
 * server are the ones talking this provider — the same id the engine's
 * `remoteEnvFor` checks before it will send an administrative request anywhere.
 */
const ARTEMIS_SERVER_PROVIDER_ID = 'artemis';

/** Where a routine runs, carried on every row so a mutation goes back to it. */
export type RoutineLocation =
  | { readonly kind: 'local' }
  | { readonly kind: 'server'; readonly profileId: string; readonly profileLabel: string };

/** A routine as the pane sees it: the snapshot plus where it runs. */
export interface RoutineRow extends RoutineSnapshot {
  readonly location: RoutineLocation;
}

export interface RoutinesPane {
  /** Local routines and every server's, merged, each tagged with where it runs. */
  readonly state: { readonly routines: readonly RoutineRow[] };
  /** A create/edit/delete/run-now call is in flight. */
  readonly busy: boolean;

  create(location: RoutineLocation, draft: RoutineDraft): void;
  update(location: RoutineLocation, id: RoutineId, patch: RoutinePatch): void;
  remove(location: RoutineLocation, id: RoutineId): void;
  runNow(location: RoutineLocation, id: RoutineId): void;
}

/** The local routines channels, or `null` in a window with no bridge at all. */
function routineChannels(): ArtemisBridge['routines'] | null {
  return resolveBridge().bridge?.routines ?? null;
}

/** The server-routine channels, or `null` in a window with no bridge at all. */
function serverRoutineChannels(): ArtemisBridge['serverRoutines'] | null {
  return resolveBridge().bridge?.serverRoutines ?? null;
}

export function useRoutines(): RoutinesPane {
  const [localRoutines, setLocalRoutines] = useState<readonly RoutineSnapshot[]>([]);
  /** Per server profile id, the routines that server reported. */
  const [serverRoutines, setServerRoutines] = useState<
    Readonly<Record<string, readonly RoutineSnapshot[]>>
  >({});
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  // `profiles` is a stable reference from the store; the Artemis-Server subset
  // is derived here rather than in the selector, because a selector that
  // returned a fresh array each call would fail zustand's cached-snapshot rule
  // and loop the render. Label is carried so a row can name its server without
  // a second read.
  const profiles = useApp((s) => s.profiles);
  const serverProfiles = useMemo(
    () =>
      profiles
        .filter((profile) => profile.providerId === ARTEMIS_SERVER_PROVIDER_ID)
        .map((profile) => ({ id: String(profile.id), label: profile.label })),
    [profiles],
  );
  const serverKey = serverProfiles.map((profile) => profile.id).join(',');

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /* Local routines: subscribe before the first read so a firing that lands
   * mid-read is not overwritten — the same race `useServerState` documents. */
  useEffect(() => {
    const routines = routineChannels();
    if (routines === null) return undefined;

    let pushed = false;
    const unsubscribe = routines.onChange((next) => {
      pushed = true;
      setLocalRoutines(next.routines);
    });
    void call(() => routines.list({})).then((result) => {
      if (result.ok && !pushed && mounted.current) setLocalRoutines(result.value.state.routines);
    });
    return unsubscribe;
  }, []);

  /** Re-read one server's routines. Failures (unreachable, older server, not an
   * Artemis Server profile) leave that server absent rather than failing the
   * whole pane — a routine that cannot be listed is one the person recreates,
   * not an error over the routines they can see. */
  const refreshServer = useCallback((profileId: string) => {
    const server = serverRoutineChannels();
    if (server === null) return;
    void call(() => server.list({ profileId })).then((result) => {
      if (!mounted.current) return;
      setServerRoutines((prev) =>
        result.ok ? { ...prev, [profileId]: result.value.routines } : prev,
      );
    });
  }, []);

  /* Every server's routines, read on mount and whenever the set of servers
   * changes. A server dropped from the list has its rows forgotten. */
  useEffect(() => {
    setServerRoutines((prev) => {
      const kept: Record<string, readonly RoutineSnapshot[]> = {};
      for (const profile of serverProfiles) {
        const existing = prev[profile.id];
        if (existing !== undefined) kept[profile.id] = existing;
      }
      return kept;
    });
    for (const profile of serverProfiles) refreshServer(profile.id);
    // `serverKey` collapses the profile list to the identities that matter, so
    // this does not re-fire on every unrelated store change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey, refreshServer]);

  const rows = useMemo<readonly RoutineRow[]>(() => {
    const local: RoutineRow[] = localRoutines.map((routine) => ({
      ...routine,
      location: { kind: 'local' },
    }));
    const remote: RoutineRow[] = serverProfiles.flatMap((profile) =>
      (serverRoutines[profile.id] ?? []).map((routine) => ({
        ...routine,
        location: { kind: 'server', profileId: profile.id, profileLabel: profile.label },
      })),
    );
    return [...local, ...remote];
  }, [localRoutines, serverRoutines, serverProfiles]);

  /** Run one mutation, holding `busy` across it so the form settles once. */
  const run = useCallback((operation: () => Promise<unknown>) => {
    setBusy(true);
    void Promise.resolve(operation()).finally(() => {
      if (mounted.current) setBusy(false);
    });
  }, []);

  const create = useCallback(
    (location: RoutineLocation, draft: RoutineDraft) => {
      if (location.kind === 'local') {
        const routines = routineChannels();
        if (routines === null) return;
        run(() =>
          call(() => routines.create({ draft })).then(
            (r) => r.ok && setLocalRoutines(r.value.state.routines),
          ),
        );
        return;
      }
      const server = serverRoutineChannels();
      if (server === null) return;
      run(() =>
        call(() => server.create({ profileId: location.profileId, draft })).then(
          (r) => r.ok && refreshServer(location.profileId),
        ),
      );
    },
    [run, refreshServer],
  );

  const update = useCallback(
    (location: RoutineLocation, id: RoutineId, patch: RoutinePatch) => {
      if (location.kind === 'local') {
        const routines = routineChannels();
        if (routines === null) return;
        run(() =>
          call(() => routines.update({ id, patch })).then(
            (r) => r.ok && setLocalRoutines(r.value.state.routines),
          ),
        );
        return;
      }
      const server = serverRoutineChannels();
      if (server === null) return;
      run(() =>
        call(() => server.update({ profileId: location.profileId, routineId: id, patch })).then(
          (r) => r.ok && refreshServer(location.profileId),
        ),
      );
    },
    [run, refreshServer],
  );

  const remove = useCallback(
    (location: RoutineLocation, id: RoutineId) => {
      if (location.kind === 'local') {
        const routines = routineChannels();
        if (routines === null) return;
        run(() =>
          call(() => routines.remove({ id })).then(
            (r) => r.ok && setLocalRoutines(r.value.state.routines),
          ),
        );
        return;
      }
      const server = serverRoutineChannels();
      if (server === null) return;
      run(() =>
        call(() => server.delete({ profileId: location.profileId, routineId: id })).then(
          (r) => r.ok && refreshServer(location.profileId),
        ),
      );
    },
    [run, refreshServer],
  );

  const runNow = useCallback(
    (location: RoutineLocation, id: RoutineId) => {
      if (location.kind === 'local') {
        const routines = routineChannels();
        if (routines === null) return;
        run(() =>
          call(() => routines.runNow({ id })).then(
            (r) => r.ok && setLocalRoutines(r.value.state.routines),
          ),
        );
        return;
      }
      const server = serverRoutineChannels();
      if (server === null) return;
      run(() =>
        call(() => server.runNow({ profileId: location.profileId, routineId: id })).then(
          (r) => r.ok && refreshServer(location.profileId),
        ),
      );
    },
    [run, refreshServer],
  );

  return { state: { routines: rows }, busy, create, update, remove, runNow };
}
