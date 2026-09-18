/**
 * Keeping a skills repository cloned and current.
 *
 * Against real git and a real repository on disk standing in for the remote,
 * because every property worth having here is a fact about what git leaves
 * behind: that a rewritten history upstream still lands, that a sync that fails
 * costs nothing already held, that a clone that dies leaves no wreck to fetch
 * into, and that a busy hour is one fetch.
 *
 * Every case spawns git several times, which a loaded Windows runner does
 * slowly; the suite says how long it needs rather than inheriting five seconds.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { skillSourceIdFor, type SkillSource } from '@rx-artemis/protocol';

import {
  createSkillSources,
  skillSourceCloneDir,
  skillSourceSkillsDir,
  syncSkillSource,
} from './skillSources.js';

let root: string;
let upstream: string;
let dataDir: string;
let source: SkillSource;

/** git, as a person with a name: a fresh runner has no identity to commit under. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function writeSkill(name: string, body: string): void {
  mkdirSync(join(upstream, 'skills', name), { recursive: true });
  writeFileSync(join(upstream, 'skills', name, 'SKILL.md'), `---\ndescription: ${name}\n---\n${body}\n`);
}

function commit(message: string): void {
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '--quiet', '-m', message);
}

const skillsOnDisk = (): string[] => readdirSync(skillSourceSkillsDir(dataDir, source)).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'artemis-skill-sources-'));
  upstream = join(root, 'upstream');
  dataDir = join(root, 'data');
  mkdirSync(upstream, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  git(upstream, 'init', '--quiet', '--initial-branch=main');
  writeSkill('unslop', 'Edit text.');
  commit('One skill');

  // A `file:` URL rather than a bare path: git ignores `--depth` for a path,
  // and the shallow fetch is part of what is under test.
  const url = pathToFileURL(upstream).href;
  source = { id: skillSourceIdFor(url), url, subdir: 'skills' };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('syncSkillSource', { timeout: 60_000 }, () => {
  it('clones a source it has never seen, shallow, into a folder named for it', async () => {
    const result = await syncSkillSource({ source, dataDir });

    expect(result).toMatchObject({ ok: true, moved: true, detail: 'cloned' });
    expect(result.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(skillsOnDisk()).toEqual(['unslop']);
    expect(git(skillSourceCloneDir(dataDir, source), 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('brings the copy up to a new commit, and says it moved', async () => {
    await syncSkillSource({ source, dataDir });
    writeSkill('tdd', 'Test first.');
    commit('A second skill');

    const result = await syncSkillSource({ source, dataDir });

    expect(result).toMatchObject({ ok: true, moved: true });
    expect(skillsOnDisk()).toEqual(['tdd', 'unslop']);
    // And says so when there was nothing to bring.
    expect(await syncSkillSource({ source, dataDir })).toMatchObject({ ok: true, moved: false, detail: 'already up to date' });
  });

  it('follows an upstream whose history was rewritten, which a fast-forward cannot', async () => {
    // How a bad skill update is undone: the commit is taken back out and the
    // branch is pushed over. The undo has to reach every machine.
    writeSkill('mistake', 'Do the wrong thing.');
    commit('A bad update');
    await syncSkillSource({ source, dataDir });
    expect(skillsOnDisk()).toEqual(['mistake', 'unslop']);

    git(upstream, 'reset', '--quiet', '--hard', 'HEAD~1');
    writeSkill('tdd', 'Test first.');
    commit('What should have shipped');

    const result = await syncSkillSource({ source, dataDir });

    expect(result).toMatchObject({ ok: true, moved: true });
    expect(skillsOnDisk()).toEqual(['tdd', 'unslop']);
  });

  it('puts back a copy somebody edited, because it is a cache and not a checkout', async () => {
    await syncSkillSource({ source, dataDir });
    const file = join(skillSourceSkillsDir(dataDir, source), 'unslop', 'SKILL.md');
    writeFileSync(file, 'tampered');

    await syncSkillSource({ source, dataDir });

    expect(readFileSync(file, 'utf8')).toContain('Edit text.');
  });

  it('leaves nothing behind when a first clone fails', async () => {
    const gone: SkillSource = { ...source, url: pathToFileURL(join(root, 'no-such-repo')).href };

    const result = await syncSkillSource({ source: gone, dataDir });

    expect(result.ok).toBe(false);
    expect(result.detail.length).toBeGreaterThan(0);
    // No half-made folder for the next sync to fetch into, and no scratch one.
    expect(existsSync(join(dataDir, 'skill-sources')) ? readdirSync(join(dataDir, 'skill-sources')) : []).toEqual([]);
  });

  it('keeps the copy it has when a later sync fails', async () => {
    await syncSkillSource({ source, dataDir });
    rmSync(upstream, { recursive: true, force: true });

    const result = await syncSkillSource({ source, dataDir });

    expect(result.ok).toBe(false);
    // A machine that is offline, or a repository that moved, keeps its skills.
    expect(skillsOnDisk()).toEqual(['unslop']);
  });
});

describe('a host’s sources', { timeout: 60_000 }, () => {
  it('names each source’s skills folder for the content bridge', () => {
    const sources = createSkillSources({ dataDir });

    expect(sources.roots([source])).toEqual([{ id: source.id, dir: skillSourceSkillsDir(dataDir, source) }]);
  });

  it('reports a source that has not synced yet as not there, not as broken', async () => {
    const sources = createSkillSources({ dataDir });

    expect(await sources.status([source])).toEqual([{ source, cloned: false, skillCount: 0 }]);
  });

  it('reports the commit, the count and when, once it has', async () => {
    const sources = createSkillSources({ dataDir, now: () => 1_000 });
    await sources.sync(source);

    const [status] = await sources.status([source]);

    expect(status).toMatchObject({ source, cloned: true, skillCount: 1, syncedAt: 1_000 });
    expect(status?.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(status?.error).toBeUndefined();
  });

  it('fetches a busy source once, however many runs start', async () => {
    let clock = 0;
    const sources = createSkillSources({ dataDir, now: () => clock, throttleMs: 10_000 });
    await sources.sync(source);
    writeSkill('tdd', 'Test first.');
    commit('A second skill');

    clock = 5_000;
    expect(await sources.sync(source)).toMatchObject({ ok: true, moved: false, detail: 'synced recently' });
    expect(skillsOnDisk()).toEqual(['unslop']);

    // "Pull now" is a person asking, and is not made to wait out the throttle.
    expect(await sources.sync(source, { force: true })).toMatchObject({ ok: true, moved: true });
    expect(skillsOnDisk()).toEqual(['tdd', 'unslop']);

    // And the throttle lapses by itself.
    writeSkill('teach', 'Explain it.');
    commit('A third skill');
    clock = 20_000;
    expect(await sources.sync(source)).toMatchObject({ ok: true, moved: true });
  });

  it('joins a sync already in flight rather than cloning twice', async () => {
    const sources = createSkillSources({ dataDir });

    const [first, second] = await Promise.all([sources.sync(source), sources.sync(source)]);

    expect(first).toBe(second);
    expect(first).toMatchObject({ ok: true, detail: 'cloned' });
  });

  it('remembers why a sync failed, and keeps counting the copy it still has', async () => {
    let clock = 0;
    const sources = createSkillSources({ dataDir, now: () => clock, throttleMs: 10 });
    await sources.sync(source);
    rmSync(upstream, { recursive: true, force: true });
    clock = 1_000;

    expect((await sources.sync(source)).ok).toBe(false);
    const [status] = await sources.status([source]);

    expect(status).toMatchObject({ cloned: true, skillCount: 1, syncedAt: 0 });
    expect(status?.error?.length).toBeGreaterThan(0);
  });

  it('reports a failed background sync where it was told to, and never throws', async () => {
    const warnings: string[] = [];
    const sources = createSkillSources({ dataDir, onWarning: (message) => warnings.push(message) });
    const gone: SkillSource = { ...source, url: pathToFileURL(join(root, 'no-such-repo')).href };

    sources.syncInBackground([gone]);
    await sources.sync(gone);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(gone.url);
  });

  it('deletes a removed source’s copy, and forgets how its last sync went', async () => {
    const sources = createSkillSources({ dataDir });
    await sources.sync(source);

    await sources.remove(source);

    expect(existsSync(skillSourceCloneDir(dataDir, source))).toBe(false);
    expect(await sources.status([source])).toEqual([{ source, cloned: false, skillCount: 0 }]);
  });
});
