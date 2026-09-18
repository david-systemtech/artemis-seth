/**
 * The list of skill repositories a headless host keeps.
 *
 * Over a real file in a scratch directory, because what matters is what is on
 * the disk afterwards: two administrators adding a repository at once both
 * keep theirs, a file nobody can parse is a machine with no sources rather
 * than a host that will not start a run, and a write that fails leaves the old
 * file whole and no scratch file beside it.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withSkillSource, withoutSkillSource } from '@rx-artemis/protocol';

import { createSkillSourceRegistry } from './skillSourceRegistry.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artemis-skill-registry-'));
  file = join(dir, 'data', 'skills.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createSkillSourceRegistry', () => {
  it('has no sources before anything was stored, and makes its folder when something is', async () => {
    const registry = createSkillSourceRegistry(file);
    expect(await registry.sources()).toEqual([]);

    await registry.update((current) => withSkillSource(current, 'https://example.com/o/skills'));

    expect((await registry.sources()).map((source) => source.url)).toEqual(['https://example.com/o/skills']);
    // The desktop's document, so a data directory moved between the two reads the same.
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, alwaysOn: [] });
  });

  it('keeps both of two additions made at once', async () => {
    const registry = createSkillSourceRegistry(file);

    await Promise.all([
      registry.update((current) => withSkillSource(current, 'https://example.com/o/one')),
      registry.update((current) => withSkillSource(current, 'https://example.com/o/two')),
    ]);

    // Each change was handed what was on disk at its turn, not a copy read
    // before the other landed.
    expect((await registry.sources()).map((source) => source.url)).toEqual([
      'https://example.com/o/one',
      'https://example.com/o/two',
    ]);
  });

  it('leaves the always-on half of the document alone', async () => {
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ version: 1, alwaysOn: [{ name: 'unslop', scope: { kind: 'all' } }] }),
    );
    const registry = createSkillSourceRegistry(file);

    const added = await registry.update((current) => withSkillSource(current, 'https://example.com/o/skills'));
    const removed = await registry.update((current) => withoutSkillSource(current, added.sources![0]!.id));

    expect(removed.alwaysOn).toEqual([{ name: 'unslop', scope: { kind: 'all' } }]);
    expect(await registry.sources()).toEqual([]);
  });

  it('reads a file nobody can parse as a machine with no sources', async () => {
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(file, '{ not json');

    expect(await createSkillSourceRegistry(file).sources()).toEqual([]);
  });

  it('tells the caller when a change could not be stored, and carries on afterwards', async () => {
    // A file where the folder should be: nothing can be written beneath it.
    await writeFile(join(dir, 'data'), 'in the way');
    const registry = createSkillSourceRegistry(file);

    await expect(
      registry.update((current) => withSkillSource(current, 'https://example.com/o/skills')),
    ).rejects.toThrow();

    // One failed write does not fail every write after it.
    await rm(join(dir, 'data'));
    await registry.update((current) => withSkillSource(current, 'https://example.com/o/skills'));
    expect(await registry.sources()).toHaveLength(1);
    // And no scratch file is left beside the real one.
    expect(await readdir(join(dir, 'data'))).toEqual(['skills.json']);
  });
});
