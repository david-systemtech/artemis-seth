/**
 * A message to a conversation the server is still working on.
 *
 * The fork, as it happened on 2026-09-16: the provider opened a turn of its own
 * when a subagent finished, the registry adopted it, and the client — whose
 * last turn had ended, so its pane read idle — sent "keep going" as a resume.
 * The route started a second run on the session. Two CLIs then wrote one
 * transcript for four minutes, each opening pull requests the other closed.
 *
 * These pin the replacement: the message goes into the live run as a steer,
 * the caller follows that run from the start, and no second run is started.
 * Where a steer cannot be honest — a fork, a rewind, a run another connection
 * holds, a build with no directory to say whose the run is — the answer is a
 * `409` that says to wait or stop, and still never a second run.
 */

import { describe, expect, it } from 'vitest';

import type { AgentEvent, RunHandle, ServerModel } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { RunSource } from '../completions.js';

const MODEL: ServerModel = {
  route: 'work-max/opus',
  id: 'opus',
  label: 'Opus',
  note: '.',
  profileId: 'prof-a' as ServerModel['profileId'],
  profileSlug: 'work-max',
  profileLabel: 'Work Max',
  providerId: 'claude',
  thinkingLevels: [{ id: 'high', label: 'High', note: '.' }],
  adaptiveThinking: false,
  fastMode: true,
  ultracode: true,
};

const TOKEN = 'busy-token-0123456789abcdef0123456789';
const CONNECTION = {
  id: 'conn-1',
  label: 'Test',
  workspace: { kind: 'ephemeral' as const, perSession: true },
  token: TOKEN,
  createdAt: 0,
};
const OTHER = { ...CONNECTION, id: 'conn-2', token: 'other-token-0123456789abcdef0123456789' };
const CATALOGUE = {
  read: async () => [
    {
      id: 'prof-a' as ServerModel['profileId'],
      slug: 'work-max',
      label: 'Work Max',
      provider: { id: 'claude' as const, label: 'Claude', kind: 'hosted' as const },
      available: true,
      disabled: false,
      live: true,
      capabilities: NO_CAPABILITIES,
      models: [MODEL],
    },
  ],
  invalidate: () => undefined,
};
const LIVE = {
  runId: 'run-live',
  providerId: 'claude',
  profileId: 'prof-a',
  cwd: '/w',
  status: 'running',
  capabilities: NO_CAPABILITIES,
  sessionId: 'sess-9',
} as unknown as RunHandle;

/**
 * An engine with one run going on `sess-9` and no way to start another.
 *
 * A steer makes the run read the message, say one more thing, and end — and
 * everything it has emitted is in the retained buffer, which is what makes the
 * send-then-subscribe order in `steerTurn` safe.
 */
function busySource() {
  const listeners = new Set<(event: AgentEvent) => void>();
  const sent: { runId: string; text: string }[] = [];
  const started: unknown[] = [];
  const emitted: AgentEvent[] = [
    {
      runId: 'run-live',
      seq: 0,
      type: 'session.started',
      sessionId: 'sess-9',
      providerId: 'claude',
      cwd: '/w',
    },
    { runId: 'run-live', seq: 1, type: 'text.delta', text: 'still working' },
  ] as unknown as AgentEvent[];
  const emit = (event: AgentEvent): void => {
    emitted.push(event);
    for (const listener of listeners) listener(event);
  };
  const source = {
    startRun: async (input: unknown) => {
      started.push(input);
      throw new Error('a second run was started on a conversation still working');
    },
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async (runId: string, text: string) => {
      sent.push({ runId: String(runId), text });
      queueMicrotask(() => {
        emit({ runId: 'run-live', seq: 2, type: 'message.delivered', messageId: 'm-1' } as never);
        emit({ runId: 'run-live', seq: 3, type: 'text.delta', text: ', and on it goes' } as never);
        emit({
          runId: 'run-live',
          seq: 4,
          type: 'run.end',
          reason: 'completed',
          sessionId: 'sess-9',
        } as never);
      });
      return { deliveredImmediately: true };
    },
    eventsSince: async () => ({ events: [], truncated: false }),
    listRuns: async () => [LIVE],
    runEvents: async () => ({ events: [...emitted], truncated: false }),
    interrupt: async () => {},
    respondToPermission: async () => {},
    disposeRun: async () => {},
  } as unknown as RunSource;
  return Object.assign(source, { sent, started });
}

async function serve(
  source: RunSource,
  extra: { withDirectory?: boolean; connections?: readonly (typeof CONNECTION)[] } = {},
) {
  const { createArtemisServer } = await import('../http.js');
  const { createWorkspaceResolver } = await import('../workspaces.js');
  const { createRunDirectory } = await import('../runs.js');
  const directory =
    extra.withDirectory === false
      ? undefined
      : createRunDirectory({ runs: source, sweepIntervalMs: 0 });
  const server = createArtemisServer({
    port: 0,
    connections: () => extra.connections ?? [CONNECTION],
    version: '1.1.1',
    catalogue: CATALOGUE,
    runs: source,
    workspaces: createWorkspaceResolver(),
    ...(directory === undefined ? {} : { runDirectory: directory }),
  });
  const port = await server.listen();
  return {
    server,
    directory,
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: async () => {
      directory?.close();
      await server.close();
    },
  };
}

