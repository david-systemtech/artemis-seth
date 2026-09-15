import { describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  Capabilities,
  PermissionRequest,
  RunHandle,
  RunId,
  RunInput,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';
import { syncScheduler } from '@rx-artemis/transcript';

import { ChangeLedger, type ChangeLedgerDeps } from './changes.js';
import { Conversation, type ConversationSettings, type ConversationState, type RunDriver } from './conversation.js';

const CLAUDE: Capabilities = {
  ...NO_CAPABILITIES,
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  resumeSession: true,
  permissionModes: ['default', 'plan', 'acceptEdits'],
};

const settings: ConversationSettings = {
  profileId: 'p1' as never,
  providerId: 'claude',
  profileLabel: 'work',
  providerLabel: 'Claude',
  cwd: '/repo',
  permissionMode: 'default',
};

/** A registry that records calls and lets a test emit events by hand. */
function fakeDriver(capabilities: Capabilities = CLAUDE) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const active = new Set<RunId>();
  const handles = new Map<RunId, RunHandle>();
  let seq = 0;
  const driver: RunDriver & {
    emit(event: Omit<AgentEvent, 'seq' | 'ts'>): void;
    start: ReturnType<typeof vi.fn<(input: RunInput) => Promise<RunHandle>>>;
    send: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
    respondToPermission: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    stopTask: ReturnType<typeof vi.fn>;
  } = {
    start: vi.fn(async (input: RunInput) => {
      const runId = input.runId as RunId;
      active.add(runId);
      const handle: RunHandle = {
        runId,
        providerId: input.providerId,
        profileId: input.profileId,
        cwd: input.cwd,
        status: 'running',
        capabilities,
        startedAt: 0,
        promptCount: 1,
      };
      handles.set(runId, handle);
      return handle;
    }),
    send: vi.fn(async () => ({ deliveredImmediately: false })),
    interrupt: vi.fn(async () => ({})),
    respondToPermission: vi.fn(async () => undefined),
    dispose: vi.fn(async () => ({})),
    stopTask: vi.fn(async () => undefined),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: (runId) => handles.get(runId),
    isActive: (runId) => active.has(runId),
    emit(event) {
      const full = { ...event, seq: seq++, ts: 0 } as AgentEvent;
      if (full.type === 'run.end') active.delete(full.runId);
      for (const listener of listeners) listener(full);
    },
  };
  return driver;
}

const ids = (() => {
  let n = 0;
  return () => `run-${++n}` as RunId;
})();

function conversation(driver: RunDriver, overrides: Partial<ConversationSettings> = {}) {
  return new Conversation({
    driver,
    settings: { ...settings, ...overrides },
    capabilitiesFor: () => CLAUDE,
    scheduler: syncScheduler,
    newRunId: ids,
  });
}

const rows = (c: Conversation) =>
  c.transcript.getRowsSnapshot().map((id) => c.transcript.getItem(id) ?? c.transcript.getGroup(id));

