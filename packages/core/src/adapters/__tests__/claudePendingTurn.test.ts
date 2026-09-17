/**
 * A prompt handed to a live process claims only the CLI turn that is its own.
 *
 * The bug, reproduced on a served session on 2026-09-08: a conversation whose
 * turn had ended with a subagent still running was sent a new prompt. The CLI,
 * about to answer its own task notification, opened *that* turn first; the
 * adapter had already made the prompt's turn the active one, so the
 * notification's sentence streamed as the prompt's answer and the `result`
 * ended the run — after which the prompt ran on a turn nobody was watching.
 * From the user's side the conversation woke for a second, said something
 * about a subagent, and stopped; the second message worked.
 *
 * What these pin: a turn opened by `continueWith` waits until the CLI echoes
 * its prompt; a CLI turn whose user message is the harness's becomes a
 * continuation and leaves the prompt queued; a turn the wire never narrates
 * with a user message still lands on the prompt (the reading every turn had
 * before); and a process that closes with a prompt still waiting ends that
 * turn rather than leaving it open forever.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, RunId } from '@rx-artemis/protocol';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const sdkMock = vi.hoisted(() => ({
  onQuery: undefined as ((params: { prompt: unknown; options?: unknown }) => unknown) | undefined,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: unknown; options?: unknown }) => {
    if (sdkMock.onQuery === undefined) throw new Error('test did not install a query hook');
    return sdkMock.onQuery(params);
  },
  listSessions: () => Promise.resolve([]),
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

/** The harness's own turn opener: a task notification in a user slot. */
const NOTIFICATION: SDKMessage = {
  type: 'user',
  parent_tool_use_id: null,
  uuid: 'notif-1',
  session_id: 'sess-abc',
  origin: { kind: 'task-notification' },
  message: {
    role: 'user',
    content: '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n</task-notification>',
  },
} as unknown as SDKMessage;

/** The CLI echoing the prompt it was handed, under the uuid it was stamped with. */
function echoOf(prompt: SDKUserMessage): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    uuid: prompt.uuid,
    session_id: 'sess-abc',
    message: { role: 'user', content: prompt.message.content },
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
 * Returns the adapter, the fake transport, and the prompt iterator with the
 * opening prompt already consumed.
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

  return { adapter, fake, prompts, adopted };
}

const NEXT: ResolvedRunInput = {
  ...BASE_INPUT,
  runId: 'run-2',
  resumeSessionId: 'sess-abc',
  prompt: 'reply with exactly the word awake',
} as ResolvedRunInput;

afterEach(() => {
  sdkMock.onQuery = undefined;
});

