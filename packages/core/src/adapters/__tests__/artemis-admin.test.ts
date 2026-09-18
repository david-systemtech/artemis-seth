/**
 * Administering a remote Artemis: what the laptop sends, and what it makes of
 * the answers.
 *
 * The server end of this contract is pinned in `server/__tests__/http.test.ts`;
 * these are the client half. Three things are worth holding still, and none of
 * them is the happy path:
 *
 *  - **The address and the token.** Both come from the profile's environment,
 *    through the same two helpers a *run* uses. A second derivation here would
 *    be a second place for the address to be wrong.
 *  - **404 is an answer, not a fault.** The server refuses to distinguish "no
 *    flow here" from "your connection may not ask", so both arrive as nothing
 *    to show — and a poller that threw on it would fill the screen with banners
 *    for the ordinary case.
 *  - **The server's own sentence reaches the user.** A duplicate label the
 *    caller cannot see is the whole of what they need to correct.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cancelRemoteSignIn,
  createRemoteAccount,
  readRemoteAccounts,
  addRemoteSkillSource,
  readRemoteMemoryBanks,
  readRemoteSignIn,
  readRemoteSkills,
  removeRemoteSkillSource,
  syncRemoteSkillSources,
  setRemoteMemoryBankScope,
  submitRemoteSignInCode,
} from '../artemis/admin.js';

const ENV = {
  ARTEMIS_LOCAL_BASE_URL: 'http://server.tail:6472/',
  ARTEMIS_LOCAL_API_KEY: 'tok-123',
};

interface Seen {
  readonly url: string;
  readonly method: string | undefined;
  readonly auth: string | undefined;
  readonly body: string | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Answer every request from a path → body table, recording what was asked. */
function stubFetch(answer: (path: string) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method,
        auth: (init?.headers as Record<string, string> | undefined)?.['authorization'],
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return answer(new URL(String(url)).pathname);
    }),
  );
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readRemoteAccounts', () => {
  it('asks both questions at once, with the profile token', async () => {
    // Two answers in one round trip because they are one question on screen:
    // may I show this at all, and what is already here?
    const seen = stubFetch((path) =>
      path.endsWith('/connection')
        ? jsonResponse({ id: 'c1', manageProfiles: true })
        : jsonResponse({ object: 'artemis.profiles', profiles: [{ id: 'p1', label: 'work' }] }),
    );

    const answer = await readRemoteAccounts(ENV);

    expect(answer.manageProfiles).toBe(true);
    expect(answer.profiles).toHaveLength(1);
    // The trailing slash on the base URL is stripped: `//api/v0/…` is a 404
    // that reads as a missing route.
    expect(seen.map((call) => call.url).sort()).toEqual([
      'http://server.tail:6472/api/v0/connection',
      'http://server.tail:6472/api/v0/profiles',
    ]);
    expect(seen.every((call) => call.auth === 'Bearer tok-123')).toBe(true);
  });

  it('reads a server that has never heard of the grant as not granting it', async () => {
    // An older server sends nothing here. A missing field must land as "no",
    // or the UI offers an administrative surface the server then 404s.
    stubFetch((path) =>
      path.endsWith('/connection')
        ? jsonResponse({ id: 'c1' })
        : jsonResponse({ object: 'artemis.profiles', profiles: [] }),
    );

    expect((await readRemoteAccounts(ENV)).manageProfiles).toBe(false);
  });
});