describe('Conversation', () => {
  it('starts a run for the first message and resumes the session for the next', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);

    expect(await c.send('hello')).toEqual({ ok: true });
    const first = driver.start.mock.calls[0]?.[0];
    expect(first).toMatchObject({ prompt: 'hello', permissionMode: 'default', cwd: '/repo' });
    expect(first?.resumeSessionId).toBeUndefined();
    expect(c.getState().status).toBe('running');

    // The optimistic row is confirmed once start() resolves.
    const user = rows(c)[0];
    expect(user).toMatchObject({ kind: 'user', text: 'hello', pending: false });

    const runId = first?.runId as RunId;
    driver.emit({ type: 'session.started', runId, sessionId: 's1' as never, providerId: 'claude', cwd: '/repo' });
    driver.emit({ type: 'run.end', runId, reason: 'completed' });
    expect(c.getState().status).toBe('idle');
    expect(c.getState().sessionId).toBe('s1');

    await c.send('again');
    expect(driver.start.mock.calls[1]?.[0]).toMatchObject({ prompt: 'again', resumeSessionId: 's1' });
  });

  /*
   * A turn that ends is not a turn that is finished with.
   *
   * `dispose()` is the one call that overrules the provider's retention of a
   * process — `ClaudeRun.release` exists precisely to stop the registry
   * reaching for it at every turn boundary, and says so. Calling it here killed
   * the CLI the moment a turn ended, and with it every subagent the turn had
   * deliberately left running in the background: measured against a real run,
   * the subagent's own transcript stopped mid-tool-call at 9 lines where an
   * undisposed one wrote 16 and a finished report. What the next turn then saw
   * was a fresh process whose ledger had never heard of the work — one row
   * reading `stopped`, `0 tools`, `0 tokens`, which is exactly what "the
   * subagents did no work" looks like from the outside.
   *
   * The registry retires a finished run on its own: the pump's `finally` calls
   * `#finalize`, which *releases* rather than disposes. Nothing here has to
   * help, and helping is the bug.
   */
  it('does not dispose a run that ended on its own, which would kill its background work', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('delegate something');
    const runId = driver.start.mock.calls[0]?.[0]?.runId as RunId;

    driver.emit({ type: 'session.started', runId, sessionId: 's1' as never, providerId: 'claude', cwd: '/repo' });
    driver.emit({
      type: 'background.tasks',
      runId,
      tasks: [{ id: 't1', kind: 'local_agent', description: 'summarise the notes', status: 'running', startedAt: 0, subagentType: 'Explore' }],
    });
    driver.emit({ type: 'run.end', runId, reason: 'completed' });

    expect(c.getState().status).toBe('idle');
    expect(driver.dispose).not.toHaveBeenCalled();
    // The work outlives the turn, and so does the row that reports it.
    expect(c.getState().tasks.map((task) => task.status)).toEqual(['running']);
  });

  it('interrupting is not disposing: the turn is stopped, the process is left alone', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('go');
    await c.interrupt();
    expect(driver.interrupt).toHaveBeenCalled();
    expect(driver.dispose).not.toHaveBeenCalled();
  });

  it('steers a live run when the provider allows it, and tracks queued delivery', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('first');
    const runId = c.getState().runId as RunId;

    expect(await c.send('and also')).toEqual({ ok: true });
    expect(driver.send).toHaveBeenCalledWith(runId, 'and also');
    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(c.getState().queued).toBe(1);
    expect(rows(c)[1]).toMatchObject({ kind: 'user', text: 'and also', messageId: `${runId}:prompt:2` });

    driver.emit({ type: 'message.delivered', runId, messageId: `${runId}:prompt:2` as never });
    expect(c.getState().queued).toBe(0);
  });

  it('refuses a mid-turn message on a provider without steering', async () => {
    const driver = fakeDriver({ ...CLAUDE, midRunSteering: false });
    const c = new Conversation({
      driver,
      settings: { ...settings, providerLabel: 'OpenCode' },
      capabilitiesFor: () => ({ ...CLAUDE, midRunSteering: false }),
      scheduler: syncScheduler,
      newRunId: ids,
    });
    await c.send('first');
    const outcome = await c.send('second');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/OpenCode cannot take a message mid-turn/);
    expect(driver.send).not.toHaveBeenCalled();
  });

  it('carries a steer that raced the end of its run into a fresh run', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('first');
    const runId = c.getState().runId as RunId;
    driver.send.mockImplementationOnce(async () => {
      driver.emit({ type: 'run.end', runId, reason: 'completed', sessionId: 's9' as never });
      throw new Error('that run is over');
    });

    expect(await c.send('late')).toEqual({ ok: true });
    expect(driver.start).toHaveBeenCalledTimes(2);
    expect(driver.start.mock.calls[1]?.[0]).toMatchObject({ prompt: 'late', resumeSessionId: 's9' });
    // One row for the prompt, not two.
    expect(rows(c).filter((row) => row?.kind === 'user').map((row) => (row as { text: string }).text)).toEqual([
      'first',
      'late',
    ]);
  });

  it('tracks permission prompts and lets an allow with setMode change the next mode', async () => {
    const driver = fakeDriver();
    const c = conversation(driver, { permissionMode: 'plan' });
    await c.send('plan it');
    const runId = c.getState().runId as RunId;
    const request: PermissionRequest = {
      id: 'req-1' as never,
      runId,
      toolName: 'ExitPlanMode',
      input: {},
      requestedAt: 0,
    };
    driver.emit({ type: 'permission.request', runId, requestId: request.id, request });
    expect(c.getState().status).toBe('awaiting_permission');
    expect(c.getState().pendingPermissions.map((r) => r.id)).toEqual(['req-1']);

    await c.respondToPermission(request.id, {
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', scope: 'session' }],
    });
    expect(driver.respondToPermission).toHaveBeenCalledWith(runId, 'req-1', expect.anything());
    expect(c.getState().settings.permissionMode).toBe('acceptEdits');
    expect(c.getState().status).toBe('running');
    expect(c.getState().pendingPermissions).toEqual([]);
  });

  it('drops a card whose request is no longer open instead of surfacing an error', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('go');
    const runId = c.getState().runId as RunId;
    driver.emit({
      type: 'permission.request',
      runId,
      requestId: 'r' as never,
      request: { id: 'r' as never, runId, toolName: 'Bash', input: {}, requestedAt: 0 },
    });
    driver.respondToPermission.mockRejectedValueOnce(new Error('not open'));
    await c.respondToPermission('r' as never, { behavior: 'deny' });
    expect(c.getState().pendingPermissions).toEqual([]);
    expect(rows(c).some((row) => row?.kind === 'notice')).toBe(false);
  });

  it('omits a permission mode the provider does not have', async () => {
    const driver = fakeDriver();
    const c = new Conversation({
      driver,
      settings: { ...settings, permissionMode: 'bypassPermissions' },
      capabilitiesFor: () => CLAUDE,
      scheduler: syncScheduler,
      newRunId: ids,
    });
    await c.send('x');
    expect(driver.start.mock.calls[0]?.[0]?.permissionMode).toBeUndefined();
  });

  it('refuses an account change while live and ends the conversation when idle', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('x');
    expect(c.updateSettings({ profileId: 'p2' as never }).ok).toBe(false);
    expect(c.updateSettings({ model: 'fable' }).ok).toBe(true);

    driver.emit({ type: 'run.end', runId: c.getState().runId as RunId, reason: 'completed', sessionId: 's' as never });
    expect(c.getState().sessionId).toBe('s');
    expect(c.updateSettings({ profileId: 'p2' as never }).ok).toBe(true);
    expect(c.getState().sessionId).toBeUndefined();
    expect(c.transcript.isEmpty).toBe(true);
  });

  it('records a start failure in the transcript and returns to idle', async () => {
    const driver = fakeDriver();
    driver.start.mockRejectedValueOnce(new Error('no such profile'));
    const c = conversation(driver);
    const outcome = await c.send('x');
    expect(outcome).toEqual({ ok: false, reason: 'no such profile' });
    expect(c.getState().status).toBe('idle');
    expect(rows(c).some((row) => row?.kind === 'notice' && row.text === 'no such profile')).toBe(true);
  });

  it('keeps the background-task list as a replacement, across the end of the run', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('x');
    const runId = c.getState().runId as RunId;
    const task = { id: 't1', kind: 'local_bash', description: 'tests', status: 'running', startedAt: 0 } as const;
    driver.emit({ type: 'background.tasks', runId, tasks: [task] });
    expect(c.getState().tasks).toEqual([task]);
    driver.emit({ type: 'background.tasks', runId, tasks: [{ ...task, status: 'completed' }] });
    expect(c.getState().tasks[0]?.status).toBe('completed');
    driver.emit({ type: 'run.end', runId, reason: 'completed' });
    expect(c.getState().tasks).toHaveLength(1);
    // Stopping after the run ended still targets the run that started it.
    await c.stopTask('t1');
    expect(driver.stopTask).toHaveBeenCalledWith(runId, 't1');
  });

  it('folds plan.limit readings onto the plan snapshot and lets a fetch replace it', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    c.setPlanUsage({
      available: true,
      windows: [{ id: 'five_hour', label: '5 hours', utilization: 10, resetsAt: null }],
      fetchedAt: 0,
    });
    await c.send('x');
    const runId = c.getState().runId as RunId;
    driver.emit({
      type: 'plan.limit',
      runId,
      limit: { status: 'warning', windowId: 'five_hour', utilization: 85 },
    });
    expect(c.getState().planUsage?.windows[0]?.utilization).toBe(85);
    // A reading with no window is not a reason to forget.
    driver.emit({ type: 'plan.limit', runId, limit: { status: 'ok' } });
    expect(c.getState().planUsage?.windows[0]?.utilization).toBe(85);
  });

  it('loads a stored conversation and resumes it on the next turn', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    const old = 'old-run' as RunId;
    const outcome = c.loadHistory('s-old' as never, [
      { type: 'text.complete', runId: old, seq: 0, ts: 0, messageId: 'm1' as never, role: 'user', text: 'earlier', replay: true },
      { type: 'text.complete', runId: old, seq: 1, ts: 0, messageId: 'm2' as never, role: 'assistant', text: 'yes', replay: true },
    ]);
    expect(outcome.ok).toBe(true);
    expect(rows(c).map((row) => row?.kind)).toEqual(['user', 'assistant']);
    await c.send('and now');
    expect(driver.start.mock.calls[0]?.[0]).toMatchObject({ resumeSessionId: 's-old' });
  });

  it('refuses attachments the provider cannot take, and passes the rest through', async () => {
    const driver = fakeDriver({ ...CLAUDE, imageInput: false, fileInput: true });
    const c = new Conversation({
      driver,
      settings,
      capabilitiesFor: () => ({ ...CLAUDE, imageInput: false, fileInput: true }),
      scheduler: syncScheduler,
      newRunId: ids,
    });
    const image = { kind: 'image', id: 'i', mediaType: 'image/png', data: 'AAAA' } as const;
    const file = { kind: 'file', id: 'f', name: 'notes.txt', data: 'AAAA' } as const;
    expect((await c.send('look', [image])).ok).toBe(false);
    expect(driver.start).not.toHaveBeenCalled();
    expect((await c.send('read', [file])).ok).toBe(true);
    expect(driver.start.mock.calls[0]?.[0]?.attachments).toEqual([file]);
  });

  it('folds usage: deltas add, cumulative replaces', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('x');
    const runId = c.getState().runId as RunId;
    driver.emit({ type: 'usage', runId, usage: { scope: 'delta', tokens: { inputTokens: 10, outputTokens: 1 } } });
    driver.emit({ type: 'usage', runId, usage: { scope: 'delta', tokens: { inputTokens: 5, outputTokens: 2 }, costUsd: 0.5 } });
    expect(c.getState().usage?.tokens).toEqual({ inputTokens: 15, outputTokens: 3 });
    expect(c.getState().usage?.costUsd).toBe(0.5);
    driver.emit({ type: 'usage', runId, usage: { scope: 'cumulative', tokens: { inputTokens: 100, outputTokens: 9 } } });
    expect(c.getState().usage?.tokens.inputTokens).toBe(100);
  });
});

/*
 * The provider can speak unprompted. When background work settles the CLI
 * takes a turn of its own about it — a new run, with an id nothing here ever
 * minted — and routing is by run id, so the default answer to an unknown one
 * is to drop it. Right for another conversation's run; wrong for this one's,
 * and the two are told apart by the session on `session.started`.
 */