describe('a prompt handed to a process running a turn of its own', () => {
  it('leaves the prompt queued while the CLI answers its notification, then serves it', async () => {
    const { adapter, fake, prompts, adopted } = await processHoldingWork();

    const second = await adapter.createRun(NEXT);
    const pushed = await nextPrompt(prompts);
    expect(pushed.message.content).toBe('reply with exactly the word awake');
    expect(typeof pushed.uuid).toBe('string');
    expect(second.status).toBe('starting');

    // The CLI's own turn first: the notification, a sentence about it, done.
    fake.messages.push(INIT);
    fake.messages.push(NOTIFICATION);
    fake.messages.push(assistantText('The subagent returned early.', 'msg-notif'));
    fake.messages.push(RESULT);

    // It lands as a continuation, as it would have had nothing been waiting…
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    const foreign = await drain(adopted[0]!.events);
    expect(foreign.map((e) => e.type)).toContain('text.complete');
    expect(foreign.at(-1)).toMatchObject({ type: 'run.end' });
    const said = foreign.find((e) => e.type === 'text.complete') as { text: string };
    expect(said.text).toBe('The subagent returned early.');

    // …and the prompt's turn has not been touched by it.
    expect(second.status).toBe('starting');

    // Now the CLI opens the prompt's turn: its echo carries the stamped uuid.
    fake.messages.push(INIT);
    fake.messages.push(echoOf(pushed));
    fake.messages.push(assistantText('awake', 'msg-awake'));
    fake.messages.push(RESULT);

    const events = await drain(second.events);
    expect(events[0]).toMatchObject({ type: 'session.started', seq: 0 });
    const answer = events.find((e) => e.type === 'text.complete') as { text: string };
    expect(answer.text).toBe('awake');
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
    // The notification turn's sentence never reached the prompt's stream.
    expect(events.some((e) => e.type === 'text.complete' && (e as { text: string }).text.includes('subagent'))).toBe(false);
  });

  it('recognises the echo by its words when the CLI minted another id', async () => {
    const { adapter, fake, prompts } = await processHoldingWork();
    const second = await adapter.createRun(NEXT);
    const pushed = await nextPrompt(prompts);

    fake.messages.push(INIT);
    fake.messages.push({
      ...(echoOf(pushed) as unknown as Record<string, unknown>),
      uuid: 'minted-elsewhere',
      message: { role: 'user', content: `The user says: ${String(pushed.message.content)}` },
    } as unknown as SDKMessage);
    fake.messages.push(assistantText('awake', 'msg-awake'));
    fake.messages.push(RESULT);

    const events = await drain(second.events);
    expect((events.find((e) => e.type === 'text.complete') as { text: string }).text).toBe('awake');
  });

  it('still lands a turn the wire never narrated with a user message on the prompt', async () => {
    // The reading every turn had before the decision existed: a CLI turn
    // with no echo at all is the prompt's. Refusing it would strand the prompt.
    const { adapter, fake, prompts } = await processHoldingWork();
    const second = await adapter.createRun(NEXT);
    await nextPrompt(prompts);

    fake.messages.push(INIT);
    fake.messages.push(assistantText('awake', 'msg-awake'));
    fake.messages.push(RESULT);

    const events = await drain(second.events);
    expect((events.find((e) => e.type === 'text.complete') as { text: string }).text).toBe('awake');
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('accepts a steer typed while the prompt is still waiting for its turn', async () => {
    const { adapter, fake, prompts } = await processHoldingWork();
    const second = await adapter.createRun(NEXT);
    const pushed = await nextPrompt(prompts);

    // The steer queues behind the prompt, exactly as it would had the CLI
    // already begun; refusing it would send the renderer down the "run
    // ended" path and start a rival run.
    await expect(second.send('and then say goodnight')).resolves.toMatchObject({
      deliveredImmediately: false,
    });
    const steer = await nextPrompt(prompts);
    expect(steer.message.content).toBe('and then say goodnight');

    fake.messages.push(INIT);
    fake.messages.push(echoOf(pushed));
    fake.messages.push(RESULT);
    await drain(second.events);
  });

  it('ends a waiting turn when the process closes under it', async () => {
    const { adapter, fake, prompts } = await processHoldingWork();
    const second = await adapter.createRun(NEXT);
    await nextPrompt(prompts);

    fake.close();

    const events = await drain(second.events);
    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      reason: 'error',
      error: { code: 'transport' },
    });
  });

  it('refuses a second prompt behind one still waiting, and names the run to steer', async () => {
    const { adapter, fake, prompts } = await processHoldingWork();
    await adapter.createRun(NEXT);
    await nextPrompt(prompts);

    /*
     * This used to send the third turn the fresh-spawn way, on the belief that
     * the provider serialises two CLIs on one transcript. It does not — see the
     * mid-turn case below for what it did instead — so the pool refuses, and
     * says which run is holding the conversation so the caller can send into
     * that one.
     */
    sdkMock.onQuery = () => {
      throw new Error('spawned a second CLI on a conversation already holding a prompt');
    };
    await expect(
      adapter.createRun({ ...NEXT, runId: 'run-3', prompt: 'and another' }),
    ).rejects.toMatchObject({
      agentError: {
        code: 'invalid_request',
        details: { reason: 'session_busy', runId: 'run-2', sessionId: 'sess-abc' },
      },
    });
    expect(fake.closed).toBe(false);
  });
});

