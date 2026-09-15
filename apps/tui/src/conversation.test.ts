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

import { Conversation, type ConversationSettings, type RunDriver } from './conversation.js';

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
