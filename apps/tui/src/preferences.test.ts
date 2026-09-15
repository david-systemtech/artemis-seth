/**
 * What the terminal remembers between launches.
 *
 * Reported as: reopening it means setting the account, the model and the mode
 * again. These pin the two rules that answer it — what is written down is
 * read back, and a model is remembered against the account that can actually
 * run it — plus the one that keeps a bad file from being a bad launch.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PreferencesStore, tuiStateDir } from './preferences.js';

const home = sep === '\\' ? 'C:\\Users\\ada' : '/home/ada';

describe('tuiStateDir', () => {
  it('is the state directory, not the cache one, on each platform', () => {
    // Losing a cache costs a slow launch; losing this costs the user their
    // settings, so it must not sit where a cleaner sweeps caches.
    expect(tuiStateDir({ platform: 'linux', home, env: {} })).toBe(join(home, '.local', 'state', 'artemis', 'tui'));
    expect(tuiStateDir({ platform: 'linux', home, env: { XDG_STATE_HOME: '/state' } })).toBe(join('/state', 'artemis', 'tui'));
    expect(tuiStateDir({ platform: 'darwin', home, env: {} })).toBe(
      join(home, 'Library', 'Application Support', 'Artemis', 'tui'),
    );
    expect(tuiStateDir({ platform: 'win32', home, env: { APPDATA: 'D:\\Roaming' } })).toBe(join('D:\\Roaming', 'Artemis', 'tui'));
  });

  it('lets ARTEMIS_TUI_STATE_DIR override everything', () => {
    // Already absolute, so resolving it is the identity — on either platform.
    const elsewhere = sep === '\\' ? 'D:\\elsewhere' : '/elsewhere';
    expect(tuiStateDir({ platform: 'linux', home, env: { ARTEMIS_TUI_STATE_DIR: elsewhere } })).toBe(elsewhere);
  });
});

describe('PreferencesStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'artemis-tui-prefs-')), 'nested');
  });
  afterEach(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  it('reads back the account and mode the last launch was left in', async () => {
    const first = new PreferencesStore(dir);
    first.save({ profileId: 'prof_work', permissionMode: 'plan' });
    await first.flush();

    expect(new PreferencesStore(dir).get()).toMatchObject({ profileId: 'prof_work', permissionMode: 'plan' });
  });

  it('remembers a model against its own account, leaving the others alone', async () => {
    const store = new PreferencesStore(dir);
    store.saveModelFor('prof_work', { model: 'opus', effort: 'high' });
    store.saveModelFor('prof_home', { model: 'sonnet' });
    store.save({ profileId: 'prof_home' });
    await store.flush();

    // A model id belongs to the provider that named it; restoring one account's
    // onto another would be refused by the adapter at best.
    const reopened = new PreferencesStore(dir);
    expect(reopened.modelFor('prof_work')).toEqual({ model: 'opus', effort: 'high' });
    expect(reopened.modelFor('prof_home')).toEqual({ model: 'sonnet' });
    expect(reopened.modelFor('prof_never_used')).toBeUndefined();
    // And the later save did not take the models with it.
    expect(reopened.get().profileId).toBe('prof_home');
  });

  it('opens on nothing remembered rather than failing, whatever the file holds', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'preferences.json'), '{ not json', 'utf8');
    expect(new PreferencesStore(dir).get()).toEqual({});

    await writeFile(join(dir, 'preferences.json'), JSON.stringify({ version: 99, preferences: { profileId: 'x' } }), 'utf8');
    expect(new PreferencesStore(dir).get()).toEqual({});
  });
});

/*
 * Pinned conversations.
 *
 * A pin is a promise about what the rail looks like next time: keep this one at
 * the top. So the only interesting questions are whether it survives the
 * launch that made it, whether toggling twice is the same as never having
 * toggled, and whether a list holding ids of conversations nobody can find any
 * more is still a list this can be asked about.
 */