const post = (url: string, body: unknown, token = TOKEN) =>
  fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface Chunk {
  readonly choices: {
    readonly delta: { readonly role?: string; readonly content?: string };
    readonly finish_reason: string | null;
  }[];
  readonly artemis?: {
    readonly runId?: string;
    readonly sessionId?: string;
    readonly endReason?: string;
    readonly ignored?: string[];
  };
}

async function parseStream(response: Response): Promise<Chunk[]> {
  return (await response.text())
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .filter((chunk) => chunk !== '[DONE]')
    .map((chunk) => JSON.parse(chunk) as Chunk);
}

describe('a message to a conversation the server is still working on', () => {
  it('steers the live run and streams it from the start, starting nothing', async () => {
    const source = busySource();
    const { url, close } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'did the session stop? keep going' }],
        stream: true,
        artemis: { sessionId: 'sess-9', remote: { detach: true, permissions: true } },
      });
      expect(response.status).toBe(200);
      const chunks = await parseStream(response);

      // The message went into the run already going, and nothing else was started.
      expect(source.sent).toEqual([{ runId: 'run-live', text: 'did the session stop? keep going' }]);
      expect(source.started).toEqual([]);

      // The caller learns which run it is now following, before anything else.
      expect(chunks[0]?.choices[0]?.delta).toEqual({ role: 'assistant' });
      expect(chunks[1]?.artemis?.runId).toBe('run-live');
      // Everything the run did before the caller arrived, then what the steer provoked.
      const text = chunks.map((chunk) => chunk.choices[0]?.delta.content ?? '').join('');
      expect(text).toBe('still working, and on it goes');
      const last = chunks.at(-1);
      expect(last?.choices[0]?.finish_reason).toBe('stop');
      expect(last?.artemis).toMatchObject({ endReason: 'completed', sessionId: 'sess-9' });
    } finally {
      await close();
    }
  });

  it('answers a whole reply the same way', async () => {
    const source = busySource();
    const { url, close } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'keep going' }],
        artemis: { sessionId: 'sess-9' },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        choices: { message: { content: string } }[];
        artemis: { sessionId?: string; endReason?: string };
      };
      expect(body.choices[0]?.message.content).toBe('still working, and on it goes');
      expect(body.artemis).toMatchObject({ sessionId: 'sess-9', endReason: 'completed' });
      expect(source.sent).toHaveLength(1);
      expect(source.started).toEqual([]);
    } finally {
      await close();
    }
  });

  it('names the fields a steer cannot carry, rather than dropping them quietly', async () => {
    const source = busySource();
    const { url, close } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'keep going' }],
        stream: true,
        artemis: { sessionId: 'sess-9', systemPrompt: 'be brief', thinking: 'high', chromeBrowser: true },
      });
      const chunks = await parseStream(response);
      // Chrome among them: a turn already running was started with its tools,
      // and a browser cannot be handed to it part-way.
      expect(chunks[0]?.artemis?.ignored).toEqual([
        'artemis.systemPrompt',
        'artemis.thinking',
        'artemis.chromeBrowser',
      ]);
    } finally {
      await close();
    }
  });

  it('refuses a fork or a rewind of a turn still being written', async () => {
    const source = busySource();
    const { url, close } = await serve(source);
    try {
      for (const reshaping of [{ forkSession: true }, { rewindToMessageId: 'msg-1' }]) {
        const response = await post(url, {
          model: 'work-max/opus',
          messages: [{ role: 'user', content: 'keep going' }],
          artemis: { sessionId: 'sess-9', ...reshaping },
        });
        expect(response.status).toBe(409);
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe('session_busy');
      }
      expect(source.sent).toEqual([]);
      expect(source.started).toEqual([]);
    } finally {
      await close();
    }
  });

  it('refuses to steer a run another connection is driving', async () => {
    const source = busySource();
    const { url, directory, close } = await serve(source, { connections: [CONNECTION, OTHER] });
    try {
      directory?.claim({
        runId: 'run-live' as RunHandle['runId'],
        connectionId: OTHER.id,
        permissions: false,
      });
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'keep going' }],
        artemis: { sessionId: 'sess-9' },
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain('another connection');
      expect(source.sent).toEqual([]);
      expect(source.started).toEqual([]);
    } finally {
      await close();
    }
  });

  it('refuses, and still starts nothing, on an engine that cannot send into a run', async () => {
    // A host that serves completions but exposes no steer. The one thing it
    // must not do with the message is what it used to: start a second run.
    const source = busySource();
    delete (source as { send?: unknown }).send;
    const { url, close } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'keep going' }],
        artemis: { sessionId: 'sess-9' },
      });
      expect(response.status).toBe(409);
      expect(source.sent).toEqual([]);
      expect(source.started).toEqual([]);
    } finally {
      await close();
    }
  });
});
