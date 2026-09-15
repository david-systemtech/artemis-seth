/**
 * The ledger's promise is narrow and absolute: it either restores exactly what
 * was there before an edit, or it refuses and says why. So every case below is
 * written as a claim about the disk afterwards — the file's content, or its
 * absence — rather than about the ledger's bookkeeping, and the refusals are
 * pinned as hard as the successes.
 *
 * Most of it runs against a real temporary directory, because the thing being
 * tested is a read racing a write on a real filesystem. The bounds are the
 * exception: proving that the fiftieth edit evicts the first, or that sixteen
 * megabytes of pre-images is where retention stops, means a fake disk backed by
 * a `Map`, which is also the check that the injected `deps` are the only way
 * this module touches a filesystem at all.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import {
  ChangeLedger,
  MAX_CHANGES,
  MAX_LEDGER_BYTES,
  MAX_SNAPSHOT_BYTES,
  fileLines,
  gitDiff,
  summarizeFiles,
  type ChangeLedgerDeps,
  type ChangedFile,
  type ToolStartLike,
} from './changes.js';

const run = promisify(execFile);

const temporaries: string[] = [];
const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'artemis-changes-'));
  temporaries.push(directory);
  return directory;
};
afterAll(async () => {
  for (const directory of temporaries) await rm(directory, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;

/** An `Edit` call, in the shape `tool.start` hands over. */
const edit = (id: string, path: string, before: string, after: string, ts = NOW): ToolStartLike => ({
  id,
  name: 'Edit',
  input: { file_path: path, old_string: before, new_string: after },
  ts,
});

/** A `Write` call: whole new content, and no claim about what was there. */
const write = (id: string, path: string, content: string, ts = NOW): ToolStartLike => ({
  id,
  name: 'Write',
  input: { file_path: path, content },
  ts,
});

/** One entry of a patch: a path, what became of the file, and its own diff. */
interface PatchChange {
  readonly path: string;
  readonly kind: string;
  readonly diff?: string;
}

/**
 * An `ApplyPatch` call, in the shape the Codex adapter hands over.
 *
 * One entry per file, each carrying that file's patch text — which is what
 * makes this the multi-file case the single-file helpers above cannot express.
 */
const patch = (id: string, changes: readonly PatchChange[], ts = NOW): ToolStartLike => ({
  id,
  name: 'ApplyPatch',
  input: { changes },
  ts,
});

/** A one-line replacement in one file of a patch. */
const applied = (path: string, before: string, after: string): PatchChange => ({
  path,
  kind: 'update',
  diff: `@@ -1,1 +1,1 @@\n-${before}\n+${after}\n`,
});

/** A file the patch removes outright, in the envelope Codex's own patches use. */
const deleted = (path: string, content: string): PatchChange => ({
  path,
  kind: 'delete',
  diff: `*** Begin Patch\n*** Delete File: ${path}\n${content
    .trimEnd()
    .split('\n')
    .map((line) => `-${line}`)
    .join('\n')}\n*** End Patch\n`,
});

/**
 * One tool call, start to finish, with whatever the tool did in the middle.
 *
 * The `apply` step is the point: the ledger's snapshot has to be taken before
 * it runs, and its after-image has to be taken after.
 */
const call = async (
  ledger: ChangeLedger,
  item: ToolStartLike,
  apply: () => Promise<void>,
  status = 'ok',
): Promise<void> => {
  await ledger.onToolStart(item);
  await apply();
  await ledger.onToolEnd({ id: item.id, status });
};

const nothing = async (): Promise<void> => {
  /* a tool that was denied changed nothing */
};

/** A filesystem in a `Map`, for the cases a real one makes slow or impossible. */
const fakeDisk = (): { readonly files: Map<string, string>; readonly deps: Partial<ChangeLedgerDeps> } => {
  const files = new Map<string, string>();
  const missing = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    files,
    deps: {
      readFile: async (path) => {
        const text = files.get(path);
        if (text === undefined) throw missing(path);
        return text;
      },
      writeFile: async (path, text) => {
        files.set(path, text);
      },
      stat: async (path) => {
        const text = files.get(path);
        if (text === undefined) throw missing(path);
        return { size: Buffer.byteLength(text, 'utf8') };
      },
      rm: async (path) => {
        files.delete(path);
      },
      now: () => NOW,
    },
  };
};

