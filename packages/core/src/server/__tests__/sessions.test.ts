/**
 * The session surface, and the property it exists to enforce: a connection
 * token sees exactly the conversations its own scope created — not another
 * token's, and never the serving user's desktop history.
 *
 * Everything here goes through `handleServerRequest`, because the guarantee
 * is only real at the boundary: routes, auth, the ledger, and the resume gate
 * exercised together.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentEvent, ServerProfile } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { Catalogue } from '../catalogue.js';
import { handleServerRequest, type ServerContext, type SessionSource } from '../http.js';
import { createSessionLedger, type SessionLedger } from '../ledger.js';

const TOKEN_A = 'token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN_C = 'token-cccccccccccccccccccccccccccccccc';

/** Two tokens pinned to one directory — one person's two laptops. */
const LAPTOP_ONE = {
  id: 'conn-a',
  label: 'Laptop one',
  workspace: { kind: 'directory' as const, path: '/work/repo' },
  token: TOKEN_A,
  createdAt: 0,
};
const LAPTOP_TWO = {
  id: 'conn-b',
  label: 'Laptop two',
  workspace: { kind: 'directory' as const, path: '/work/repo' },
  token: TOKEN_B,
  createdAt: 0,
};
/** A different principal: same server, different directory. */
const STRANGER = {
  id: 'conn-c',
  label: 'Someone else',
  workspace: { kind: 'directory' as const, path: '/work/other' },
  token: TOKEN_C,
  createdAt: 0,
};

const PROFILES: readonly ServerProfile[] = [
  {
    id: 'prof-a' as ServerProfile['id'],
    slug: 'work-max',
    label: 'Work Max',
    provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
    available: true,
    disabled: false,
    live: true,
    capabilities: NO_CAPABILITIES,
    models: [
      {
        route: 'work-max/opus',
        id: 'opus',
        label: 'Opus 5',
        note: 'The big one.',
        profileId: 'prof-a' as ServerProfile['id'],
        profileSlug: 'work-max',
        profileLabel: 'Work Max',
        providerId: 'claude',
        thinkingLevels: [],
        adaptiveThinking: false,
        fastMode: false,
        ultracode: false,
      },
    ],
  },
];

const catalogue: Catalogue = {
  read: async () => PROFILES,
  invalidate: () => undefined,
};

/** A store that knows two conversations under prof-a in /work/repo. */
const sessionSource: SessionSource = {
  list: async (query) => ({
    sessions:
      query.profileId === 'prof-a' && query.cwd === '/work/repo'
        ? [
            {
              id: 'sess-1' as never,
              providerId: 'claude' as never,
              profileId: 'prof-a' as never,
              cwd: '/work/repo',
              title: 'First conversation',
              firstPrompt: 'hello',
              updatedAt: 111,
            },
            {
              id: 'sess-2' as never,
              providerId: 'claude' as never,
              profileId: 'prof-a' as never,
              cwd: '/work/repo',
              title: 'Second conversation',
              updatedAt: 222,
            },
          ]
        : [],
    hasMore: false,
  }),
  messages: async (query) => ({
    events: [
      {
        type: 'text.complete',
        runId: query.runId,
        seq: 0,
        ts: 1,
        messageId: 'm1',
        role: 'assistant',
        text: `stored text of ${query.sessionId}`,
      } as unknown as AgentEvent,
    ],
    hasMore: false,
  }),
};