/**
 * The door the others were built to close, found open.
 *
 * Reproduced from a served conversation on 2026-09-16: a subagent finished, the
 * CLI opened a turn of its own and was still composing it, and the client —
 * whose own last turn had ended, so its pane read idle — sent "keep going" as
 * a resume. `canServe` refused the mid-turn process, as it should, and the
 * pool then spawned a second CLI with `--resume` against the file the first
 * was writing. Both wrote the same plan, opened rival pull requests, and
 * messaged each other as separate peers for four minutes.
 */
describe('a prompt sent to a process mid-turn', () => {
  it('is refused rather than run beside it, naming the turn already going', async () => {
    const { adapter, fake, adopted } = await processHoldingWork();

    // The CLI opens its own turn on the settled task and is mid-sentence.
    fake.messages.push(INIT);
    fake.messages.push(NOTIFICATION);
    fake.messages.push(assistantText('The subagent returned early.', 'msg-notif'));
    await vi.waitFor(() => expect(adopted).toHaveLength(1));

    sdkMock.onQuery = () => {
      throw new Error('spawned a second CLI on a conversation mid-turn');
    };
    await expect(adapter.createRun(NEXT)).rejects.toMatchObject({
      agentError: {
        code: 'invalid_request',
        details: { reason: 'session_busy', runId: adopted[0]!.runId, sessionId: 'sess-abc' },
      },
    });

    // The turn that was refused beside is untouched: it finishes on its own.
    fake.messages.push(RESULT);
    const foreign = await drain(adopted[0]!.events);
    expect(foreign.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
    expect(fake.closed).toBe(false);
  });

  it('refuses a fork on the same terms — a branch of a sentence still being written', async () => {
    const { adapter, fake, adopted } = await processHoldingWork();
    fake.messages.push(INIT);
    fake.messages.push(NOTIFICATION);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));

    sdkMock.onQuery = () => {
      throw new Error('spawned a second CLI to fork a conversation mid-turn');
    };
    await expect(adapter.createRun({ ...NEXT, forkSession: true })).rejects.toMatchObject({
      agentError: { details: { reason: 'session_busy' } },
    });
    fake.messages.push(RESULT);
    await drain(adopted[0]!.events);
  });

  it('refuses a rewind mid-turn instead of closing the transport under it', async () => {
    // The rewind door checked for tasks and not for an open turn, so a rewind
    // that landed mid-sentence released the process and destroyed the words it
    // was producing. Same refusal as its two neighbours now.
    const { adapter, fake, adopted } = await processHoldingWork();
    fake.messages.push(INIT);
    fake.messages.push(NOTIFICATION);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));

    await expect(
      adapter.createRun({ ...NEXT, rewindToMessageId: 'msg-1' }),
    ).rejects.toMatchObject({
      agentError: { code: 'invalid_request', message: expect.stringContaining('stop it before rewinding') },
    });
    expect(fake.closed).toBe(false);
    fake.messages.push(RESULT);
    await drain(adopted[0]!.events);
  });
});

/* -------------------------------------------------------------------------- */
/* A CLI that narrates its commands                                            */
/* -------------------------------------------------------------------------- */

/**
 * What the bundled CLI actually puts on the wire, measured 2026-09-17: it never
 * echoes the prompt. A uuid-stamped command is framed by `command_lifecycle`
 * (`queued`, then `started` as its turn opens), the turn's messages carry
 * `user_message_uuid`, and the only `user` messages are tool results. Waiting
 * for an echo therefore read the first tool result as somebody else's turn and
 * sent the whole turn to a continuation nobody was watching — five silent
 * minutes on a served conversation — and, on a fresh spawn, took the harness's
 * own turn about an orphaned task as the prompt's and closed the process on
 * its `result` before the prompt ran.
 */

