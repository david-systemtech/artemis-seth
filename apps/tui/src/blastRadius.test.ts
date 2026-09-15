/**
 * This module's promise has two halves, and they fail in different ways, so
 * they are tested differently.
 *
 * The recogniser is a table: a string in, a list of segments out, and every
 * interesting case is a line. Most of the lines are about *not* firing — a
 * `--soft` reset, an `>>` append, a `git checkout` that moves a branch — because
 * a card that warns about everything is a card people learn to click through,
 * and a false positive is the failure mode that costs the feature its point.
 *
 * The previews run against a real temporary tree wherever the thing being
 * checked is arithmetic about a filesystem: a glob that has to skip dotfiles,
 * a directory counted recursively, a size read off a file. The caps are the
 * exception, where 2500 files would be built to prove a number, so those use a
 * `Map` standing in for the disk — which doubles as the check that the injected
 * `deps` really are the only way this module reaches a filesystem.
 *
 * And then the rule the whole module exists to keep: it must never run the
 * command it is previewing. That is checked twice over. Once at the boundary,
 * by pinning {@link assertReadOnly} and {@link cleanArgv} directly. Once from
 * the outside, by driving every git verb through a fake `execFile` that records
 * each argv, and judging what it recorded against a rule this file writes out
 * itself rather than importing — because a test that asks the implementation
 * what counts as safe would agree with any bug it contained.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  BLAST_TIMEOUT_MS,
  MAX_ENTRIES,
  assertReadOnly,
  blastRadiusLines,
  cleanArgv,
  destructiveParts,
  previewBlastRadius,
  type BlastRadiusDeps,
  type Destructive,
  type DirEntry,
  type Preview,
} from './blastRadius.js';

// ---------------------------------------------------------------------------
// A disk, and a git that is only ever asked questions
// ---------------------------------------------------------------------------

const temporaries: string[] = [];
afterAll(async () => {
  for (const directory of temporaries) await rm(directory, { recursive: true, force: true });
});

/**
 * A small tree, rebuilt per test.
 *
 * It has the four things the glob expander has to get right: nesting, a
 * dotfile, a directory whose name is not a match, and a file literally called
 * `*`, which is the only way to tell an expanded pattern from a quoted one.
 */
async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'artemis-blast-'));
  temporaries.push(root);
  await mkdir(join(root, 'build', 'nested', 'deep'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.cache'), { recursive: true });
  // Windows cannot name a file `*`, so the tree has no such file there and the
  // one test that needs it is skipped on that platform.
  const names = ['build/a.js', 'build/b.js', 'build/nested/c.js', 'build/nested/deep/d.js', 'src/a.ts', 'src/b.ts', 'keep.txt', '.dotfile'];
  if (process.platform !== 'win32') names.push('*');
  for (const path of names) {
    await writeFile(join(root, path), 'x');
  }
  await writeFile(join(root, 'log.txt'), 'hello world');
  await writeFile(join(root, 'empty.txt'), '');
  return root;
}

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeout: number;
}

/** A `git` that answers from a table and remembers every question. */
function recorder(replies: Readonly<Record<string, string>> = {}): { readonly execFile: BlastRadiusDeps['execFile']; readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    execFile: async (file, args, options) => {
      calls.push({ file, args: [...args], cwd: options.cwd, timeout: options.timeout });
      const key = [file, ...args].join(' ');
      const reply = replies[key];
      if (reply === undefined) throw new Error(`nothing canned for: ${key}`);
      return reply;
    },
  };
}

/** A filesystem made of a `Map`, for the cases where building one would be absurd. */
function fakeDisk(directories: ReadonlyMap<string, readonly DirEntry[]>): BlastRadiusDeps {
  return {
    execFile: async (file) => {
      throw new Error(`previewing rm must not run ${file}`);
    },
    // Keys are resolved on both sides, so `/w` and `\\w` and `D:\\w` are one
    // directory whatever the host's separator and drive letter make of them.
    readdir: async (path) => {
      const entries = directories.get(resolve(path));
      if (entries === undefined) throw new Error(`not a directory: ${path}`);
      return entries;
    },
    stat: async (path) => ({ size: 0, directory: directories.has(resolve(path)) }),
    timeoutMs: BLAST_TIMEOUT_MS,
  };
}

