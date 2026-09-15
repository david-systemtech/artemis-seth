/**
 * `@path` completion: the ranking, the memory, and the token.
 *
 * The failure mode of a completion is not crashing, it is offering the wrong
 * file first — which no type can catch and a person notices immediately. So the
 * scorer's cases are written as the orderings they have to produce, with a
 * fixed list of paths and no filesystem, and the two that a greedy matcher gets
 * wrong (`co/Comp`, and a filename typed out in full) are pinned by name.
 *
 * `listFiles` does touch a disk, in a temporary directory, because the thing
 * worth testing about it is exactly what a repository does and does not
 * contain.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_MATCH_LIMIT, Frecency, defaultFrecencyPath, fuzzyMatch, listFiles, mentionAt, replaceMention } from './fileIndex.js';

const run = promisify(execFile);

/** A fixed corpus: every ordering below is a claim about these seven paths. */
const PATHS: readonly string[] = [
  'apps/tui/src/components/Composer.tsx',
  'apps/tui/src/components/ComposerActions.tsx',
  'packages/core/src/adapters/compose.ts',
  'apps/tui/src/commands.ts',
  'docs/composer.md',
  'packages/core/src/index.ts',
  'apps/tui/src/app.tsx',
];

const ranked = (query: string, paths: readonly string[] = PATHS): readonly string[] =>
  fuzzyMatch(query, paths).map((match) => match.path);