describe('a turn the provider started on its own', () => {
  const started = (runId: RunId, sessionId: string) =>
    ({ type: 'session.started', runId, sessionId: sessionId as never, providerId: 'claude', cwd: '/repo' }) as const;
  const task = { id: 't1', kind: 'local_agent', description: 'map the keybindings', status: 'running', startedAt: 0, subagentType: 'Explore' } as const;

  /** A conversation whose turn delegated and ended, with the subagent still running. */
  async function afterDelegating() {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('delegate something');
    const runId = c.getState().runId as RunId;
    driver.emit(started(runId, 's1'));
    driver.emit({ type: 'background.tasks', runId, tasks: [task] });
    driver.emit({ type: 'run.end', runId, reason: 'completed' });
    expect(c.getState().status).toBe('idle');
    return { driver, c };
  }

  it('is taken as this conversation\'s own when it names this session and nothing else is running', async () => {
    const { driver, c } = await afterDelegating();
    const foreign = 'run-c1' as RunId;

    driver.emit(started(foreign, 's1'));
    expect(c.getState().status).toBe('running');
    expect(c.getState().runId).toBe(foreign);

    driver.emit({ type: 'background.tasks', runId: foreign, tasks: [{ ...task, status: 'completed' }] });
    expect(c.getState().tasks.map((row) => row.status)).toEqual(['completed']);

    driver.emit({ type: 'text.complete', runId: foreign, role: 'assistant', messageId: 'm1', blockIndex: 0, text: 'The Explore agent found 14 bindings.' } as never);
    expect(JSON.stringify(rows(c))).toContain('The Explore agent found 14 bindings.');

    driver.emit({ type: 'run.end', runId: foreign, reason: 'completed' });
    expect(c.getState().status).toBe('idle');
    expect(c.getState().runId).toBeUndefined();
  });

  it('is left alone when it belongs to another session', async () => {
    const { driver, c } = await afterDelegating();
    driver.emit(started('run-c1' as RunId, 'someone-else'));
    expect(c.getState().status).toBe('idle');
    driver.emit({ type: 'background.tasks', runId: 'run-c1' as RunId, tasks: [] });
    expect(c.getState().tasks.map((row) => row.status)).toEqual(['running']);
  });

  it('does not displace a turn this conversation is already running', async () => {
    const { driver, c } = await afterDelegating();
    await c.send('and another thing');
    const own = c.getState().runId as RunId;
    driver.emit(started('run-c1' as RunId, 's1'));
    expect(c.getState().runId).toBe(own);
  });
});

/*
 * The one window the adoption above cannot cover: the next prompt is already
 * typed when the CLI takes its settle turn first. Two runs of this session are
 * then alive at once — the prompt's, waiting, and the continuation — and
 * `#runId` can hold only one. The continuation is not adopted, but it is not
 * nobody's either: what it says about the work is this conversation's to show,
 * and the row it settles must settle here.
 */
describe('a provider turn arriving while a prompt is waiting', () => {
  const started = (runId: RunId, sessionId: string) =>
    ({ type: 'session.started', runId, sessionId: sessionId as never, providerId: 'claude', cwd: '/repo' }) as const;
  const task = { id: 't1', kind: 'local_agent', description: 'map the keybindings', status: 'running', startedAt: 0, subagentType: 'Explore' } as const;

  it('settles the row and shows what was said, without touching the waiting prompt', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('delegate something');
    const first = c.getState().runId as RunId;
    driver.emit(started(first, 's1'));
    driver.emit({ type: 'background.tasks', runId: first, tasks: [task] });
    driver.emit({ type: 'run.end', runId: first, reason: 'completed' });

    await c.send('and another thing');
    const own = c.getState().runId as RunId;
    const sibling = 'run-c1' as RunId;

    driver.emit(started(sibling, 's1'));
    driver.emit({ type: 'background.tasks', runId: sibling, tasks: [{ ...task, status: 'completed' }] });
    driver.emit({ type: 'text.complete', runId: sibling, role: 'assistant', messageId: 'm1', blockIndex: 0, text: 'The Explore agent found 14 bindings.' } as never);
    driver.emit({ type: 'run.end', runId: sibling, reason: 'completed' });

    expect(c.getState().tasks.map((row) => row.status)).toEqual(['completed']);
    expect(JSON.stringify(rows(c))).toContain('The Explore agent found 14 bindings.');
    // The prompt's own turn is untouched by any of it.
    expect(c.getState().runId).toBe(own);
    expect(c.getState().status).toBe('running');

    driver.emit(started(own, 's1'));
    driver.emit({ type: 'run.end', runId: own, reason: 'completed' });
    expect(c.getState().status).toBe('idle');
  });

  it('ignores the same sequence from another session', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('delegate something');
    const first = c.getState().runId as RunId;
    driver.emit(started(first, 's1'));
    driver.emit({ type: 'background.tasks', runId: first, tasks: [task] });
    driver.emit({ type: 'run.end', runId: first, reason: 'completed' });
    await c.send('and another thing');

    driver.emit(started('run-x' as RunId, 'someone-else'));
    driver.emit({ type: 'background.tasks', runId: 'run-x' as RunId, tasks: [] });
    expect(c.getState().tasks.map((row) => row.status)).toEqual(['running']);
  });
});

/*
 * A steer the provider accepted is not a steer it has read.
 *
 * It sits with the CLI until the next tool break, and the fold is invisible from
 * out here: the only thing that says a particular message was read is the
 * `message.delivered` that names it. So the queue is a list of messages and not
 * a tally — the tally was the thing nobody could take a message off, and the
 * thing that could not say *which* two of them the status line meant.
 *
 * What these pin: the text survives, in reading order; a delivery strikes the
 * entry it names; the newest can be handed back to the composer; and the end of
 * the turn ends the queue with it.
 */