describe('ChangeLedger', () => {
  it('snapshots the file as the call starts and promotes it when the call succeeds', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'a.txt');
    await writeFile(path, 'one\n');
    const ledger = new ChangeLedger(directory);

    await call(ledger, edit('t1', path, 'one', 'two'), () => writeFile(path, 'two\n'));

    const [change] = ledger.changes();
    expect(ledger.changes()).toHaveLength(1);
    expect(change?.id).toBe('t1');
    expect(change?.path).toBe(path);
    expect(change?.ts).toBe(NOW);
    // The whole point: the content kept is the one that is no longer on disk.
    expect(change?.before).toEqual({ kind: 'content', text: 'one\n' });
    expect(await readFile(path, 'utf8')).toBe('two\n');
    expect(change?.added).toBe(1);
    expect(change?.removed).toBe(1);
    expect(change?.edit.path).toBe(path);
    expect(ledger.last()?.id).toBe('t1');
  });

  it('resolves a relative path against the working directory', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'rel.txt'), 'one\n');
    const ledger = new ChangeLedger(directory);

    await call(ledger, edit('t1', 'rel.txt', 'one', 'two'), () => writeFile(join(directory, 'rel.txt'), 'two\n'));

    expect(ledger.last()?.path).toBe(join(directory, 'rel.txt'));
    // And the display name is the short one, which is what a list can show.
    expect(ledger.files()[0]?.label).toBe('rel.txt');
  });

  it('drops the snapshot when the call did not succeed', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'a.txt');
    await writeFile(path, 'one\n');
    const ledger = new ChangeLedger(directory);

    await call(ledger, edit('denied', path, 'one', 'two'), nothing, 'denied');
    await call(ledger, edit('failed', path, 'one', 'two'), nothing, 'error');
    await call(ledger, edit('stopped', path, 'one', 'two'), nothing, 'cancelled');

    expect(ledger.changes()).toEqual([]);
    expect(ledger.files()).toEqual([]);
    expect(await ledger.undo()).toEqual({ ok: false, reason: 'there is nothing to undo' });
  });

  it('ignores a call that is not a file edit, and an end it never saw a start for', async () => {
    const directory = await temporaryDirectory();
    const ledger = new ChangeLedger(directory);

    await ledger.onToolStart({ id: 'b1', name: 'Bash', input: { command: 'ls' }, ts: NOW });
    await ledger.onToolEnd({ id: 'b1', status: 'ok' });
    await ledger.onToolEnd({ id: 'never-started', status: 'ok' });

    expect(ledger.changes()).toEqual([]);
  });

  it('records a file that did not exist as absent, and undoing it deletes the file', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'new.md');
    const ledger = new ChangeLedger(directory);

    await call(ledger, write('t1', path, 'fresh\n'), () => writeFile(path, 'fresh\n'));

    expect(ledger.last()?.before).toEqual({ kind: 'absent' });
    expect(await ledger.undo()).toEqual({ ok: true, path, action: 'deleted' });
    await expect(stat(path)).rejects.toThrow();
    expect(ledger.changes()).toEqual([]);
  });

  it('restores the pre-image, and forgets the change rather than recording the undo', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'a.txt');
    await writeFile(path, 'one\ntwo\n');
    const ledger = new ChangeLedger(directory);

    await call(ledger, edit('t1', path, 'two', 'three'), () => writeFile(path, 'one\nthree\n'));
    expect(await ledger.undo()).toEqual({ ok: true, path, action: 'restored' });

    expect(await readFile(path, 'utf8')).toBe('one\ntwo\n');
    // An undo that recorded a change could itself be undone, which is a loop.
    expect(ledger.changes()).toEqual([]);
    expect(ledger.files()).toEqual([]);
    expect(ledger.last()).toBeUndefined();
  });

  it('refuses when the file has changed since the edit, and leaves both the file and the record alone', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'a.txt');
    await writeFile(path, 'one\n');
    const ledger = new ChangeLedger(directory);

    await call(ledger, edit('t1', path, 'one', 'two'), () => writeFile(path, 'two\n'));
    // Somebody else — a second edit, an editor, a formatter — got there first.
    await writeFile(path, 'two\nand mine\n');

    expect(await ledger.undo()).toEqual({ ok: false, reason: 'the file has changed since' });
    expect(await readFile(path, 'utf8')).toBe('two\nand mine\n');
    // The record survives a refusal: `/diff` should still be able to show it.
    expect(ledger.changes()).toHaveLength(1);
  });

  it('refuses to delete a created file that has been written to since', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'new.md');
    const ledger = new ChangeLedger(directory);

    await call(ledger, write('t1', path, 'fresh\n'), () => writeFile(path, 'fresh\n'));
    await writeFile(path, 'fresh\nand mine\n');

    expect(await ledger.undo()).toEqual({ ok: false, reason: 'the file has changed since' });
    expect(await readFile(path, 'utf8')).toBe('fresh\nand mine\n');
  });

  it('undoes the named change rather than the newest when asked', async () => {
    const directory = await temporaryDirectory();
    const first = join(directory, 'first.txt');
    const second = join(directory, 'second.txt');
    await writeFile(first, 'one\n');
    await writeFile(second, 'alpha\n');
    const ledger = new ChangeLedger(directory);

    await call(ledger, edit('t1', first, 'one', 'two'), () => writeFile(first, 'two\n'), 'ok');
    await call(ledger, edit('t2', second, 'alpha', 'beta', NOW + 1), () => writeFile(second, 'beta\n'));

    expect(await ledger.undo('t1')).toEqual({ ok: true, path: first, action: 'restored' });
    expect(await readFile(first, 'utf8')).toBe('one\n');
    expect(await readFile(second, 'utf8')).toBe('beta\n');
    expect(ledger.changes().map((change) => change.id)).toEqual(['t2']);

    const gone = await ledger.undo('t1');
    expect(gone.ok).toBe(false);
  });

  it('keeps the changes in the order the calls started, whatever order they end in', async () => {
    const directory = await temporaryDirectory();
    const early = join(directory, 'early.txt');
    const late = join(directory, 'late.txt');
    await writeFile(early, 'one\n');
    await writeFile(late, 'one\n');
    const ledger = new ChangeLedger(directory);

    // Two parallel calls: the second one started ends first.
    await ledger.onToolStart(edit('early', early, 'one', 'two', NOW));
    await ledger.onToolStart(edit('late', late, 'one', 'two', NOW + 5));
    await writeFile(late, 'two\n');
    await ledger.onToolEnd({ id: 'late', status: 'ok' });
    await writeFile(early, 'two\n');
    await ledger.onToolEnd({ id: 'early', status: 'ok' });

    expect(ledger.changes().map((change) => change.id)).toEqual(['late', 'early']);
    expect(ledger.last()?.id).toBe('late');
  });

  it('adds up each file across the session, most recently touched first', async () => {
    const directory = await temporaryDirectory();
    const a = join(directory, 'a.txt');
    const b = join(directory, 'nested', 'b.txt');
    await writeFile(a, 'one\n');
    const ledger = new ChangeLedger(directory);

    await call(ledger, edit('t1', a, 'one', 'two', NOW), () => writeFile(a, 'two\n'));
    await call(ledger, write('t2', b, 'x\ny', NOW + 10), async () => {
      await mkdir(join(directory, 'nested'), { recursive: true });
      await writeFile(b, 'x\ny');
    });
    await call(ledger, edit('t3', a, 'two', 'three', NOW + 20), () => writeFile(a, 'three\n'));

    expect(ledger.files()).toEqual([
      { path: a, label: 'a.txt', added: 2, removed: 2, edits: 2, last: NOW + 20 },
      { path: b, label: 'nested/b.txt', added: 2, removed: 0, edits: 1, last: NOW + 10 },
    ]);

    // An undo takes its share of the totals back out with it.
    expect((await ledger.undo('t3')).ok).toBe(true);
    expect(ledger.files()[0]).toMatchObject({ path: a, added: 1, removed: 1, edits: 1 });
  });

  it('forgets a file entirely once its last change is undone', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'a.txt');
    await writeFile(path, 'one\n');
    const ledger = new ChangeLedger(directory);

    await call(ledger, edit('t1', path, 'one', 'two'), () => writeFile(path, 'two\n'));
    expect(await ledger.undo()).toMatchObject({ ok: true });
    expect(ledger.files()).toEqual([]);
    expect(summarizeFiles(ledger.files())).toBe('');
  });

  it('starts empty again on a new conversation', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'a.txt');
    await writeFile(path, 'one\n');
    const ledger = new ChangeLedger(directory);

    await call(ledger, edit('t1', path, 'one', 'two'), () => writeFile(path, 'two\n'));
    ledger.reset();

    expect(ledger.changes()).toEqual([]);
    expect(ledger.files()).toEqual([]);
    expect(await ledger.undo()).toEqual({ ok: false, reason: 'there is nothing to undo' });
  });

  it('records a file it cannot read as unknown, and refuses to restore it', async () => {
    const disk = fakeDisk();
    const cwd = resolve('/work');
    const path = resolve(cwd, 'locked.txt');
    disk.files.set(path, 'one\n');
    const ledger = new ChangeLedger(cwd, {
      ...disk.deps,
      readFile: async (target) => {
        if (target === path) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return '';
      },
    });

    await call(ledger, edit('t1', path, 'one', 'two'), async () => {
      disk.files.set(path, 'two\n');
    });

    expect(ledger.last()?.before).toEqual({ kind: 'unknown' });
    expect(await ledger.undo()).toEqual({ ok: false, reason: 'locked.txt could not be read before the edit' });
  });

  it('will not copy a file past the snapshot cap, and says so instead of restoring it', async () => {
    const disk = fakeDisk();
    const cwd = resolve('/work');
    const path = resolve(cwd, 'huge.log');
    disk.files.set(path, 'x'.repeat(MAX_SNAPSHOT_BYTES + 1));
    const ledger = new ChangeLedger(cwd, disk.deps);

    await call(ledger, edit('t1', path, 'x', 'y'), async () => {
      disk.files.set(path, 'y'.repeat(MAX_SNAPSHOT_BYTES + 1));
    });

    expect(ledger.last()?.before).toEqual({ kind: 'too large', bytes: MAX_SNAPSHOT_BYTES + 1 });
    expect(await ledger.undo()).toEqual({ ok: false, reason: 'huge.log was too large to snapshot before the edit' });
    // Still a change: it is in `/diff` and in the totals, it just cannot be
    // taken back.
    expect(ledger.changes()).toHaveLength(1);
  });

  it('keeps the last fifty edits, and the totals of every edit before them', async () => {
    const disk = fakeDisk();
    const cwd = resolve('/work');
    const ledger = new ChangeLedger(cwd, disk.deps);
    const count = MAX_CHANGES + 5;

    for (let index = 0; index < count; index += 1) {
      const path = resolve(cwd, `f${String(index)}.txt`);
      disk.files.set(path, 'one\n');
      await call(ledger, edit(`t${String(index)}`, path, 'one', 'two', NOW + index), async () => {
        disk.files.set(path, 'two\n');
      });
    }

    expect(ledger.changes()).toHaveLength(MAX_CHANGES);
    expect(ledger.last()?.id).toBe(`t${String(count - 1)}`);
    expect(ledger.changes().map((change) => change.id)).not.toContain('t0');
    // Evicting a pre-image is a memory decision, not a claim that the edit
    // never happened: "files changed" still counts all of them.
    expect(ledger.files()).toHaveLength(count);
    expect(summarizeFiles(ledger.files())).toBe(`${String(count)} files · +${String(count)} -${String(count)}`);
  });

  it('snapshots every file of a patch and records one change for each', async () => {
    const directory = await temporaryDirectory();
    const a = join(directory, 'a.txt');
    const b = join(directory, 'b.txt');
    await writeFile(a, 'one\n');
    await writeFile(b, 'alpha\n');
    const ledger = new ChangeLedger(directory);

    await call(ledger, patch('p1', [applied(a, 'one', 'two'), applied(b, 'alpha', 'beta')]), async () => {
      await writeFile(a, 'two\n');
      await writeFile(b, 'beta\n');
    });

    // Both files, each with the content that is no longer on disk — the second
    // one is the whole point: it used to be dropped.
    expect(ledger.changes().map((change) => change.id)).toEqual(['p1#2', 'p1#1']);
    expect(ledger.changes().map((change) => change.path)).toEqual([b, a]);
    expect(ledger.changes().map((change) => change.before)).toEqual([
      { kind: 'content', text: 'alpha\n' },
      { kind: 'content', text: 'one\n' },
    ]);
    expect(ledger.files()).toEqual([
      { path: a, label: 'a.txt', added: 1, removed: 1, edits: 1, last: NOW },
      { path: b, label: 'b.txt', added: 1, removed: 1, edits: 1, last: NOW },
    ]);

    // And each is undone on its own: the patch is not the unit a person takes
    // back, the file is.
    expect(await ledger.undo('p1#1')).toEqual({ ok: true, path: a, action: 'restored' });
    expect(await readFile(a, 'utf8')).toBe('one\n');
    expect(await readFile(b, 'utf8')).toBe('beta\n');
    expect(ledger.files().map((file) => file.label)).toEqual(['b.txt']);
  });

  it('lists a file named without a diff, and refuses to undo it', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'named.ts');
    await writeFile(path, 'one\n');
    const reads: string[] = [];
    const ledger = new ChangeLedger(directory, {
      readFile: async (target) => {
        reads.push(target);
        return readFile(target, 'utf8');
      },
    });

    await call(ledger, patch('p1', [{ path, kind: 'update' }]), () => writeFile(path, 'two\n'));

    // Named, counted as an edit, and honest about knowing nothing else: zero is
    // what is known, not a claim that nothing changed.
    expect(ledger.files()).toEqual([
      { path, label: 'named.ts', added: 0, removed: 0, edits: 1, last: NOW },
    ]);
    expect(ledger.last()?.before).toEqual({ kind: 'not taken' });
    // Never read, before the edit or after it: there is nothing to compare.
    expect(reads).toEqual([]);

    expect(await ledger.undo()).toEqual({
      ok: false,
      reason: 'this edit carried no content to restore',
    });
    // Refused, and the file left exactly as the tool left it.
    expect(await readFile(path, 'utf8')).toBe('two\n');
    expect(ledger.changes()).toHaveLength(1);
  });

  it('puts back a file the patch deleted', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'gone.txt');
    await writeFile(path, 'one\ntwo\n');
    const ledger = new ChangeLedger(directory);

    await call(ledger, patch('p1', [deleted(path, 'one\ntwo\n')]), () => rm(path));

    const change = ledger.last();
    expect(change?.edit.operation).toBe('delete');
    expect(change?.before).toEqual({ kind: 'content', text: 'one\ntwo\n' });
    // A deleted file is the case the after-image has to handle as a state
    // rather than as a hash: absent is what it is supposed to be now.
    expect(await ledger.undo()).toEqual({ ok: true, path, action: 'restored' });
    expect(await readFile(path, 'utf8')).toBe('one\ntwo\n');
  });

  it('stops retaining pre-images once they add up past the budget', async () => {
    const disk = fakeDisk();
    const cwd = resolve('/work');
    const ledger = new ChangeLedger(cwd, disk.deps);
    const big = 'x'.repeat(MAX_SNAPSHOT_BYTES);
    const fits = MAX_LEDGER_BYTES / MAX_SNAPSHOT_BYTES;

    for (let index = 0; index <= fits; index += 1) {
      const path = resolve(cwd, `big${String(index)}.bin`);
      disk.files.set(path, big);
      await call(ledger, edit(`t${String(index)}`, path, 'x', 'y', NOW + index), async () => {
        disk.files.set(path, `${big}y`);
      });
    }

    // One more than the budget holds went in, so the oldest came out — by
    // bytes, well before the count cap of fifty would have applied.
    expect(ledger.changes()).toHaveLength(fits);
    expect(ledger.changes().map((change) => change.id)).not.toContain('t0');
    expect(ledger.last()?.id).toBe(`t${String(fits)}`);
  });
});

