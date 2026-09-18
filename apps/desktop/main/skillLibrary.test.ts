/**
 * The always-on choices on disk, against a real filesystem.
 *
 * The repair logic is the protocol's and is tested there; what this pins is
 * that the store runs it on both paths, that a read never creates or throws,
 * and that a save is atomic and serialised — the properties that are facts
 * about real files.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SKILL_LIBRARY_FILE, SkillLibraryStore } from './skillLibrary.js';

const sandboxes: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'artemis-skill-library-'));
  sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    rmSync(sandboxes.pop()!, { recursive: true, force: true });
  }
});

const ON = { version: 1 as const, alwaysOn: [{ name: 'unslop', scope: { kind: 'all' as const } }] };

describe('SkillLibraryStore', () => {
  it('reads a machine that has never switched anything on as nothing on', async () => {
    const dir = sandbox();

    expect(await new SkillLibraryStore({ userDataDir: dir }).read()).toEqual({ version: 1, alwaysOn: [] });
    // And does not create the file just by being read: it is on the path of
    // every run, on machines that will never open the pane.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('round-trips a save through a second store', async () => {
    const dir = sandbox();
    await new SkillLibraryStore({ userDataDir: dir }).write(ON);

    expect(await new SkillLibraryStore({ userDataDir: dir }).read()).toEqual(ON);
  });

  it('answers a save with what landed, which is what a read would produce', async () => {
    const store = new SkillLibraryStore({ userDataDir: sandbox() });

    const landed = await store.write({
      version: 1,
      alwaysOn: [
        { name: 'unslop', scope: { kind: 'all' } },
        { name: 'unslop', scope: { kind: 'profiles', profileIds: [] } },
      ],
    });

    expect(landed).toEqual(ON);
    expect(await store.read()).toEqual(ON);
  });

  it('reads a corrupt file as nothing on, instead of failing the run that asked', async () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, SKILL_LIBRARY_FILE), '{ not json');

    expect(await new SkillLibraryStore({ userDataDir: dir }).read()).toEqual({ version: 1, alwaysOn: [] });
  });

  it('does not remember a guess: the next read tries the file again', async () => {
    const dir = sandbox();
    const store = new SkillLibraryStore({ userDataDir: dir });
    writeFileSync(path.join(dir, SKILL_LIBRARY_FILE), '{ not json');
    expect(await store.read()).toEqual({ version: 1, alwaysOn: [] });

    // Fixed by hand, or a lock that lifted: the next run gets the real choices,
    // not the guess the first one had to make.
    writeFileSync(path.join(dir, SKILL_LIBRARY_FILE), JSON.stringify(ON));
    expect(await store.read()).toEqual(ON);
  });

  it('refuses the pane a file it cannot parse, rather than a guess it would save over', async () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, SKILL_LIBRARY_FILE), '{ not json');

    await expect(new SkillLibraryStore({ userDataDir: dir }).load()).rejects.toThrow(/not valid JSON/);
  });

  it('refuses the pane a file it cannot read, and runs still start', async () => {
    const dir = sandbox();
    // A directory where the file should be: unreadable as a file even to root,
    // which is what an unreadable file cannot be made to be in every sandbox.
    mkdirSync(path.join(dir, SKILL_LIBRARY_FILE));
    const store = new SkillLibraryStore({ userDataDir: dir });

    await expect(store.load()).rejects.toThrow(/Could not read/);
    expect(await store.read()).toEqual({ version: 1, alwaysOn: [] });
  });

  it('gives the pane an absent file as nothing on, like a run, without creating it', async () => {
    const dir = sandbox();

    expect(await new SkillLibraryStore({ userDataDir: dir }).load()).toEqual({ version: 1, alwaysOn: [] });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('leaves no temp file behind, and writes something a person can read', async () => {
    const dir = sandbox();
    await new SkillLibraryStore({ userDataDir: dir }).write(ON);

    expect(readdirSync(dir)).toEqual([SKILL_LIBRARY_FILE]);
    expect(readFileSync(path.join(dir, SKILL_LIBRARY_FILE), 'utf8')).toContain('\n  "alwaysOn": [');
  });

  it('serialises overlapping saves so the last switch thrown wins', async () => {
    const store = new SkillLibraryStore({ userDataDir: sandbox() });
    const off = { version: 1 as const, alwaysOn: [] };

    await Promise.all([store.write(ON), store.write(off), store.write(ON)]);

    expect(await store.read()).toEqual(ON);
  });

  it('answers a save with the skill’s name exactly as it was given', async () => {
    // The pane adopts this answer and matches rows by equality. A name that
    // came back tidied would read "off" on the real row and appear a second
    // time as a skill that is not on the machine.
    const store = new SkillLibraryStore({ userDataDir: sandbox() });

    const landed = await store.write({ version: 1, alwaysOn: [{ name: ' notes ', scope: { kind: 'all' } }] });

    expect(landed.alwaysOn.map((entry) => entry.name)).toEqual([' notes ']);
  });

  it('lets the pane and the main process each change their own half, and keeps both', async () => {
    // The pane saves switches and main adds sources, to one file. A
    // whole-document write from either would drop the other's half.
    const store = new SkillLibraryStore({ userDataDir: sandbox() });
    const url = 'https://github.com/david-systemtech/agent-skills.git';

    await Promise.all([
      store.update((current) => ({ ...current, alwaysOn: [{ name: 'unslop', scope: { kind: 'all' } }] })),
      store.update((current) => ({ ...current, sources: [{ id: 'ignored', url, subdir: 'skills' }] })),
      store.update((current) => ({ ...current, alwaysOn: [...current.alwaysOn, { name: 'tdd', scope: { kind: 'all' } }] })),
    ]);

    const landed = await store.read();
    expect(landed.alwaysOn.map((entry) => entry.name)).toEqual(['unslop', 'tdd']);
    expect(landed.sources?.map((source) => source.url)).toEqual([url]);
  });

  it('will not build a change on a file it could not read', async () => {
    // A change built on a guess would save the guess over the real file.
    const dir = sandbox();
    writeFileSync(path.join(dir, SKILL_LIBRARY_FILE), '{ not json');
    const store = new SkillLibraryStore({ userDataDir: dir });

    await expect(store.update((current) => ({ ...current, alwaysOn: [] }))).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(path.join(dir, SKILL_LIBRARY_FILE), 'utf8')).toBe('{ not json');
  });

  it('refuses a relative user-data directory', () => {
    expect(() => new SkillLibraryStore({ userDataDir: 'relative/path' })).toThrow();
  });
});
