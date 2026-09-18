/**
 * @vitest-environment jsdom
 *
 * Opening a conversation that is still working.
 *
 * The bug this pins: clicking a session in the sidebar always read a **static
 * snapshot** off disk, whatever that conversation was doing at the time. A run
 * this window holds no pane for is unreachable by events — `applyAgentEvent`
 * drops anything `paneForRun` cannot place — so a conversation that was
 * mid-turn opened frozen and *stayed* frozen while the agent went on working.
 * Only ⌘R recovered it, because `adoptLiveRuns` runs at boot and attaches every
 * live run the registry knows about.
 *
 * A window holds no pane whenever the turn was started somewhere else: a
 * scheduled wakeup, a routine, another window, the HTTP server, or a pane this
 * window evicted. Each ends as a sidebar row marked working above a transcript
 * that will not move.
 *
 * Same caveat as the neighbouring suites: `renderer/tsconfig.json` excludes
 * test files, so these assertions are behavioural rather than typechecked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allPanes,
  closePane,
  focusPane,
  focusedPane,
  handleAgentEvent,
  refreshLiveWork,
  resumeSession,
  splitPane,
  submitPrompt,
  useApp,
} from './store';
import { paneState, setPaneState } from './pane';
import { seedApp } from './testkit';

const CAPS = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
} as const;

const CLAUDE_DESCRIPTOR = {
  id: 'claude',
  label: 'Claude',
  capabilities: CAPS,
  models: [],
  effortLevels: [],
  available: true,
};

const PROFILE = { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.p1' };

/** What the registry answers with. */
let mainProcessRuns: readonly unknown[] = [];
/** Whether the registry can answer at all. */
let registryReachable = true;
/** Held open so a test can move the selection while an open is in flight. */
let registryGate: Promise<void> | null = null;
/** Runs whose retained events were asked for — evidence of an attach. */
let eventsAsked: string[] = [];
/** Sessions whose stored transcript was read — evidence of a snapshot. */
let historyRead: string[] = [];
/** Run ids that received a mid-turn message. */
let steeredRuns: string[] = [];
/** New runs attempted by the composer. */
let startedRuns: string[] = [];
/** What the live-work poll says is actively running. */
let workingSessions: string[] = [];
/** Runs the composer asked the engine to attach to a served conversation with. */
let attachedInputs: { runId: string; resumeSessionId?: string; attachToLive?: boolean }[] = [];
/** Runs the window gave up on. */
let disposedRuns: string[] = [];
/**
 * Whether a served attach announces its session before `runs.start` answers,
 * as the engine really does: the run's first event is the `session.started`
 * for the conversation it is joining, pushed the moment the run exists.
 */
let announceOnStart = false;

function liveRun(runId: string, sessionId: string, status = 'running') {
  return {
    runId,
    status,
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/a',
    capabilities: CAPS,
    startedAt: 1_000,
    sessionId,
    // Zero, so `replayEarlierTurns` returns early: this suite is about which
    // path is taken, and a history read inside the attach only adds noise.
    historyOffset: 0,
  } as const;
}