const kinds = (command: string): readonly string[] => destructiveParts(command).map((part) => part.kind);

const only = async (command: string, cwd: string, deps: Partial<BlastRadiusDeps> = {}): Promise<Preview> => {
  const previews = await previewBlastRadius(destructiveParts(command), cwd, deps);
  const first = previews[0];
  if (first === undefined) throw new Error(`no preview for: ${command}`);
  return first;
};

// ===========================================================================

describe('reading a command line', () => {
  it('keeps a quoted path whole, and a quoted glob literal', () => {
    expect(destructiveParts('rm "my notes.txt" \'a b\'')[0]?.targets).toEqual(['my notes.txt', 'a b']);
    // The escape is how a quoted `*` survives as a filename rather than a pattern.
    expect(destructiveParts("rm '*'")[0]?.targets).toEqual(['\\*']);
    expect(destructiveParts('rm *')[0]?.targets).toEqual(['*']);
    expect(destructiveParts('rm my\\ file')[0]?.targets).toEqual(['my file']);
  });

  it('finds the rm on the far side of &&, ||, ; and a pipe', () => {
    expect(destructiveParts('npm ci && rm -rf node_modules')[0]).toMatchObject({ text: 'rm -rf node_modules', targets: ['node_modules'] });
    expect(destructiveParts('test -d tmp || rm -r tmp')[0]?.targets).toEqual(['tmp']);
    expect(destructiveParts('rm a; rm b').map((part) => part.targets)).toEqual([['a'], ['b']]);
    expect(kinds('ls | rm x')).toEqual(['rm']);
    expect(destructiveParts('cd /tmp\nrm -rf junk')[0]?.text).toBe('rm -rf junk');
  });

  it('reads nothing out of a comment', () => {
    expect(destructiveParts('echo hi # rm -rf /')).toEqual([]);
    expect(destructiveParts('# rm -rf /\nls')).toEqual([]);
    // A `#` in the middle of a word is part of the word, not a comment.
    expect(destructiveParts('rm note#1.txt')[0]?.targets).toEqual(['note#1.txt']);
  });

  it('takes a redirect target for a redirect and not an operand', () => {
    expect(destructiveParts('rm foo > log.txt')).toEqual([
      { kind: 'rm', text: 'rm foo > log.txt', targets: ['foo'], flags: [] },
      { kind: 'truncate-redirect', text: 'rm foo > log.txt', targets: ['log.txt'], flags: [] },
    ]);
    // The `2` is a file descriptor, so it must not join `rm`'s operands.
    expect(destructiveParts('rm foo 2> err.log')[0]?.targets).toEqual(['foo']);
    expect(destructiveParts('cat a < b')).toEqual([]);
  });
});