describe('readRemoteMemoryBanks', () => {
  it('asks both questions at once, and reports the accounts a scope may name', async () => {
    const seen = stubFetch((path) =>
      path.endsWith('/connection')
        ? jsonResponse({ id: 'c1', manageProfiles: true })
        : jsonResponse({
            object: 'artemis.memory-banks',
            banks: [
              {
                slug: 'cortex',
                path: '/data/banks/cortex',
                role: 'readwrite',
                enabled: true,
                profiles: { kind: 'all' },
              },
            ],
            profiles: [{ id: 'p1', slug: 'work', label: 'Work' }],
          }),
    );

    const answer = await readRemoteMemoryBanks(ENV);

    expect(answer).toMatchObject({ manageProfiles: true, available: true });
    expect(answer.banks.map((bank) => bank.slug)).toEqual(['cortex']);
    // The labels come with the ids, because a list of opaque ids is not a
    // checklist anybody can tick.
    expect(answer.profiles).toEqual([{ id: 'p1', slug: 'work', label: 'Work' }]);
    expect(seen.map((call) => call.url).sort()).toEqual([
      'http://server.tail:6472/api/v0/connection',
      'http://server.tail:6472/api/v0/memory-banks',
    ]);
  });

  it('reads a refusal or a missing route as nothing to edit, not as a fault', async () => {
    /*
     * 404 is what an older server, a build with no registry, and a token
     * without the grant all get — the server refuses to tell them apart on
     * purpose — and 501 is what an administrator gets from a build that serves
     * accounts and keeps no banks. All three mean the pane renders nothing, and
     * a throw here would put a banner on a settings screen somebody merely
     * opened.
     */
    for (const status of [404, 501]) {
      stubFetch((path) =>
        path.endsWith('/connection')
          ? jsonResponse({ id: 'c1', manageProfiles: true })
          : jsonResponse({ error: { message: 'no' } }, status),
      );
      const answer = await readRemoteMemoryBanks(ENV);
      expect(answer.available).toBe(false);
      expect(answer.banks).toEqual([]);
      vi.unstubAllGlobals();
    }
  });
});

describe('setRemoteMemoryBankScope', () => {
  it('PATCHes the whole scope, with the slug on the path', async () => {
    // Whole rather than a diff: a client that has just drawn a checklist sends
    // what the checklist says, and two clients editing at once cannot
    // interleave into a scope neither asked for.
    const seen = stubFetch(() =>
      jsonResponse({
        object: 'artemis.memory-bank',
        bank: {
          slug: 'cortex',
          path: '/data/banks/cortex',
          role: 'readwrite',
          enabled: true,
          profiles: { kind: 'profiles', profileIds: ['p1'] },
        },
      }),
    );

    const answer = await setRemoteMemoryBankScope(ENV, 'cortex', {
      kind: 'profiles',
      profileIds: ['p1'],
    });

    expect(answer.bank.profiles).toEqual({ kind: 'profiles', profileIds: ['p1'] });
    expect(seen[0]?.method).toBe('PATCH');
    expect(seen[0]?.url).toBe('http://server.tail:6472/api/v0/memory-banks/cortex');
    expect(seen[0]?.body).toBe('{"profiles":{"kind":"profiles","profileIds":["p1"]}}');
  });
});

describe('createRemoteAccount', () => {
  it('posts the label and hands back where the credential will live', async () => {
    const seen = stubFetch(() =>
      jsonResponse({
        object: 'artemis.profile',
        id: 'p2',
        label: 'work',
        providerId: 'claude',
        configDir: '/data/profiles/work',
      }),
    );

    const created = await createRemoteAccount(ENV, { label: 'work' });

    expect(created.configDir).toBe('/data/profiles/work');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toBe(JSON.stringify({ label: 'work' }));
  });

  it('passes the server’s own refusal through', async () => {
    // The caller holds the administrative grant and is creating a thing on
    // their own machine; "the request failed" leaves them with nothing to
    // correct.
    stubFetch(() =>
      jsonResponse(
        { error: { message: 'An account called "work" already exists on this server.' } },
        409,
      ),
    );

    await expect(createRemoteAccount(ENV, { label: 'work' })).rejects.toThrow(/already exists/);
  });
});

