/**
 * A subagent that outlives its turn must still be seen to finish, served too.
 *
 * Driven through the server's own composition root — `createHeadlessHost` —
 * with the SDK replaced by a scripted transport, so what is exercised is the
 * chain a served client hangs off: host → registry → Claude adapter → the
 * registry's fan-out, which is where the wire picks events up.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@rx-artemis/protocol';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const sdkMock = vi.hoisted(() => ({
  onQuery: undefined as ((params: { prompt: unknown; options?: unknown }) => unknown) | undefined,
}));

// Resolved from core's own location and by real path, because pnpm's isolated
// linking means the bare specifier does not resolve from this package — and
// core's copy is the one that has to be replaced.
const sdk = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module');
  const { realpathSync } = await import('node:fs');
  const fromCore = createRequire(realpathSync(createRequire(import.meta.url).resolve('@rx-artemis/core')));
  return { path: realpathSync(fromCore.resolve('@anthropic-ai/claude-agent-sdk')) };
});

vi.mock(sdk.path, () => ({
  query: (params: { prompt: unknown; options?: unknown }) => {
    if (sdkMock.onQuery === undefined) throw new Error('test did not install a query hook');
    return sdkMock.onQuery(params);
  },
  listSessions: () => Promise.resolve([]),
}));

const { createHeadlessHost } = await import('./host.js');
const { AsyncQueue } = await import('@rx-artemis/core');

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

function installQuery() {
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
      return captured.prompt[Symbol.asyncIterator]();
    },
  };
}

const SESSION = 'sess-abc';
const sys = (subtype: string, rest: Record<string, unknown>): SDKMessage =>
  ({ type: 'system', subtype, session_id: SESSION, uuid: `${subtype}-${String(Math.random())}`, ...rest }) as unknown as SDKMessage;

const INIT = (cwd: string): SDKMessage =>
  sys('init', {
    cwd,
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
  });

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
  session_id: SESSION,
  uuid: 'result-1',
} as unknown as SDKMessage;

const tasksChanged = (ids: readonly string[]): SDKMessage =>
  sys('background_tasks_changed', {
    tasks: ids.map((task_id) => ({ task_id, task_type: 'local_agent', description: 'map the keybindings', status: 'running' })),
  });

const taskStarted = (task_id: string): SDKMessage =>
  sys('task_started', { task_id, task_type: 'local_agent', description: 'map the keybindings', subagent_type: 'Explore' });

const taskNotification = (task_id: string): SDKMessage =>
  sys('task_notification', { task_id, status: 'completed', summary: 'Found 14 bindings', usage: { total_tokens: 4200, tool_uses: 6, duration_ms: 9000 } });

const NOTIFICATION: SDKMessage = {
  type: 'user',
  parent_tool_use_id: null,
  uuid: 'notif-1',
  session_id: SESSION,
  origin: { kind: 'task-notification' },
  message: { role: 'user', content: '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n</task-notification>' },
} as unknown as SDKMessage;

const assistantText = (text: string, id = 'msg-a'): SDKMessage =>
  ({
    type: 'assistant',
    message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    session_id: SESSION,
    uuid: `u-${id}`,
    parent_tool_use_id: null,
  }) as unknown as SDKMessage;

let root: string;
let cwd: string;
let host: ReturnType<typeof createHeadlessHost>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artemis-served-settle-'));
  const dataDir = join(root, 'data');
  cwd = join(root, 'work');
  const configDir = join(dataDir, 'profiles', 'work');
  await Promise.all([mkdir(configDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  await writeFile(
    join(dataDir, 'profiles.json'),
    JSON.stringify({
      version: 2,
      profiles: [{ id: 'prof_work', label: 'Work', providerId: 'claude', configDir, publicEnv: {}, createdAt: 1, updatedAt: 1 }],
    }),
  );
  host = createHeadlessHost(dataDir);
});

afterEach(async () => {
  sdkMock.onQuery = undefined;
  await host.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('a subagent that outlives its served turn', () => {
  it('settles on the stream a client is listening to, on a turn of the provider\'s own', async () => {
    const seen: AgentEvent[] = [];
    host.runs.subscribe((event) => seen.push(event));
    const query = installQuery();

    const handle = await host.runs.start({ providerId: 'claude', profileId: 'prof_work' as never, cwd, prompt: 'delegate something', permissionMode: 'default' } as never);
    await query.prompts().next();
    const fake = query.fake();

    // The turn delegates and ends, leaving the subagent running.
    fake.messages.push(INIT(cwd));
    fake.messages.push(taskStarted('t1'));
    fake.messages.push(tasksChanged(['t1']));
    fake.messages.push(RESULT);
    await vi.waitFor(() => expect(seen.some((event) => event.type === 'run.end' && event.runId === handle.runId)).toBe(true));
    expect(fake.closed).toBe(false);

    // The subagent finishes; the CLI says so, then takes a turn of its own about it.
    fake.messages.push(tasksChanged([]));
    fake.messages.push(taskNotification('t1'));
    fake.messages.push(INIT(cwd));
    fake.messages.push(NOTIFICATION);
    fake.messages.push(assistantText('The Explore agent found 14 bindings.', 'msg-notif'));
    fake.messages.push(RESULT);

    await vi.waitFor(
      () => {
        const settled = seen.find(
          (event) => event.type === 'background.tasks' && event.tasks.some((task) => task.id === 't1' && task.status === 'completed'),
        );
        expect(settled).toBeDefined();
        // On a run the client never started — the one it has to be told about.
        expect(settled?.runId).not.toBe(handle.runId);
        expect(host.runs.get(settled!.runId)?.sessionId).toBe(SESSION);
      },
      { timeout: 3_000 },
    );
    expect(seen.some((event) => event.type === 'text.complete' && event.text === 'The Explore agent found 14 bindings.')).toBe(true);
  });
});
