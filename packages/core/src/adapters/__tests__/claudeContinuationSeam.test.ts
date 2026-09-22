/**
 * A turn the CLI opens on its own measures where the conversation ends and it
 * begins.
 *
 * The registry takes a started run's seam before the CLI is spawned. A turn
 * the CLI opens by itself — the queued message it answers after an interrupt,
 * the task notification it replies to — is adopted with none, and a window
 * that joined such a turn on the server had nothing to read history up to: it
 * drew the turn alone, over a conversation it had been showing a moment before
 * (2026-09-18, a served session, after "read now" on a queued message). The
 * process knows what the registry cannot: the `init` that announces the turn
 * comes after the CLI has filed the message that opened it and before a word
 * of its answer, so a count taken then *is* the seam.
 *
 * These pin that the count is taken when the turn announces itself, that it
 * lands on the adopted run, and that a read that fails leaves the seam unknown
 * rather than the turn broken.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, RunId } from '@rx-artemis/protocol';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const sdkMock = vi.hoisted(() => ({
  onQuery: undefined as ((params: { prompt: unknown; options?: unknown }) => unknown) | undefined,
  /** What the session file holds when it is read. */
  stored: [] as unknown[],
  /** Every read of a stored session, as the SDK was asked. */
  reads: [] as { sessionId: string; options: unknown }[],
  failReads: false,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: unknown; options?: unknown }) => {
    if (sdkMock.onQuery === undefined) throw new Error('test did not install a query hook');
    return sdkMock.onQuery(params);
  },
  listSessions: () => Promise.resolve([]),
  getSessionMessages: (sessionId: string, options: unknown) => {
    sdkMock.reads.push({ sessionId, options });
    if (sdkMock.failReads) return Promise.reject(new Error('transcript unreadable'));
    return Promise.resolve(sdkMock.stored);
  },
}));

const { createClaudeAdapter } = await import('../claude.js');
const { AsyncQueue } = await import('../stream.js');
type ResolvedRunInput = import('../types.js').ResolvedRunInput;
type Run = import('../types.js').Run;

class FakeQuery {
  readonly messages = new AsyncQueue<SDKMessage>();
  closed = false;
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.messages[Symbol.asyncIterator]();
  }
  interrupt(): Promise<{ still_queued: string[] }> {
    return Promise.resolve({ still_queued: [] });
  }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}
  close(): void {
    this.closed = true;
    this.messages.close();
  }
}

function installQuery(): { fake: () => FakeQuery; prompts: () => AsyncIterable<SDKUserMessage> } {
  let captured: { fake: FakeQuery; prompt: AsyncIterable<SDKUserMessage> } | undefined;
  sdkMock.onQuery = (params) => {
    const fake = new FakeQuery();
    captured = { fake, prompt: params.prompt as AsyncIterable<SDKUserMessage> };
    return fake;
  };
  return {
    fake: () => {
      if (captured === undefined) throw new Error('query() was never called');
      return captured.fake;
    },
    prompts: () => {
      if (captured === undefined) throw new Error('query() was never called');
      return captured.prompt;
    },
  };
}

const BASE_INPUT: ResolvedRunInput = {
  runId: 'run-1',
  providerId: 'claude',
  profileId: 'prof-1',
  cwd: process.cwd(),
  prompt: 'launch a subagent',
  env: {},
} as ResolvedRunInput;

const INIT: SDKMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-abc',
  cwd: process.cwd(),
  model: 'claude-opus-4',
  tools: [],
  slash_commands: [],
  permissionMode: 'default',
  claude_code_version: '2.1.226',
  mcp_servers: [],
  apiKeySource: 'user',
  output_style: 'default',
  skills: [],
  plugins: [],
  uuid: 'init-1',
} as unknown as SDKMessage;

const RESULT: SDKMessage = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 100,
  duration_api_ms: 90,
  num_turns: 1,
  result: 'done',
  stop_reason: 'end_turn',
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 2 },
  modelUsage: {},
  permission_denials: [],
  session_id: 'sess-abc',
  uuid: 'result-1',
} as unknown as SDKMessage;

function tasksChanged(tasks: readonly { task_id: string; description: string }[]): SDKMessage {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: tasks.map((task) => ({ ...task, task_type: 'local_subagent', status: 'running' })),
    session_id: 'sess-abc',
    uuid: `tasks-${String(tasks.length)}`,
  } as unknown as SDKMessage;
}

function assistantText(text: string, id = 'msg-a'): SDKMessage {
  return {
    type: 'assistant',
    message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    session_id: 'sess-abc',
    uuid: `u-${id}`,
    parent_tool_use_id: null,
  } as unknown as SDKMessage;
}

