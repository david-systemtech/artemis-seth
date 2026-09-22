/**
 * @vitest-environment jsdom
 *
 * The browser a run chose for itself, from the push channel to the pane.
 *
 * Every other browser choice in Artemis starts in a picker and travels towards
 * main. This one goes the other way: with two Chrome profiles connected and a
 * conversation set to neither, the run's first browser verb refuses, the agent
 * asks the user which, and the answer is taken inside a tool call in the main
 * process. The pane has to learn it or the next turn asks the same question
 * again — and the run navigator would go on saying "My Chrome" about a
 * conversation that has settled on one of two.
 *
 * What is pinned is the routing and what is written: the pane holding that run,
 * the conversation's own choice rather than the window's, and nothing at all
 * for a run this window does not hold.
 *
 * Same caveat as its neighbours: `renderer/tsconfig.json` excludes test files,
 * so the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { RunBrowserChoice } from '@rx-artemis/protocol';

import { focusedPane, installBrowserChoiceFeed, useApp } from './store';
import { setPaneState, type Pane, type RunState } from './pane';
import { ALL_CAPABILITIES, seedApp } from './testkit';

const pane = (): Pane => focusedPane();

/** The listener `installBrowserChoiceFeed` registered, from the fake bridge. */
let feed: ((choice: RunBrowserChoice) => void) | null = null;

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    onBrowserChoice: (listener: (choice: RunBrowserChoice) => void) => {
      feed = listener;
      return () => {
        feed = null;
      };
    },
  },
};

function runningRun(runId: string): RunState {
  return {
    runId,
    status: 'running',
    capabilities: ALL_CAPABILITIES,
    startedAt: 1,
  } as unknown as RunState;
}

function push(runId: string, browserId: string): void {
  if (feed === null) throw new Error('the feed was never installed');
  feed({ kind: 'run-browser-choice', runId, browserId } as RunBrowserChoice);
}

const state = () => pane().store.getState();

beforeEach(() => {
  installBrowserChoiceFeed();
  seedApp({ run: null, browserMode: null, browserExtensionId: null });
});

describe('a browser a run settled on', () => {
  it('becomes the conversation’s own choice, named', () => {
    setPaneState(pane(), { run: runningRun('run-1') });

    push('run-1', 'b-personal');

    expect(state().browserMode).toBe('extension');
    expect(state().browserExtensionId).toBe('b-personal');
  });

  it('lands mid-turn, while the run is still going', () => {
    // Unlike a predicted prompt, which is only meaningful about an ended run.
    // The question is asked on the *first* browser verb, which is the earliest
    // point in a turn anything browser-shaped happens.
    setPaneState(pane(), { run: runningRun('run-1') });

    push('run-1', 'b-work');

    expect(state().browserExtensionId).toBe('b-work');
  });

  it('is dropped for a run this window does not hold', () => {
    // Push channels broadcast to every window, so a second window hears about
    // the first window's runs and must have nowhere to put them.
    setPaneState(pane(), { run: runningRun('run-1') });

    push('run-elsewhere', 'b-work');

    expect(state().browserMode).toBeNull();
    expect(state().browserExtensionId).toBeNull();
  });

  it('is dropped by a window holding no run at all', () => {
    setPaneState(pane(), { run: null });

    push('run-1', 'b-work');

    expect(state().browserMode).toBeNull();
  });

  it('overrides a conversation that was following the window default', () => {
    // Which is exactly the conversation that could have been asked: one that
    // named no browser. The answer is a statement about the conversation, so
    // it stops following.
    useApp.setState({ browserMode: 'extension', browserExtensionId: null } as never);
    setPaneState(pane(), { run: runningRun('run-1'), browserMode: null });

    push('run-1', 'b-personal');

    expect(state().browserMode).toBe('extension');
    expect(state().browserExtensionId).toBe('b-personal');
    // And the window's own default is untouched: one conversation answered a
    // question, and the answer is not a setting for every other one.
    expect(useApp.getState().browserExtensionId).toBeNull();
  });

  it('replaces an earlier answer rather than accumulating one', () => {
    setPaneState(pane(), { run: runningRun('run-1') });

    push('run-1', 'b-work');
    push('run-1', 'b-personal');

    expect(state().browserExtensionId).toBe('b-personal');
  });
});
