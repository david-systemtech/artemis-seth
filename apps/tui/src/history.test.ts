/**
 * What the composer remembers, and what it refuses to remember.
 *
 * Reported as: everything typed is gone the moment it is sent. These pin the
 * promises that answer it — what was appended is read back, including the
 * multi-line prompts that are the whole reason the file is JSONL — and the
 * ones that keep the remembering cheap: a file nobody can be trusted to have
 * left well formed is still a history, blank and repeated prompts never reach
 * it, and it stops growing at a cap. Then the walking, which is pure and has
 * edges in both directions.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HISTORY_KEPT_ENTRIES,
  HISTORY_MAX_ENTRIES,
  HistoryCursor,
  PromptHistory,
  defaultHistoryPath,
  type HistoryEntry,
} from './history.js';

const HERE = '/work/artemis';
const THERE = '/work/other';

describe('defaultHistoryPath', () => {
  it('sits in the state directory, beside what else the terminal remembers', () => {
    expect(defaultHistoryPath({ platform: 'linux', home: '/home/ada', env: { XDG_STATE_HOME: '/state' } })).toBe(
      join('/state', 'artemis', 'tui', 'history.jsonl'),
    );
  });
});

describe('PromptHistory', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    // Nested, so the first append has to create the directory as well.
    dir = join(await mkdtemp(join(tmpdir(), 'artemis-tui-history-')), 'nested');
    path = join(dir, 'history.jsonl');
  });
  afterEach(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  const seed = async (entries: readonly HistoryEntry[]): Promise<void> => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
  };

  it('opens on an empty history when nothing has been typed yet', async () => {
    const history = await PromptHistory.load(path);
    expect(history.size).toBe(0);
    expect(history.recent({ kind: 'all' })).toEqual([]);
    expect(history.search('anything', { kind: 'all' })).toEqual([]);
  });

  it('reads back what was appended, multi-line prompts included', async () => {
    const history = await PromptHistory.load(path);
    const multiline = 'rename the field, then:\n  - update the tests\n  - update the docs';
    history.append({ text: 'first prompt', cwd: HERE, sessionId: 'sess_1', ts: 1_000 });
    history.append({ text: multiline, cwd: HERE, sessionId: 'sess_1', ts: 2_000 });
    await history.flush();

    // One JSON object per line, so the newlines inside a prompt are escaped
    // rather than mistaken for the end of an entry.
    expect((await readFile(path, 'utf8')).split('\n').filter((line) => line.length > 0)).toHaveLength(2);

    const reopened = await PromptHistory.load(path);
    expect(reopened.recent({ kind: 'all' })).toEqual([multiline, 'first prompt']);
    expect(reopened.search('update the docs', { kind: 'all' })[0]).toMatchObject({
      text: multiline,
      cwd: HERE,
      ts: 2_000,
    });
  });

  it('keeps writes in the order the appends were made without awaiting each one', async () => {
    const history = await PromptHistory.load(path);
    history.append({ text: 'one', cwd: HERE, ts: 1 });
    history.append({ text: 'two', cwd: HERE, ts: 2 });
    history.append({ text: 'three', cwd: HERE, ts: 3 });
    await history.flush();

    const reopened = await PromptHistory.load(path);
    expect(reopened.recent({ kind: 'all' })).toEqual(['three', 'two', 'one']);
  });

  it('stores the same text once when it is sent twice in a row', async () => {
    const history = await PromptHistory.load(path);
    history.append({ text: 'run the tests', cwd: HERE, ts: 1 });
    history.append({ text: 'run the tests', cwd: HERE, ts: 2 });
    expect(history.size).toBe(1);

    // Not consecutively, though: coming back to a prompt later is a use of it,
    // and it should sort to the top again.
    history.append({ text: 'now lint', cwd: HERE, ts: 3 });
    history.append({ text: 'run the tests', cwd: HERE, ts: 4 });
    expect(history.size).toBe(3);
    expect(history.recent({ kind: 'all' })).toEqual(['run the tests', 'now lint']);

    await history.flush();
    // And the rule survives a relaunch, because it is the last entry that is
    // compared and it was read back with everything else.
    const reopened = await PromptHistory.load(path);
    reopened.append({ text: 'run the tests', cwd: HERE, ts: 5 });
    expect(reopened.size).toBe(3);
  });

  it('never stores a blank prompt', async () => {
    const history = await PromptHistory.load(path);
    history.append({ text: '', cwd: HERE, ts: 1 });
    history.append({ text: '   ', cwd: HERE, ts: 2 });
    history.append({ text: '\n\t \n', cwd: HERE, ts: 3 });
    await history.flush();

    expect(history.size).toBe(0);
    expect(await PromptHistory.load(path).then((reopened) => reopened.size)).toBe(0);
  });

  it('skips the lines it cannot read rather than losing the file', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path,
      [
        JSON.stringify({ ts: 1, text: 'good one', cwd: HERE }),
        'not json at all',
        JSON.stringify({ ts: 'nope', text: 'wrong shape', cwd: HERE }),
        JSON.stringify({ ts: 4, cwd: HERE }),
        JSON.stringify(['not an object']),
        JSON.stringify({ ts: 6, text: 'good two', cwd: HERE }),
        // The half line a process killed mid-append leaves behind: no newline,
        // and no closing brace either.
        '{"ts":7,"text":"half a pro',
      ].join('\n'),
      'utf8',
    );

    const history = await PromptHistory.load(path);
    expect(history.recent({ kind: 'all' })).toEqual(['good two', 'good one']);

    // And it is still appendable: the next prompt lands after the mess.
    history.append({ text: 'good three', cwd: HERE, ts: 8 });
    await history.flush();
    expect((await PromptHistory.load(path)).recent({ kind: 'all' })).toEqual(['good three', 'good two', 'good one']);
  });

  it('rewrites the file to the newest entries once the cap is passed', async () => {
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < HISTORY_MAX_ENTRIES; i += 1) entries.push({ ts: i, text: `prompt ${String(i)}`, cwd: HERE });
    await seed(entries);

    const history = await PromptHistory.load(path);
    expect(history.size).toBe(HISTORY_MAX_ENTRIES);
    history.append({ text: 'the one over the line', cwd: HERE, ts: HISTORY_MAX_ENTRIES });
    await history.flush();

    expect(history.size).toBe(HISTORY_KEPT_ENTRIES);
    const reopened = await PromptHistory.load(path);
    expect(reopened.size).toBe(HISTORY_KEPT_ENTRIES);
    const texts = reopened.recent({ kind: 'all' });
    expect(texts[0]).toBe('the one over the line');
    // The newest half kept, the oldest half gone.
    expect(texts.at(-1)).toBe(`prompt ${String(HISTORY_MAX_ENTRIES - HISTORY_KEPT_ENTRIES + 1)}`);
    expect(texts).not.toContain('prompt 0');

    // Rewritten by rename, so no temp file is left lying beside it.
    expect(await readdir(dir)).toEqual(['history.jsonl']);
  });

  it('offers each distinct prompt once, at its newest position', async () => {
    await seed([
      { ts: 1, text: 'alpha', cwd: HERE },
      { ts: 2, text: 'beta', cwd: HERE },
      { ts: 3, text: 'alpha', cwd: HERE },
      { ts: 4, text: 'gamma', cwd: HERE },
    ]);

    const history = await PromptHistory.load(path);
    // Both occurrences of `alpha` are kept on disk, but walking Up should not
    // pass through the same string twice.
    expect(history.size).toBe(4);
    expect(history.recent({ kind: 'all' })).toEqual(['gamma', 'alpha', 'beta']);
  });

  it('scopes to this session, this folder, or everything', async () => {
    await seed([
      { ts: 1, text: 'here, older session', cwd: HERE, sessionId: 'sess_1' },
      { ts: 2, text: 'elsewhere', cwd: THERE, sessionId: 'sess_2' },
      { ts: 3, text: 'here, this session', cwd: HERE, sessionId: 'sess_3' },
      { ts: 4, text: 'here, no session at all', cwd: HERE },
    ]);

    const history = await PromptHistory.load(path);
    expect(history.recent({ kind: 'session', sessionId: 'sess_3' })).toEqual(['here, this session']);
    expect(history.recent({ kind: 'folder', cwd: HERE })).toEqual([
      'here, no session at all',
      'here, this session',
      'here, older session',
    ]);
    expect(history.recent({ kind: 'folder', cwd: THERE })).toEqual(['elsewhere']);
    expect(history.recent({ kind: 'all' })).toHaveLength(4);
    expect(history.recent({ kind: 'session', sessionId: 'sess_never' })).toEqual([]);
  });

  it('searches case-insensitively and says where the match was', async () => {
    await seed([
      { ts: 1, text: 'Fix the Parser bug', cwd: HERE, sessionId: 'sess_1' },
      { ts: 2, text: 'parse the log file', cwd: THERE, sessionId: 'sess_2' },
      { ts: 3, text: 'unrelated', cwd: HERE, sessionId: 'sess_1' },
    ]);

    const history = await PromptHistory.load(path);
    expect(history.search('parse', { kind: 'all' })).toEqual([
      { text: 'parse the log file', cwd: THERE, ts: 2, index: 0 },
      { text: 'Fix the Parser bug', cwd: HERE, ts: 1, index: 8 },
    ]);
    // Either case of the query finds either case of the text.
    expect(history.search('PARSER', { kind: 'all' }).map((match) => match.index)).toEqual([8]);
    // Scope still applies while searching.
    expect(history.search('parse', { kind: 'folder', cwd: HERE }).map((match) => match.text)).toEqual([
      'Fix the Parser bug',
    ]);
    expect(history.search('nothing like this', { kind: 'all' })).toEqual([]);
  });

  it('answers an empty query with the recent list, and honours a limit', async () => {
    await seed([
      { ts: 1, text: 'alpha', cwd: HERE },
      { ts: 2, text: 'beta', cwd: HERE },
      { ts: 3, text: 'alpha again', cwd: HERE },
    ]);

    const history = await PromptHistory.load(path);
    // A search field that has only just opened shows the history, not nothing.
    expect(history.search('', { kind: 'all' }).map((match) => match.text)).toEqual([
      ...history.recent({ kind: 'all' }),
    ]);
    expect(history.search('', { kind: 'all' }).map((match) => match.index)).toEqual([0, 0, 0]);
    expect(history.search('', { kind: 'all' }, 2).map((match) => match.text)).toEqual(['alpha again', 'beta']);
    expect(history.search('alpha', { kind: 'all' }, 1).map((match) => match.text)).toEqual(['alpha again']);
  });
});

describe('HistoryCursor', () => {
  it('walks back from the draft into the history and stops at the oldest', () => {
    const cursor = new HistoryCursor(['newest', 'middle', 'oldest'], 'half typed');
    expect(cursor.atDraft()).toBe(true);
    expect(cursor.current()).toBe('half typed');

    expect(cursor.up()).toBe('newest');
    expect(cursor.atDraft()).toBe(false);
    expect(cursor.up()).toBe('middle');
    expect(cursor.up()).toBe('oldest');
    // No wrapping: pressing Up at the end of the list is a no-op, not a jump
    // back to the newest entry.
    expect(cursor.up()).toBe('oldest');
    expect(cursor.current()).toBe('oldest');
  });

  it('gives the draft back when it walks down past the newest entry', () => {
    const cursor = new HistoryCursor(['newest', 'older'], 'half typed');
    cursor.up();
    cursor.up();
    expect(cursor.current()).toBe('older');
    expect(cursor.down()).toBe('newest');
    expect(cursor.down()).toBe('half typed');
    expect(cursor.atDraft()).toBe(true);
    // And staying there, however often Down is pressed.
    expect(cursor.down()).toBe('half typed');
    expect(cursor.atDraft()).toBe(true);
  });

  it('stays on the draft when there is nothing remembered', () => {
    const cursor = new HistoryCursor([], 'half typed');
    expect(cursor.up()).toBe('half typed');
    expect(cursor.up()).toBe('half typed');
    expect(cursor.down()).toBe('half typed');
    expect(cursor.atDraft()).toBe(true);
  });

  it('has exactly one place to go with a single entry', () => {
    const cursor = new HistoryCursor(['only one'], '');
    expect(cursor.up()).toBe('only one');
    expect(cursor.up()).toBe('only one');
    expect(cursor.atDraft()).toBe(false);
    // An empty draft is still a draft: walking down restores the empty line.
    expect(cursor.down()).toBe('');
    expect(cursor.atDraft()).toBe(true);
  });
});
