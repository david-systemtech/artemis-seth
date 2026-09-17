/**
 * Joining a run nobody started over completions.
 *
 * A run the provider opened on its own — the turn it takes when a subagent
 * settles — belonged to no connection, so its stream route answered 404 to
 * everyone: the desktop's pane read idle over a turn still being written, and
 * the first thing that put it on screen was a message typed into it, which
 * `steerLiveRun` claims on the run's behalf. The stream route now makes the
 * same claim on the same terms — the run is live, it names a session, and the
 * caller's scope may access that session — and only that claim: a run another
 * connection holds stays that connection's, and a session the caller cannot
 * see stays a 404 indistinguishable from an id that never existed.
 */

import { describe, expect, it } from 'vitest';

import type { AgentEvent, RunHandle, ServerModel } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { RunSource } from '../completions.js';
import type { SessionLedger } from '../ledger.js';

const MODEL: ServerModel = {
  route: 'work-max/opus',
  id: 'opus',
  label: 'Opus',
  note: '.',
  profileId: 'prof-a' as ServerModel['profileId'],
  profileSlug: 'work-max',
  profileLabel: 'Work Max',
  providerId: 'claude',
  thinkingLevels: [],
  adaptiveThinking: false,
  fastMode: false,
  ultracode: false,
};

const TOKEN = 'claim-token-0123456789abcdef0123456789';
const CONNECTION = {
  id: 'conn-1',
  label: 'Test',
  workspace: { kind: 'ephemeral' as const, perSession: true },
  token: TOKEN,
  createdAt: 0,
};
const OTHER_TOKEN = 'other-token-0123456789abcdef0123456789';
const OTHER = { ...CONNECTION, id: 'conn-2', token: OTHER_TOKEN };
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

/** A turn the provider opened by itself: live, on a session, owned by nobody. */
const OWN_TURN = {
  runId: 'run-own',
  providerId: 'claude',
  profileId: 'prof-a',
  cwd: '/w',
  status: 'running',
  capabilities: NO_CAPABILITIES,
  sessionId: 'sess-9',
  lastSeq: 1,
} as unknown as RunHandle;

function ownTurnSource() {
  const listeners = new Set<(event: AgentEvent) => void>();
  const emitted: AgentEvent[] = [
    { runId: 'run-own', seq: 0, type: 'session.started', sessionId: 'sess-9', providerId: 'claude', cwd: '/w' },
    { runId: 'run-own', seq: 1, type: 'text.delta', text: 'the subagent finished' },
  ] as unknown as AgentEvent[];
  const emit = (event: AgentEvent): void => {
    emitted.push(event);
    for (const listener of listeners) listener(event);
  };
  const source = {
    startRun: async () => {
      throw new Error('nothing should be started');
    },
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async () => ({ deliveredImmediately: true }),
    eventsSince: async () => ({ events: [], truncated: false }),
    listRuns: async () => [OWN_TURN],
    getRun: async (runId: string) => (runId === 'run-own' ? OWN_TURN : undefined),
    runEvents: async () => ({ events: [...emitted], truncated: false }),
    interrupt: async () => {},
    respondToPermission: async () => {},
    disposeRun: async () => {},
  } as unknown as RunSource;
  const finish = (): void => {
    emit({ runId: 'run-own', seq: 2, type: 'text.delta', text: ', and I read its report' } as never);
    emit({ runId: 'run-own', seq: 3, type: 'run.end', reason: 'completed', sessionId: 'sess-9' } as never);
  };
  return Object.assign(source, { finish });
}

/** A ledger where `sess-9` belongs to whoever asks, unless told otherwise. */
function ledgerFor(accessible: readonly string[]): SessionLedger {
  return {
    load: async () => undefined,
    record: () => undefined,
    has: (id: string) => accessible.includes(id),
    isProgramSession: () => false,
    get: () => undefined,
    listFor: () => [],
    mayAccess: (_scope: unknown, id: string) => accessible.includes(id),
    size: () => accessible.length,
    flush: async () => undefined,
  } as unknown as SessionLedger;
}

async function serve(source: RunSource, ledger: SessionLedger | undefined) {
  const { createArtemisServer } = await import('../http.js');
  const { createWorkspaceResolver } = await import('../workspaces.js');
  const { createRunDirectory } = await import('../runs.js');
  const directory = createRunDirectory({ runs: source, sweepIntervalMs: 0 });
  const server = createArtemisServer({
    port: 0,
    connections: () => [CONNECTION, OTHER],
    version: '1.1.1',
    catalogue: CATALOGUE,
    runs: source,
    workspaces: createWorkspaceResolver(),
    runDirectory: directory,
    ...(ledger === undefined ? {} : { ledger }),
  });
  const port = await server.listen();
  return {
    directory,
    stream: (token = TOKEN) =>
      fetch(`http://127.0.0.1:${port}/api/v0/runs/run-own/stream`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    close: async () => {
      directory.close();
      await server.close();
    },
  };
}

function texts(body: string): string {
  return body
    .split('\n\n')
    .filter((line) => line.startsWith('data: ') && !line.endsWith('[DONE]'))
    .map((line) => JSON.parse(line.slice(6)) as { choices: { delta: { content?: string } }[] })
    .map((chunk) => chunk.choices[0]?.delta.content ?? '')
    .join('');
}

describe('the stream of a run nobody started over completions', () => {
  it('is joined by the connection whose conversation it is in, which then owns the run', async () => {
    const source = ownTurnSource();
    const { directory, stream, close } = await serve(source, ledgerFor(['sess-9']));
    try {
      const response = await stream();
      expect(response.status).toBe(200);
      // Let the replay go out, then end the turn so the stream closes.
      await new Promise((resolve) => setTimeout(resolve, 50));
      source.finish();
      expect(texts(await response.text())).toBe('the subagent finished, and I read its report');
      expect(directory.owns(CONNECTION.id, 'run-own' as never)).toBe(true);
    } finally {
      await close();
    }
  });

  it('stays a 404 for a connection that cannot see the conversation', async () => {
    const source = ownTurnSource();
    const { directory, stream, close } = await serve(source, ledgerFor([]));
    try {
      const response = await stream();
      expect(response.status).toBe(404);
      expect(directory.owns(CONNECTION.id, 'run-own' as never)).toBe(false);
    } finally {
      await close();
    }
  });

  it('stays a 404 on a build with no ledger to own it through', async () => {
    const source = ownTurnSource();
    const { stream, close } = await serve(source, undefined);
    try {
      expect((await stream()).status).toBe(404);
    } finally {
      await close();
    }
  });

  it('keeps the run with the connection that joined first', async () => {
    const source = ownTurnSource();
    const { directory, stream, close } = await serve(source, ledgerFor(['sess-9']));
    try {
      const first = await stream();
      expect(first.status).toBe(200);
      const second = await stream(OTHER_TOKEN);
      expect(second.status).toBe(404);
      expect(directory.owns(CONNECTION.id, 'run-own' as never)).toBe(true);
      expect(directory.owns(OTHER.id, 'run-own' as never)).toBe(false);
      source.finish();
      await first.text();
    } finally {
      await close();
    }
  });
});
