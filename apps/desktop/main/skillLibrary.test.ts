/**
 * The always-on choices on disk, against a real filesystem.
 *
 * The repair logic is the protocol's and is tested there; what this pins is
 * that the store runs it on both paths, that a read never creates or throws,
 * and that a save is atomic and serialised — the properties that are facts
 * about real files.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('refuses a relative user-data directory', () => {
    expect(() => new SkillLibraryStore({ userDataDir: 'relative/path' })).toThrow();
  });
});
