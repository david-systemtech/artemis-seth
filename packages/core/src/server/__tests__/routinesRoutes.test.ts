/**
 * The routine routes, and the property they exist to enforce: a connection
 * token touches exactly the routines its own scope created — not another
 * token's, and never one on an account it may not see.
 *
 * Everything here goes through `handleServerRequest`, because the guarantee is
 * only real at the boundary: routes, auth, the scope rule and the store
 * exercised together — the same shape `sessions.test.ts` proves for
 * conversations.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentEvent,
  RunHandle,
  RunInput,
  ServerConnection,
  ServerProfile,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { Catalogue } from '../catalogue.js';
import { handleServerRequest, type ServerContext } from '../http.js';
import { createServerRoutineStore, type ServerRoutineStore } from '../routines.js';
import { WorkspaceUnavailableError, type WorkspaceResolver } from '../workspaces.js';

const TOKEN_A = 'token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const CONN_A: ServerConnection = {
  id: 'conn-a',
  label: 'Laptop',
  workspace: { kind: 'directory', path: '/work/repo' },
  token: TOKEN_A,
  createdAt: 0,
};
const CONN_B: ServerConnection = {
  id: 'conn-b',
  label: 'Other',
  workspace: { kind: 'directory', path: '/work/other' },
  token: TOKEN_B,
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

const workspaces: WorkspaceResolver = {
  resolve: async ({ workspace }) => {
    if (workspace.kind === 'directory') return { path: workspace.path, ephemeral: false };
    throw new WorkspaceUnavailableError('nope');
  },
  release: async () => undefined,
  disposeAll: async () => undefined,
};

/** A run source that never really fires — the routes are what is under test. */
function silentRuns(): {
  start(input: RunInput): Promise<RunHandle>;
  subscribe(l: (e: AgentEvent) => void): () => void;
} {
  return {
    start: async (input) =>
      ({ runId: input.runId ?? 'run-x', status: 'working', startedAt: Date.now() }) as unknown as RunHandle,
    subscribe: () => () => undefined,
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

async function freshStore(): Promise<ServerRoutineStore> {
  const dir = await mkdtemp(join(tmpdir(), 'artemis-routine-routes-'));
  const store = createServerRoutineStore({
    dataDir: dir,
    runs: silentRuns(),
    workspaces,
    catalogue,
    connections: () => [CONN_A, CONN_B],
  });
  cleanups.push(async () => {
    await store.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  await store.load();
  return store;
}

function context(store: ServerRoutineStore): ServerContext {
  return {
    connections: [CONN_A, CONN_B],
    version: '0.0.0',
    catalogue,
    startedAt: 1_700_000_000_000,
    routines: store,
  };
}

function request(
  method: string,
  url: string,
  token: string,
  body?: unknown,
): Parameters<typeof handleServerRequest>[0] {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:6472', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body }),
  };
}

const DRAFT = {
  name: 'Morning triage',
  instructions: 'Summarise the overnight alerts.',
  profileId: 'acct-1',
  providerId: 'claude',
  schedule: { kind: 'daily', at: '09:00' },
};

describe('the routine routes', () => {
  it('answers 501 when this build keeps no routines', async () => {
    const reply = await handleServerRequest(request('GET', '/api/v0/routines', TOKEN_A), {
      connections: [CONN_A],
      version: '0',
      catalogue,
      startedAt: 0,
    });
    expect(reply.status).toBe(501);
  });

  it('creates a routine, stamps the caller\'s scope, and lists it back', async () => {
    const store = await freshStore();
    const created = await handleServerRequest(
      request('POST', '/api/v0/routines', TOKEN_A, { draft: DRAFT }),
      context(store),
    );
    expect(created.status).toBe(200);

    const listed = await handleServerRequest(request('GET', '/api/v0/routines', TOKEN_A), context(store));
    const body = listed.body as { routines: { name: string; scope: string }[] };
    expect(body.routines).toHaveLength(1);
    expect(body.routines[0]).toMatchObject({ name: 'Morning triage', scope: 'dir:/work/repo' });
  });

  it('shows one token nothing of another\'s routines', async () => {
    const store = await freshStore();
    await handleServerRequest(
      request('POST', '/api/v0/routines', TOKEN_A, { draft: DRAFT }),
      context(store),
    );
    const listed = await handleServerRequest(request('GET', '/api/v0/routines', TOKEN_B), context(store));
    expect((listed.body as { routines: unknown[] }).routines).toHaveLength(0);
  });

  it('answers the same 404 for a foreign routine as for an absent one', async () => {
    const store = await freshStore();
    const created = await handleServerRequest(
      request('POST', '/api/v0/routines', TOKEN_A, { draft: DRAFT }),
      context(store),
    );
    const id = (created.body as { routine: { id: string } }).routine.id;

    const foreignPatch = await handleServerRequest(
      request('PATCH', `/api/v0/routines/${id}`, TOKEN_B, { patch: { paused: true } }),
      context(store),
    );
    const absentPatch = await handleServerRequest(
      request('PATCH', '/api/v0/routines/no-such', TOKEN_B, { patch: { paused: true } }),
      context(store),
    );
    expect(foreignPatch.status).toBe(404);
    expect(absentPatch.status).toBe(404);
    expect(JSON.stringify(foreignPatch.body)).toBe(JSON.stringify(absentPatch.body));

    // B cannot delete or run it either, and A's routine is untouched.
    expect(
      (await handleServerRequest(request('DELETE', `/api/v0/routines/${id}`, TOKEN_B), context(store)))
        .status,
    ).toBe(404);
    expect(
      (
        await handleServerRequest(
          request('POST', `/api/v0/routines/${id}/run-now`, TOKEN_B),
          context(store),
        )
      ).status,
    ).toBe(404);
    expect(store.listFor('dir:/work/repo')).toHaveLength(1);
  });

  it('lets the owner edit and delete its own routine', async () => {
    const store = await freshStore();
    const created = await handleServerRequest(
      request('POST', '/api/v0/routines', TOKEN_A, { draft: DRAFT }),
      context(store),
    );
    const id = (created.body as { routine: { id: string } }).routine.id;

    const edited = await handleServerRequest(
      request('PATCH', `/api/v0/routines/${id}`, TOKEN_A, { patch: { name: 'Evening triage' } }),
      context(store),
    );
    expect((edited.body as { routine: { name: string } }).routine.name).toBe('Evening triage');

    const deleted = await handleServerRequest(
      request('DELETE', `/api/v0/routines/${id}`, TOKEN_A),
      context(store),
    );
    expect((deleted.body as { deleted: boolean }).deleted).toBe(true);
    expect(store.listFor('dir:/work/repo')).toHaveLength(0);
  });

  it('refuses to create a routine on an account this connection cannot see', async () => {
    const store = await freshStore();
    const reply = await handleServerRequest(
      request('POST', '/api/v0/routines', TOKEN_A, {
        draft: { ...DRAFT, profileId: 'acct-hidden' },
      }),
      context(store),
    );
    expect(reply.status).toBe(404);
    expect(store.listFor('dir:/work/repo')).toHaveLength(0);
  });

  it('rejects a draft with no schedule as a 400', async () => {
    const store = await freshStore();
    const reply = await handleServerRequest(
      request('POST', '/api/v0/routines', TOKEN_A, {
        draft: { name: 'x', instructions: 'y', profileId: 'acct-1', providerId: 'claude' },
      }),
      context(store),
    );
    expect(reply.status).toBe(400);
  });
});