describe('the verbs it knows', () => {
  it('recognises rm with any flags, and notes them', () => {
    expect(destructiveParts('rm -rf build dist')[0]).toEqual({ kind: 'rm', text: 'rm -rf build dist', targets: ['build', 'dist'], flags: ['-rf'] });
    // A plain delete of one named file is still a delete.
    expect(destructiveParts('rm notes.txt')[0]).toMatchObject({ kind: 'rm', flags: [] });
    expect(destructiveParts('rm -- -weird')[0]?.targets).toEqual(['-weird']);
    expect(destructiveParts('rm')).toEqual([]);
  });

  it('recognises git clean, folding an exclusion into one word', () => {
    expect(destructiveParts('git clean -fdx -e node_modules -- src')[0]).toEqual({
      kind: 'git-clean',
      text: 'git clean -fdx -e node_modules -- src',
      targets: ['src'],
      flags: ['-fdx', '--exclude=node_modules'],
    });
    expect(destructiveParts('git clean --exclude build -f')[0]?.flags).toEqual(['--exclude=build', '-f']);
  });

  it('recognises git reset --hard and leaves the other resets alone', () => {
    expect(destructiveParts('git reset --hard origin/main')[0]).toMatchObject({ kind: 'git-reset-hard', targets: ['origin/main'], flags: ['--hard'] });
    expect(destructiveParts('git reset --soft HEAD~1')).toEqual([]);
    expect(destructiveParts('git reset')).toEqual([]);
  });

  it('recognises the three ways to force a push, and not a plain one', () => {
    expect(kinds('git push --force origin main')).toEqual(['git-push-force']);
    expect(kinds('git push -f')).toEqual(['git-push-force']);
    expect(kinds('git push --force-with-lease=main:abc123 origin main')).toEqual(['git-push-force']);
    expect(destructiveParts('git push --force origin main')[0]?.targets).toEqual(['origin', 'main']);
    expect(destructiveParts('git push origin main')).toEqual([]);
    // git's own options come before the subcommand and must not hide it.
    expect(kinds('git -C /srv/repo push -f')).toEqual(['git-push-force']);
  });

  it('recognises the discarding forms of checkout and restore only', () => {
    expect(destructiveParts('git checkout -- src/a.ts src/b.ts')[0]).toMatchObject({ kind: 'git-checkout-discard', targets: ['src/a.ts', 'src/b.ts'] });
    expect(destructiveParts('git restore src/a.ts')[0]).toMatchObject({ kind: 'git-checkout-discard', targets: ['src/a.ts'] });
    // Moving to a branch is not discarding, and `--staged` leaves the work tree alone.
    expect(destructiveParts('git checkout main')).toEqual([]);
    expect(destructiveParts('git checkout -b feature')).toEqual([]);
    expect(destructiveParts('git restore --staged src/a.ts')).toEqual([]);
    expect(kinds('git restore --staged --worktree src/a.ts')).toEqual(['git-checkout-discard']);
  });

  it('recognises git branch -D and leaves -d alone', () => {
    expect(destructiveParts('git branch -D feature old')[0]).toMatchObject({ kind: 'git-branch-delete', targets: ['feature', 'old'], flags: ['-D'] });
    expect(kinds('git branch --delete --force feature')).toEqual(['git-branch-delete']);
    // `-d` refuses to drop an unmerged branch, so it destroys nothing git kept.
    expect(destructiveParts('git branch -d feature')).toEqual([]);
    expect(destructiveParts('git branch -a')).toEqual([]);
  });

  it('recognises a DROP inside psql -c and mysql -e', () => {
    expect(destructiveParts('psql -c "DROP TABLE users, orders CASCADE;"')[0]).toMatchObject({ kind: 'drop', targets: ['users', 'orders'], flags: ['table'] });
    expect(destructiveParts("mysql -e 'drop database if exists shop'")[0]).toMatchObject({ kind: 'drop', targets: ['shop'], flags: ['database'] });
    expect(destructiveParts('psql --command="DROP TABLE a"')[0]?.targets).toEqual(['a']);
    expect(destructiveParts('psql -c "SELECT * FROM users"')).toEqual([]);
  });

  it('recognises a truncating redirect and leaves an append alone', () => {
    expect(destructiveParts('echo hi > notes.txt')[0]).toMatchObject({ kind: 'truncate-redirect', targets: ['notes.txt'] });
    expect(destructiveParts('echo hi >> notes.txt')).toEqual([]);
    // Nobody loses anything down /dev/null.
    expect(destructiveParts('make > /dev/null')).toEqual([]);
  });

  it('recognises chmod -R, find -delete and find -exec rm', () => {
    expect(destructiveParts('chmod -R 777 /srv/app')[0]).toMatchObject({ kind: 'chmod-recursive', targets: ['/srv/app'], flags: ['-R'] });
    expect(destructiveParts('chmod 777 /srv/app')).toEqual([]);
    expect(destructiveParts('find . -name "*.log" -delete')[0]).toMatchObject({ kind: 'find-delete', targets: ['.'], flags: ['-delete'] });
    expect(destructiveParts('find build tmp -type f -exec rm -f {} +')[0]).toMatchObject({ kind: 'find-delete', targets: ['build', 'tmp'] });
    expect(destructiveParts('find . -name "*.log" -print')).toEqual([]);
  });

  it('sees through sudo, env and a leading assignment', () => {
    expect(destructiveParts('sudo rm -rf /var/cache/x')[0]?.targets).toEqual(['/var/cache/x']);
    expect(destructiveParts('env -u HOME rm x')[0]?.targets).toEqual(['x']);
    expect(destructiveParts('FOO=bar rm x')[0]?.targets).toEqual(['x']);
    expect(destructiveParts('/bin/rm x')[0]?.targets).toEqual(['x']);
  });

  it('yields nothing for a command that destroys nothing', () => {
    for (const command of [
      'ls -la',
      'pnpm install && pnpm test',
      'git status --porcelain',
      'git commit -m "rm -rf build"',
      'echo "rm -rf /"',
      'grep -rn "rm" src/',
      'cat a.txt | wc -l',
      'mkdir -p build',
      '',
      '   ',
    ]) {
      expect(destructiveParts(command), command).toEqual([]);
    }
  });
});