/* -------------------------------------------------------------------------- */
/* git                                                                        */
/* -------------------------------------------------------------------------- */

const gitOnPath = async (): Promise<boolean> => {
  try {
    await run('git', ['--version']);
    return true;
  } catch {
    return false;
  }
};

/** Identity and signing forced on the command line, so nobody's global config
 *  can fail a commit that only exists to give the diff something to be against. */
const COMMIT = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

describe('gitDiff', () => {
  it('shows the tracked change and names the untracked file', async (context) => {
    if (!(await gitOnPath())) context.skip('git is not on PATH');
    const directory = await temporaryDirectory();
    await run('git', ['init'], { cwd: directory });
    await writeFile(join(directory, 'tracked.txt'), 'one\n');
    await run('git', ['add', 'tracked.txt'], { cwd: directory });
    await run('git', [...COMMIT, 'commit', '-m', 'first'], { cwd: directory });
    await writeFile(join(directory, 'tracked.txt'), 'one\ntwo\n');
    await writeFile(join(directory, 'untracked.txt'), 'never added\n');

    const result = await gitDiff(directory);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('Untracked:');
    expect(result.text).toContain('untracked.txt');
    expect(result.text).toContain('tracked.txt |');
    expect(result.text).toContain('+two');
    // The names of untracked files, not their contents: a `/diff` that dumped
    // every new file would bury the change the reader came for.
    expect(result.text).not.toContain('never added');
  });

  it('diffs against the index in a repository with no commits yet', async (context) => {
    if (!(await gitOnPath())) context.skip('git is not on PATH');
    const directory = await temporaryDirectory();
    await run('git', ['init'], { cwd: directory });
    await writeFile(join(directory, 'staged.txt'), 'first\n');
    await run('git', ['add', 'staged.txt'], { cwd: directory });

    const result = await gitDiff(directory);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // There is no HEAD to diff against, and `git diff` alone would say nothing
    // at all about a directory whose every file is new.
    expect(result.text).toContain('staged.txt');
    expect(result.text).toContain('+first');
  });

  it('is empty, not an error, for a clean work tree', async (context) => {
    if (!(await gitOnPath())) context.skip('git is not on PATH');
    const directory = await temporaryDirectory();
    await run('git', ['init'], { cwd: directory });
    await writeFile(join(directory, 'tracked.txt'), 'one\n');
    await run('git', ['add', 'tracked.txt'], { cwd: directory });
    await run('git', [...COMMIT, 'commit', '-m', 'first'], { cwd: directory });

    expect(await gitDiff(directory)).toEqual({ ok: true, text: '' });
  });

  it('says so when the directory is not a repository', async (context) => {
    if (!(await gitOnPath())) context.skip('git is not on PATH');
    const directory = await temporaryDirectory();

    const result = await gitDiff(directory);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('not a git repository');
  });

  it('says so when git is not installed', async () => {
    const result = await gitDiff('/anywhere', {
      run: () => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })),
    });

    expect(result).toEqual({ ok: false, reason: 'git is not on PATH' });
  });

  it('lists only the untracked names, and is not fooled by a rename', async () => {
    const result = await gitDiff('/work', {
      run: (args) => {
        if (args[0] === 'rev-parse') return Promise.resolve('');
        if (args[0] === 'status') {
          // A rename carries a second, NUL-separated path for its source; read
          // naively, `old.txt` would look like the next record's status.
          return Promise.resolve('R  new.txt\0old.txt\0?? fresh.txt\0 M edited.txt\0');
        }
        return Promise.resolve('');
      },
    });

    expect(result).toEqual({ ok: true, text: 'Untracked:\n  fresh.txt' });
  });
});