/** The CLI framing a uuid-stamped command, as `msg_lifecycle_v1` has it. */
function lifecycle(
  commandUuid: string,
  state: 'queued' | 'started' | 'completed' | 'cancelled',
): SDKMessage {
  return {
    type: 'command_lifecycle',
    command_uuid: commandUuid,
    state,
    uuid: `lc-${commandUuid.slice(0, 8)}-${state}`,
    session_id: 'sess-abc',
  } as unknown as SDKMessage;
}

/** An `init` from such a CLI, which advertises the frames. */
const NARRATED_INIT: SDKMessage = {
  ...(INIT as unknown as Record<string, unknown>),
  capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'],
} as unknown as SDKMessage;

/** An assistant message stamped with the prompt it answers. */
function assistantFor(text: string, userUuid: string, id = 'msg-n'): SDKMessage {
  return {
    ...(assistantText(text, id) as unknown as Record<string, unknown>),
    user_message_uuid: userUuid,
  } as unknown as SDKMessage;
}

/** A tool call, and the tool result that is the only `user` message such a CLI writes. */
function toolCall(id: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'true' } }],
    },
    session_id: 'sess-abc',
    uuid: `u-${id}`,
    parent_tool_use_id: null,
  } as unknown as SDKMessage;
}

function toolResult(id: string): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    uuid: `tr-${id}`,
    session_id: 'sess-abc',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  } as unknown as SDKMessage;
}

function resultFor(userUuid: string): SDKMessage {
  return {
    ...(RESULT as unknown as Record<string, unknown>),
    user_message_uuid: userUuid,
  } as unknown as SDKMessage;
}

/** Read one event, then the rest, off a stream that may only be iterated once. */
function firstThenRest(events: AsyncIterable<AgentEvent>): {
  first: () => Promise<AgentEvent>;
  rest: () => Promise<AgentEvent[]>;
} {
  const iterator = events[Symbol.asyncIterator]();
  return {
    first: async () => {
      const next = await iterator.next();
      if (next.done === true) throw new Error('the stream ended before its first event');
      return next.value;
    },
    rest: async () => {
      const out: AgentEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return out;
        out.push(next.value);
      }
    },
  };
}