describe('the sign-in calls', () => {
  it('encodes the account id into the path', async () => {
    const seen = stubFetch(() =>
      jsonResponse({ object: 'artemis.signin', state: 'starting', profileId: 'a/b' }),
    );

    await readRemoteSignIn(ENV, 'a/b');
    expect(seen[0]?.url).toBe('http://server.tail:6472/api/v0/profiles/a%2Fb/signin');
  });

  it('reads a 404 as nothing to show rather than as a fault', async () => {
    stubFetch(() => jsonResponse({ error: { message: 'No sign-in is in progress.' } }, 404));

    expect(await readRemoteSignIn(ENV, 'p1')).toBeNull();
    expect(await cancelRemoteSignIn(ENV, 'p1')).toBeNull();
  });

  it('sends the code as a body and nowhere else', async () => {
    // Not in the path, not in a query string — either would put a single-use
    // secret in every access log between here and the container.
    const seen = stubFetch(() =>
      jsonResponse({ object: 'artemis.signin', state: 'completing', profileId: 'p1' }),
    );

    await submitRemoteSignInCode(ENV, 'p1', 'S3CR3T');

    expect(seen[0]?.url).toBe('http://server.tail:6472/api/v0/profiles/p1/signin/code');
    expect(seen[0]?.url).not.toContain('S3CR3T');
    expect(seen[0]?.body).toBe(JSON.stringify({ code: 'S3CR3T' }));
  });

  it('names the address when nothing is answering', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    await expect(readRemoteSignIn(ENV, 'p1')).rejects.toThrow(/server\.tail:6472/);
  });
});

describe('a server’s skills', () => {
  const BODY = {
    object: 'artemis.skills',
    skills: [
      {
        name: 'unslop',
        description: 'De-slop prose.',
        origin: { kind: 'machine' },
        dir: '/data/agent/.agents/skills/unslop',
        modelInvocable: true,
        userInvocable: true,
        bodyChars: 6100,
      },
    ],
    sources: [],
    profiles: [{ id: 'p1', slug: 'work', label: 'Work' }],
    manage: true,
  };

  it('reads what the server carries, and whether this token may change it', async () => {
    const seen = stubFetch(() => jsonResponse(BODY));
    const remote = await readRemoteSkills(ENV);
    expect(seen).toMatchObject([{ url: 'http://server.tail:6472/api/v0/skills', auth: 'Bearer tok-123' }]);
    expect(remote).toMatchObject({ available: true, manage: true, profiles: [{ label: 'Work' }] });
    expect(remote.skills.map((skill) => skill.name)).toEqual(['unslop']);
  });

  it('treats a server with no such surface as one that carries nothing, not as a fault', async () => {
    // An older server answers 404 and a host with no skills 501. Neither is a
    // banner: the pane says the server cannot, and the names it sends go unread.
    for (const status of [404, 501]) {
      stubFetch(() => jsonResponse({ error: { message: 'no' } }, status));
      expect(await readRemoteSkills(ENV)).toEqual({
        available: false,
        manage: false,
        skills: [],
        sources: [],
        profiles: [],
      });
    }
  });

  it('adds, pulls and removes through the routes, and answers with the state each one returns', async () => {
    const seen = stubFetch(() => jsonResponse(BODY));
    await addRemoteSkillSource(ENV, { url: 'https://github.com/demo/agent-skills', subdir: 'skills' });
    await syncRemoteSkillSources(ENV);
    await syncRemoteSkillSources(ENV, 'agent skills/1');
    const after = await removeRemoteSkillSource(ENV, 'agent-skills-1a2b3c4d');

    expect(seen.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ['POST', '/api/v0/skills/sources'],
      ['POST', '/api/v0/skills/sync'],
      // An id is a path segment, so it is encoded as one.
      ['POST', '/api/v0/skills/sources/agent%20skills%2F1/sync'],
      ['DELETE', '/api/v0/skills/sources/agent-skills-1a2b3c4d'],
    ]);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      url: 'https://github.com/demo/agent-skills',
      subdir: 'skills',
    });
    expect(after.available).toBe(true);
  });

  it('passes the server’s own sentence on when a write is refused', async () => {
    stubFetch(() =>
      jsonResponse({ error: { message: 'This connection may read the skills on this server but not change its repositories.' } }, 403),
    );
    await expect(addRemoteSkillSource(ENV, { url: 'https://github.com/demo/agent-skills' })).rejects.toThrow(
      /may read the skills on this server but not change/,
    );
  });
});
