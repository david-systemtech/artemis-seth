/**
 * Drafting, filing and landing, against real banks in temp directories and a
 * real git for the commit path. Nothing here reaches a network: the
 * pull-request path is exercised only up to the point a forge would be asked.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectForge } from '../forge.js';
import { readBankAt } from '../formats.js';
import { scoreEntry, searchBanks } from '../search.js';
import { draftMemory, placeFor, promoteBank, renderEntry, retireMemory } from '../writer.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'artemis-bank-writer-'));
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

/** A cortex-shaped bank with one project folder and one entry, committed. */
function projectsBank(): string {
  const dir = scratch();
  mkdirSync(join(dir, 'projects', 'personal', 'homelab', 'memories'), { recursive: true });
  writeFileSync(join(dir, 'cerebro.json'), JSON.stringify({ layout: 'projects', default_org: 'personal' }));
  writeFileSync(
    join(dir, 'projects', 'personal', 'homelab', 'memories', 'nas-paths.md'),
    '---\nname: nas-paths\ndescription: Before writing a path on the NAS\nmetadata:\n  type: reference\n  added: 2026-09-01\n  org: personal\n  project: homelab\n---\n\nUse /mnt/user, never /mnt/cache.\n',
  );
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

/** A manifest bank that lands by commit, brands-first. */
function commitBank(): string {
  const dir = scratch();
  mkdirSync(join(dir, 'brands', 'cool-jams', 'ads', 'memories'), { recursive: true });
  writeFileSync(
    join(dir, 'BANK.md'),
    '---\nname: brands\nmemories:\n  glob: brands/*/*/memories/**/*.md\n  scope: brands/{brand}/{system}/\nwrite:\n  place: brands/{brand}/{system}/memories/{name}.md\n  land: commit\n---\n\nInstructions.\n',
  );
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

describe('detectForge', () => {
  it('tells GitHub from Gitea by host, over https, http and scp remotes', () => {
    expect(detectForge('https://github.com/seth-torrence/artemis.git')).toEqual({
      kind: 'github', apiBase: 'https://api.github.com', host: 'github.com', scheme: 'https', owner: 'seth-torrence', repo: 'artemis',
    });
    expect(detectForge('git@github.com:david-systemtech/brandsolidate.git')).toMatchObject({ kind: 'github', owner: 'david-systemtech', repo: 'brandsolidate' });
    expect(detectForge('http://100.109.204.54:8300/david/cortex.git')).toEqual({
      kind: 'gitea', apiBase: 'http://100.109.204.54:8300/api/v1', host: '100.109.204.54:8300', scheme: 'http', owner: 'david', repo: 'cortex',
    });
    expect(detectForge('C:\\banks\\local')).toBeNull();
    expect(detectForge('/srv/git/bank.git')).toBeNull();
    expect(detectForge('nonsense')).toBeNull();
  });
});

describe('renderEntry and placeFor', () => {
  it('renders a cerebro entry the way the CLI does, quoting only what misreads', () => {
    const bank = readBankAt(projectsBank(), { slug: 'cortex' })!;
    const text = renderEntry(bank, {
      name: 'a-fact',
      description: 'When: this matters',
      body: 'Body.',
      metadata: { added: '2026-09-15', type: 'reference', org: 'personal', project: 'homelab' },
    });
    expect(text).toBe('---\nname: a-fact\ndescription: "When: this matters"\nmetadata:\n  type: reference\n  added: 2026-09-15\n  org: personal\n  project: homelab\n---\n\nBody.\n');
  });

  it('files by the bank\'s template and refuses a folder that does not exist', () => {
    const bank = readBankAt(projectsBank(), { slug: 'cortex' })!;
    expect(placeFor(bank, 'x', { org: 'personal', project: 'homelab' })).toEqual({ path: 'projects/personal/homelab/memories/x.md', problem: null });
    expect(placeFor(bank, 'x', { org: 'personal' }).problem).toContain('`project` not given');
    expect(placeFor(bank, 'x', { org: 'personal', project: 'nope' }).problem).toContain('never invent one');
    expect(placeFor(bank, 'x', { org: 'Bad', project: 'homelab' }).problem).toContain('kebab-case');
  });
});

describe('draftMemory', () => {
  it('queues a valid memory in inbox/ and names its destination', () => {
    const root = projectsBank();
    const bank = readBankAt(root, { slug: 'cortex' })!;
    const result = draftMemory(bank, {
      name: 'nas-backup-window',
      description: 'Before scheduling anything heavy on the NAS overnight',
      body: 'Backups run 02:00 to 04:00 on 2026-09-15 and every night after.',
      type: 'reference',
      scope: { org: 'personal', project: 'homelab' },
      today: '2026-09-15',
    });
    expect(result).toMatchObject({ ok: true, file: 'inbox/nas-backup-window.md', destination: 'projects/personal/homelab/memories/nas-backup-window.md', replaces: null });
    expect(readFileSync(join(root, 'inbox', 'nas-backup-window.md'), 'utf8')).toContain('type: reference');
  });

  it('refuses on a warning as well as an error, writing nothing', () => {
    const root = projectsBank();
    const bank = readBankAt(root, { slug: 'cortex' })!;
    const result = draftMemory(bank, {
      name: 'vague',
      description: 'x',
      body: 'Changed recently.',
      type: 'feedback',
      scope: { org: 'personal', project: 'homelab' },
    });
    expect(result.ok).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('relative date'), expect.stringContaining('**Why:**')]));
    expect(existsSync(join(root, 'inbox', 'vague.md'))).toBe(false);
  });

  it('says what it would replace when the name exists', () => {
    const bank = readBankAt(projectsBank(), { slug: 'cortex' })!;
    const result = draftMemory(bank, {
      name: 'nas-paths',
      description: 'Before writing a path on the NAS',
      body: 'Use /mnt/user.',
      type: 'reference',
      scope: { org: 'personal', project: 'homelab' },
    });
    expect(result.replaces).toBe('projects/personal/homelab/memories/nas-paths.md');
  });
});