function session(id: string) {
  return {
    id,
    title: 'A conversation',
    updatedAt: 2_000,
    cwd: '/a',
    profileId: 'p1',
    providerId: 'claude',
  } as never;
}

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    list: async () => {
      if (registryGate) await registryGate;
      return registryReachable
        ? { ok: true, value: { runs: mainProcessRuns } }
        : { ok: false, error: { code: 'unknown', message: 'the registry is unreachable' } };
    },
    events: async ({ runId }: { runId: string }) => {
      eventsAsked.push(runId);
      return { ok: true, value: { runId, events: [], truncated: false } };
    },
    send: async ({ runId }: { runId: string }) => {
      steeredRuns.push(runId);
      return { ok: true, value: { runId, deliveredImmediately: true } };
    },
    start: async (request: {
      runId?: string;
      input?: { runId: string; resumeSessionId?: string; attachToLive?: boolean };
    }) => {
      const input = request.input;
      startedRuns.push(input?.runId ?? request.runId ?? '?');
      // Joining a served run: the engine answers with the handle it minted,
      // carrying the seam the server measured. See `attachServedRun`.
      if (input?.attachToLive === true && input.resumeSessionId !== undefined) {
        attachedInputs.push(input);
        if (announceOnStart) {
          handleAgentEvent({
            type: 'session.started',
            runId: input.runId,
            seq: 0,
            ts: 1,
            sessionId: input.resumeSessionId,
            providerId: 'artemis',
            cwd: '/a',
            resumedFrom: input.resumeSessionId,
          } as never);
        }
        return {
          ok: true,
          value: { run: { ...liveRun(input.runId, input.resumeSessionId), providerId: 'artemis' } },
        };
      }
      return { ok: false, error: { code: 'unknown', message: 'unexpected rival run' } };
    },
    liveWork: async () => ({
      ok: true,
      value: { sessionIds: workingSessions, working: workingSessions, delegated: [] },
    }),
    dispose: async ({ runId }: { runId: string }) => {
      disposedRuns.push(runId);
      return { ok: true, value: {} };
    },
    onEvent: () => () => undefined,
  },
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
    messages: async (request: { sessionId: string }) => {
      historyRead.push(request.sessionId);
      return { ok: true, value: { events: [], hasMore: false } };
    },
  },
  profiles: { list: async () => ({ ok: true, value: { profiles: [PROFILE] } }) },
  providers: {
    list: async () => ({ ok: true, value: { providers: [CLAUDE_DESCRIPTOR] } }),
    models: async () => ({ ok: true, value: { models: [], live: false } }),
    commands: async () => ({ ok: true, value: { commands: [] } }),
  },
  usagePlan: { cached: async () => ({ ok: true, value: { usage: null } }) },
  workspace: { describe: async () => ({ ok: true, value: { workspace: null } }) },
  auth: { status: async () => ({ ok: true, value: { status: null } }) },
};

/** A `text.complete` on `runId`, as the live feed would deliver it. */
function say(runId: string, text: string, seq = 0) {
  return {
    type: 'text.complete',
    runId,
    seq,
    ts: 1,
    messageId: `${runId}:m${seq}`,
    role: 'assistant',
    text,
  } as never;
}

function paneFor(runId: string) {
  const state = useApp.getState();
  return [...allPanes(state), ...state.background].find(
    (pane) => paneState(pane).run?.runId === runId,
  );
}

function transcriptText(runId: string): string {
  const pane = paneFor(runId);
  if (!pane) return '';
  return pane.transcript
    .getListSnapshot()
    .map((id) => (pane.transcript.getItem(id) as { text?: string } | undefined)?.text ?? '')
    .join('');
}

