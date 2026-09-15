/**
 * A subagent that outlives its turn must still be seen to finish.
 *
 * Driven through the terminal's own composition root — `createTuiHost` — with
 * the SDK replaced by a scripted transport, so what is exercised is the exact
 * chain the TUI runs: host → registry → Claude adapter → `Conversation`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { syncScheduler } from '@rx-artemis/transcript';

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

const { createTuiHost } = await import('./host.js');
const { Conversation } = await import('./conversation.js');
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
let dataDir: string;
let cwd: string;
let host: ReturnType<typeof createTuiHost>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artemis-settle-'));
  dataDir = join(root, 'data');
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
  host = createTuiHost(dataDir, { cwd });
});

afterEach(async () => {
  sdkMock.onQuery = undefined;
  await host.dispose();
  await rm(root, { recursive: true, force: true });
});

const texts = (c: InstanceType<typeof Conversation>) =>
  c.transcript
    .getRowsSnapshot()
    .map((id) => c.transcript.getItem(id) ?? c.transcript.getGroup(id))
    .flatMap((row) => (row !== undefined && 'text' in row && typeof row.text === 'string' ? [row.text] : []));

describe('a subagent that outlives its turn', () => {
  it('settles on screen and the transcript carries what the agent said about it', async () => {
    const c = new Conversation({
      driver: host.runs,
      settings: {
        profileId: 'prof_work' as never,
        providerId: 'claude',
        profileLabel: 'Work',
        providerLabel: 'Claude',
        cwd,
        permissionMode: 'default',
      },
      capabilitiesFor: (id) => host.capabilitiesFor(id),
      scheduler: syncScheduler,
    });
    const query = installQuery();

    expect(await c.send('delegate something')).toEqual({ ok: true });
    await query.prompts().next();
    const fake = query.fake();

    // The turn delegates and ends, leaving the subagent running.
    fake.messages.push(INIT(cwd));
    fake.messages.push(taskStarted('t1'));
    fake.messages.push(tasksChanged(['t1']));
    fake.messages.push(RESULT);
    await vi.waitFor(() => expect(c.getState().status).toBe('idle'));
    expect(c.getState().tasks.map((t) => [t.id, t.status, t.subagentType])).toEqual([['t1', 'running', 'Explore']]);
    expect(fake.closed).toBe(false);

    // The subagent finishes. The CLI says so, then takes a turn of its own
    // about it: init, the notification in a user slot, a sentence, result.
    fake.messages.push(tasksChanged([]));
    fake.messages.push(taskNotification('t1'));
    fake.messages.push(INIT(cwd));
    fake.messages.push(NOTIFICATION);
    fake.messages.push(assistantText('The Explore agent found 14 bindings.', 'msg-notif'));
    fake.messages.push(RESULT);

    await vi.waitFor(() => expect(c.getState().tasks.map((t) => t.status)).toEqual(['completed']), { timeout: 3_000 });
    await vi.waitFor(() => expect(texts(c)).toContain('The Explore agent found 14 bindings.'), { timeout: 3_000 });
  });
});