describe('promoteBank and retireMemory by commit', () => {
  it('files the drafts, commits them, empties the inbox, and rejects a bad one beside them', async () => {
    const root = commitBank();
    const bank = readBankAt(root, { slug: 'brands' })!;
    const good = draftMemory(bank, {
      name: 'geo-rule',
      description: 'Before touching the geo firewall rule',
      body: 'It challenges non-US traffic, measured 2026-09-15.',
      type: 'reference',
      scope: { brand: 'cool-jams', system: 'ads' },
      today: '2026-09-15',
    });
    expect(good.ok).toBe(true);
    // A draft written by hand that the gate would refuse.
    writeFileSync(join(root, 'inbox', 'bad.md'), '---\nname: bad\ndescription: x\nmetadata:\n  type: novel\n---\n\nx\n');

    const result = await promoteBank(bank, { gitEnv: GIT_ENV });
    expect(result.landed).toEqual(['geo-rule']);
    expect(result.rejected).toEqual([{ name: 'bad', reasons: expect.arrayContaining([expect.stringContaining('type must be one of')]) }]);
    expect(result.outcome?.kind).toBe('commit');
    expect(existsSync(join(root, 'brands', 'cool-jams', 'ads', 'memories', 'geo-rule.md'))).toBe(true);
    expect(readdirSync(join(root, 'inbox'))).toEqual(['bad.md.rejected']);
    expect(git(root, 'log', '--oneline')).toContain('memory: add geo-rule');
    expect(git(root, 'status', '--porcelain', '-uall').trim()).toContain('inbox/bad.md.rejected');

    const after = readBankAt(root, { slug: 'brands' })!;
    const retired = await retireMemory(after, 'geo-rule', 'no longer true', { gitEnv: GIT_ENV });
    expect(retired.kind).toBe('commit');
    expect(existsSync(join(root, 'brands', 'cool-jams', 'ads', 'memories', 'geo-rule.md'))).toBe(false);
    expect(git(root, 'log', '--oneline')).toContain('memory: retire geo-rule (no longer true)');
    expect((await retireMemory(readBankAt(root, { slug: 'brands' })!, 'geo-rule', undefined, { gitEnv: GIT_ENV })).kind).toBe('nothing');
  });

  it('refuses to land anything for a bank that says land: none', async () => {
    const root = scratch();
    mkdirSync(join(root, 'memories'));
    writeFileSync(join(root, 'BANK.md'), '---\nname: ro\nwrite:\n  land: none\n---\n');
    const bank = readBankAt(root, { slug: 'ro' })!;
    draftMemory(bank, { name: 'x', description: 'When x', body: 'Fact, 2026-09-15.', type: 'reference' });
    const result = await promoteBank(bank);
    expect(result.outcome?.kind).toBe('nothing');
    expect(result.landed).toEqual([]);
  });
});

describe('search', () => {
  it('ranks name and description matches above body matches and returns snippets', () => {
    const bank = readBankAt(projectsBank(), { slug: 'cortex' })!;
    const [entry] = bank.entries;
    expect(scoreEntry(entry!, 'nas')).toBeGreaterThan(scoreEntry(entry!, 'cache'));
    expect(scoreEntry(entry!, 'unrelated words')).toBe(0);
    const hits = searchBanks([{ slug: 'cortex', bank }], 'mnt cache');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('/mnt/cache');
    expect(searchBanks([{ slug: 'cortex', bank }], 'nothing here at all')).toEqual([]);
  });
});