beforeEach(() => {
  seedApp({
    providers: [CLAUDE_DESCRIPTOR],
    activeProviderId: 'claude',
    profiles: [PROFILE],
    activeProfileId: 'p1',
    cwd: '/a',
    run: null,
    resumeSessionId: null,
  } as never);
  mainProcessRuns = [];
  registryReachable = true;
  registryGate = null;
  eventsAsked = [];
  historyRead = [];
  steeredRuns = [];
  startedRuns = [];
  workingSessions = [];
  attachedInputs = [];
  disposedRuns = [];
  announceOnStart = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('opening a conversation from the sidebar', () => {
  it('attaches to the run when the conversation is still working', async () => {
    // The turn was started somewhere this window cannot see — a scheduled
    // wakeup, another window, the server — so no pane holds it.
    mainProcessRuns = [liveRun('r1', 's1')];

    resumeSession(session('s1'));
    await vi.waitFor(() => expect(eventsAsked).toContain('r1'));

    // The pane now *holds* the run, which is the whole point: events addressed
    // to it can be placed, so the conversation moves on screen as it happens
    // rather than at the next reload.
    handleAgentEvent(say('r1', 'still working on it'));
    await vi.waitFor(() => expect(transcriptText('r1')).toContain('still working on it'));
  });

  it('reads the stored transcript when nothing is running', async () => {
    mainProcessRuns = [];

    resumeSession(session('s1'));

    await vi.waitFor(() => expect(historyRead).toContain('s1'));
    expect(eventsAsked).toHaveLength(0);
  });

  it('reads the stored transcript for a run that has ended', async () => {
    // An ended run in the registry is history, not a live stream: attaching to
    // it would replace the conversation with one finished turn.
    mainProcessRuns = [liveRun('r1', 's1', 'ended')];

    resumeSession(session('s1'));

    await vi.waitFor(() => expect(historyRead).toContain('s1'));
    expect(eventsAsked).toHaveLength(0);
  });

  it('reads the stored transcript when the registry cannot answer', async () => {
    // Degrades to exactly the old behaviour rather than to an empty pane: the
    // conversation is still readable, it simply will not follow along.
    registryReachable = false;
    mainProcessRuns = [liveRun('r1', 's1')];

    resumeSession(session('s1'));

    await vi.waitFor(() => expect(historyRead).toContain('s1'));
    expect(eventsAsked).toHaveLength(0);
  });

  it('drops its answer when the column has moved on to another conversation', async () => {
    /*
     * Clicking one row and then another before the first registry answer
     * arrives. Attaching the first conversation's run now would rewrite the
     * column's provider, profile and directory from a handle for a
     * conversation the user has already navigated away from — the same race
     * the stored-transcript read has always guarded, and a louder one, because
     * an attach also takes ownership of a live stream.
     */
    mainProcessRuns = [liveRun('r1', 's1')];
    let release = (): void => undefined;
    registryGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    resumeSession(session('s1'));
    resumeSession(session('s2'));
    release();

    await vi.waitFor(() => expect(historyRead).toContain('s2'));
    // The abandoned conversation's run was never attached.
    expect(eventsAsked).toHaveLength(0);
  });

  it('reveals the column that already holds it rather than opening a second', async () => {
    // Single ownership is `resumeSession`'s own early return, and it is what
    // makes a second check inside the open unnecessary: the first open writes
    // `resumeSessionId` synchronously, so a second column clicking the same
    // row is sent to the pane that has it.
    mainProcessRuns = [liveRun('r1', 's1')];
    resumeSession(session('s1'));
    await vi.waitFor(() => expect(eventsAsked).toEqual(['r1']));

    const holder = paneFor('r1');
    eventsAsked = [];
    historyRead = [];
    const second = splitPane('right');
    resumeSession(session('s1'), second as never);

    // Nothing re-read and nothing re-attached; focus moved to the holder.
    expect(eventsAsked).toHaveLength(0);
    expect(historyRead).toHaveLength(0);
    expect(useApp.getState().focusedPaneId).toBe(holder?.id);
  });

  it('repairs an already-visible stale pane, then steers the real run', async () => {
    /*
     * The Codex split-brain reported on 2026-08-25: the pane retained the
     * session id but lost its live run binding. Clicking its row returned early
     * as "already open", so the composer started a rival turn and Codex refused
     * it because the original runner was still handling the session.
     */
    setPaneState(focusedPane(), {
      resumeSessionId: 's1',
      run: { ...liveRun('old-ended', 's1', 'ended'), endReason: 'error' },
    } as never);
    mainProcessRuns = [liveRun('r-live', 's1')];

    resumeSession(session('s1'));
    await vi.waitFor(() => expect(eventsAsked).toContain('r-live'));

    expect(paneState(focusedPane()).run).toMatchObject({
      runId: 'r-live',
      sessionId: 's1',
      status: 'running',
    });

    await submitPrompt('read this while you work');
    expect(steeredRuns).toEqual(['r-live']);
  });

  it('automatically repairs a stale visible pane when the live-work poll finds it', async () => {
    setPaneState(focusedPane(), {
      resumeSessionId: 's1',
      run: { ...liveRun('old-ended', 's1', 'ended'), endReason: 'error' },
    } as never);
    mainProcessRuns = [liveRun('r-live', 's1')];
    workingSessions = ['s1'];

    await refreshLiveWork();

    expect(eventsAsked).toEqual(['r-live']);
    expect(paneState(focusedPane()).run).toMatchObject({ runId: 'r-live', status: 'running' });
    expect(useApp.getState().runningSessions).toContain('s1');
  });

  it('joins a served conversation the server is working on when this registry has no run for it', async () => {
    /*
     * Reported 2026-09-17: the desktop restarted while the server was
     * mid-turn. The poll said the conversation was working, the pane showed a
     * static transcript, and only a typed message — steered, and answered
     * with a replay — put the work on screen. Nothing in this registry serves
     * a served run, so the pane asks the engine to attach to the server's.
     */
    setPaneState(focusedPane(), {
      resumeSessionId: 'sv1',
      run: null,
      activeProviderId: 'artemis',
      activeProfileId: 'p-served',
    } as never);
    mainProcessRuns = [];
    workingSessions = ['sv1'];

    await refreshLiveWork();

    expect(attachedInputs).toHaveLength(1);
    expect(attachedInputs[0]).toMatchObject({
      resumeSessionId: 'sv1',
      attachToLive: true,
      prompt: '',
    });
    const attached = attachedInputs[0]?.runId;
    expect(eventsAsked).toEqual([attached]);
    expect(paneState(focusedPane()).run).toMatchObject({
      runId: attached,
      sessionId: 'sv1',
      status: 'running',
    });

    // Still attached on the next poll: nothing asks the engine twice.
    await refreshLiveWork();
    expect(attachedInputs).toHaveLength(1);
    setPaneState(focusedPane(), { activeProviderId: 'claude', activeProfileId: 'p1' } as never);
  });

  it('keeps the served run it joined when its own announcement lands first', async () => {
    /*
     * Seen 2026-09-18: the pane fell idle while the server went on working,
     * and from then on drew a stopped card with nothing under it every few
     * seconds, with no message sent. Each live-work tick attached; the run's
     * own `session.started` reached the window before `runs.start` answered;
     * with no pane holding the id yet, `claimContinuation` adopted it onto
     * this pane — which then read as live, so the attach concluded the
     * column had moved on and disposed the run it had just asked for. The
     * dispose ended it, the card was drawn, the pane fell idle, and the next
     * tick did it all again.
     */
    setPaneState(focusedPane(), {
      resumeSessionId: 'sv2',
      run: null,
      activeProviderId: 'artemis',
      activeProfileId: 'p-served',
    } as never);
    mainProcessRuns = [];
    workingSessions = ['sv2'];
    announceOnStart = true;

    await refreshLiveWork();

    expect(attachedInputs).toHaveLength(1);
    const attached = attachedInputs[0]?.runId;
    // The run it asked for is the run it kept: rebuilt, not let go.
    expect(disposedRuns).toEqual([]);
    expect(eventsAsked).toEqual([attached]);
    expect(paneState(focusedPane()).run).toMatchObject({
      runId: attached,
      sessionId: 'sv2',
      status: 'running',
    });
    // And nothing of its own was drawn as a turn that came and went.
    const transcript = focusedPane().transcript;
    transcript.flush();
    const ends = transcript
      .getListSnapshot()
      .map((id) => transcript.getItem(id))
      .filter((item) => item?.kind === 'run-end');
    expect(ends).toHaveLength(0);

    // Live, so the next tick has nothing to do.
    await refreshLiveWork();
    expect(attachedInputs).toHaveLength(1);
    setPaneState(focusedPane(), { activeProviderId: 'claude', activeProfileId: 'p1' } as never);
  });

  it('reveals the live owner when a stale duplicate names the same session', () => {
    const stale = focusedPane();
    setPaneState(stale, {
      resumeSessionId: 's1',
      run: { ...liveRun('old-ended', 's1', 'ended'), endReason: 'error' },
    } as never);
    const live = splitPane('right');
    expect(live).not.toBeNull();
    setPaneState(live as never, { resumeSessionId: 's1', run: liveRun('r-live', 's1') } as never);
    focusPane(stale.id);

    resumeSession(session('s1'), stale);

    expect(useApp.getState().focusedPaneId).toBe(live?.id);
    // This suite seeds the focused pane between tests but deliberately keeps
    // the grid, so remove the extra column this assertion introduced.
    setPaneState(live as never, { resumeSessionId: null, run: null } as never);
    closePane((live as NonNullable<typeof live>).id);
    setPaneState(stale, { resumeSessionId: null, run: null } as never);
  });

  it('checks the registry before a stale pane can start a rival run', async () => {
    setPaneState(focusedPane(), {
      resumeSessionId: 's1',
      run: { ...liveRun('old-ended', 's1', 'ended'), endReason: 'error' },
    } as never);
    mainProcessRuns = [liveRun('r-live', 's1')];

    const sent = await submitPrompt('steer without waiting for the poll');

    expect(eventsAsked).toEqual(['r-live']);
    expect(paneState(focusedPane()).run).toMatchObject({ runId: 'r-live', status: 'running' });
    expect(sent).toBe(true);
    expect(steeredRuns).toEqual(['r-live']);
    expect(startedRuns).toHaveLength(0);
  });
});