describe('the messages waiting to be read', () => {
  /**
   * Number the fake's prompts the way the registry numbers its own.
   *
   * A steer works out the identity the registry will file it under from
   * `RunHandle.promptCount`, which the registry advances per prompt accepted.
   * The fake's handle is static, so without this every steer would claim
   * `:prompt:2` — two entries under one id, which a real run does not produce
   * and a test must not lean on.
   */
  function numberPrompts(driver: ReturnType<typeof fakeDriver>): void {
    const handleOf = driver.get;
    driver.get = (runId) => {
      const handle = handleOf(runId);
      return handle === undefined
        ? undefined
        : { ...handle, promptCount: 1 + driver.send.mock.calls.length };
    };
  }

  /** A live turn with two steers the provider has taken and not read. */
  async function withTwoQueued() {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('the opening prompt');
    numberPrompts(driver);
    await c.send('also check the migration script');
    await c.send('and rerun the e2e suite');
    return { driver, c, runId: c.getState().runId as RunId };
  }

  it('keeps the text of each one, in the order the provider will read them', async () => {
    const { c, runId } = await withTwoQueued();
    const state = c.getState();
    expect(state.queuedMessages.map((message) => message.text)).toEqual([
      'also check the migration script',
      'and rerun the e2e suite',
    ]);
    // Under the identity the registry filed each one as, which is what a
    // delivery will name and what the optimistic row already claimed.
    expect(state.queuedMessages.map((message) => message.id)).toEqual([
      `${runId}:prompt:2`,
      `${runId}:prompt:3`,
    ]);
    // Both are with the provider already: nothing in the TUI holds a message
    // back itself, so `after-turn` never occurs on this path.
    expect(state.queuedMessages.map((message) => message.delivery)).toEqual([
      'next-tool-break',
      'next-tool-break',
    ]);
    // The number the status line prints is the length of the list, so the two
    // cannot disagree about a message the way a count and a fold did.
    expect(state.queued).toBe(2);
  });

  it('strikes the message a delivery names and leaves the other waiting', async () => {
    const { driver, c, runId } = await withTwoQueued();
    driver.emit({ type: 'message.delivered', runId, messageId: `${runId}:prompt:2` as never });
    expect(c.getState().queuedMessages.map((message) => message.text)).toEqual(['and rerun the e2e suite']);
    expect(c.getState().queued).toBe(1);
  });

  it('strikes the oldest when the delivery names an id it does not hold', async () => {
    // Which happens for real on an adopted run: it reports no `promptCount`, so
    // a steer claims `:prompt:2` while the registry files it as `:prompt:1`.
    // A delivery nobody can match is still a delivery, and a strip left
    // counting a message the agent is acting on is the old bug.
    const { driver, c, runId } = await withTwoQueued();
    driver.emit({ type: 'message.delivered', runId, messageId: `${runId}:prompt:1` as never });
    expect(c.getState().queuedMessages.map((message) => message.text)).toEqual(['and rerun the e2e suite']);
  });

  it('hands the newest one back and stops counting it', async () => {
    const { c } = await withTwoQueued();
    expect(c.takeBackQueued()).toBe('and rerun the e2e suite');
    expect(c.getState().queuedMessages.map((message) => message.text)).toEqual([
      'also check the migration script',
    ]);
    expect(c.getState().queued).toBe(1);
    expect(c.takeBackQueued()).toBe('also check the migration script');
    expect(c.getState().queuedMessages).toEqual([]);
    // Nothing waiting, nothing to give back — the composer keeps what it has.
    expect(c.takeBackQueued()).toBeUndefined();
  });

  it('does not pretend to un-send what it took back', async () => {
    // The provider has the message and will read it whatever happens here. So
    // nothing is retracted, nothing is interrupted, and the row the message
    // already drew stays exactly where it is: it really was sent.
    const { driver, c } = await withTwoQueued();
    c.takeBackQueued();
    expect(driver.interrupt).not.toHaveBeenCalled();
    expect(
      rows(c)
        .filter((row) => row?.kind === 'user')
        .map((row) => (row as { text: string }).text),
    ).toEqual(['the opening prompt', 'also check the migration script', 'and rerun the e2e suite']);
  });

  it('empties the queue when the turn ends', async () => {
    // Whatever the provider had not read it will never read now, under this run:
    // the queue died with the turn that was holding it.
    const { driver, c, runId } = await withTwoQueued();
    driver.emit({ type: 'run.end', runId, reason: 'completed' });
    expect(c.getState().queuedMessages).toEqual([]);
    expect(c.getState().queued).toBe(0);
    expect(c.takeBackQueued()).toBeUndefined();
  });
});

/*
 * What the agent is doing, and for how long.
 *
 * The status line used to say `working…` for every second of every turn. What
 * it says instead is a fold over the stream that happens here: the turn's
 * clock, a one-line activity taken from the agent's own words, and the tokens
 * it has written since the prompt went out. The clock is injected so the
 * expectations can be exact.
 */
