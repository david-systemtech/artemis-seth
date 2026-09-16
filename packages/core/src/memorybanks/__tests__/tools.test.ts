/**
 * The memory tools, driven through their handlers against a real bank and a
 * real registry in temp directories. The commit landing is exercised with a
 * real git; nothing reaches a network.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REGISTRY_V2_FILE } from '../registryV2.js';
import { loadRunBanks, memoryTools, MEMORY_TOOL_SERVER, memoryToolServer } from '../tools.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'artemis-bank-tools-'));
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
};

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: GIT_ENV });
}

function commitBank(): string {
  const dir = scratch();
  mkdirSync(join(dir, 'brands', 'cool-jams', 'ads', 'memories'), { recursive: true });
  writeFileSync(
    join(dir, 'BANK.md'),
    '---\nname: brands\ndescription: The brands.\nmemories:\n  glob: brands/*/*/memories/**/*.md\n  scope: brands/{brand}/{system}/\nwrite:\n  place: brands/{brand}/{system}/memories/{name}.md\n  land: commit\n---\n',
  );
  writeFileSync(
    join(dir, 'brands', 'cool-jams', 'ads', 'memories', 'geo-rule.md'),
    '---\nname: geo-rule\ndescription: Before touching the geo firewall rule\nmetadata:\n  type: reference\n  added: 2026-09-15\n---\n\nIt challenges non-US traffic.\n',
  );
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

function registryFor(bank: string, profiles: unknown): string {
  const dataDir = scratch();
  writeFileSync(
    join(dataDir, REGISTRY_V2_FILE),
    JSON.stringify({ version: 2, banks: [{ slug: 'brands', path: bank, role: 'readwrite', enabled: true, profiles }], default: 'brands' }),
  );
  return dataDir;
}

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

function handlers(options: Parameters<typeof memoryTools>[0]): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  for (const definition of memoryTools(options)) {
    out[definition.name] = definition.handler as unknown as Handler;
  }
  return out;
}

const NOWHERE = join(scratch(), 'none');

describe('the memory tools', () => {
  it('builds a server under the addressed name with five tools', () => {
    const server = memoryToolServer({ dataDir: scratch(), cliRegistryPath: NOWHERE });
    expect(server.type).toBe('sdk');
    expect(server.name).toBe(MEMORY_TOOL_SERVER);
    expect(Object.keys(handlers({ dataDir: scratch(), cliRegistryPath: NOWHERE })).sort()).toEqual([
      'memory_draft', 'memory_promote', 'memory_read', 'memory_retire', 'memory_search',
    ]);
  });

  it('offers only the banks the run\'s profile carries', () => {
    const bank = commitBank();
    const dataDir = registryFor(bank, { kind: 'profiles', profileIds: ['work'] });
    expect(loadRunBanks({ dataDir, cliRegistryPath: NOWHERE, profileId: 'work' }).map(({ record }) => record.slug)).toEqual(['brands']);
    expect(loadRunBanks({ dataDir, cliRegistryPath: NOWHERE, profileId: 'home' })).toEqual([]);
  });

  it('searches, reads, drafts, promotes and retires against a commit-landing bank', async () => {
    const bank = commitBank();
    const dataDir = registryFor(bank, { kind: 'all' });
    const tools = handlers({ dataDir, cliRegistryPath: NOWHERE, profileId: 'p', landing: { gitEnv: GIT_ENV }, today: () => '2026-09-15' });

    const found = await tools['memory_search']!({ query: 'geo firewall' }, {});
    expect(found.isError).toBeUndefined();
    expect(found.content[0]?.text).toContain('brands/geo-rule [brand=cool-jams system=ads]');

    const read = await tools['memory_read']!({ name: 'geo-rule' }, {});
    expect(read.content[0]?.text).toContain('It challenges non-US traffic.');
    expect((await tools['memory_read']!({ name: 'missing' }, {})).isError).toBe(true);

    const refused = await tools['memory_draft']!({ name: 'bad name', description: 'x', body: 'y', type: 'reference' }, {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('kebab-case');
    expect(refused.content[0]?.text).toContain('files by brand, then system');

    const queued = await tools['memory_draft']!(
      { name: 'bot-fight-mode', description: 'Before turning Bot Fight Mode on for cool-jams', body: 'It blocks the AI crawlers we want, measured 2026-09-15.', type: 'reference', scope: { brand: 'cool-jams', system: 'ads' } },
      {},
    );
    expect(queued.isError).toBeUndefined();
    expect(queued.content[0]?.text).toContain('Queued inbox/bot-fight-mode.md in brands');

    const promoted = await tools['memory_promote']!({}, {});
    expect(promoted.isError).toBeUndefined();
    expect(promoted.content[0]?.text).toContain('Landed bot-fight-mode: committed');
    expect(existsSync(join(bank, 'brands', 'cool-jams', 'ads', 'memories', 'bot-fight-mode.md'))).toBe(true);

    const again = await tools['memory_search']!({ query: 'crawlers' }, {});
    expect(again.content[0]?.text).toContain('bot-fight-mode');

    const retired = await tools['memory_retire']!({ name: 'bot-fight-mode', reason: 'test' }, {});
    expect(retired.isError).toBeUndefined();
    expect(existsSync(join(bank, 'brands', 'cool-jams', 'ads', 'memories', 'bot-fight-mode.md'))).toBe(false);

    const empty = await tools['memory_promote']!({}, {});
    expect(empty.content[0]?.text).toContain('Nothing queued');
  });

  it('refuses a write into a read-only bank, and names the banks when several could take it', async () => {
    const one = commitBank();
    const two = commitBank();
    const dataDir = scratch();
    writeFileSync(
      join(dataDir, REGISTRY_V2_FILE),
      JSON.stringify({
        version: 2,
        banks: [
          { slug: 'ro', path: one, role: 'readonly', enabled: true, profiles: { kind: 'all' } },
          { slug: 'a', path: one, role: 'readwrite', enabled: true, profiles: { kind: 'all' } },
          { slug: 'b', path: two, role: 'readwrite', enabled: true, profiles: { kind: 'all' } },
        ],
      }),
    );
    const tools = handlers({ dataDir, cliRegistryPath: NOWHERE });
    const ambiguous = await tools['memory_draft']!({ name: 'x', description: 'When x', body: 'Fact.', type: 'reference' }, {});
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0]?.text).toContain('several banks reach this run');
    const readonly = await tools['memory_draft']!({ name: 'x', description: 'When x', body: 'Fact.', type: 'reference', bank: 'ro' }, {});
    expect(readonly.isError).toBe(true);
    expect(readonly.content[0]?.text).toContain('no writable bank called ro');
  });
});