/* -------------------------------------------------------------------------- */
/* Saying it in a line                                                        */
/* -------------------------------------------------------------------------- */

const changed = (label: string, added: number, removed: number): ChangedFile => ({
  path: `/w/${label}`,
  label,
  added,
  removed,
  edits: 1,
  last: NOW,
});

describe('summarizeFiles', () => {
  it('counts the files and the churn', () => {
    expect(summarizeFiles([changed('a.ts', 40, 5), changed('b.ts', 1, 2), changed('c.ts', 1, 0)])).toBe('3 files · +42 -7');
  });

  it('says nothing at all when nothing has changed', () => {
    expect(summarizeFiles([])).toBe('');
  });

  it('keeps the noun singular for one file', () => {
    expect(summarizeFiles([changed('a.ts', 3, 0)])).toBe('1 file · +3 -0');
  });

  it('drops the churn before the count when the bar is narrow', () => {
    const files = [changed('a.ts', 40, 5), changed('b.ts', 1, 2), changed('c.ts', 1, 0)];
    expect(summarizeFiles(files, 16)).toBe('3 files · +42 -7');
    expect(summarizeFiles(files, 15)).toBe('3 files');
    expect(summarizeFiles(files, 3)).toBe('3 f');
  });
});

describe('fileLines', () => {
  it('lines the counts up in a column', () => {
    expect(fileLines([changed('src/a.ts', 3, 1), changed('b.ts', 10, 2)])).toEqual([
      'src/a.ts   +3 -1',
      'b.ts      +10 -2',
    ]);
  });

  it('shortens the path from the left, keeping the filename', () => {
    const [line] = fileLines([changed('apps/tui/src/components/Composer.tsx', 3, 1)], 20);
    expect(line).toBe('…Composer.tsx  +3 -1');
    expect(line).toHaveLength(20);
  });

  it('gives the whole line when there is no room to lay it out', () => {
    expect(fileLines([changed('a.ts', 3, 1)], 4)).toEqual(['a.ts  +3 -1']);
  });

  it('has nothing to say about no files', () => {
    expect(fileLines([])).toEqual([]);
  });
});