describe('PreferencesStore pins', () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'artemis-tui-pins-')), 'nested');
  });
  afterEach(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  it('reads pins back, in the order they were made', async () => {
    const store = new PreferencesStore(dir);
    expect(store.isPinned('s-1')).toBe(false);
    expect(store.togglePin('s-1')).toBe(true);
    expect(store.togglePin('s-2')).toBe(true);
    await store.flush();

    const reopened = new PreferencesStore(dir);
    expect(reopened.isPinned('s-1')).toBe(true);
    expect(reopened.isPinned('s-2')).toBe(true);
    expect(reopened.isPinned('s-3')).toBe(false);
    expect(reopened.get().pinned).toEqual(['s-1', 's-2']);
    expect([...reopened.pinnedSet()]).toEqual(['s-1', 's-2']);
  });

  it('toggles back off, leaving every other pin where it was', async () => {
    const store = new PreferencesStore(dir);
    store.togglePin('s-1');
    store.togglePin('s-2');
    expect(store.togglePin('s-1')).toBe(false);
    await store.flush();

    const reopened = new PreferencesStore(dir);
    expect(reopened.isPinned('s-1')).toBe(false);
    expect(reopened.isPinned('s-2')).toBe(true);
    expect(reopened.get().pinned).toEqual(['s-2']);
  });

  it('keeps pins through the other settings, and the other settings through a pin', async () => {
    // One file, and a save of either half must not be a save over the other.
    const store = new PreferencesStore(dir);
    store.saveModelFor('prof_work', { model: 'opus' });
    store.save({ profileId: 'prof_work', permissionMode: 'plan' });
    store.togglePin('s-1');
    store.save({ permissionMode: 'acceptEdits' });
    await store.flush();

    const reopened = new PreferencesStore(dir);
    expect(reopened.isPinned('s-1')).toBe(true);
    expect(reopened.modelFor('prof_work')).toEqual({ model: 'opus' });
    expect(reopened.get()).toMatchObject({ profileId: 'prof_work', permissionMode: 'acceptEdits' });
  });

  it('answers about an id it has never heard of, and holds on to ones nobody can find', async () => {
    // A pinned session can be deleted, or belong to an account that is logged
    // out. Neither is something this file can check, and dropping the id would
    // silently unpin a conversation that comes back tomorrow.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'preferences.json'),
      JSON.stringify({ version: 1, preferences: { pinned: ['s-gone', 's-here'] } }),
      'utf8',
    );

    const store = new PreferencesStore(dir);
    expect(store.isPinned('s-gone')).toBe(true);
    expect(store.isPinned('never-existed')).toBe(false);
    store.togglePin('s-here');
    await store.flush();
    expect(new PreferencesStore(dir).get().pinned).toEqual(['s-gone']);
  });

  it('opens on nothing pinned when the file says something else entirely', async () => {
    // Hand-edited, or written by a version that meant something different by
    // the word. A launch is never something a preferences file gets to fail.
    const store = new PreferencesStore(dir);
    store.save({ pinned: 'yes' as unknown as readonly string[] });
    expect(store.isPinned('s-1')).toBe(false);
    expect([...store.pinnedSet()]).toEqual([]);
    expect(store.togglePin('s-1')).toBe(true);
    expect([...store.pinnedSet()]).toEqual(['s-1']);
    await store.flush();
  });

  it('hands back the same set until the pins change', async () => {
    // The rail asks once per draw and then asks of every row; rebuilding the
    // set for each of those would be a scan per row.
    const store = new PreferencesStore(dir);
    store.togglePin('s-1');
    const set = store.pinnedSet();
    expect(store.pinnedSet()).toBe(set);
    store.togglePin('s-2');
    expect(store.pinnedSet()).not.toBe(set);
    expect([...store.pinnedSet()]).toEqual(['s-1', 's-2']);
    await store.flush();
  });
});