const temporaries: string[] = [];
const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'artemis-index-'));
  temporaries.push(directory);
  return directory;
};
afterAll(async () => {
  for (const directory of temporaries) await rm(directory, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe('fuzzyMatch', () => {
  it('prefers the file the query describes over the one that merely contains the letters', () => {
    // The case a greedy scan gets wrong: it lands `co` on `core` and stops,
    // never noticing that `components` offers the same run one segment from a
    // file actually called `Composer`.
    expect(ranked('co/Comp')).toEqual([
      'apps/tui/src/components/Composer.tsx',
      'apps/tui/src/components/ComposerActions.tsx',
      'packages/core/src/adapters/compose.ts',
    ]);
  });

  it('puts a filename typed out in full first', () => {
    // Typing a whole basename is an answer, not a query, and must not be
    // out-argued by a longer path that happens to contain the same letters.
    expect(ranked('Composer.tsx')).toEqual([
      'apps/tui/src/components/Composer.tsx',
      'apps/tui/src/components/ComposerActions.tsx',
    ]);
  });

  it('matches case-insensitively and reports the offsets in the path as written', () => {
    const [best] = fuzzyMatch('comp', ['apps/tui/src/components/Composer.tsx']);

    // The basename beats the directory of the same name, and the indices point
    // at the original characters so a highlight can be drawn over them.
    expect(best?.indices).toEqual([24, 25, 26, 27]);
    expect(best?.indices.map((index) => best.path.charAt(index)).join('')).toBe('Comp');
  });

  it('scores the start of the basename above the start of the path', () => {
    const [best] = fuzzyMatch('app', ['apps/tui/src/app.tsx']);

    expect(best?.indices).toEqual([13, 14, 15]);
  });

  it('drops a path whose characters are not all there, in order', () => {
    expect(ranked('zq')).toEqual([]);
    // `x` never appears in this one, so a subsequence is impossible.
    expect(ranked('composex', ['packages/core/src/adapters/compose.ts'])).toEqual([]);
  });

  it('returns at most the limit, twelve by default', () => {
    expect(DEFAULT_MATCH_LIMIT).toBe(12);
    expect(fuzzyMatch('s', PATHS, { limit: 2 })).toHaveLength(2);
    expect(fuzzyMatch('s', PATHS, { limit: 0 })).toEqual([]);
    expect(fuzzyMatch('', PATHS, { limit: 3 })).toHaveLength(3);
  });

  it('breaks a tie on the shorter path, then on path order', () => {
    expect(ranked('one', ['b/one.ts', 'a/one.ts', 'a/one.longer.ts'])).toEqual(['a/one.ts', 'b/one.ts', 'a/one.longer.ts']);
  });

  it('lets what was picked before win between otherwise equal paths', () => {
    const frecency = { boost: (path: string): number => (path === 'b/one.ts' ? 10 : 0) };

    expect(fuzzyMatch('one', ['a/one.ts', 'b/one.ts'], { frecency }).map((match) => match.path)).toEqual(['b/one.ts', 'a/one.ts']);
  });

  it('offers what was picked before, then alphabetical, when nothing has been typed', () => {
    const paths = ['docs/composer.md', 'apps/tui/src/app.tsx', 'packages/core/src/index.ts'];
    const frecency = new Frecency();
    frecency.record('packages/core/src/index.ts');

    const results = fuzzyMatch('   ', paths, { frecency });

    expect(results.map((match) => match.path)).toEqual(['packages/core/src/index.ts', 'apps/tui/src/app.tsx', 'docs/composer.md']);
    // Nothing was typed, so there is nothing to highlight.
    expect(results.map((match) => match.indices)).toEqual([[], [], []]);
  });
});

describe('Frecency', () => {
  it('is worth nothing for a path never picked', () => {
    expect(new Frecency().boost('never.ts', NOW)).toBe(0);
  });

  it('rises with picks and decays with age', () => {
    const frecency = new Frecency();
    frecency.record('often.ts', NOW - DAY);
    frecency.record('often.ts', NOW);
    frecency.record('once.ts', NOW);
    frecency.record('stale.ts', NOW - 60 * DAY);

    expect(frecency.boost('often.ts', NOW)).toBeGreaterThan(frecency.boost('once.ts', NOW));
    expect(frecency.boost('once.ts', NOW)).toBeGreaterThan(frecency.boost('stale.ts', NOW));
    // A boost nudges the ranking; it can never carry an irrelevant file to the
    // top of a real match.
    expect(frecency.boost('often.ts', NOW)).toBeLessThanOrEqual(48);
    expect(frecency.boost('stale.ts', NOW)).toBeGreaterThan(0);
  });

  it('round-trips through its JSON file', async () => {
    const directory = await temporaryDirectory();
    // Nested, so that saving has to create the directory the way a first run does.
    const path = join(directory, 'nested', 'files.json');
    const store = new Frecency(path);
    store.record('a.ts', NOW);
    store.record('a.ts', NOW);
    store.record('b.ts', NOW - DAY);
    await store.save();

    const reopened = new Frecency();
    await reopened.load(path);

    expect(reopened.boost('a.ts', NOW)).toBeCloseTo(store.boost('a.ts', NOW));
    expect(reopened.boost('b.ts', NOW)).toBeCloseTo(store.boost('b.ts', NOW));
    expect(reopened.boost('a.ts', NOW)).toBeGreaterThan(reopened.boost('b.ts', NOW));
    const written = JSON.parse(await readFile(path, 'utf8')) as { version: number };
    expect(written.version).toBe(1);
  });

  it('remembers nothing when the file is missing, unreadable or nonsense', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'nonsense.json'), 'not json at all');
    await writeFile(join(directory, 'wrong.json'), JSON.stringify({ version: 99, entries: { 'a.ts': { at: NOW, count: 3 } } }));

    const missing = new Frecency(join(directory, 'gone.json'));
    await missing.load();
    const nonsense = new Frecency();
    await nonsense.load(join(directory, 'nonsense.json'));
    const wrong = new Frecency();
    await wrong.load(join(directory, 'wrong.json'));

    expect(missing.boost('a.ts', NOW)).toBe(0);
    expect(nonsense.boost('a.ts', NOW)).toBe(0);
    expect(wrong.boost('a.ts', NOW)).toBe(0);
    // Nowhere to save to is not an error either.
    await expect(new Frecency().save()).resolves.toBeUndefined();
  });

  it('keeps its file beside the other things the terminal remembers', () => {
    expect(defaultFrecencyPath({ platform: 'linux', home: '/home/ada', env: { XDG_STATE_HOME: '/state' } })).toBe(
      join('/state', 'artemis', 'tui', 'files.json'),
    );
  });
});

describe('mentionAt', () => {
  it('finds a token at the start of the text and one after whitespace', () => {
    expect(mentionAt('@app', 4)).toEqual({ start: 0, end: 4, query: 'app' });
    expect(mentionAt('look at @src/app.tsx', 20)).toEqual({ start: 8, end: 20, query: 'src/app.tsx' });
  });

  it('is the whole token wherever in it the cursor sits', () => {
    // Arrowing back to fix a letter must not narrow the list to a prefix.
    expect(mentionAt('see @apps/tui here', 8)).toEqual({ start: 4, end: 13, query: 'apps/tui' });
    expect(mentionAt('see @apps/tui here', 5)).toEqual({ start: 4, end: 13, query: 'apps/tui' });
  });

  it('is an empty query the moment the @ is typed', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(mentionAt('hi @', 4)).toEqual({ start: 3, end: 4, query: '' });
  });

  it('is nothing inside an email address', () => {
    // The `@` is mid-token, so it does not start one.
    expect(mentionAt('ada@example.com', 12)).toBeNull();
    expect(mentionAt('mail @ada ada@example.com', 25)).toBeNull();
  });

  it('allows an @ inside the path, which scoped package folders have', () => {
    const text = 'see @node_modules/@scope/thing';

    expect(mentionAt(text, text.length)).toEqual({ start: 4, end: 30, query: 'node_modules/@scope/thing' });
  });

  it('is nothing when the cursor is on or before the @, or past the token', () => {
    expect(mentionAt('@app', 0)).toBeNull();
    expect(mentionAt('hi @app', 3)).toBeNull();
    expect(mentionAt('@app here', 9)).toBeNull();
    expect(mentionAt('hi ', 3)).toBeNull();
    expect(mentionAt('', 0)).toBeNull();
    expect(mentionAt('@app', 99)).toBeNull();
  });
});

