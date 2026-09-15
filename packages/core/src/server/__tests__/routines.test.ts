/**
 * The server routine store: appointments that fire in the server, owned per
 * connection.
 *
 * Driven the way the desktop host's tests are — a fake run source, a real temp
 * data directory, fake timers — plus the two things only a *server* store has
 * to get right: scope isolation (one connection cannot see or fire another's
 * routines) and a pinned directory + bypass mode on every firing (a served run
 * may only start in the connection's own folder, and there is nobody there to
 * answer a prompt).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentEvent,
  RoutineDraft,
  RunHandle,
  RunInput,
  ServerConnection,
  ServerProfile,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { Catalogue } from '../catalogue.js';
import {
  createServerRoutineStore,
  readServerRoutines,
  SERVER_ROUTINES_FILE,
  type ServerRoutineStore,
} from '../routines.js';
import { WorkspaceUnavailableError, type WorkspaceResolver } from '../workspaces.js';

/** Tuesday 2026-03-03, 08:59:30 local — thirty seconds shy of a 09:00 firing. */
const almostNine = new Date(2026, 2, 3, 8, 59, 30);

/** One person's connection, pinned to a directory it may run turns in. */
const CONN_A: ServerConnection = {
  id: 'conn-a',
  label: 'Laptop',
  workspace: { kind: 'directory', path: '/work/repo' },
  token: 'token-a',
  createdAt: 0,
};
/** A different principal: same server, a different directory. */
const CONN_B: ServerConnection = {
  id: 'conn-b',
  label: 'Other',
  workspace: { kind: 'directory', path: '/work/other' },
  token: 'token-b',
  createdAt: 0,
};

const ACCOUNT: ServerProfile = {
  id: 'acct-1' as ServerProfile['id'],
  slug: 'work',
  label: 'Work',
  provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
  available: true,
  disabled: false,
  live: true,
  capabilities: NO_CAPABILITIES,
  models: [
    {
      route: 'work/opus',
      id: 'opus',
      label: 'Opus',
      note: 'The default.',
      profileId: 'acct-1' as ServerProfile['id'],
      profileSlug: 'work',
      profileLabel: 'Work',
      providerId: 'claude',
      thinkingLevels: [],
      adaptiveThinking: false,
      fastMode: false,
      ultracode: false,
    },
  ],
};

const catalogue: Catalogue = {
  read: async () => [ACCOUNT],
  invalidate: () => undefined,
};

const DRAFT: RoutineDraft = {
  name: 'Morning triage',
  instructions: 'Read the overnight alerts and summarise.',
  profileId: 'acct-1',
  providerId: 'claude',
  schedule: { kind: 'daily', at: '09:00' },
};

interface FakeRuns {
  readonly started: RunInput[];
  emit(event: Partial<AgentEvent>): void;
  readonly source: { start(input: RunInput): Promise<RunHandle>; subscribe(l: (e: AgentEvent) => void): () => void };
}

function fakeRuns(): FakeRuns {
  const started: RunInput[] = [];
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    started,
    emit: (event) => {
      for (const listener of listeners) listener(event as AgentEvent);
    },
    source: {
      start: async (input: RunInput) => {
        started.push(input);
        return {
          runId: input.runId ?? 'run-x',
          providerId: input.providerId,
          profileId: input.profileId,
          cwd: input.cwd,
          status: 'working',
          startedAt: Date.now(),
        } as unknown as RunHandle;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

/** A resolver that hands back a directory workspace's path, and refuses the rest. */
const workspaces: WorkspaceResolver = {
  resolve: async ({ workspace }) => {
    if (workspace.kind === 'directory') return { path: workspace.path, ephemeral: false };
    throw new WorkspaceUnavailableError('This connection cannot run turns.');
  },
  release: async () => undefined,
  disposeAll: async () => undefined,
};

const stores: ServerRoutineStore[] = [];
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'artemis-server-routines-'));
  dirs.push(dir);
  return dir;
}

interface Harness {
  readonly store: ServerRoutineStore;
  readonly runs: FakeRuns;
  readonly dir: string;
}