describe('previewing rm against a directory', () => {
  it('expands a glob one level deep and lists what it matched', async () => {
    const root = await tree();
    expect(await only('rm build/*.js', root)).toMatchObject({ kind: 'rm', summary: '2 files', lines: ['build/a.js', 'build/b.js'], count: 2 });
  });

  it('counts a directory recursively, and counts nothing twice', async () => {
    const root = await tree();
    expect(await only('rm -rf build', root)).toMatchObject({ summary: '1 directory (4 files inside)', lines: ['build/'], count: 1, truncated: false });
    // The file is inside the directory, so it is one blast and not two.
    expect(await only('rm -rf build build/a.js', root)).toMatchObject({ summary: '1 directory (4 files inside)', lines: ['build/'] });
  });

  it('expands **, {a,b} and ? without a shell', async () => {
    const root = await tree();
    expect(await only('rm build/**/*.js', root)).toMatchObject({
      summary: '4 files',
      lines: ['build/a.js', 'build/b.js', 'build/nested/c.js', 'build/nested/deep/d.js'],
    });
    expect(await only('rm src/{a,b}.ts', root)).toMatchObject({ summary: '2 files', lines: ['src/a.ts', 'src/b.ts'] });
    expect(await only('rm src/?.ts', root)).toMatchObject({ summary: '2 files' });
  });

  it.skipIf(process.platform === 'win32')('leaves the dotfiles out of a bare star, and reads a quoted one as a filename', async () => {
    const root = await tree();
    const star = await only('rm -rf *', root);
    expect(star.summary).toBe('4 files and 2 directories (6 files inside)');
    expect(star.lines).not.toContain('.dotfile');
    expect(star.lines).not.toContain('.cache/');
    expect(star.lines).toContain('*');
    // Quoted, it is the one file with that name and nothing else.
    expect(await only("rm '*'", root)).toMatchObject({ summary: '1 file', lines: ['*'], count: 1 });
  });

  it('says nothing is there when nothing matches', async () => {
    const root = await tree();
    expect(await only('rm -rf nope.txt', root)).toMatchObject({ summary: 'nothing matching is there, so nothing would be deleted', count: 0 });
    expect(await only('rm -rf build/*.ts', root)).toMatchObject({ count: 0 });
  });

  it('names a path it cannot expand rather than calling it empty', async () => {
    const root = await tree();
    // Claiming "nothing would be deleted" about `rm -rf ~/work` is the one
    // failure worse than saying nothing at all.
    expect(await only('rm -rf ~/work', root)).toMatchObject({
      summary: 'cannot tell: 1 path needs the shell to expand',
      lines: ['~/work — needs the shell to expand'],
    });
    expect((await only('rm -rf $BUILD_DIR keep.txt', root)).summary).toBe('1 file, and 1 path the shell would have to expand');
  });

  it('stops counting at the cap and says the count is a floor', async () => {
    const directories = new Map<string, readonly DirEntry[]>([
      [resolve('/w'), [{ name: 'big', directory: true }]],
      [resolve('/w', 'big'), Array.from({ length: MAX_ENTRIES + 500 }, (_, index) => ({ name: `f${String(index)}.txt`, directory: false }))],
    ]);
    const preview = await only('rm -rf big', '/w', fakeDisk(directories));
    expect(preview.summary).toBe(`1 directory (${String(MAX_ENTRIES)}+ files inside)`);
    expect(preview.truncated).toBe(true);
  });
});