describe('Conversation activity', () => {
  /** A conversation whose idea of "now" a test controls. */
  function clocked(driver: RunDriver, now: () => number) {
    return new Conversation({
      driver,
      settings,
      capabilitiesFor: () => CLAUDE,
      scheduler: syncScheduler,
      newRunId: ids,
      now,
    });
  }

  /** A live turn, with the clock parked at `start` until a test moves it. */
  async function turn(start = 1_000) {
    const driver = fakeDriver();
    let t = start;
    const c = clocked(driver, () => t);
    await c.send('take a look');
    const runId = c.getState().runId as RunId;
    driver.emit({ type: 'session.started', runId, sessionId: 's1' as never, providerId: 'claude', cwd: '/repo' });
    return {
      driver,
      c,
      runId,
      /** Move the clock. Nothing reads it until the next event. */
      at: (next: number) => (t = next),
      /** This turn's events. Routing is by run id, so it is never optional. */
      emit: (event: Omit<AgentEvent, 'seq' | 'ts' | 'runId'>) => driver.emit({ ...event, runId }),
      think: (text: string, blockIndex = 0, messageId = 'm1') =>
        driver.emit({ type: 'thinking.delta', runId, messageId: messageId as never, blockIndex, text }),
      write: (text: string) =>
        driver.emit({ type: 'text.delta', runId, messageId: 'm1' as never, blockIndex: 1, text }),
    };
  }

  it('starts the turn clock when the turn starts and stops it when it ends', async () => {
    const { emit, c } = await turn(1_000);
    expect(c.getState().turnStartedAt).toBe(1_000);
    emit({ type: 'run.end', reason: 'completed' });
    // Nothing is running, so nothing may be counting: a clock left ticking
    // would print a duration for a turn that finished minutes ago.
    expect(c.getState().turnStartedAt).toBeUndefined();
  });

  it('times a turn the provider started by itself from when it was heard of', async () => {
    // An adopted run — the CLI answering about background work of its own —
    // is a turn someone is waiting through, and the moment it was heard of is
    // the only start time available.
    const { driver, emit, c } = await turn(1_000);
    emit({ type: 'run.end', reason: 'completed' });
    expect(c.getState().turnStartedAt).toBeUndefined();
    driver.emit({ type: 'session.started', runId: 'run-adopted' as RunId, sessionId: 's1' as never, providerId: 'claude', cwd: '/repo' });
    expect(c.getState().status).toBe('running');
    expect(c.getState().turnStartedAt).toBe(1_000);
  });

  it('takes the first line of a thinking block and holds it while the block runs on', async () => {
    const { c, at, think } = await turn(1_000);
    at(2_000);
    think('**Investigating ');
    // Nothing yet: half a header is not a heading, and printing it would
    // rewrite the status line a word at a time.
    expect(c.getState().activity).toBeUndefined();
    think('rendering code**\n');
    expect(c.getState().activity).toEqual({ kind: 'thinking', text: 'Investigating rendering code', since: 2_000 });

    const settled = c.getState().activity;
    at(9_000);
    think('\nThe status bar reads its state from the conversation, so ');
    think('the fold belongs there rather than in the component.');
    // Same thought, same object — and the same `since`, which is what the
    // stall warning is timed against.
    expect(c.getState().activity).toBe(settled);
  });

  it('strips the markdown the model wrote its header in', async () => {
    const { c, think } = await turn();
    think('## Checking the mapper\nand then the adapter');
    expect(c.getState().activity?.text).toBe('Checking the mapper');
  });

  it('settles a header that never ends, rather than saying nothing all turn', async () => {
    const { c, think } = await turn();
    // No newline ever arrives, so the line settles at the width the status bar
    // would clip it to anyway — past which nothing printed can change.
    think('A'.repeat(200));
    expect(c.getState().activity?.text).toBe(`${'A'.repeat(59)}…`);
  });

  it('skips the blank lines a block opens with', async () => {
    const { c, think } = await turn();
    think('\n\n');
    expect(c.getState().activity).toBeUndefined();
    think('Reading the failing test\n');
    expect(c.getState().activity?.text).toBe('Reading the failing test');
  });

  it('reads the next thinking block as a new thought', async () => {
    const { c, at, think } = await turn();
    think('First thought\nwith more below');
    at(30_000);
    think('Second thought\n', 1);
    expect(c.getState().activity).toEqual({ kind: 'thinking', text: 'Second thought', since: 30_000 });
  });

  it('names the tool and its target while one is running', async () => {
    const { c, at, emit, think } = await turn();
    think('Looking for the call sites\n');
    at(5_000);
    emit({ type: 'tool.start', toolCallId: 't1' as never, name: 'Read', input: { file_path: 'apps/tui/src/app.tsx' } });
    expect(c.getState().activity).toEqual({ kind: 'tool', text: 'Read apps/tui/src/app.tsx', since: 5_000 });
    emit({ type: 'tool.start', toolCallId: 't2' as never, name: 'Bash', input: { command: 'pnpm test' } });
    expect(c.getState().activity?.text).toBe('Bash pnpm test');
  });

  it('gives the line back to the thought the tool interrupted', async () => {
    const { c, at, emit, think } = await turn();
    think('Looking for the call sites\n');
    emit({ type: 'tool.start', toolCallId: 't1' as never, name: 'Read', input: { file_path: 'a.ts' } });
    at(20_000);
    emit({ type: 'tool.end', toolCallId: 't1' as never, status: 'ok' });
    // The thought returns, but its clock restarts: a tool call is proof of
    // progress, so the stall warning must not count the time either side of
    // one as a single unbroken stare.
    expect(c.getState().activity).toEqual({ kind: 'thinking', text: 'Looking for the call sites', since: 20_000 });
  });

  it('says nothing in particular when a tool ends with no thought behind it', async () => {
    const { c, emit } = await turn();
    emit({ type: 'tool.start', toolCallId: 't1' as never, name: 'Bash', input: { command: 'pnpm test' } });
    emit({ type: 'tool.end', toolCallId: 't1' as never, status: 'ok' });
    expect(c.getState().activity).toBeUndefined();
  });

  it('lets only the call that is on the line take itself off it', async () => {
    // Tools run in parallel. The first of three to finish must not blank a
    // line describing one of the other two.
    const { c, emit } = await turn();
    emit({ type: 'tool.start', toolCallId: 't1' as never, name: 'Read', input: { file_path: 'a.ts' } });
    emit({ type: 'tool.start', toolCallId: 't2' as never, name: 'Read', input: { file_path: 'b.ts' } });
    emit({ type: 'tool.end', toolCallId: 't1' as never, status: 'ok' });
    expect(c.getState().activity?.text).toBe('Read b.ts');
  });

  it('says writing once the answer starts, and does not go back to the thought after', async () => {
    const { c, at, emit, think, write } = await turn();
    think('Working out the shape\n');
    at(7_000);
    write('The status bar ');
    expect(c.getState().activity).toEqual({ kind: 'writing', text: 'writing', since: 7_000 });

    const first = c.getState().activity;
    at(8_000);
    write('reads its state…');
    // Every token of an answer is the same fact, so it is the same object.
    expect(c.getState().activity).toBe(first);

    emit({ type: 'tool.start', toolCallId: 't1' as never, name: 'Edit', input: { file_path: 'a.ts' } });
    emit({ type: 'tool.end', toolCallId: 't1' as never, status: 'ok' });
    // The thought that led to the answer is spent; restoring it after the
    // answer has begun would be the line going backwards.
    expect(c.getState().activity).toBeUndefined();
  });

  it('ignores a subagent, which has a row of its own', async () => {
    // `DelegatedStrip` draws every delegated agent. A fan-out of three writing
    // to the main line would make it flicker between three unrelated thoughts
    // and say nothing about the agent being waited on.
    const { c, emit, think } = await turn();
    think('Reading the mapper\n');
    emit({ type: 'thinking.delta', messageId: 'm2' as never, blockIndex: 0, text: 'A subagent thinks\n', agentId: 'a1' as never });
    emit({ type: 'tool.start', toolCallId: 't9' as never, name: 'Grep', input: { pattern: 'x' }, agentId: 'a1' as never });
    emit({ type: 'text.delta', messageId: 'm2' as never, blockIndex: 0, text: 'hello', agentId: 'a1' as never });
    expect(c.getState().activity?.text).toBe('Reading the mapper');
  });

  it("counts the turn's own output tokens from the usage the provider sends mid-turn", async () => {
    const { c, emit } = await turn();
    expect(c.getState().turnTokens).toBeUndefined();
    // Claude and Codex both report `delta` usage during a turn — per assistant
    // message and per token-count report — so these add up.
    emit({ type: 'usage', usage: { scope: 'delta', tokens: { inputTokens: 1_200, outputTokens: 800 } } });
    emit({ type: 'usage', usage: { scope: 'delta', tokens: { inputTokens: 40, outputTokens: 1_540 } } });
    expect(c.getState().turnTokens).toBe(2_340);
    // The conversation's own total keeps counting input as well; the two
    // readings answer different questions and sit at opposite ends of the bar.
    expect(c.getState().usage?.tokens.outputTokens).toBe(2_340);
    expect(c.getState().usage?.tokens.inputTokens).toBe(1_240);
  });

  it('takes a cumulative report as the whole turn, because a run is a turn', async () => {
    const { c, emit } = await turn();
    emit({ type: 'usage', usage: { scope: 'delta', tokens: { inputTokens: 10, outputTokens: 500 } } });
    emit({ type: 'usage', usage: { scope: 'cumulative', tokens: { inputTokens: 20, outputTokens: 900 } } });
    expect(c.getState().turnTokens).toBe(900);
  });

  it('starts the next turn from nothing', async () => {
    const { c, emit, think } = await turn(1_000);
    think('Reading the mapper\n');
    emit({ type: 'usage', usage: { scope: 'delta', tokens: { inputTokens: 10, outputTokens: 500 } } });
    emit({ type: 'run.end', reason: 'completed' });

    const ended = c.getState();
    expect(ended.activity).toBeUndefined();
    expect(ended.turnTokens).toBeUndefined();
    expect(ended.turnStartedAt).toBeUndefined();

    await c.send('now the other one');
    const next = c.getState();
    expect(next.turnStartedAt).toBe(1_000);
    expect(next.activity).toBeUndefined();
    expect(next.turnTokens).toBeUndefined();
  });

  it('clears the turn when a start fails, so nothing is left counting', async () => {
    const driver = fakeDriver();
    driver.start.mockRejectedValueOnce(new Error('no such profile'));
    const c = clocked(driver, () => 1_000);
    expect(await c.send('hello')).toEqual({ ok: false, reason: 'no such profile' });
    expect(c.getState().turnStartedAt).toBeUndefined();
  });

  it('forgets the turn when the screen is cleared', async () => {
    const { c, emit, think } = await turn();
    think('Reading the mapper\n');
    emit({ type: 'run.end', reason: 'completed' });
    expect(c.reset()).toEqual({ ok: true });
    expect(c.getState().turnStartedAt).toBeUndefined();
    expect(c.getState().activity).toBeUndefined();
  });

  it('publishes nothing for a delta that changes nothing', async () => {
    // The point of settling a heading once. Before this, every token of a turn
    // replaced the state with an object that was new but not different — a
    // re-render of the whole app per token, for a line that cannot change.
    const { c, think, write } = await turn();
    think('Reading the mapper\n');
    const settled = c.getState();

    const changed = vi.fn();
    const stop = c.subscribe(changed);
    think('There is a lot of it, and ');
    think('none of it belongs on the status line.');
    write('So');
    expect(changed).toHaveBeenCalledTimes(1); // the one that said `writing`

    const writing = c.getState();
    write(' the fold');
    write(' lives in the conversation.');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(c.getState()).toBe(writing);
    expect(settled).not.toBe(writing);
    stop();
  });
});

/*
 * Going back to an earlier prompt.
 *
 * The protocol has carried the intent all along — `rewindToMessageId`, with or
 * without `forkSession`, gated on `Capabilities.rewind` — and nothing in the
 * terminal used it. What these pin is the model half: which prompts can be
 * pointed at, which of the two moves a provider gets, that the next `start()`
 * carries the truncation exactly once, and that a cut which turns out never to
 * have happened puts the conversation back.
 */