function userEcho(text: string, uuid: string): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    session_id: 'sess-abc',
    uuid,
    parent_tool_use_id: null,
  } as unknown as SDKMessage;
}

function toolResultEcho(uuid: string): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    session_id: 'sess-abc',
    uuid,
    parent_tool_use_id: null,
  } as unknown as SDKMessage;
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** Wait for the next prompt the adapter pushed at the CLI. */
async function nextPrompt(prompts: AsyncIterator<SDKUserMessage>): Promise<SDKUserMessage> {
  const next = await prompts.next();
  if (next.done === true) throw new Error('the prompt queue closed');
  return next.value;
}

/**
 * A process left alive by a subagent: the first turn launched one and ended.
 * Whatever the CLI says next opens a turn of its own.
 */
async function processHoldingWork() {
  const adopted: Run[] = [];
  let n = 0;
  const adapter = createClaudeAdapter({
    onContinuation: (run) => adopted.push(run),
    newRunId: () => `run-c${String(++n)}` as RunId,
  });
  const query = installQuery();
  const first = await adapter.createRun(BASE_INPUT);
  const prompts = query.prompts()[Symbol.asyncIterator]();
  await nextPrompt(prompts);

  const fake = query.fake();
  fake.messages.push(INIT);
  fake.messages.push(tasksChanged([{ task_id: 't1', description: 'sleep then report' }]));
  fake.messages.push(RESULT);
  await drain(first.events);
  expect(fake.closed).toBe(false);
  // Nothing was read to get here: the seam is a continuation's concern.
  expect(sdkMock.reads).toEqual([]);

  return { fake, adopted };
}

afterEach(() => {
  sdkMock.onQuery = undefined;
  sdkMock.stored = [];
  sdkMock.reads = [];
  sdkMock.failReads = false;
});