describe('previewing the things that are not rm', () => {
  it('reports the size a redirect would throw away, and says nothing when there is none', async () => {
    const root = await tree();
    expect(await only('echo hi > log.txt', root)).toMatchObject({ kind: 'truncate-redirect', summary: 'log.txt would be emptied, throwing away 11 B' });
    // Creating a file, or emptying an empty one, destroys nothing.
    expect(await previewBlastRadius(destructiveParts('echo hi > missing.txt'), root)).toEqual([]);
    expect(await previewBlastRadius(destructiveParts('echo hi > empty.txt'), root)).toEqual([]);
  });

  it('counts the entries under a chmod -R and a find -delete', async () => {
    const root = await tree();
    expect(await only('chmod -R 755 build', root)).toMatchObject({ summary: 'chmod -R would change the mode of 6 entries', lines: ['build — 6 entries'] });
    expect(await only('find src -type f -delete', root)).toMatchObject({ summary: 'find would walk 2 entries and delete every match' });
  });

  it('names the objects a DROP would take, and reads no disk to do it', async () => {
    const { execFile, calls } = recorder();
    const preview = await only('psql -c "DROP TABLE users, orders"', '/repo', { execFile });
    expect(preview).toMatchObject({ kind: 'drop', summary: 'would drop 2 tables', lines: ['users', 'orders'] });
    expect(calls).toEqual([]);
  });
});