/**
 * Flush before removing: the ledger persists lazily, and an `rm` racing a
 * write mid-flight recreates the file under the directory being removed —
 * ENOTEMPTY, intermittently. The same trap the routine store's tests hit.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

async function freshLedger(): Promise<{ ledger: SessionLedger; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'artemis-ledger-'));
  const ledger = createSessionLedger(dir);
  cleanups.push(async () => {
    await ledger.flush();
    await rm(dir, { recursive: true, force: true });
  });
  await ledger.load();
  return { ledger, dir };
}

function context(ledger: SessionLedger, extra: Partial<ServerContext> = {}): ServerContext {
  return {
    connections: [LAPTOP_ONE, LAPTOP_TWO, STRANGER],
    version: '0.0.0',
    catalogue,
    startedAt: 1_700_000_000_000,
    ledger,
    sessions: sessionSource,
    ...extra,
  };
}

function get(url: string, token: string) {
  return {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:6472', authorization: `Bearer ${token}` },
  };
}

/** Record sess-1 and sess-2 as LAPTOP_ONE's, the way the router does. */
function seedOwnership(ledger: SessionLedger): void {
  for (const sessionId of ['sess-1', 'sess-2']) {
    ledger.record({
      sessionId,
      connectionId: LAPTOP_ONE.id,
      profileId: 'prof-a',
      workspaceKey: 'dir:/work/repo',
      cwd: '/work/repo',
    });
  }
}

