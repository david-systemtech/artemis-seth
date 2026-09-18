/**
 * `GET /api/v0/commands`: the slash commands a served session would offer.
 *
 * What is pinned: the union is over the accounts the connection can see and
 * only those; the per-account rows say which account offers what; the host is
 * asked in the directory a turn here would run in; a filter that names nothing
 * is a 404 rather than an empty list; one account's failure costs its rows and
 * not the menu; and a build without the seam says so with a 501 and leaves the
 * route off its index. The names themselves are the host's business.
 */

import { describe, expect, it } from 'vitest';

import type { ServerConnection, ServerProfile } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { Catalogue } from '../catalogue.js';
import { handleServerRequest, type CommandSource } from '../http.js';

const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz';
const CONNECTION: ServerConnection = {
  id: 'conn-1',
  label: 'Test',
  workspace: { kind: 'directory', path: '/w' },
  token: TOKEN,
  createdAt: 0,
};

const profile = (id: string, slug: string, label: string): ServerProfile => ({
  id: id as ServerProfile['id'],
  slug,
  label,
  provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
  available: true,
  disabled: false,
  live: true,
  capabilities: NO_CAPABILITIES,
  models: [],
});

const PROFILES: readonly ServerProfile[] = [
  profile('prof-a', 'work', 'Work'),
  profile('prof-b', 'personal', 'Personal'),
];

const catalogue: Catalogue = { read: async () => PROFILES, invalidate: () => undefined };

function ask(
  url: string,
  commands?: CommandSource,
  connection: ServerConnection = CONNECTION,
): ReturnType<typeof handleServerRequest> {
  return handleServerRequest(
    { method: 'GET', url, headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` } },
    {
      connections: [connection],
      version: '1',
      catalogue,
      startedAt: 0,
      ...(commands === undefined ? {} : { commands }),
    },
  );
}

/** A source that answers per account and records what it was asked. */
function source(answers: Readonly<Record<string, readonly string[]>>) {
  const asked: { readonly profileId: string; readonly providerId: string; readonly cwd?: string }[] = [];
  const commands: CommandSource = {
    list: async (query) => {
      asked.push(query);
      const answer = answers[query.profileId];
      if (answer === undefined) throw new Error('this account cannot be read');
      return answer;
    },
  };
  return { commands, asked };
}

describe('the commands route', () => {
  it('answers the union across the visible accounts, and each account’s own rows', async () => {
    const { commands, asked } = source({
      'prof-a': ['compact', 'artemis-skills:unslop'],
      'prof-b': ['compact', 'artemis-skills:code-review'],
    });

    const reply = await ask('/api/v0/commands', commands);

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      object: 'artemis.commands',
      commands: ['compact', 'artemis-skills:unslop', 'artemis-skills:code-review'],
      accounts: [
        {
          profileId: 'prof-a',
          profileSlug: 'work',
          profileLabel: 'Work',
          providerId: 'claude',
          commands: ['compact', 'artemis-skills:unslop'],
        },
        {
          profileId: 'prof-b',
          profileSlug: 'personal',
          profileLabel: 'Personal',
          providerId: 'claude',
          commands: ['compact', 'artemis-skills:code-review'],
        },
      ],
    });
    // Asked in the directory a turn on this connection would run in.
    expect(asked.map((query) => query.cwd)).toEqual(['/w', '/w']);
  });

  it('narrows to one account by slug or by id, and 404s a name it does not serve', async () => {
    const { commands, asked } = source({ 'prof-a': ['a'], 'prof-b': ['b'] });

    expect((await ask('/api/v0/commands?profile=personal', commands)).body).toMatchObject({
      commands: ['b'],
    });
    expect((await ask('/api/v0/commands?profile=prof-a', commands)).body).toMatchObject({
      commands: ['a'],
    });
    // One reading each — the other account was never opened.
    expect(asked.map((query) => query.profileId)).toEqual(['prof-b', 'prof-a']);

    const missing = await ask('/api/v0/commands?profile=nobody', commands);
    expect(missing.status).toBe(404);
    expect(JSON.stringify(missing.body)).toContain('nobody');
  });

  it('names no directory for a connection that runs in a scratch one', async () => {
    const { commands, asked } = source({ 'prof-a': [], 'prof-b': [] });

    await ask('/api/v0/commands', commands, {
      ...CONNECTION,
      workspace: { kind: 'ephemeral', perSession: true },
    });

    expect(asked).toHaveLength(2);
    expect(asked.every((query) => query.cwd === undefined)).toBe(true);
  });

  it('keeps the other accounts’ rows when one account cannot be read', async () => {
    const { commands } = source({ 'prof-a': ['a'] });

    const reply = await ask('/api/v0/commands', commands);

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      commands: ['a'],
      accounts: [
        { profileId: 'prof-a', commands: ['a'] },
        { profileId: 'prof-b', commands: [] },
      ],
    });
  });

  it('answers 501 from a build without the seam, and lists the route only when it has one', async () => {
    expect((await ask('/api/v0/commands')).status).toBe(501);

    const paths = async (commands?: CommandSource): Promise<readonly string[]> => {
      const body = (await ask('/', commands)).body as { endpoints: readonly { path: string }[] };
      return body.endpoints.map((entry) => entry.path);
    };
    expect(await paths()).not.toContain('/api/v0/commands');
    expect(await paths(source({}).commands)).toContain('/api/v0/commands');
  });
});
