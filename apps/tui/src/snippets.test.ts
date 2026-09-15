/**
 * What a snippet promises.
 *
 * Three things, and they fail in three different ways. The file has to survive
 * being hand-edited, being half-written and being from another version, because
 * losing every saved prompt is the one unrecoverable bug here. The template
 * language has to leave prose alone — a `$` that begins nothing is a `$` — and
 * has to be exact about offsets, since every one of them becomes a cursor
 * position. And the trigger has to stay out of the way of pasted code, which is
 * full of semicolons.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXAMPLE_SNIPPETS,
  Snippets,
  defaultSnippetsPath,
  expand,
  expandInText,
  isSnippetName,
  snippetAt,
  toSnippetName,
} from './snippets.js';

describe('defaultSnippetsPath', () => {
  it('sits in the state directory, beside what else the terminal remembers', () => {
    expect(defaultSnippetsPath({ platform: 'linux', home: '/home/ada', env: { XDG_STATE_HOME: '/state' } })).toBe(
      join('/state', 'artemis', 'tui', 'snippets.json'),
    );
  });
});

describe('Snippets', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    // Nested, so the first save has to create the directory as well.
    dir = join(await mkdtemp(join(tmpdir(), 'artemis-tui-snippets-')), 'nested');
    path = join(dir, 'snippets.json');
  });
  afterEach(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  const seed = async (contents: unknown): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(path, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  };

  const stored = async (): Promise<{ version: number; snippets: { name: string; body: string }[] }> =>
    JSON.parse(await readFile(path, 'utf8')) as { version: number; snippets: { name: string; body: string }[] };

  it('opens on nothing at all, because none ship', async () => {
    const snippets = await Snippets.load(path);
    expect(snippets.list()).toEqual([]);
    expect(snippets.get('fix-tests')).toBeUndefined();
  });

  it('answers with what was just saved, before the disk has caught up', async () => {
    const snippets = await Snippets.load(path);
    const saved = snippets.set('fix-tests', 'run `$1`', 1_700_000_000_000);
    expect(saved).toEqual({ name: 'fix-tests', body: 'run `$1`', updatedAt: 1_700_000_000_000 });
    expect(snippets.get('fix-tests')).toEqual(saved);
    await snippets.flush();
  });

  it('writes what was saved and reads it back through the file', async () => {
    const snippets = await Snippets.load(path);
    snippets.set('fix-tests', 'the body\nover two lines, with a $1 in it', 1_700_000_000_000);
    await snippets.flush();

    const reopened = await Snippets.load(path);
    expect(reopened.get('fix-tests')).toEqual({
      name: 'fix-tests',
      body: 'the body\nover two lines, with a $1 in it',
      updatedAt: 1_700_000_000_000,
    });
  });

  it('creates the state directory on the first save, and leaves no temporary behind', async () => {
    const snippets = await Snippets.load(path);
    snippets.set('one', 'a');
    snippets.set('two', 'b');
    await snippets.flush();

    expect(await readdir(dir)).toEqual(['snippets.json']);
    expect((await stored()).version).toBe(1);
  });

  it('lists alphabetically, and writes the file that way too, whatever order they were saved in', async () => {
    const snippets = await Snippets.load(path);
    snippets.set('review-diff', 'c');
    snippets.set('explain', 'a');
    snippets.set('fix-tests', 'b');
    await snippets.flush();

    expect(snippets.list().map((snippet) => snippet.name)).toEqual(['explain', 'fix-tests', 'review-diff']);
    expect((await stored()).snippets.map((snippet) => snippet.name)).toEqual(['explain', 'fix-tests', 'review-diff']);
  });

  it('replaces a snippet of the same name rather than keeping both', async () => {
    const snippets = await Snippets.load(path);
    snippets.set('notes', 'first', 1);
    snippets.set('notes', 'second', 2);
    await snippets.flush();

    const reopened = await Snippets.load(path);
    expect(reopened.list()).toEqual([{ name: 'notes', body: 'second', updatedAt: 2 }]);
  });

  it('removes, and says whether there was anything to remove', async () => {
    const snippets = await Snippets.load(path);
    snippets.set('notes', 'a');
    expect(snippets.remove('notes')).toBe(true);
    expect(snippets.remove('notes')).toBe(false);
    expect(snippets.remove('never-existed')).toBe(false);
    await snippets.flush();

    expect((await Snippets.load(path)).list()).toEqual([]);
  });

  it('refuses a name the trigger could never type again, and stores nothing', async () => {
    const snippets = await Snippets.load(path);
    for (const name of ['Fix Tests', 'fix tests', 'fix_tests', 'fix.tests', '', 'ünïcode', ';;fix']) {
      expect(() => snippets.set(name, 'body')).toThrow(RangeError);
    }
    expect(snippets.list()).toEqual([]);
  });

  it('keeps an entry someone added by hand without a timestamp', async () => {
    await seed({ version: 1, snippets: [{ name: 'by-hand', body: 'typed into the file' }] });
    expect((await Snippets.load(path)).get('by-hand')).toEqual({ name: 'by-hand', body: 'typed into the file', updatedAt: 0 });
  });

  it('skips the entries it cannot read and keeps the rest', async () => {
    await seed({
      version: 1,
      snippets: [
        null,
        42,
        'not an entry',
        { name: 'Bad Name', body: 'a' },
        { name: 'no-body' },
        { name: 'not-a-string-body', body: 7 },
        { name: 'good', body: 'kept', updatedAt: 5 },
        { name: 'nan-time', body: 'kept too', updatedAt: 'yesterday' },
      ],
    });
    const snippets = await Snippets.load(path);
    expect(snippets.list()).toEqual([
      { name: 'good', body: 'kept', updatedAt: 5 },
      { name: 'nan-time', body: 'kept too', updatedAt: 0 },
    ]);
  });

  it('takes the later of two entries that share a name', async () => {
    await seed({ version: 1, snippets: [{ name: 'dup', body: 'first' }, { name: 'dup', body: 'second' }] });
    expect((await Snippets.load(path)).get('dup')?.body).toBe('second');
  });

  it('treats a file it cannot read as no snippets', async () => {
    await seed('{"version": 1, "snippets": [{"name": "half-writ');
    expect((await Snippets.load(path)).list()).toEqual([]);
  });

  it('treats a file from another version, or of another shape, as no snippets', async () => {
    await seed({ version: 2, snippets: [{ name: 'future', body: 'a' }] });
    expect((await Snippets.load(path)).list()).toEqual([]);

    await seed({ version: 1, snippets: { 'not-an-array': true } });
    expect((await Snippets.load(path)).list()).toEqual([]);

    await seed(null);
    expect((await Snippets.load(path)).list()).toEqual([]);
  });

  it('never makes a caller catch a write that cannot happen', async () => {
    const blocked = join(dir, 'a-file');
    await mkdir(dir, { recursive: true });
    await writeFile(blocked, 'in the way', 'utf8');

    const snippets = await Snippets.load(join(blocked, 'snippets.json'));
    snippets.set('notes', 'a');
    await expect(snippets.flush()).resolves.toBeUndefined();
    expect(snippets.get('notes')?.body).toBe('a');
  });
});

describe('snippet names', () => {
  it('are lower-case letters, digits and dashes, and nothing else', () => {
    for (const name of ['fix-tests', 'a', 'a1', '2fa', 'a-b-c']) expect(isSnippetName(name)).toBe(true);
    for (const name of ['', 'Fix', 'fix tests', 'fix_tests', 'fix.tests', 'fix/tests', 'fixé']) {
      expect(isSnippetName(name)).toBe(false);
    }
  });

  it('are made out of whatever a person typed, when there is anything left of it', () => {
    expect(toSnippetName('Fix Tests')).toBe('fix-tests');
    expect(toSnippetName('  Review  the DIFF!  ')).toBe('review-the-diff');
    expect(toSnippetName('already-fine')).toBe('already-fine');
    expect(toSnippetName('snake_case')).toBe('snake-case');
    expect(toSnippetName('2FA')).toBe('2fa');
    expect(toSnippetName('   ')).toBeNull();
    expect(toSnippetName('!!!')).toBeNull();
  });
});

describe('expand', () => {
  it('fills the slots in order from the words typed after the name', () => {
    expect(expand('git log $1 $2', ['-n', '5'])).toEqual({ text: 'git log -n 5', cursor: 12, slots: [] });
  });

  it('gives the last slot everything left over, because one slot and a phrase is the common case', () => {
    expect(expand('Explain $1', ['the', 'auth', 'flow']).text).toBe('Explain the auth flow');
    expect(expand('$1: $2', ['fix', 'the', 'failing', 'test']).text).toBe('fix: the failing test');
  });

  it('keeps a default when no word was passed for the slot, and offers it as a range', () => {
    expect(expand('run `${1:pnpm test}`')).toEqual({
      text: 'run `pnpm test`',
      cursor: 5,
      slots: [{ start: 5, end: 14 }],
    });
  });

  it('replaces a default when a word was passed', () => {
    expect(expand('run `${1:pnpm test}`', ['make check'])).toEqual({ text: 'run `make check`', cursor: 16, slots: [] });
  });

  it('leaves the cursor on the first empty slot and lists the rest for Tab', () => {
    expect(expand('a $1 b ${2:two} c $3')).toEqual({
      text: 'a  b two c ',
      cursor: 2,
      slots: [
        { start: 2, end: 2 },
        { start: 5, end: 8 },
        { start: 11, end: 11 },
      ],
    });
  });

  it('walks the slots in the order they appear, not the order they are numbered', () => {
    expect(expand('$2 then $1', ['one'])).toEqual({ text: ' then one', cursor: 0, slots: [{ start: 0, end: 0 }] });
  });

  it('sends the cursor to $0 once every slot is filled', () => {
    expect(expand('before\n$0\nafter ${1:x}', ['y'])).toEqual({
      text: 'before\n\nafter y',
      cursor: 7,
      slots: [],
      final: 7,
    });
  });

  it('prefers an empty slot to $0, and reports $0 as the stop after the last one', () => {
    expect(expand('$0 and ${1:x}')).toEqual({
      text: ' and x',
      cursor: 5,
      slots: [{ start: 5, end: 6 }],
      final: 0,
    });
  });

  it('never fills $0 from the words, and never offers it as a slot', () => {
    expect(expand('$0$1', ['a'])).toEqual({ text: 'a', cursor: 0, slots: [], final: 0 });
  });

  it('lets the first $0 win, and keeps the second as the text it is', () => {
    expect(expand('$0 x $0')).toEqual({ text: ' x ', cursor: 0, slots: [], final: 0 });
  });

  it('stops at the end when there is neither a slot nor a $0', () => {
    expect(expand('just text')).toEqual({ text: 'just text', cursor: 9, slots: [] });
  });

  it('drops words the body has nowhere to put', () => {
    expect(expand('no slots here', ['a', 'b'])).toEqual({ text: 'no slots here', cursor: 13, slots: [] });
  });

  it('reads $$ as a dollar, which is how a body says $1 and means it', () => {
    expect(expand('$$1 costs $$')).toEqual({ text: '$1 costs $', cursor: 10, slots: [] });
  });

  it('leaves a dollar that begins nothing exactly where it is', () => {
    const prose = '100$ and $foo and ${bad} and ${1 and $';
    expect(expand(prose)).toEqual({ text: prose, cursor: prose.length, slots: [] });
  });

  it('fills a repeated slot in both places, and offers both when it is empty', () => {
    expect(expand('$1 then $1 again', ['x']).text).toBe('x then x again');
    expect(expand('$1 then $1')).toEqual({
      text: ' then ',
      cursor: 0,
      slots: [
        { start: 0, end: 0 },
        { start: 6, end: 6 },
      ],
    });
  });

  it('treats an @path as ordinary text, for the composer to notice later', () => {
    expect(expand('Explain @${1:path/to/file}')).toEqual({
      text: 'Explain @path/to/file',
      cursor: 9,
      slots: [{ start: 9, end: 21 }],
    });
    expect(expand('Explain @$1', ['src/app.ts']).text).toBe('Explain @src/app.ts');
  });

  it('reads a braced slot, with or without a default', () => {
    expect(expand('${1:a}|$2|${3}')).toEqual({
      text: 'a||',
      cursor: 0,
      slots: [
        { start: 0, end: 1 },
        { start: 2, end: 2 },
        { start: 3, end: 3 },
      ],
    });
  });

  it('reads a slot numbered past nine', () => {
    expect(expand('$10')).toEqual({ text: '', cursor: 0, slots: [{ start: 0, end: 0 }] });
    expect(expand('$10', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']).text).toBe('j');
  });

  it('reads an empty default as no default at all', () => {
    expect(expand('${1:}')).toEqual({ text: '', cursor: 0, slots: [{ start: 0, end: 0 }] });
  });

  it('expands an empty body into an empty composer', () => {
    expect(expand('')).toEqual({ text: '', cursor: 0, slots: [] });
  });
});

describe('snippetAt', () => {
  it('finds the name being typed after the trigger', () => {
    expect(snippetAt(';;fix-tests', 11)).toEqual({ start: 0, end: 11, name: 'fix-tests' });
  });

  it('is the whole token, not just what is left of the cursor', () => {
    expect(snippetAt(';;fix-tests', 4)).toEqual({ start: 0, end: 11, name: 'fix-tests' });
  });

  it('is nothing until the cursor is past both semicolons, and an empty name the moment it is', () => {
    expect(snippetAt(';;', 0)).toBeNull();
    expect(snippetAt(';;', 1)).toBeNull();
    expect(snippetAt(';;', 2)).toEqual({ start: 0, end: 2, name: '' });
  });

  it('finds one after a space, and one after a newline', () => {
    expect(snippetAt('please ;;explain now', 15)).toEqual({ start: 7, end: 16, name: 'explain' });
    expect(snippetAt('one\n;;two', 9)).toEqual({ start: 4, end: 9, name: 'two' });
  });

  it('stops at whitespace, leaving the words after the name to the caller', () => {
    expect(snippetAt(';;explain src/app.ts', 9)).toEqual({ start: 0, end: 9, name: 'explain' });
  });

  it('ignores semicolons in the middle of a token, which is where pasted code keeps them', () => {
    expect(snippetAt('foo();;', 7)).toBeNull();
    expect(snippetAt('a;;b', 4)).toBeNull();
    expect(snippetAt('http://x;;y', 11)).toBeNull();
  });

  it('is nothing when there is no trigger, and nothing in an empty composer', () => {
    expect(snippetAt('hello', 3)).toBeNull();
    expect(snippetAt(';one', 4)).toBeNull();
    expect(snippetAt('', 0)).toBeNull();
  });

  it('is nothing for a cursor outside the text', () => {
    expect(snippetAt(';;fix', -1)).toBeNull();
    expect(snippetAt(';;fix', 99)).toBeNull();
  });
});

describe('expandInText', () => {
  it('writes the expansion over the trigger and shifts every offset with it', () => {
    const text = 'note: ;;explain';
    expect(snippetAt(text, 15)).toEqual({ start: 6, end: 15, name: 'explain' });
    expect(expandInText(text, 6, 15, expand('see @${1:path} now'))).toEqual({
      text: 'note: see @path now',
      cursor: 11,
      slots: [{ start: 11, end: 15 }],
    });
  });

  it('keeps whatever followed the trigger', () => {
    expect(expandInText('a ;;x b', 2, 5, expand('[$1]'))).toEqual({
      text: 'a [] b',
      cursor: 3,
      slots: [{ start: 3, end: 3 }],
    });
  });

  it('shifts $0 along with the rest', () => {
    expect(expandInText('xx', 2, 2, expand('a$0b'))).toEqual({ text: 'xxab', cursor: 3, slots: [], final: 3 });
  });

  it('adds no space of its own, unlike replacing a mention', () => {
    expect(expandInText('a ;;x', 2, 5, expand('hello')).text).toBe('a hello');
  });
});

describe('EXAMPLE_SNIPPETS', () => {
  it('are three, named the way the store insists on', () => {
    expect(EXAMPLE_SNIPPETS.map((snippet) => snippet.name)).toEqual(['fix-tests', 'explain', 'review-diff']);
    for (const snippet of EXAMPLE_SNIPPETS) expect(isSnippetName(snippet.name)).toBe(true);
  });

  it('expand into prose with nothing of the template language left showing', () => {
    for (const snippet of EXAMPLE_SNIPPETS) {
      const expansion = expand(snippet.body);
      expect(expansion.text).not.toMatch(/\$\d|\$\{/);
      expect(expansion.slots.length).toBeGreaterThan(0);
      expect(expansion.cursor).toBe(expansion.slots[0]?.start);
    }
  });

  it('seed a store that had nothing in it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artemis-tui-snippets-seed-'));
    try {
      const path = join(dir, 'snippets.json');
      const snippets = await Snippets.load(path);
      for (const snippet of EXAMPLE_SNIPPETS) snippets.set(snippet.name, snippet.body);
      await snippets.flush();

      const reopened = await Snippets.load(path);
      expect(reopened.list().map((snippet) => snippet.name)).toEqual(['explain', 'fix-tests', 'review-diff']);
      expect(reopened.get('fix-tests')?.body).toBe(EXAMPLE_SNIPPETS[0]?.body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