describe('GET /api/v0/sessions', () => {
  it('answers 501 when this build keeps no history', async () => {
    const { ledger } = await freshLedger();
    const reply = await handleServerRequest(
      get('/api/v0/sessions', TOKEN_A),
      context(ledger, { sessions: undefined }),
    );
    expect(reply.status).toBe(501);
  });

  it('lists a scope its own conversations, enriched from the store', async () => {
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const reply = await handleServerRequest(get('/api/v0/sessions', TOKEN_A), context(ledger));
    expect(reply.status).toBe(200);
    const body = reply.body as { sessions: { id: string; title: string; cwd: string }[] };
    expect(body.sessions.map((row) => row.id).sort()).toEqual(['sess-1', 'sess-2']);
    expect(body.sessions[0]?.cwd).toBe('/work/repo');
    expect(body.sessions.map((row) => row.title).sort()).toEqual([
      'First conversation',
      'Second conversation',
    ]);
  });

  it('shows the same history to a second token with the same pin', async () => {
    // The multi-device case this feature exists for: one person, one
    // directory, a token per laptop.
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const reply = await handleServerRequest(get('/api/v0/sessions', TOKEN_B), context(ledger));
    const body = reply.body as { sessions: { id: string }[] };
    expect(body.sessions).toHaveLength(2);
  });

  it('shows nothing to a token pinned elsewhere', async () => {
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const reply = await handleServerRequest(get('/api/v0/sessions', TOKEN_C), context(ledger));
    expect(reply.status).toBe(200);
    expect((reply.body as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it('never lists a session the ledger does not own', async () => {
    // The desktop user's own history: real in the store, absent from the
    // ledger. The store answers with it; the route must not.
    const { ledger } = await freshLedger();
    ledger.record({
      sessionId: 'sess-1',
      connectionId: LAPTOP_ONE.id,
      profileId: 'prof-a',
      workspaceKey: 'dir:/work/repo',
      cwd: '/work/repo',
    });
    const reply = await handleServerRequest(get('/api/v0/sessions', TOKEN_A), context(ledger));
    const body = reply.body as { sessions: { id: string }[] };
    // sess-2 exists in the store but was never recorded — invisible.
    expect(body.sessions.map((row) => row.id)).toEqual(['sess-1']);
  });
});

describe('GET /api/v0/sessions/{id}/messages', () => {
  it('replays an owned conversation', async () => {
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const reply = await handleServerRequest(
      get('/api/v0/sessions/sess-1/messages', TOKEN_A),
      context(ledger),
    );
    expect(reply.status).toBe(200);
    const body = reply.body as { events: { text?: string }[] };
    expect(body.events[0]?.text).toBe('stored text of sess-1');
  });

  it('answers the same 404 for absent and for foreign', async () => {
    // A token must not be able to sound out which ids exist.
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const absent = await handleServerRequest(
      get('/api/v0/sessions/no-such/messages', TOKEN_A),
      context(ledger),
    );
    const foreign = await handleServerRequest(
      get('/api/v0/sessions/sess-1/messages', TOKEN_C),
      context(ledger),
    );
    expect(absent.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(absent.body)).toBe(JSON.stringify(foreign.body));
  });
});

describe('the resume gate on chat completions', () => {
  function chat(sessionId: string, token: string) {
    return {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { host: '127.0.0.1:6472', authorization: `Bearer ${token}` },
      body: {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'continue' }],
        artemis: { sessionId },
      },
    };
  }

  it('refuses to resume a conversation outside the scope', async () => {
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const reply = await handleServerRequest(
      chat('sess-1', TOKEN_C),
      context(ledger, {
        // Present so the gate is the thing refusing, not the 501.
        runs: {} as never,
        workspaces: { resolve: async () => ({ path: '/work/other', ephemeral: false }) } as never,
      }),
    );
    expect(reply.status).toBe(404);
    expect(JSON.stringify(reply.body)).toContain('No such conversation');
  });

  it('refuses the desktop user\'s own sessions the same way', async () => {
    const { ledger } = await freshLedger();
    // Nothing recorded at all: the id names a conversation the person had in
    // that directory themselves. Structurally unreachable.
    const reply = await handleServerRequest(
      chat('the-users-private-session', TOKEN_A),
      context(ledger, {
        runs: {} as never,
        workspaces: { resolve: async () => ({ path: '/work/repo', ephemeral: false }) } as never,
      }),
    );
    expect(reply.status).toBe(404);
  });
});

describe('the ledger itself', () => {
  it('survives a restart, and migrates the v1 array to unowned entries', async () => {
    const { ledger, dir } = await freshLedger();
    ledger.record({
      sessionId: 'sess-x',
      connectionId: 'conn-a',
      profileId: 'prof-a',
      workspaceKey: 'dir:/work/repo',
      cwd: '/work/repo',
    });
    await ledger.flush();

    const stored = JSON.parse(await readFile(join(dir, 'serverSessions.json'), 'utf8')) as {
      version: number;
      entries: { sessionId: string }[];
    };
    expect(stored.version).toBe(2);
    expect(stored.entries[0]?.sessionId).toBe('sess-x');

    const reloaded = createSessionLedger(dir);
    await reloaded.load();
    expect(reloaded.has('sess-x')).toBe(true);
    expect(
      reloaded.mayAccess({ profileIds: ['prof-a'], workspaceKey: 'dir:/work/repo' }, 'sess-x'),
    ).toBe(true);
  });

  it('keeps v1 entries hidden from the sidebar and reachable by nobody', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artemis-ledger-v1-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const { writeFile } = await import('node:fs/promises');
    // The desktop's real v1 shape: `{ ids: [...] }`.
    await writeFile(join(dir, 'serverSessions.json'), JSON.stringify({ ids: ['old-1', 'old-2'] }), 'utf8');

    const ledger = createSessionLedger(dir);
    await ledger.load();
    expect(ledger.has('old-1')).toBe(true);
    // No recorded owner means no scope matches — a migration must not invent
    // an access grant.
    expect(
      ledger.mayAccess({ profileIds: ['prof-a'], workspaceKey: 'dir:/work/repo' }, 'old-1'),
    ).toBe(false);
    expect(
      ledger.listFor({ profileIds: ['prof-a'], workspaceKey: 'dir:/work/repo' }),
    ).toHaveLength(0);
  });

  it('scopes ephemeral workspaces to the connection that made them', async () => {
    const { ledger } = await freshLedger();
    ledger.record({
      sessionId: 'scratch-1',
      connectionId: 'conn-x',
      profileId: 'prof-a',
      workspaceKey: 'conn:conn-x',
      cwd: '/tmp/scratch/abc',
    });
    expect(
      ledger.mayAccess({ profileIds: ['prof-a'], workspaceKey: 'conn:conn-x' }, 'scratch-1'),
    ).toBe(true);
    expect(
      ledger.mayAccess({ profileIds: ['prof-a'], workspaceKey: 'conn:conn-y' }, 'scratch-1'),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The account that holds the conversation                                    */
/* -------------------------------------------------------------------------- */

/**
 * A second served account, with its own store.
 *
 * What the tests below are about: a transcript lives in exactly one account's
 * store, and the provider looks nowhere else. The ledger names an account,
 * the request names an account, and neither is guaranteed to be the one whose
 * store actually holds the file.
 */
const PROF_B: ServerProfile = {
  id: 'prof-b' as ServerProfile['id'],
  slug: 'other',
  label: 'Other',
  provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
  available: true,
  disabled: false,
  live: true,
  capabilities: NO_CAPABILITIES,
  models: [
    {
      route: 'other/opus',
      id: 'opus',
      label: 'Opus 5',
      note: 'The big one, elsewhere.',
      profileId: 'prof-b' as ServerProfile['id'],
      profileSlug: 'other',
      profileLabel: 'Other',
      providerId: 'claude',
      thinkingLevels: [],
      adaptiveThinking: false,
      fastMode: false,
      ultracode: false,
    },
  ],
};

const twoAccounts: Catalogue = {
  read: async () => [...PROFILES, PROF_B],
  invalidate: () => undefined,
};

/** prof-a's store holds sess-1 and sess-2 as above; prof-b's holds sess-3, in the same directory. */
const twoStores: SessionSource = {
  list: async (query) => {
    if (query.cwd !== '/work/repo') return { sessions: [], hasMore: false };
    if (query.profileId === 'prof-a') return sessionSource.list(query);
    if (query.profileId === 'prof-b') {
      return {
        sessions: [
          {
            id: 'sess-3' as never,
            providerId: 'claude' as never,
            profileId: 'prof-b' as never,
            cwd: '/work/repo',
            title: 'Held elsewhere',
            updatedAt: 333,
          },
        ],
        hasMore: false,
      };
    }
    return { sessions: [], hasMore: false };
  },
  messages: sessionSource.messages,
};

function recordAs(ledger: SessionLedger, sessionId: string, profileId: string): void {
  ledger.record({
    sessionId,
    connectionId: LAPTOP_ONE.id,
    profileId,
    workspaceKey: 'dir:/work/repo',
    cwd: '/work/repo',
  });
}

describe('a conversation the ledger files under the wrong account', () => {
  it('is listed under the account whose store holds it, and the ledger is corrected', async () => {
    const { ledger } = await freshLedger();
    // A resume sent on prof-a re-recorded sess-3 against it before the
    // provider refused; the transcript has been in prof-b's store all along.
    recordAs(ledger, 'sess-3', 'prof-a');

    const reply = await handleServerRequest(
      get('/api/v0/sessions', TOKEN_A),
      context(ledger, { catalogue: twoAccounts, sessions: twoStores }),
    );
    expect(reply.status).toBe(200);
    const body = reply.body as {
      sessions: { id: string; profileId?: string; profileSlug: string; title: string }[];
    };
    expect(body.sessions.map((row) => row.id)).toEqual(['sess-3']);
    expect(body.sessions[0]).toMatchObject({
      profileId: 'prof-b',
      profileSlug: 'other',
      title: 'Held elsewhere',
    });
    // Corrected in place, so the next listing needs no second pass.
    expect(ledger.get('sess-3')?.profileId).toBe('prof-b');
  });

  it('drops only a conversation no visible store holds', async () => {
    const { ledger } = await freshLedger();
    recordAs(ledger, 'sess-gone', 'prof-a');
    const reply = await handleServerRequest(
      get('/api/v0/sessions', TOKEN_A),
      context(ledger, { catalogue: twoAccounts, sessions: twoStores }),
    );
    expect((reply.body as { sessions: unknown[] }).sessions).toEqual([]);
    expect(ledger.get('sess-gone')?.profileId).toBe('prof-a');
  });

  it('keeps the ledger where the store it names agrees', async () => {
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    await handleServerRequest(
      get('/api/v0/sessions', TOKEN_A),
      context(ledger, { catalogue: twoAccounts, sessions: twoStores }),
    );
    expect(ledger.get('sess-1')?.profileId).toBe('prof-a');
  });
});

describe('resuming on the wrong account', () => {
  /** A run source that starts, says one thing, and ends — recording what it was asked. */
  function runsEndingWith(sessionId: string) {
    const listeners = new Set<(event: AgentEvent) => void>();
    const started: { profileId: string; model: string }[] = [];
    const source = {
      started,
      startRun: async (input: {
        providerId: string;
        profileId: string;
        cwd: string;
        model: string;
      }) => {
        started.push({ profileId: input.profileId, model: input.model });
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              type: 'text.complete',
              runId: 'run-1',
              seq: 0,
              ts: 0,
              messageId: 'm1',
              role: 'assistant',
              text: 'continued',
            } as unknown as AgentEvent);
            listener({
              type: 'run.end',
              runId: 'run-1',
              seq: 1,
              ts: 0,
              reason: 'completed',
              sessionId,
            } as unknown as AgentEvent);
          }
        });
        return {
          runId: 'run-1',
          providerId: input.providerId,
          profileId: input.profileId,
          cwd: input.cwd,
          status: 'working',
          capabilities: NO_CAPABILITIES,
          startedAt: 0,
        } as never;
      },
      subscribe: (listener: (event: AgentEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      interrupt: async () => undefined,
      respondToPermission: async () => undefined,
      disposeRun: async () => undefined,
    };
    return source;
  }

  function chatOn(route: string, sessionId: string) {
    return {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN_A}` },
      body: {
        model: route,
        messages: [{ role: 'user', content: 'continue' }],
        artemis: { sessionId },
      },
    };
  }

  const workspaces = {
    resolve: async () => ({ path: '/work/repo', ephemeral: false }),
  } as never;

  it('moves the run to the account holding the conversation, and says so', async () => {
    const { ledger } = await freshLedger();
    // The ledger is right; the column that sent this was left on prof-a.
    recordAs(ledger, 'sess-3', 'prof-b');
    const runs = runsEndingWith('sess-3');

    const reply = await handleServerRequest(
      chatOn('work-max/opus', 'sess-3'),
      context(ledger, {
        catalogue: twoAccounts,
        sessions: twoStores,
        runs: runs as never,
        workspaces,
      }),
    );
    expect(reply.status).toBe(200);
    expect(runs.started).toEqual([{ profileId: 'prof-b', model: 'opus' }]);
    const body = reply.body as {
      model: string;
      artemis: { redirected?: { from: string; to: string } };
    };
    expect(body.model).toBe('other/opus');
    expect(body.artemis.redirected).toEqual({
      from: 'work-max/opus',
      to: 'other/opus',
      profileId: 'prof-b',
      profileSlug: 'other',
      profileLabel: 'Other',
    });
    // Never re-recorded against the account that could not have opened it.
    expect(ledger.get('sess-3')?.profileId).toBe('prof-b');
  });

  it('follows the store when the ledger itself names the wrong account', async () => {
    const { ledger } = await freshLedger();
    // The clobber this repairs: a failed resume left the entry on prof-a.
    recordAs(ledger, 'sess-3', 'prof-a');
    const runs = runsEndingWith('sess-3');

    const reply = await handleServerRequest(
      // Sent on prof-b's route, which the ledger disagrees with. The store
      // settles it: prof-b holds the file, so the request stands and the
      // ledger is corrected by the run it records.
      chatOn('other/opus', 'sess-3'),
      context(ledger, {
        catalogue: twoAccounts,
        sessions: twoStores,
        runs: runs as never,
        workspaces,
      }),
    );
    expect(reply.status).toBe(200);
    expect(runs.started).toEqual([{ profileId: 'prof-b', model: 'opus' }]);
    expect(
      (reply.body as { artemis: { redirected?: unknown } }).artemis.redirected,
    ).toBeUndefined();
    expect(ledger.get('sess-3')?.profileId).toBe('prof-b');
  });

  it('leaves a resume alone when the requested account holds the conversation', async () => {
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const runs = runsEndingWith('sess-1');

    const reply = await handleServerRequest(
      chatOn('work-max/opus', 'sess-1'),
      context(ledger, {
        catalogue: twoAccounts,
        sessions: twoStores,
        runs: runs as never,
        workspaces,
      }),
    );
    expect(reply.status).toBe(200);
    expect(runs.started).toEqual([{ profileId: 'prof-a', model: 'opus' }]);
    expect(
      (reply.body as { artemis: { redirected?: unknown } }).artemis.redirected,
    ).toBeUndefined();
  });

  it('reports the redirect on the first chunk of a stream', async () => {
    const { ledger } = await freshLedger();
    recordAs(ledger, 'sess-3', 'prof-b');
    const runs = runsEndingWith('sess-3');
    const request = chatOn('work-max/opus', 'sess-3');
    const reply = await handleServerRequest(
      { ...request, body: { ...request.body, stream: true } },
      context(ledger, {
        catalogue: twoAccounts,
        sessions: twoStores,
        runs: runs as never,
        workspaces,
      }),
    );
    expect(reply.status).toBe(200);
    expect('stream' in reply).toBe(true);
    const chunks: string[] = [];
    for await (const piece of (reply as { stream: AsyncIterable<string> }).stream) {
      chunks.push(piece);
    }
    const first = chunks[0] ?? '';
    expect(first).toContain('"redirected"');
    expect(first).toContain('"to":"other/opus"');
  });
});

describe('correcting the ledger in place', () => {
  it('changes the account and keeps the order', async () => {
    const { ledger } = await freshLedger();
    recordAs(ledger, 'sess-1', 'prof-a');
    recordAs(ledger, 'sess-3', 'prof-a');
    recordAs(ledger, 'sess-2', 'prof-a');

    expect(ledger.reattribute('sess-3', 'prof-b')).toBe(true);
    expect(ledger.get('sess-3')?.profileId).toBe('prof-b');
    // Newest first, and sess-3 did not become the newest by being corrected.
    const scope = { workspaceKey: 'dir:/work/repo', profileIds: ['prof-a', 'prof-b'] };
    expect(ledger.listFor(scope).map((entry) => entry.sessionId)).toEqual([
      'sess-2',
      'sess-3',
      'sess-1',
    ]);
  });

  it('answers false for an absent entry, or one that already says so', async () => {
    const { ledger } = await freshLedger();
    recordAs(ledger, 'sess-1', 'prof-a');
    expect(ledger.reattribute('sess-1', 'prof-a')).toBe(false);
    expect(ledger.reattribute('no-such', 'prof-b')).toBe(false);
  });

  it('persists the correction', async () => {
    const { ledger, dir } = await freshLedger();
    recordAs(ledger, 'sess-1', 'prof-a');
    ledger.reattribute('sess-1', 'prof-b');
    await ledger.flush();
    const stored = JSON.parse(await readFile(join(dir, 'serverSessions.json'), 'utf8')) as {
      entries: { sessionId: string; profileId: string }[];
    };
    expect(stored.entries).toEqual([
      expect.objectContaining({ sessionId: 'sess-1', profileId: 'prof-b' }),
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Forking and rewinding over the wire                                        */
/* -------------------------------------------------------------------------- */

/** An account whose provider can fork and rewind, unlike prof-a's bare one. */
const PROF_C: ServerProfile = {
  id: 'prof-c' as ServerProfile['id'],
  slug: 'branchy',
  label: 'Branchy',
  provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
  available: true,
  disabled: false,
  live: true,
  capabilities: { ...NO_CAPABILITIES, forkSession: true, rewind: true },
  models: [
    {
      route: 'branchy/opus',
      id: 'opus',
      label: 'Opus 5',
      note: 'Can branch.',
      profileId: 'prof-c' as ServerProfile['id'],
      profileSlug: 'branchy',
      profileLabel: 'Branchy',
      providerId: 'claude',
      thinkingLevels: [],
      adaptiveThinking: false,
      fastMode: false,
      ultracode: false,
    },
  ],
};

const withBranchy: Catalogue = {
  read: async () => [...PROFILES, PROF_C],
  invalidate: () => undefined,
};

/** prof-c's store holds sess-9 in the pinned directory; prof-a's store is as above. */
const storeOfC: SessionSource = {
  list: async (query) =>
    query.profileId === 'prof-c' && query.cwd === '/work/repo'
      ? {
          sessions: [
            {
              id: 'sess-9' as never,
              providerId: 'claude' as never,
              profileId: 'prof-c' as never,
              cwd: '/work/repo',
              title: 'Branchable',
              updatedAt: 9,
            },
          ],
          hasMore: false,
        }
      : sessionSource.list(query),
  messages: sessionSource.messages,
};

/** A run source that ends at once with the session it is told, recording what it was asked. */
function scriptedRuns(sessionId: string) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const started: Record<string, unknown>[] = [];
  return {
    started,
    startRun: async (input: Record<string, unknown>) => {
      const { profileId, model, resumeSessionId, forkSession, rewindToMessageId } = input;
      started.push({
        profileId,
        model,
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        ...(forkSession === undefined ? {} : { forkSession }),
        ...(rewindToMessageId === undefined ? {} : { rewindToMessageId }),
      });
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({
            type: 'text.complete',
            runId: 'run-1',
            seq: 0,
            ts: 0,
            messageId: 'm1',
            role: 'assistant',
            text: 'branched',
          } as unknown as AgentEvent);
          listener({
            type: 'run.end',
            runId: 'run-1',
            seq: 1,
            ts: 0,
            reason: 'completed',
            sessionId,
          } as unknown as AgentEvent);
        }
      });
      return {
        runId: 'run-1',
        providerId: input['providerId'],
        profileId,
        cwd: input['cwd'],
        status: 'working',
        capabilities: NO_CAPABILITIES,
        startedAt: 0,
      } as never;
    },
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    interrupt: async () => undefined,
    respondToPermission: async () => undefined,
    disposeRun: async () => undefined,
  };
}

describe('forking and rewinding over the wire', () => {
  const workspaces = {
    resolve: async () => ({ path: '/work/repo', ephemeral: false }),
  } as never;

  function chatWith(route: string, artemis: Record<string, unknown>) {
    return {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN_A}` },
      body: {
        model: route,
        messages: [{ role: 'user', content: 'again, differently' }],
        artemis,
      },
    };
  }

  it('refuses a fork on an account whose provider cannot fork', async () => {
    const { ledger } = await freshLedger();
    seedOwnership(ledger);
    const runs = scriptedRuns('sess-1');
    const reply = await handleServerRequest(
      chatWith('work-max/opus', { sessionId: 'sess-1', forkSession: true }),
      context(ledger, { catalogue: withBranchy, sessions: storeOfC, runs: runs as never, workspaces }),
    );
    expect(reply.status).toBe(400);
    expect(JSON.stringify(reply.body)).toContain('cannot fork');
    // Refused before anything was spent.
    expect(runs.started).toEqual([]);
  });

  it('refuses a rewind with no conversation to cut', async () => {
    const { ledger } = await freshLedger();
    const runs = scriptedRuns('sess-new');
    const reply = await handleServerRequest(
      chatWith('branchy/opus', { rewindToMessageId: 'msg-7' }),
      context(ledger, { catalogue: withBranchy, sessions: storeOfC, runs: runs as never, workspaces }),
    );
    expect(reply.status).toBe(400);
    expect(JSON.stringify(reply.body)).toContain('artemis.sessionId');
    expect(runs.started).toEqual([]);
  });

  it('passes a fork and a rewind anchor to the run on a capable account', async () => {
    const { ledger } = await freshLedger();
    recordAs(ledger, 'sess-9', 'prof-c');
    const runs = scriptedRuns('sess-9-branch');
    const reply = await handleServerRequest(
      chatWith('branchy/opus', { sessionId: 'sess-9', forkSession: true, rewindToMessageId: 'msg-7' }),
      context(ledger, { catalogue: withBranchy, sessions: storeOfC, runs: runs as never, workspaces }),
    );
    expect(reply.status).toBe(200);
    expect(runs.started).toEqual([
      {
        profileId: 'prof-c',
        model: 'opus',
        resumeSessionId: 'sess-9',
        forkSession: true,
        rewindToMessageId: 'msg-7',
      },
    ]);
    // The branch the run announced is this connection's now, like any
    // conversation it starts — listable and resumable by the same token.
    expect(ledger.get('sess-9-branch')?.profileId).toBe('prof-c');
    expect(ledger.get('sess-9')?.profileId).toBe('prof-c');
  });
});