describe('going back to an earlier prompt', () => {
  const REWINDS: Capabilities = { ...CLAUDE, rewind: true, forkSession: true };

  function rewinding(capabilities: Capabilities = REWINDS) {
    const driver = fakeDriver(capabilities);
    const c = new Conversation({
      driver,
      settings,
      capabilitiesFor: () => capabilities,
      scheduler: syncScheduler,
      newRunId: ids,
    });
    return { driver, c };
  }

  /**
   * Two stored turns, as a resume replays them.
   *
   * Replayed rows are the ones that carry the provider's own message ids, which
   * is the whole reason the picker can point at them — see {@link UserTurn}.
   */
  function storedTurns(): readonly AgentEvent[] {
    const old = 'old-run' as RunId;
    return [
      { type: 'text.complete', runId: old, seq: 0, ts: 10, messageId: 'u-1', role: 'user', text: 'add a status line', replay: true },
      { type: 'text.complete', runId: old, seq: 1, ts: 11, messageId: 'm-1', role: 'assistant', text: 'Done.', replay: true },
      { type: 'text.complete', runId: old, seq: 2, ts: 12, messageId: 'u-2', role: 'user', text: 'now make it blue', replay: true },
      { type: 'text.complete', runId: old, seq: 3, ts: 13, messageId: 'm-2', role: 'assistant', text: 'Blue it is.', replay: true },
    ] as AgentEvent[];
  }

  /** A resumed conversation of two stored turns, idle and ready to wind back. */
  function resumed(capabilities: Capabilities = REWINDS) {
    const { driver, c } = rewinding(capabilities);
    expect(c.loadHistory('s-old' as never, storedTurns())).toEqual({ ok: true });
    return { driver, c };
  }

  /** What each row says, or what kind of row it is when it says nothing. */
  const said = (c: Conversation) =>
    rows(c).map((row) => {
      if (row === undefined) return 'nothing';
      if ('text' in row) return row.text;
      return 'kind' in row ? row.kind : 'group';
    });

  it('lists the prompts in order, with the provider id where there is one', async () => {
    const { driver, c } = resumed();
    await c.send('and now the other one');
    const runId = driver.start.mock.calls[0]?.[0]?.runId as RunId;

    expect(c.userTurns()).toEqual([
      { id: expect.any(String), messageId: 'u-1', text: 'add a status line', ts: 10 },
      { id: expect.any(String), messageId: 'u-2', text: 'now make it blue', ts: 12 },
      // Typed in this window, so the only name it has is the registry's own —
      // a word the provider's stored chain has never heard. Reported as no id
      // at all, with the run it was sent under, and the list greys it.
      { id: expect.any(String), messageId: undefined, text: 'and now the other one', ts: expect.any(Number), runId },
    ]);
  });

  it('refuses when the provider cannot truncate a resumed session', () => {
    const { c } = resumed({ ...CLAUDE, rewind: false, forkSession: false });
    expect(c.canRewind()).toEqual({
      ok: false,
      reason: 'Claude cannot go back to an earlier prompt.',
    });
  });

  it('refuses a provider that can only branch, rather than cutting the screen and not the context', () => {
    // `forkSession` alone is not a third way of going back: the truncation is
    // the part `rewind` gates, so the branch would start from the *end* of the
    // conversation while the screen showed it cut back to an old prompt, and
    // the answer would come back confident. Codex and OpenCode are here today.
    const { c } = resumed({ ...CLAUDE, rewind: false, forkSession: true });
    expect(c.canRewind()).toEqual({
      ok: false,
      reason: 'Claude can branch a conversation but not wind one back to an earlier prompt.',
    });
  });

  it('refuses when there is no session to wind back', () => {
    const { c } = rewinding();
    expect(c.canRewind()).toEqual({
      ok: false,
      reason: 'There is no stored conversation to go back through yet.',
    });
  });

  it('refuses while a turn is live', async () => {
    const { c } = resumed();
    await c.send('one more thing');
    expect(c.canRewind()).toEqual({
      ok: false,
      reason: 'Wait for this turn to finish, or press Esc to interrupt it.',
    });
  });

  it('winds the newest turn back in place and branches for anything older', () => {
    const { c } = resumed();
    // The cut a provider is not expected to refuse: one turn, which is the only
    // range the CLI's drops-a-turn acknowledgement can vouch for.
    expect(c.canRewind('u-2')).toEqual({ ok: true, fork: false });
    // Deeper than that, the in-place rewind "takes its chances with the
    // provider's own guard" — so the branch is taken, and the original session
    // is left whole rather than argued with.
    expect(c.canRewind('u-1')).toEqual({ ok: true, fork: true });
    // No target answers for the newest, which is what a standing hint wants.
    expect(c.canRewind()).toEqual({ ok: true, fork: false });
  });

  it('cannot branch on a provider that only rewinds, and says so by not forking', () => {
    const { c } = resumed({ ...CLAUDE, rewind: true, forkSession: false });
    expect(c.canRewind('u-1')).toEqual({ ok: true, fork: false });
  });

  it('cuts the screen back to the prompt and carries the truncation on the next turn, once', async () => {
    const { driver, c } = resumed();
    expect(c.armRewind('u-2')).toEqual({ ok: true });

    // The conversation reads as already wound back while the prompt is retyped.
    expect(said(c)).toEqual(['add a status line', 'Done.']);
    expect(c.getState().rewindArmed).toEqual({ messageId: 'u-2', fork: false });

    await c.send('now make it green');
    expect(driver.start.mock.calls[0]?.[0]).toMatchObject({
      prompt: 'now make it green',
      resumeSessionId: 's-old',
      rewindToMessageId: 'u-2',
    });
    expect(driver.start.mock.calls[0]?.[0]?.forkSession).toBeUndefined();
    // Consumed: the arm describes one start, and the turn after it must not ask
    // for a truncation the provider has already made.
    expect(c.getState().rewindArmed).toBeUndefined();

    const runId = c.getState().runId as RunId;
    driver.emit({ type: 'text.complete', runId, role: 'assistant', messageId: 'm-3', blockIndex: 0, text: 'Green it is.' } as never);
    driver.emit({ type: 'run.end', runId, reason: 'completed' });
    await c.send('and again');
    expect(driver.start.mock.calls[1]?.[0]?.rewindToMessageId).toBeUndefined();
  });

  it('asks for a branch when the target is not the most recent turn', async () => {
    const { driver, c } = resumed();
    expect(c.armRewind('u-1')).toEqual({ ok: true });
    expect(said(c)).toEqual([]);
    expect(c.getState().rewindArmed).toEqual({ messageId: 'u-1', fork: true });

    await c.send('add a status line, but smaller');
    expect(driver.start.mock.calls[0]?.[0]).toMatchObject({
      resumeSessionId: 's-old',
      rewindToMessageId: 'u-1',
      forkSession: true,
    });
  });

  it('refuses a prompt that is not in the conversation', () => {
    const { c } = resumed();
    expect(c.armRewind('u-9')).toEqual({ ok: false, reason: 'That prompt is not in this conversation.' });
  });

  it('puts the rows back when the arm is dropped', () => {
    const { c } = resumed();
    c.armRewind('u-1');
    expect(said(c)).toEqual([]);

    c.disarmRewind();
    expect(said(c)).toEqual(['add a status line', 'Done.', 'now make it blue', 'Blue it is.']);
    expect(c.getState().rewindArmed).toBeUndefined();
    // And the conversation is whole again, so it can be wound back afresh.
    expect(c.userTurns().map((turn) => turn.messageId)).toEqual(['u-1', 'u-2']);
  });

  it('brings a shell line back as a shell line, not as a slash command', () => {
    // A `!git status` row is drawn with `$` and a `/compact` row with `/`,
    // and the difference is one field. Dropped on the way back through the
    // redraw, the restored row claimed the app had a `/git` it does not.
    const { c } = resumed();
    c.transcript.apply({
      type: 'command.run',
      runId: 'local-shell' as RunId,
      seq: 0,
      ts: 20,
      command: { name: 'git', args: 'status', output: 'nothing to commit' },
      source: 'shell',
    } as AgentEvent);
    c.transcript.apply({
      type: 'command.run',
      runId: 'old-run' as RunId,
      seq: 4,
      ts: 21,
      command: { name: 'compact' },
    } as AgentEvent);

    c.armRewind('u-1');
    c.disarmRewind();

    const commands = rows(c).filter((row): row is Extract<typeof row, { kind: 'command' }> =>
      row !== undefined && 'kind' in row && row.kind === 'command',
    );
    expect(commands.map((row) => [row.name, row.source])).toEqual([
      ['git', 'shell'],
      // A provider's own command has no source, and must not acquire one.
      ['compact', undefined],
    ]);
  });

  it('does nothing when the arm is dropped after the turn has gone out', async () => {
    // The composer empties as the prompt is sent, and that must not redraw the
    // conversation over a rewind the provider is already making.
    const { c } = resumed();
    c.armRewind('u-2');
    await c.send('now make it green');

    c.disarmRewind();
    expect(said(c)).toEqual(['add a status line', 'Done.', 'now make it green']);
  });

  it('puts the rows back when the start fails, with the prompt where the attempt happened', async () => {
    const { driver, c } = resumed();
    driver.start.mockRejectedValueOnce(new Error('no such profile'));
    c.armRewind('u-2');

    expect(await c.send('now make it green')).toEqual({ ok: false, reason: 'no such profile' });
    // Nothing was truncated anywhere but on this screen, so the conversation is
    // as it was — with the attempt, and the reason it failed, below it.
    expect(said(c)).toEqual([
      'add a status line',
      'Done.',
      'now make it blue',
      'Blue it is.',
      'now make it green',
      'no such profile',
    ]);
    expect(c.getState().rewindArmed).toBeUndefined();

    // The failure does not re-arm: the next turn is an ordinary one.
    await c.send('never mind');
    expect(driver.start.mock.calls[1]?.[0]?.rewindToMessageId).toBeUndefined();
  });

  it('puts the rows back when the provider refuses the rewind and says nothing', async () => {
    const { driver, c } = resumed();
    c.armRewind('u-2');
    await c.send('now make it green');
    const runId = c.getState().runId as RunId;

    // An error with nothing said is what a refused truncation looks like from
    // here: the adapter throws before the model is reached.
    driver.emit({ type: 'run.end', runId, reason: 'error', error: { code: 'invalid_request', message: 'Could not rewind: that message is not in this session.' } } as never);
    expect(said(c).slice(0, 4)).toEqual(['add a status line', 'Done.', 'now make it blue', 'Blue it is.']);
    expect(said(c)).toContain('now make it green');
  });

  it('keeps the cut when the turn produced something, because the provider really did wind back', async () => {
    const { driver, c } = resumed();
    c.armRewind('u-2');
    await c.send('now make it green');
    const runId = c.getState().runId as RunId;

    driver.emit({ type: 'text.complete', runId, role: 'assistant', messageId: 'm-3', blockIndex: 0, text: 'Green it is.' } as never);
    driver.emit({ type: 'run.end', runId, reason: 'error', error: { code: 'unknown', message: 'the process died' } } as never);
    // The rows are not put back: they would describe a conversation the
    // provider no longer holds.
    expect(said(c)).not.toContain('now make it blue');
  });

  it('brings back what the turns did, not only what they said', async () => {
    // `TranscriptModel` has no re-insert — `truncateFrom` is the one door out —
    // so putting rows back means replaying each of them as the event it came
    // from. What has to survive that is everything a reader looks at.
    const { driver, c } = resumed();
    await c.send('run the tests');
    const runId = c.getState().runId as RunId;
    driver.emit({ type: 'thinking.delta', runId, messageId: 'm-4', blockIndex: 0, text: 'Working out which suite' } as never);
    driver.emit({ type: 'tool.start', runId, toolCallId: 'call-1', name: 'Bash', input: { command: 'pnpm test' } } as never);
    driver.emit({ type: 'tool.end', runId, toolCallId: 'call-1', status: 'ok', resultText: '699 passed' } as never);
    driver.emit({ type: 'text.complete', runId, role: 'assistant', messageId: 'm-4', blockIndex: 1, text: 'All green.' } as never);
    driver.emit({ type: 'run.end', runId, reason: 'completed' });

    c.armRewind('u-1');
    expect(said(c)).toEqual([]);
    c.disarmRewind();

    // The call keeps its own id, because the provider named it — so a
    // re-delivery still lands on the row rather than drawing a second one.
    expect(c.transcript.getItem('t:call-1')).toMatchObject({
      kind: 'tool',
      name: 'Bash',
      input: { command: 'pnpm test' },
      status: 'ok',
      resultText: '699 passed',
    });
    expect(JSON.stringify(rows(c))).toContain('Working out which suite');
    expect(said(c)).toContain('All green.');
    expect(c.userTurns().map((turn) => turn.text)).toEqual([
      'add a status line',
      'now make it blue',
      'run the tests',
    ]);
  });

  it('cuts further back when armed twice, and comes back whole', () => {
    const { c } = resumed();
    expect(c.armRewind('u-2')).toEqual({ ok: true });
    expect(c.armRewind('u-1')).toEqual({ ok: true });
    expect(said(c)).toEqual([]);
    expect(c.getState().rewindArmed).toEqual({ messageId: 'u-1', fork: true });

    c.disarmRewind();
    expect(said(c)).toEqual(['add a status line', 'Done.', 'now make it blue', 'Blue it is.']);
  });

  it('keeps an armed cut when a turn of the provider\'s own speaks and fails', async () => {
    // The CLI takes turns of its own — a settle turn about background work —
    // and one of them ending badly says nothing about a rewind it has not been
    // asked for yet. Nothing has gone out while the arm is still held.
    const { driver, c } = resumed();
    c.armRewind('u-2');
    const settle = 'run-settle' as RunId;
    driver.emit({ type: 'session.started', runId: settle, sessionId: 's-old' as never, providerId: 'claude', cwd: '/repo' });
    driver.emit({ type: 'text.complete', runId: settle, role: 'assistant', messageId: 'm-9', blockIndex: 0, text: 'The background work finished.' } as never);
    driver.emit({ type: 'run.end', runId: settle, reason: 'error' } as never);

    expect(c.getState().rewindArmed).toEqual({ messageId: 'u-2', fork: false });
    expect(said(c)).not.toContain('now make it blue');
    await c.send('now make it green');
    expect(driver.start.mock.calls[0]?.[0]?.rewindToMessageId).toBe('u-2');
  });

  it('follows the branch when the fork answers with a session of its own', async () => {
    const { driver, c } = resumed();
    c.armRewind('u-1');
    await c.send('add a status line, but smaller');
    const runId = c.getState().runId as RunId;

    driver.emit({
      type: 'session.started',
      runId,
      sessionId: 's-branch' as never,
      providerId: 'claude',
      cwd: '/repo',
      resumedFrom: 's-old' as never,
      forked: true,
    } as never);
    expect(c.getState().sessionId).toBe('s-branch');

    driver.emit({ type: 'run.end', runId, reason: 'completed' });
    await c.send('and now the rail says the branch');
    // The next turn resumes the branch, and the conversation it came off is
    // left exactly as it was — which is the whole point of having forked.
    expect(driver.start.mock.calls[1]?.[0]?.resumeSessionId).toBe('s-branch');
  });
});

