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

import type { ArtemisBridge, SkillInfo, SkillLibraryDocument } from '@rx-artemis/protocol';
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

  /**
   * The document as of the latest switch, for the next one to start from.
   *
   * A ref because two switches thrown in quick succession both close over the
   * `document` of the render they were created in, and the second built on that
   * would silently undo the first.
   */
  const latest = useRef<SkillLibraryDocument>(document);
  latest.current = document;

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

    void (async () => {
      const result = await call(() => bridge.save({ document: next }));
      if (result.ok) {
        setSaveError(null);
        return;
      }
      setSaveError(result.error.message);
      // Put back only what this switch changed. A later switch that has since
      // landed is not this one's to undo.
      const undone = withSkillAlwaysOn(latest.current, name, !on);
      latest.current = undone;
      setDocument(undone);
    })();
  }, []);

  return { loading, error, skills, document, saveError, setAlwaysOn };
}