describe('previewing git, with git standing in', () => {
  it('runs git clean with -n and repeats the paths it printed', async () => {
    const { execFile, calls } = recorder({ 'git clean -n -d -x --exclude=node_modules': 'Would remove dist/\nWould remove tmp.log\n' });
    expect(await only('git clean -fdx -e node_modules', '/repo', { execFile })).toMatchObject({
      kind: 'git-clean',
      summary: 'git clean would remove 2 paths',
      lines: ['dist/', 'tmp.log'],
      count: 2,
    });
    expect(calls).toEqual([{ file: 'git', args: ['clean', '-n', '-d', '-x', '--exclude=node_modules'], cwd: '/repo', timeout: BLAST_TIMEOUT_MS }]);
  });

  it('says git clean would remove nothing when it printed nothing', async () => {
    const { execFile } = recorder({ 'git clean -n': '' });
    expect(await only('git clean -f', '/repo', { execFile })).toMatchObject({ summary: 'git clean would remove nothing', count: 0 });
  });

  it('counts what a reset --hard would lose and names where it would land', async () => {
    const replies = { 'git status --porcelain': ' M a.ts\n?? b.ts\n', 'git log --oneline -1': 'abc1234 the last commit\n' };
    expect(await only('git reset --hard origin/main', '/repo', recorder(replies))).toMatchObject({
      summary: '2 uncommitted changes would be lost, back to origin/main — currently abc1234 the last commit',
      lines: [' M a.ts', '?? b.ts'],
      count: 2,
    });
    expect((await only('git reset --hard', '/repo', recorder({ ...replies, 'git status --porcelain': '' }))).summary).toBe(
      'nothing uncommitted would be lost, back to abc1234 the last commit',
    );
  });

  it('names branch, remote and the commits a force push would discard', async () => {
    const { execFile } = recorder({
      'git rev-parse --abbrev-ref HEAD': 'feature\n',
      'git remote -v': 'origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\n',
      'git rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/feature\n',
      'git rev-list --count HEAD..@{u}': '3\n',
    });
    const preview = await only('git push --force origin main', '/repo', { execFile });
    expect(preview.summary).toBe('force-push feature to origin: would discard 3 remote commits');
    expect(preview.lines[0]).toBe('upstream: origin/feature');
  });

  it('says so when there is no upstream to read', async () => {
    const { execFile, calls } = recorder({
      'git rev-parse --abbrev-ref HEAD': 'feature\n',
      'git remote -v': 'origin\tgit@github.com:a/b.git (fetch)\n',
      // No `@{u}`: the query fails the way git fails it, and nothing is invented.
    });
    expect((await only('git push -f', '/repo', { execFile })).summary).toBe('force-push feature to origin: no upstream is set, so what is on the remote cannot be read');
    expect(calls.map((call) => call.args.join(' '))).not.toContain('rev-list --count HEAD..@{u}');
  });

  it('marks each checked-out path with whether it has local changes', async () => {
    const { execFile } = recorder({ 'git diff --name-only --relative': 'src/a.ts\n' });
    expect(await only('git checkout -- src/a.ts src/b.ts', '/repo', { execFile })).toMatchObject({
      summary: '1 of 2 paths would lose local changes',
      lines: ['src/a.ts — local changes would be lost', 'src/b.ts — no local changes'],
    });
    const clean = recorder({ 'git diff --name-only --relative': '' });
    expect((await only('git restore src/a.ts', '/repo', clean)).summary).toBe('none of these paths has local changes to lose');
  });

  it('says whether each branch being deleted is merged', async () => {
    const { execFile } = recorder({ 'git branch --merged': '* main\n  old\n  (HEAD detached at abc1234)\n' });
    expect(await only('git branch -D old new', '/repo', { execFile })).toMatchObject({
      summary: '1 of 2 branches not merged',
      lines: ['old — merged, nothing would become unreachable', 'new — not merged into HEAD; its commits would become unreachable'],
    });
    const merged = recorder({ 'git branch --merged': '* main\n  old\n' });
    expect((await only('git branch -D old', '/repo', merged)).summary).toBe('that branch is already merged');
  });

  it('turns a failing git into one could-not-preview line rather than throwing', async () => {
    const { execFile } = recorder({});
    const preview = await only('git reset --hard', '/repo', { execFile });
    expect(preview.summary).toBe('could not preview: nothing canned for: git status --porcelain');
    expect(preview.lines).toEqual([]);

    const noisy: BlastRadiusDeps['execFile'] = async () => {
      throw new Error(`fatal: not a git repository\n${'x'.repeat(400)}`);
    };
    const clipped = await only('git clean -f', '/repo', { execFile: noisy });
    expect(clipped.summary).toBe('could not preview: fatal: not a git repository');
  });
});