describe('a turn the CLI opens on its own', () => {
  it('counts the conversation the moment the turn announces itself, and reports it on the run', async () => {
    const { fake, adopted } = await processHoldingWork();
    // What the session file holds when the CLI opens its next turn: the
    // conversation so far and the message that opened the turn, and not one
    // word of the answer.
    sdkMock.stored = new Array<unknown>(6).fill({ type: 'user' });

    fake.messages.push(INIT);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    const turn = adopted[0] as Run;
    await vi.waitFor(() => expect(turn.historyOffset).toBe(6));

    // Read from the conversation's own store and directory, as every read is.
    expect(sdkMock.reads).toEqual([{ sessionId: 'sess-abc', options: { dir: process.cwd() } }]);

    fake.messages.push(assistantText('The subagent returned early.', 'msg-notif'));
    fake.messages.push(RESULT);
    const events = await drain(turn.events);
    expect(events.find((e) => e.type === 'text.complete')).toMatchObject({
      text: 'The subagent returned early.',
    });
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('pins the seam to the opening message once the CLI echoes it, when the count ran ahead of the write', async () => {
    // Measured 2026-09-22 on a served read-now: the count at init said 998,
    // the file said 999 a few milliseconds later, and the rebuilt transcript
    // drew every message but the one just sent. Here the store lags the same
    // way: five messages at init, six by the time the echo arrives.
    const { fake, adopted } = await processHoldingWork();
    sdkMock.stored = new Array<unknown>(5).fill({ type: 'user', uuid: 'older' });

    fake.messages.push(INIT);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    const turn = adopted[0] as Run;
    await vi.waitFor(() => expect(turn.historyOffset).toBe(5));

    // The write lands, and the CLI echoes the message that opened the turn.
    sdkMock.stored = [...sdkMock.stored, { type: 'user', uuid: 'opening-1' }];
    fake.messages.push(userEcho('try this wireguard config for singapore instead', 'opening-1'));

    await vi.waitFor(() => expect(turn.historyOffset).toBe(6));

    fake.messages.push(assistantText('Reading the config.', 'msg-3'));
    fake.messages.push(RESULT);
    const events = await drain(turn.events);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('keeps a seam the count got right, and pins it exactly once', async () => {
    const { fake, adopted } = await processHoldingWork();
    sdkMock.stored = [
      ...new Array<unknown>(5).fill({ type: 'user', uuid: 'older' }),
      { type: 'user', uuid: 'opening-1' },
    ];

    fake.messages.push(INIT);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    const turn = adopted[0] as Run;
    await vi.waitFor(() => expect(turn.historyOffset).toBe(6));

    fake.messages.push(userEcho('go on', 'opening-1'));
    await vi.waitFor(() => expect(sdkMock.reads).toHaveLength(2));
    fake.messages.push(assistantText('ok', 'msg-3'));
    fake.messages.push(RESULT);
    await drain(turn.events);

    expect(turn.historyOffset).toBe(6);
    // One read at init, one to pin.
    expect(sdkMock.reads).toHaveLength(2);
  });

  it('is not pinned by a tool result, a synthetic message or a replay, only by the prompt', async () => {
    const { fake, adopted } = await processHoldingWork();
    sdkMock.stored = [
      ...new Array<unknown>(5).fill({ type: 'user', uuid: 'older' }),
      { type: 'user', uuid: 'result-1' },
      { type: 'user', uuid: 'synthetic-1' },
      { type: 'user', uuid: 'replay-1' },
      { type: 'user', uuid: 'opening-1' },
    ];

    fake.messages.push(INIT);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    const turn = adopted[0] as Run;
    await vi.waitFor(() => expect(turn.historyOffset).toBe(9));

    // All three arrive while the turn is still waiting for its opener. None
    // of them is it: had any been taken for it, the seam would move to its
    // position and a read would show in the log.
    fake.messages.push(toolResultEcho('result-1'));
    fake.messages.push({ ...userEcho('(synthetic)', 'synthetic-1'), isSynthetic: true } as SDKMessage);
    fake.messages.push({ ...userEcho('(replay)', 'replay-1'), isReplay: true } as SDKMessage);
    fake.messages.push(assistantText('thinking', 'msg-2'));
    // A wrongly taken opener reads the store within a tick; three retry
    // periods is ample to be sure none of them did.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(sdkMock.reads).toHaveLength(1);
    expect(turn.historyOffset).toBe(9);

    fake.messages.push(userEcho('the real prompt', 'opening-1'));
    await vi.waitFor(() => expect(sdkMock.reads).toHaveLength(2));
    expect(turn.historyOffset).toBe(9);

    fake.messages.push(assistantText('ok', 'msg-3'));
    fake.messages.push(RESULT);
    await drain(turn.events);
  });

  it('does not let a turn whose opener never showed borrow the next turn\'s', async () => {
    const { fake, adopted } = await processHoldingWork();
    sdkMock.stored = new Array<unknown>(5).fill({ type: 'user', uuid: 'older' });

    // A turn the CLI opened and closed without echoing a prompt at all.
    fake.messages.push(INIT);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    const first = adopted[0] as Run;
    await vi.waitFor(() => expect(first.historyOffset).toBe(5));
    fake.messages.push(assistantText('a note to self', 'msg-2'));
    fake.messages.push(RESULT);
    await drain(first.events);

    // The next turn's prompt pins the next turn, and only that one.
    sdkMock.stored = [...sdkMock.stored, { type: 'user', uuid: 'second-opener' }];
    fake.messages.push(INIT);
    await vi.waitFor(() => expect(adopted).toHaveLength(2));
    const second = adopted[1] as Run;
    fake.messages.push(userEcho('now this', 'second-opener'));
    await vi.waitFor(() => expect(second.historyOffset).toBe(6));
    expect(first.historyOffset).toBe(5);

    fake.messages.push(assistantText('ok', 'msg-3'));
    fake.messages.push(RESULT);
    await drain(second.events);
  });

  it('keeps the counted seam when the echoed message never appears in the store', async () => {
    const { fake, adopted } = await processHoldingWork();
    sdkMock.stored = new Array<unknown>(5).fill({ type: 'user', uuid: 'older' });

    fake.messages.push(INIT);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    const turn = adopted[0] as Run;
    await vi.waitFor(() => expect(turn.historyOffset).toBe(5));

    fake.messages.push(userEcho('a message the store never files', 'ghost'));
    fake.messages.push(assistantText('ok', 'msg-3'));
    fake.messages.push(RESULT);
    await drain(turn.events);

    // Tried six times after the count, then left as counted - no worse than
    // before. Waited out in full so the retries do not bleed into the next test.
    await vi.waitFor(() => expect(sdkMock.reads).toHaveLength(7), { timeout: 2000 });
    expect(turn.historyOffset).toBe(5);
  });

  it('leaves the seam unknown when the store cannot be read, and the turn untouched', async () => {
    const { fake, adopted } = await processHoldingWork();
    sdkMock.failReads = true;

    fake.messages.push(INIT);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    await vi.waitFor(() => expect(sdkMock.reads).toHaveLength(1));
    const turn = adopted[0] as Run;

    fake.messages.push(assistantText('still here', 'msg-2'));
    fake.messages.push(RESULT);
    const events = await drain(turn.events);

    // Unknown, not zero: a zero would tell a window the whole file is this
    // turn's, and it would draw the conversation twice.
    expect(turn.historyOffset).toBeUndefined();
    expect(events.find((e) => e.type === 'text.complete')).toMatchObject({ text: 'still here' });
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });
});