async function makeStore(options?: {
  readonly dir?: string;
  readonly connections?: readonly ServerConnection[];
}): Promise<Harness> {
  const dir = options?.dir ?? (await tempDir());
  const runs = fakeRuns();
  const store = createServerRoutineStore({
    dataDir: dir,
    runs: runs.source,
    workspaces,
    catalogue,
    connections: () => options?.connections ?? [CONN_A, CONN_B],
  });
  stores.push(store);
  return { store, runs, dir };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(almostNine);
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('scope', () => {
  it('shows a connection only its own routines', async () => {
    const { store } = await makeStore();
    await store.load();
    await store.create({ draft: DRAFT, connection: CONN_A });

    // A's own scope sees it; B's — a different directory — sees nothing.
    expect(store.listFor('dir:/work/repo').map((r) => r.name)).toEqual(['Morning triage']);
    expect(store.listFor('dir:/work/other')).toHaveLength(0);
  });

  it('refuses to edit, delete or fire another scope\'s routine', async () => {
    const { store, runs } = await makeStore();
    await store.load();
    const created = await store.create({ draft: DRAFT, connection: CONN_A });

    // B's scope names A's id and is answered with "no such routine" throughout.
    expect(await store.update('dir:/work/other', created.id, { paused: true })).toBeUndefined();
    expect(await store.remove('dir:/work/other', created.id)).toBe(false);
    expect(await store.runNow('dir:/work/other', created.id)).toBeUndefined();
    expect(runs.started).toHaveLength(0);
    // Untouched for its real owner.
    expect(store.listFor('dir:/work/repo')).toHaveLength(1);
  });

  it('refuses a connection with no directory to pin a routine to', async () => {
    const { store } = await makeStore();
    await store.load();
    const ephemeral: ServerConnection = {
      id: 'conn-e',
      label: 'Scratch',
      workspace: { kind: 'ephemeral', perSession: true },
      token: 'token-e',
      createdAt: 0,
    };
    await expect(store.create({ draft: DRAFT, connection: ephemeral })).rejects.toThrow();
  });
});

describe('firing', () => {
  it('fires in the connection\'s pinned directory, in bypass mode, tagged with the id', async () => {
    const { store, runs } = await makeStore();
    await store.load();
    store.start();
    await store.create({ draft: DRAFT, connection: CONN_A });

    await vi.advanceTimersByTimeAsync(31_000); // cross 09:00, land on the tick

    expect(runs.started).toHaveLength(1);
    const input = runs.started[0];
    expect(input?.cwd).toBe('/work/repo');
    expect(input?.permissionMode).toBe('bypassPermissions');
    expect(input?.prompt).toBe(DRAFT.instructions);
    // The model was omitted on the draft, so the account's default resolves it.
    expect(input?.model).toBe('opus');
    expect(input?.metadata?.['routineId']).toBeDefined();
  });

  it('runNow fires immediately and settles history on run.end', async () => {
    const { store, runs } = await makeStore();
    await store.load();
    store.start();
    const created = await store.create({
      draft: { ...DRAFT, schedule: { kind: 'manual' } },
      connection: CONN_A,
    });

    const after = await store.runNow('dir:/work/repo', created.id);
    expect(runs.started).toHaveLength(1);
    expect(after?.running).toBe(true);

    const runId = runs.started[0]?.runId as string;
    runs.emit({ type: 'session.started', runId, sessionId: 'sess-1' } as Partial<AgentEvent>);
    runs.emit({ type: 'run.end', runId, reason: 'completed' } as Partial<AgentEvent>);

    const row = store.listFor('dir:/work/repo')[0]?.history[0];
    expect(row).toMatchObject({ outcome: 'completed', sessionId: 'sess-1' });
    expect(store.listFor('dir:/work/repo')[0]?.running).toBe(false);
  });

  it('skips instead of stacking a second copy while one is running', async () => {
    const { store, runs } = await makeStore();
    await store.load();
    store.start();
    const created = await store.create({ draft: DRAFT, connection: CONN_A });

    await store.runNow('dir:/work/repo', created.id);
    await store.runNow('dir:/work/repo', created.id);

    expect(runs.started).toHaveLength(1);
    expect(store.listFor('dir:/work/repo')[0]?.history[0]).toMatchObject({
      outcome: 'skipped',
      skipReason: 'overlap',
    });
  });

  it('records a skip when the connection is gone', async () => {
    // No connections at all: the routine's own connection cannot be found, so
    // there is nowhere to run and the firing is a skip rather than a run.
    const { store, runs } = await makeStore({ connections: [] });
    await store.load();
    store.start();
    // Created against A even though the live list is empty, so the routine
    // exists but its connection does not.
    const created = await store.create({ draft: DRAFT, connection: CONN_A });
    await store.runNow('dir:/work/repo', created.id);

    expect(runs.started).toHaveLength(0);
    expect(store.listFor('dir:/work/repo')[0]?.history[0]).toMatchObject({
      outcome: 'skipped',
      skipReason: 'engine-unavailable',
    });
  });
});

describe('persistence and catch-up', () => {
  it('round-trips a routine through disk', async () => {
    const first = await makeStore();
    await first.store.load();
    await first.store.create({ draft: DRAFT, connection: CONN_A });

    const raw = JSON.parse(await readFile(join(first.dir, SERVER_ROUTINES_FILE), 'utf8'));
    const parsed = readServerRoutines(raw.routines);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ scope: 'dir:/work/repo', connectionId: 'conn-a' });

    const second = await makeStore({ dir: first.dir });
    await second.store.load();
    expect(second.store.listFor('dir:/work/repo')[0]).toMatchObject({ name: 'Morning triage' });
  });

  it('makes up one appointment missed while the server was down', async () => {
    const first = await makeStore();
    await first.store.load();
    await first.store.create({ draft: DRAFT, connection: CONN_A });
    await first.store.dispose();

    // Relaunch the next day at 09:30 — yesterday's 09:00 was kept while it ran
    // (it did not), today's 09:00 was missed while the process was down.
    vi.setSystemTime(new Date(2026, 2, 4, 9, 30, 0));
    const second = await makeStore({ dir: first.dir });
    await second.store.load();
    second.store.start();
    // Let the start-time catch-up pass resolve its awaits.
    await vi.advanceTimersByTimeAsync(0);

    expect(second.runs.started).toHaveLength(1);
    expect(second.store.listFor('dir:/work/repo')[0]?.history[0]).toMatchObject({
      outcome: 'running',
      catchUp: true,
    });
  });
});