describe('it never runs the command it previews', () => {
  it('records only read-only git queries, across every verb at once', async () => {
    const root = await tree();
    const { execFile, calls } = recorder({
      'git clean -n -d -x': 'Would remove dist/\n',
      'git status --porcelain': ' M a.ts\n',
      'git log --oneline -1': 'abc1234 head\n',
      'git rev-parse --abbrev-ref HEAD': 'main\n',
      'git remote -v': 'origin\tssh://example/a.git (fetch)\n',
      'git rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/main\n',
      'git rev-list --count HEAD..@{u}': '2\n',
      'git diff --name-only --relative': 'src/a.ts\n',
      'git branch --merged': '* main\n',
    });
    const command = [
      'git clean -fdx',
      'git reset --hard HEAD~3',
      'git push --force origin main',
      'git checkout -- src/a.ts',
      'git branch -D old',
      'rm -rf build',
      'chmod -R 777 src',
      'echo x > log.txt',
    ].join(' && ');

    const previews = await previewBlastRadius(destructiveParts(command), root, { execFile });
    expect(previews).toHaveLength(8);

    // The rule, written here rather than imported: a test that asked the module
    // what counts as safe would agree with whatever it had got wrong.
    const readOnlySubcommands = new Set(['status', 'log', 'rev-parse', 'rev-list', 'remote', 'diff', 'branch', 'clean']);
    const mutating = ['-f', '--force', '-i', '--interactive', '--hard', '-D', 'rm', 'add', 'commit', 'checkout', 'restore', 'reset', 'push', 'stash', 'merge', 'rebase', 'filter-branch'];

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const label = [call.file, ...call.args].join(' ');
      expect(call.file, label).toBe('git');
      const [subcommand, ...rest] = call.args;
      expect(subcommand !== undefined && readOnlySubcommands.has(subcommand), label).toBe(true);
      if (subcommand === 'clean') expect(rest[0], label).toBe('-n');
      if (subcommand === 'branch') expect(rest, label).toContain('--merged');
      for (const word of mutating) expect(call.args, label).not.toContain(word);
      expect(call.cwd, label).toBe(root);
      expect(call.timeout, label).toBe(BLAST_TIMEOUT_MS);
    }
  });

  it('keeps git clean a dry run whatever flags the command carried', () => {
    const part: Destructive = { kind: 'git-clean', text: '', targets: ['src', 'a b'], flags: ['-dfx', '-i', '--force', '--exclude=node_modules'] };
    const argv = cleanArgv(part);
    expect(argv).toEqual(['clean', '-n', '-d', '-x', '--exclude=node_modules', '--', 'src', 'a b']);
    expect(() => assertReadOnly('git', argv)).not.toThrow();
    // Pathspecs go after `--`, so a target that looks like a flag stays a path.
    expect(cleanArgv({ kind: 'git-clean', text: '', targets: ['-rf'], flags: [] })).toEqual(['clean', '-n', '--', '-rf']);
  });

  it('refuses any argv that is not a known read-only query', () => {
    expect(() => assertReadOnly('git', ['status', '--porcelain'])).not.toThrow();
    expect(() => assertReadOnly('git', ['clean', '-n', '-d', '-x', '--exclude=a', '--', 'src'])).not.toThrow();

    expect(() => assertReadOnly('git', ['clean', '-f'])).toThrow(/only as a dry run/);
    expect(() => assertReadOnly('git', ['clean', '-n', '-f'])).toThrow(/only as a dry run/);
    expect(() => assertReadOnly('git', ['clean', '-n', '-i'])).toThrow(/only as a dry run/);
    expect(() => assertReadOnly('git', ['push', '--force'])).toThrow(/not a known read-only query/);
    expect(() => assertReadOnly('git', ['status'])).toThrow(/not a known read-only query/);
    expect(() => assertReadOnly('rm', ['-rf', '/'])).toThrow(/only read-only git queries/);
    expect(() => assertReadOnly('sh', ['-c', 'rm -rf /'])).toThrow(/only read-only git queries/);
  });
});

describe('blastRadiusLines', () => {
  const previews: readonly Preview[] = [
    { kind: 'rm', summary: '3 files and 1 directory (412 files inside)', lines: ['a.ts', 'b.ts'], count: 5 },
    { kind: 'git-clean', summary: 'git clean would remove nothing', lines: [], count: 0 },
  ];

  it('draws one warning per preview with its detail indented under it', () => {
    expect(blastRadiusLines(previews)).toEqual([
      '⚠ 3 files and 1 directory (412 files inside)',
      '  a.ts',
      '  b.ts',
      '  … +3 more',
      '⚠ git clean would remove nothing',
    ]);
    expect(blastRadiusLines([])).toEqual([]);
  });

  it('clips every line to the width it was given', () => {
    expect(blastRadiusLines([{ kind: 'rm', summary: 'a'.repeat(40), lines: ['b'.repeat(40)] }], 10)).toEqual(['⚠ aaaaaaa…', '  bbbbbbb…']);
    // A width nobody could draw in still yields one character per line.
    expect(blastRadiusLines(previews, 1).every((line) => line.length <= 8)).toBe(true);
  });
});
