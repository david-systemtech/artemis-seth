/**
 * The skills one Artemis server carries, for the Skills pane.
 *
 * A conversation on a server runs there, with the server's skills, so this is
 * the list the always-on switches are resolved against for it. The switches
 * themselves are not here: they are one choice, kept on this machine by
 * `useSkills`, and they cross to the server by name when a run starts.
 *
 * One instance per server profile. Every write answers with the server's whole
 * state, read after the write, and that answer is what is drawn — a clone just
 * changed a disk this machine cannot see.
 */

import { useCallback, useEffect, useState } from 'react';

import type { ArtemisBridge, IpcResult, ServerSkillsResponse } from '@rx-artemis/protocol';

import { call, resolveBridge } from '../lib/bridge';

export interface ServerSkillsPane {
  readonly loading: boolean;
  /** Why the server could not be asked at all. */
  readonly error: string | null;
  /** What it carries, or `null` until it has answered once. */
  readonly state: ServerSkillsResponse | null;
  /** `'add'`, a source id, `'all'`, or `null` when nothing is running. */
  readonly busy: string | null;
  /** Why the last repository action did not take. */
  readonly actionError: string | null;
  addSource(url: string, subdir: string): Promise<boolean>;
  removeSource(id: string): void;
  syncSources(id?: string): void;
}

function channel(): ArtemisBridge['serverSkills'] | null {
  // `?.` on the surface as well as the bridge: a test harness that predates
  // this surface hands over a bridge without it, and that is "cannot ask".
  return resolveBridge().bridge?.serverSkills ?? null;
}

export function useServerSkills(profileId: string): ServerSkillsPane {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ServerSkillsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const bridge = channel();
      if (bridge === null) {
        setLoading(false);
        setError('This window cannot reach the main process.');
        return;
      }
      const result = await call(() => bridge.list({ profileId: profileId as never }));
      if (!live) return;
      setLoading(false);
      if (result.ok) {
        setState(result.value);
        setError(null);
      } else {
        setError(result.error.message);
      }
    })();
    return () => {
      live = false;
    };
  }, [profileId]);

  const act = useCallback(
    async (
      what: string,
      run: (bridge: ArtemisBridge['serverSkills']) => Promise<IpcResult<ServerSkillsResponse>>,
    ): Promise<boolean> => {
      const bridge = channel();
      if (bridge === null) {
        setActionError('This window cannot reach the main process.');
        return false;
      }
      setBusy(what);
      const result = await call(() => run(bridge));
      setBusy(null);
      if (!result.ok) {
        setActionError(result.error.message);
        return false;
      }
      setActionError(null);
      setState(result.value);
      return true;
    },
    [],
  );

  const addSource = useCallback(
    (url: string, subdir: string) =>
      act('add', (bridge) => bridge.addSource({ profileId: profileId as never, url, subdir })),
    [act, profileId],
  );
  const removeSource = useCallback(
    (id: string) => void act(id, (bridge) => bridge.removeSource({ profileId: profileId as never, id })),
    [act, profileId],
  );
  const syncSources = useCallback(
    (id?: string) =>
      void act(id ?? 'all', (bridge) =>
        bridge.syncSources({ profileId: profileId as never, ...(id === undefined ? {} : { id }) }),
      ),
    [act, profileId],
  );

  return { loading, error, state, busy, actionError, addSource, removeSource, syncSources };
}