describe('a CLI that narrates its commands', () => {
  it('opens the prompt turn on its lifecycle frame and streams it as it goes', async () => {
    const { adapter, fake, prompts, adopted } = await processHoldingWork();
    const second = await adapter.createRun(NEXT);
    const pushed = await nextPrompt(prompts);
    const uuid = pushed.uuid as string;
    const stream = firstThenRest(second.events);

    fake.messages.push(lifecycle(uuid, 'queued'));
    fake.messages.push(lifecycle(uuid, 'started'));
    fake.messages.push(NARRATED_INIT);
    // Installed before a word is said: the first event lands ahead of any result.
    expect(await stream.first()).toMatchObject({ type: 'session.started' });

    fake.messages.push(toolCall('t-1'));
    // The one `user` message on this wire. Not an echo, and not another turn.
    fake.messages.push(toolResult('t-1'));
    fake.messages.push(assistantFor('awake', uuid));
    fake.messages.push(resultFor(uuid));
    fake.messages.push(lifecycle(uuid, 'completed'));

    const events = await stream.rest();
    expect(events.map((e) => e.type)).toContain('tool.start');
    expect((events.find((e) => e.type === 'text.complete') as { text: string }).text).toBe('awake');
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
    expect(adopted).toHaveLength(0);
  });

  it('keeps a turn that ended without naming the prompt off it, then serves the prompt', async () => {
    const { adapter, fake, prompts, adopted } = await processHoldingWork();
    const second = await adapter.createRun(NEXT);
    const pushed = await nextPrompt(prompts);
    const uuid = pushed.uuid as string;

    // The CLI's own turn first: no user slot, no owner named, over in a beat.
    fake.messages.push(lifecycle(uuid, 'queued'));
    fake.messages.push(NARRATED_INIT);
    fake.messages.push(assistantText('The subagent returned early.', 'msg-notif'));
    fake.messages.push(RESULT);

    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    const foreign = await drain(adopted[0]!.events);
    expect((foreign.find((e) => e.type === 'text.complete') as { text: string }).text).toBe(
      'The subagent returned early.',
    );
    expect(second.status).toBe('starting');
    expect(fake.closed).toBe(false);

    fake.messages.push(lifecycle(uuid, 'started'));
    fake.messages.push(NARRATED_INIT);
    fake.messages.push(assistantFor('awake', uuid));
    fake.messages.push(resultFor(uuid));

    const events = await drain(second.events);
    expect((events.find((e) => e.type === 'text.complete') as { text: string }).text).toBe('awake');
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('holds the opening turn of a fresh spawn behind the turn the CLI runs first', async () => {
    // The two-second resend: a `--resume` of a conversation whose last process
    // left a task behind runs the harness's notification turn before the prompt.
    const adopted: Run[] = [];
    let n = 0;
    const adapter = createClaudeAdapter({
      onContinuation: (run) => adopted.push(run),
      newRunId: () => `run-c${String(++n)}` as RunId,
    });
    const query = installQuery();
    const first = await adapter.createRun({ ...BASE_INPUT, resumeSessionId: 'sess-abc' });
    const prompts = query.prompts()[Symbol.asyncIterator]();
    const opening = await nextPrompt(prompts);
    const uuid = opening.uuid as string;
    expect(typeof uuid).toBe('string');
    const fake = query.fake();

    fake.messages.push(lifecycle(uuid, 'queued'));
    fake.messages.push(NARRATED_INIT);
    fake.messages.push(NOTIFICATION);
    fake.messages.push(assistantText('That task had been stopped.', 'msg-notif'));
    fake.messages.push(RESULT);

    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    await drain(adopted[0]!.events);
    // The prompt's run is untouched, and the process that holds it is still up.
    expect(first.status).toBe('starting');
    expect(fake.closed).toBe(false);

    fake.messages.push(lifecycle(uuid, 'started'));
    fake.messages.push(NARRATED_INIT);
    fake.messages.push(assistantFor('hello', uuid));
    fake.messages.push(resultFor(uuid));

    const events = await drain(first.events);
    expect((events.find((e) => e.type === 'text.complete') as { text: string }).text).toBe('hello');
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('never reads a tool result as another turn echo, even without the frames', async () => {
    const { adapter, fake, prompts, adopted } = await processHoldingWork();
    const second = await adapter.createRun(NEXT);
    await nextPrompt(prompts);

    fake.messages.push(INIT);
    fake.messages.push(toolCall('t-1'));
    fake.messages.push(toolResult('t-1'));
    fake.messages.push(assistantText('awake', 'msg-awake'));
    fake.messages.push(RESULT);

    const events = await drain(second.events);
    expect(events.map((e) => e.type)).toContain('tool.start');
    expect((events.find((e) => e.type === 'text.complete') as { text: string }).text).toBe('awake');
    expect(adopted).toHaveLength(0);
  });

  it('ends the opening turn as interrupted when the CLI cancels the queued prompt', async () => {
    const adapter = createClaudeAdapter();
    const query = installQuery();
    const run = await adapter.createRun(BASE_INPUT);
    const opening = await nextPrompt(query.prompts()[Symbol.asyncIterator]());
    const uuid = opening.uuid as string;

    query.fake().messages.push(lifecycle(uuid, 'queued'));
    query.fake().messages.push(lifecycle(uuid, 'cancelled'));

    const events = await drain(run.events);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'interrupted' });
  });
});
