/**
 * This machine's skills and the always-on choices, as the Skills pane sees them.
 *
 * Not in the app store, for the reason `useAgentPrompts` gives: the document is
 * owned by the main process, read when the pane opens and written back when it
 * changes, and nothing outside the pane reads it — a run gets its always-on
 * skills from `engine.ts`, never from here.
 *
 * ---------------------------------------------------------------------------
 * A SWITCH SAVES AT ONCE, AND A FAILED SAVE PUTS IT BACK
 * ---------------------------------------------------------------------------
 *
 * The prompt library debounces because its edits are keystrokes. These are
 * switches: one gesture, one write, no burst to coalesce — and no unmount race
 * to guard, because the write is issued in the same tick as the click.
 *
 * The switch moves before the write lands, because a control that waits on IPC
 * feels broken. If the write then fails, it moves back and says why. That is
 * the opposite of what the prompt library does with a failed save — it keeps
 * the user's text on screen — and the difference is what is at stake: a
 * half-typed paragraph is work worth keeping in view, while a switch showing
 * "on" for a skill no run will ever be given is simply a lie about the next
 * conversation.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ArtemisBridge,
  IpcResult,
  SkillInfo,
  SkillLibraryDocument,
  SkillSourceStatus,
  SkillsListResponse,
} from '@rx-artemis/protocol';
import { defaultSkillLibraryDocument, withSkillAlwaysOn } from '@rx-artemis/protocol';

import { call, resolveBridge } from '../lib/bridge';

export interface SkillsPaneState {
  /** True until the first read lands. */
  readonly loading: boolean;
  /** Why the *read* failed. Fatal to the pane; nothing is drawn to switch. */
  readonly error: string | null;
  /** Every skill a session on this machine would be offered, by name. */
  readonly skills: readonly SkillInfo[];
  readonly document: SkillLibraryDocument;
  /** Why the last switch did not take, already safe to show. Cleared by the next one that does. */
  readonly saveError: string | null;
  /** Switch a skill always-on, or off. */
  readonly setAlwaysOn: (name: string, on: boolean) => void;
  /** The repositories this machine keeps cloned, and how each copy is doing. */
  readonly sources: readonly SkillSourceStatus[];
  /**
   * Which source action is running: `'add'`, a source's id while it is being
   * pulled or removed, `'all'` for "pull everything", or `null`. One at a time —
   * a clone can take a while, and two racing each other would each answer with
   * a list the other had already changed.
   */
  readonly sourceBusy: string | null;
  /** Why the last source action failed, already safe to show. */
  readonly sourceError: string | null;
  /** Subscribe to a repository. Resolves true when it was added. */
  readonly addSource: (url: string, subdir: string) => Promise<boolean>;
  readonly removeSource: (id: string) => void;
  /** Pull now: one source, or every one when no id is given. */
  readonly syncSources: (id?: string) => void;
}

function channel(): ArtemisBridge['skills'] | null {
  return resolveBridge().bridge?.skills ?? null;
}

export function useSkills(): SkillsPaneState {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<readonly SkillInfo[]>([]);
  const [document, setDocument] = useState<SkillLibraryDocument>(defaultSkillLibraryDocument);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sources, setSources] = useState<readonly SkillSourceStatus[]>([]);
  const [sourceBusy, setSourceBusy] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);

  /**
   * The document as of the latest switch, for the next one to start from.
   *
   * A ref because two switches thrown in quick succession both close over the
   * `document` of the render they were created in, and the second built on that
   * would silently undo the first.
   */
  const latest = useRef<SkillLibraryDocument>(document);
  latest.current = document;

  /**
   * What main last said it holds — the document every run is composed from —
   * and how many switches have been sent to it.
   *
   * While switches are in flight the pane shows its own guess; when the last
   * of them is answered it shows main's word instead. Undoing one failed switch
   * on top of the guess cannot do that: a later save carried the failed switch
   * with it, so it may well have landed after all, and a switch-off put back
   * by hand comes back with a scope of everyone, not the one it had.
   */
  const stored = useRef<SkillLibraryDocument>(document);
  const sent = useRef(0);
  /** The newest save whose answer {@link stored} reflects. */
  const answered = useRef(0);

  useEffect(() => {
    const bridge = channel();
    if (bridge === null) {
      setLoading(false);
      setError('This window cannot reach the main process.');
      return undefined;
    }

    let cancelled = false;
    void (async () => {
      const result = await call(() => bridge.list({}));
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        // Not seeded with an empty library: switches drawn over a read that
        // failed would, on the first click, replace the real choices with one.
        setError(result.error.message);
        return;
      }
      setError(null);
      setSkills(result.value.skills);
      setSources(result.value.sources);
      stored.current = result.value.document;
      setDocument(result.value.document);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const setAlwaysOn = useCallback((name: string, on: boolean): void => {
    const before = latest.current;
    const next = withSkillAlwaysOn(before, name, on);
    if (next === before) return;

    latest.current = next;
    setDocument(next);

    const bridge = channel();
    if (bridge === null) {
      latest.current = before;
      setDocument(before);
      setSaveError('This window cannot reach the main process.');
      return;
    }

    const save = ++sent.current;
    void (async () => {
      const result = await call(() => bridge.save({ document: next }));
      if (result.ok) {
        // Main answers with what it stored, which may differ from what was
        // sent: it rebuilds the document on the way in.
        if (save > answered.current) {
          stored.current = result.value.document;
          answered.current = save;
        }
        setSaveError(null);
      } else {
        setSaveError(result.error.message);
      }
      // A switch still in flight keeps the pane on its guess; the last answer
      // settles it on what main holds.
      if (save === sent.current) {
        latest.current = stored.current;
        setDocument(stored.current);
      }
    })();
  }, []);

  /**
   * Run one source action and take main's whole answer.
   *
   * The list and the sources are adopted as answered, because a clone just
   * changed what is on the disk and nothing here could have guessed how. The
   * *choices* are not: a source action never changes them, and adopting the
   * document from its answer could overwrite a switch still in flight.
   */
  const sourceAction = useCallback(
    async (
      busy: string,
      act: (bridge: ArtemisBridge['skills']) => Promise<IpcResult<SkillsListResponse>>,
    ): Promise<boolean> => {
      const bridge = channel();
      if (bridge === null) {
        setSourceError('This window cannot reach the main process.');
        return false;
      }
      setSourceBusy(busy);
      const result = await call(() => act(bridge));
      setSourceBusy(null);
      if (!result.ok) {
        setSourceError(result.error.message);
        return false;
      }
      setSourceError(null);
      setSkills(result.value.skills);
      setSources(result.value.sources);
      return true;
    },
    [],
  );

  const addSource = useCallback(
    (url: string, subdir: string) => sourceAction('add', (bridge) => bridge.addSource({ url, subdir })),
    [sourceAction],
  );
  const removeSource = useCallback(
    (id: string) => void sourceAction(id, (bridge) => bridge.removeSource({ id })),
    [sourceAction],
  );
  const syncSources = useCallback(
    (id?: string) =>
      void sourceAction(id ?? 'all', (bridge) => bridge.syncSources(id === undefined ? {} : { id })),
    [sourceAction],
  );

  return {
    loading,
    error,
    skills,
    document,
    saveError,
    setAlwaysOn,
    sources,
    sourceBusy,
    sourceError,
    addSource,
    removeSource,
    syncSources,
  };
}