/*
 * What the turn did to the disk.
 *
 * The ledger has its own suite, which is where the pre-images, the guards and
 * the bounds are pinned. What is pinned here is the wiring, and it is the half
 * that can silently be wrong: the ledger is only as good as the events it is
 * shown, and every one of them arrives through this class. So each case below
 * is an event stream in, and a claim about what the conversation can say
 * afterwards — including the two that a narrower reading of "this
 * conversation's events" would have dropped on the floor, a subagent's edit and
 * a call that was refused.
 *
 * The filesystem is a `Map`, which is also the check that nothing here touches
 * a real one.
 */
describe('Conversation: the change ledger', () => {
  const disk = (): { readonly files: Map<string, string>; readonly deps: Partial<ChangeLedgerDeps> } => {
    const files = new Map<string, string>();
    const missing = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return {
      files,
      deps: {
        readFile: async (path) => {
          const text = files.get(path);
          if (text === undefined) throw missing(path);
          return text;
        },
        writeFile: async (path, text) => {
          files.set(path, text);
        },
        stat: async (path) => {
          const text = files.get(path);
          if (text === undefined) throw missing(path);
          return { size: Buffer.byteLength(text, 'utf8') };
        },
        rm: async (path) => {
          files.delete(path);
        },
        now: () => 0,
      },
    };
  };

  /** A conversation whose ledger is over the `Map`, and the `Map`. */
  const ledgered = (overrides: Partial<ConversationSettings> = {}) => {
    const driver = fakeDriver();
    const { files, deps } = disk();
    const c = new Conversation({
      driver,
      settings: { ...settings, ...overrides },
      capabilitiesFor: () => CLAUDE,
      scheduler: syncScheduler,
      newRunId: ids,
      ledger: (cwd) => new ChangeLedger(cwd, deps),
    });
    return { driver, c, files };
  };

  /**
   * One tool call as the wire delivers it, with whatever the tool did in the
   * middle.
   *
   * The wait between the start and the edit is the point rather than a
   * nicety: the ledger's pre-image is a read racing the tool, and a test that
   * wrote the file in the same tick as the announcement would be asserting
   * about a race it had rigged.
   */
  const call = async (
    driver: ReturnType<typeof fakeDriver>,
    c: Conversation,
    event: Record<string, unknown>,
    apply: () => void,
    status = 'ok',
  ): Promise<void> => {
    const runId = c.getState().runId;
    const { toolCallId, agentId } = event;
    driver.emit({ type: 'tool.start', runId, ...event } as never);
    await c.changesSettled();
    apply();
    driver.emit({
      type: 'tool.end',
      runId,
      toolCallId,
      status,
      ...(agentId === undefined ? {} : { agentId }),
    } as never);
    await c.changesSettled();
  };

  const edit = (toolCallId: string, path: string, before: string, after: string): Record<string, unknown> => ({
    toolCallId,
    name: 'Edit',
    input: { file_path: path, old_string: before, new_string: after },
  });

  it('records an edit as it happens, and puts it in the state as three numbers', async () => {
    const { driver, c, files } = ledgered();
    files.set('/repo/a.ts', 'one\n');
    await c.send('change a.ts');
    const told: ConversationState['filesChanged'][] = [];
    c.subscribe(() => told.push(c.getState().filesChanged));

    await call(driver, c, edit('t1', 'a.ts', 'one', 'two'), () => files.set('/repo/a.ts', 'two\n'));

    // Relative to the conversation's own cwd, which is the ledger's.
    expect(c.changes.files()).toMatchObject([{ label: 'a.ts', path: '/repo/a.ts', edits: 1 }]);
    expect(c.getState().filesChanged).toEqual({ files: 1, added: 1, removed: 1 });
    // And the bar was told: the fold publishes, so a summary that lands a disk
    // read after the event still reaches the screen.
    expect(told.at(-1)).toEqual({ files: 1, added: 1, removed: 1 });
    // And the pre-image is what the file held *before* the tool ran, which is
    // the one moment it was available.
    expect(c.changes.last()?.before).toEqual({ kind: 'content', text: 'one\n' });
  });

  it('records a subagent’s edits, which land on the same disk as anybody else’s', async () => {
    const { driver, c, files } = ledgered();
    files.set('/repo/deep.ts', 'old\n');
    await c.send('delegate it');

    await call(
      driver,
      c,
      { ...edit('t2', 'deep.ts', 'old', 'new'), agentId: 'a1' },
      () => files.set('/repo/deep.ts', 'new\n'),
    );

    // The activity line deliberately ignores a subagent — three delegated
    // agents must not make the status line flicker between three thoughts —
    // and the ledger deliberately does not: a `/diff` that left out the files
    // a delegated agent rewrote would be worse than no `/diff` at all.
    expect(c.getState().activity).toBeUndefined();
    expect(c.changes.files().map((file) => file.label)).toEqual(['deep.ts']);
    expect(c.getState().filesChanged).toEqual({ files: 1, added: 1, removed: 1 });
  });

  it('records nothing for a call that was refused', async () => {
    const { driver, c, files } = ledgered();
    files.set('/repo/a.ts', 'one\n');
    await c.send('change a.ts');

    // Denied at the permission prompt: the tool never ran, so there is no
    // change to report and nothing that could be undone.
    await call(driver, c, edit('t3', 'a.ts', 'one', 'two'), () => undefined, 'denied');
    expect(c.changes.files()).toEqual([]);
    expect(c.changes.last()).toBeUndefined();
    expect(c.getState().filesChanged).toBeUndefined();

    // An error is the same answer, for the same reason.
    await call(driver, c, edit('t4', 'a.ts', 'one', 'two'), () => undefined, 'error');
    expect(c.getState().filesChanged).toBeUndefined();
    expect(files.get('/repo/a.ts')).toBe('one\n');
  });

  it('forgets what it knew when the conversation is cleared', async () => {
    const { driver, c, files } = ledgered();
    files.set('/repo/a.ts', 'one\n');
    await c.send('change a.ts');
    await call(driver, c, edit('t5', 'a.ts', 'one', 'two'), () => files.set('/repo/a.ts', 'two\n'));
    driver.emit({ type: 'run.end', runId: c.getState().runId as RunId, reason: 'completed' });

    expect(c.reset()).toEqual({ ok: true });
    // "What this conversation changed" is a question about *this* conversation,
    // and the screen and the ledger are cleared by the same move.
    expect(c.changes.files()).toEqual([]);
    expect(c.changes.last()).toBeUndefined();
    expect(c.getState().filesChanged).toBeUndefined();
  });

  it('starts again when the conversation moves to another directory', async () => {
    const { driver, c, files } = ledgered();
    files.set('/repo/a.ts', 'one\n');
    await c.send('change a.ts');
    await call(driver, c, edit('t6', 'a.ts', 'one', 'two'), () => files.set('/repo/a.ts', 'two\n'));
    driver.emit({ type: 'run.end', runId: c.getState().runId as RunId, reason: 'completed' });

    expect(c.updateSettings({ cwd: '/elsewhere' })).toEqual({ ok: true });
    expect(c.getState().filesChanged).toBeUndefined();

    files.set('/elsewhere/b.ts', 'old\n');
    await c.send('now change b.ts');
    await call(driver, c, edit('t7', 'b.ts', 'old', 'new'), () => files.set('/elsewhere/b.ts', 'new\n'));
    // Resolved and labelled against the directory it is actually working in;
    // a path recorded against the old root would name a different file.
    expect(c.changes.files()).toMatchObject([{ label: 'b.ts', path: '/elsewhere/b.ts' }]);
  });

  it('recomputes the summary when a change is taken back', async () => {
    const { driver, c, files } = ledgered();
    files.set('/repo/a.ts', 'one\n');
    await c.send('change a.ts');
    await call(driver, c, edit('t8', 'a.ts', 'one', 'two'), () => files.set('/repo/a.ts', 'two\n'));

    // `/undo` goes to the ledger directly — there is no event behind it — so
    // the caller says when the totals have moved. Without this the bar would
    // go on counting a file that has been put back.
    expect(await c.changes.undo()).toMatchObject({ ok: true, action: 'restored' });
    expect(files.get('/repo/a.ts')).toBe('one\n');
    expect(c.getState().filesChanged).toEqual({ files: 1, added: 1, removed: 1 });
    c.refreshChanges();
    expect(c.getState().filesChanged).toBeUndefined();
  });
});