describe('replaceMention', () => {
  it('writes over the token, @ and all, and leaves the cursor past one space', () => {
    const mention = mentionAt('see @app here', 8);

    expect(mention).not.toBeNull();
    expect(mention && replaceMention('see @app here', mention.start, mention.end, 'apps/tui/src/app.tsx')).toEqual({
      text: 'see apps/tui/src/app.tsx here',
      cursor: 25,
    });
  });

  it('adds the space at the end of the line, and does not double one already there', () => {
    expect(replaceMention('see @app', 4, 8, 'x.ts')).toEqual({ text: 'see x.ts ', cursor: 9 });
    expect(replaceMention('see @app there', 4, 8, 'x.ts')).toEqual({ text: 'see x.ts there', cursor: 9 });
  });
});

const gitOnPath = async (): Promise<boolean> => {
  try {
    await run('git', ['--version']);
    return true;
  } catch {
    return false;
  }
};

describe('listFiles', () => {
  it('asks git, which already knows what the project ignores', async (context) => {
    if (!(await gitOnPath())) context.skip('git is not on PATH');
    const directory = await temporaryDirectory();
    await run('git', ['init'], { cwd: directory });
    await writeFile(join(directory, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(directory, 'ignored.txt'), 'secret');
    await writeFile(join(directory, 'keep.ts'), '');
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'nested', 'deep.ts'), '');

    const files = await listFiles(directory);

    // Untracked files are in — nothing has been committed here — and the
    // ignored one is out, which is the whole reason git is asked at all.
    expect(files).toEqual(['.gitignore', 'keep.ts', 'nested/deep.ts']);
    expect(files).not.toContain('ignored.txt');
  });

  it('walks when there is no repository, skipping dependencies and build output', async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, 'src'));
    await mkdir(join(directory, 'node_modules', 'ink'), { recursive: true });
    await mkdir(join(directory, 'dist'));
    await mkdir(join(directory, '.git'));
    await mkdir(join(directory, '.cache'));
    await writeFile(join(directory, 'src', 'app.tsx'), '');
    await writeFile(join(directory, 'node_modules', 'ink', 'index.js'), '');
    await writeFile(join(directory, 'dist', 'app.js'), '');
    await writeFile(join(directory, '.git', 'HEAD'), '');
    await writeFile(join(directory, '.cache', 'blob'), '');
    await writeFile(join(directory, 'readme.md'), '');

    // A temporary directory is not a work tree, so git declines and the walk
    // answers; paths come back relative and with forward slashes either way.
    const files = await listFiles(directory);

    expect(files).toEqual(['readme.md', 'src/app.tsx']);
    // And the walk can be asked for directly, inside a repository or out.
    expect(await listFiles(directory, { git: false })).toEqual(files);
  });

  it('does not follow a symlinked directory', async () => {
    const directory = await temporaryDirectory();
    const elsewhere = await temporaryDirectory();
    await writeFile(join(elsewhere, 'far.ts'), '');
    await writeFile(join(directory, 'near.ts'), '');
    try {
      await symlink(elsewhere, join(directory, 'link'), 'dir');
    } catch {
      // Windows without the privilege to make one: nothing to test here.
      return;
    }

    expect(await listFiles(directory, { git: false })).toEqual(['near.ts']);
  });

  it('stops at the limit, and at zero lists nothing', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'a.ts'), '');
    await writeFile(join(directory, 'b.ts'), '');
    await writeFile(join(directory, 'c.ts'), '');

    expect(await listFiles(directory, { git: false, limit: 2 })).toEqual(['a.ts', 'b.ts']);
    expect(await listFiles(directory, { git: false, limit: 0 })).toEqual([]);
  });

  it('lists nothing for a directory that is not there', async () => {
    const directory = await temporaryDirectory();

    expect(await listFiles(join(directory, 'gone'))).toEqual([]);
  });
});
