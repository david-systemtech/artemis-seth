/**
 * What Artemis decides to run, and what it makes of what comes back.
 *
 * Two halves. The detection half is pure: a fake `PATH` lookup and a fake
 * environment decide which tool is found, and every assertion is the exact
 * argv, so the suite gives the same answer on a laptop with `delta` installed
 * and on a CI box with nothing. The `pipeThrough` half uses a fake child that
 * emits what a real filter would — chunks on stdout, a complaint on stderr, an
 * exit status — so no process is started and the timeout is a few milliseconds
 * rather than ten seconds.
 *
 * The one test that touches the disk is the `PATH` lookup itself, which is the
 * only thing here that can only be true of a real file.
 */

import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_PIPE_BYTES,
  PIPE_TIMEOUT_MS,
  externalDiffTool,
  externalPager,
  externalViewer,
  isOnPath,
  pipeThrough,
  type OnPathFn,
  type PipeSpawnLike,
  type PipeSpawnOptionsLike,
} from './externalTools.js';

/** A `PATH` that holds exactly these programs. */
const holding =
  (...installed: readonly string[]): OnPathFn =>
  (command) =>
    installed.includes(command);

/** A `PATH` nobody is allowed to consult, for the paths that must short-circuit. */
const forbidden: OnPathFn = (command) => {
  throw new Error(`PATH was searched for ${command}`);
};

const everything = holding('delta', 'diff-so-fancy', 'bat', 'less');

const BAT_DIFF_ARGV = ['bat', '--language=diff', '--paging=never', '--style=plain', '--color=always'];

describe('externalDiffTool', () => {
  it('prefers delta, then diff-so-fancy, then bat, then nothing', () => {
    expect(externalDiffTool({ env: {}, which: everything })?.label).toBe('delta');
    expect(externalDiffTool({ env: {}, which: holding('diff-so-fancy', 'bat', 'less') })?.label).toBe('diff-so-fancy');
    expect(externalDiffTool({ env: {}, which: holding('bat', 'less') })?.label).toBe('bat');
    expect(externalDiffTool({ env: {}, which: holding('less') })).toBeNull();
  });

  it('runs each tool with the arguments that keep it from paging', () => {
    expect(externalDiffTool({ env: {}, which: holding('delta') })).toEqual({ argv: ['delta', '--paging=never'], label: 'delta' });
    expect(externalDiffTool({ env: {}, which: holding('diff-so-fancy') })).toEqual({ argv: ['diff-so-fancy'], label: 'diff-so-fancy' });
    expect(externalDiffTool({ env: {}, which: holding('bat') })).toEqual({ argv: BAT_DIFF_ARGV, label: 'bat' });
  });

  it('tells delta how wide the box is, when it was measured', () => {
    expect(externalDiffTool({ env: {}, which: holding('delta'), columns: 96 })).toEqual({
      argv: ['delta', '--paging=never', '--width=96'],
      label: 'delta',
    });
    expect(externalDiffTool({ env: {}, which: holding('delta'), columns: 80.6 })?.argv).toEqual(['delta', '--paging=never', '--width=80']);
  });

  it('leaves the width out when there is no sensible one', () => {
    for (const columns of [undefined, 0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(externalDiffTool({ env: {}, which: holding('delta'), columns })?.argv).toEqual(['delta', '--paging=never']);
    }
  });

  it('does not pass the width to a tool that was not asked for one', () => {
    expect(externalDiffTool({ env: {}, which: holding('bat'), columns: 96 })?.argv).toEqual(BAT_DIFF_ARGV);
    expect(externalDiffTool({ env: { ARTEMIS_DIFF: 'delta' }, which: forbidden, columns: 96 })?.argv).toEqual(['delta']);
  });

  it('lets ARTEMIS_DIFF beat every tool on the path, without searching it', () => {
    expect(externalDiffTool({ env: { ARTEMIS_DIFF: 'ydiff' }, which: forbidden })).toEqual({ argv: ['ydiff'], label: 'ydiff' });
  });

  it('splits an override on whitespace, honouring quotes', () => {
    expect(externalDiffTool({ env: { ARTEMIS_DIFF: 'delta --side-by-side --dark' }, which: forbidden })).toEqual({
      argv: ['delta', '--side-by-side', '--dark'],
      label: 'delta',
    });
    expect(externalDiffTool({ env: { ARTEMIS_DIFF: '"C:\\Program Files\\delta\\delta.exe" --width=80' }, which: forbidden })).toEqual({
      argv: ['C:\\Program Files\\delta\\delta.exe', '--width=80'],
      label: 'delta',
    });
  });

  it('names the program, not the path it was given by', () => {
    expect(externalDiffTool({ env: { ARTEMIS_DIFF: '/opt/homebrew/bin/delta --dark' }, which: forbidden })?.label).toBe('delta');
  });

  it('is turned off by ARTEMIS_DIFF=off, in any case, without searching the path', () => {
    expect(externalDiffTool({ env: { ARTEMIS_DIFF: 'off' }, which: forbidden })).toBeNull();
    expect(externalDiffTool({ env: { ARTEMIS_DIFF: '  OFF  ' }, which: forbidden })).toBeNull();
    expect(externalDiffTool({ env: { ARTEMIS_DIFF: 'Off' }, which: forbidden })).toBeNull();
  });

  it('treats a blank override as one that was never set', () => {
    expect(externalDiffTool({ env: { ARTEMIS_DIFF: '   ' }, which: holding('delta') })?.label).toBe('delta');
    expect(externalDiffTool({ env: { ARTEMIS_DIFF: '""' }, which: holding('delta') })?.label).toBe('delta');
    expect(externalDiffTool({ env: { ARTEMIS_DIFF: '' }, which: holding() })).toBeNull();
  });
});

describe('externalPager', () => {
  it('falls back to less with the flags git uses', () => {
    expect(externalPager({ env: {}, which: holding('less') })).toEqual({ argv: ['less', '-R', '-F', '-X'], label: 'less' });
  });

  it('answers nothing when there is no less either', () => {
    expect(externalPager({ env: {}, which: holding('bat') })).toBeNull();
  });

  it('lets ARTEMIS_PAGER beat PAGER and less', () => {
    expect(externalPager({ env: { ARTEMIS_PAGER: 'moar -width 100', PAGER: 'less' }, which: forbidden })).toEqual({
      argv: ['moar', '-width', '100'],
      label: 'moar',
    });
  });

  it('is turned off by ARTEMIS_PAGER=off', () => {
    expect(externalPager({ env: { ARTEMIS_PAGER: 'off', PAGER: 'less' }, which: forbidden })).toBeNull();
    expect(externalPager({ env: { ARTEMIS_PAGER: 'OFF' }, which: forbidden })).toBeNull();
  });

  it('uses PAGER when it is set to a real pager', () => {
    expect(externalPager({ env: { PAGER: 'less -FRX' }, which: forbidden })).toEqual({ argv: ['less', '-FRX'], label: 'less' });
    expect(externalPager({ env: { PAGER: 'bat --paging=always' }, which: forbidden })).toEqual({ argv: ['bat', '--paging=always'], label: 'bat' });
  });

  it('ignores PAGER=cat and reaches for less instead', () => {
    expect(externalPager({ env: { PAGER: 'cat' }, which: holding('less') })).toEqual({ argv: ['less', '-R', '-F', '-X'], label: 'less' });
    expect(externalPager({ env: { PAGER: '/bin/cat' }, which: holding('less') })?.label).toBe('less');
    expect(externalPager({ env: { PAGER: 'cat -v' }, which: holding('less') })?.label).toBe('less');
    expect(externalPager({ env: { PAGER: 'cat' }, which: holding() })).toBeNull();
  });

  it('does not mistake another program for cat', () => {
    expect(externalPager({ env: { PAGER: 'catn' }, which: forbidden })?.label).toBe('catn');
    expect(externalPager({ env: { PAGER: 'bat' }, which: forbidden })?.label).toBe('bat');
  });
});

describe('externalViewer', () => {
  it('prefers bat, with numbers and its own pager', () => {
    expect(externalViewer('/tmp/notes.md', { env: {}, which: everything })).toEqual({
      argv: ['bat', '--paging=always', '--style=numbers', '/tmp/notes.md'],
      label: 'bat',
    });
  });

  it('falls back to the pager with the path appended', () => {
    expect(externalViewer('/tmp/notes.md', { env: {}, which: holding('less') })).toEqual({
      argv: ['less', '-R', '-F', '-X', '/tmp/notes.md'],
      label: 'less',
    });
    expect(externalViewer('/tmp/notes.md', { env: { PAGER: 'moar' }, which: holding() })).toEqual({
      argv: ['moar', '/tmp/notes.md'],
      label: 'moar',
    });
  });

  it('answers nothing when there is no viewer and no pager', () => {
    expect(externalViewer('/tmp/notes.md', { env: {}, which: holding('delta') })).toBeNull();
  });

  it('is turned off by ARTEMIS_PAGER=off, bat on the path or not', () => {
    expect(externalViewer('/tmp/notes.md', { env: { ARTEMIS_PAGER: 'off' }, which: everything })).toBeNull();
    expect(externalViewer('/tmp/notes.md', { env: { ARTEMIS_PAGER: 'OFF' }, which: holding('less') })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* A fake filter                                                              */
/* -------------------------------------------------------------------------- */

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: PipeSpawnOptionsLike;
}

/** What the filter does: writes, complains, exits, hangs, or never starts. */
interface Behaviour {
  readonly stdout?: readonly (string | Buffer)[];
  readonly stderr?: readonly string[];
  readonly code?: number | null;
  readonly signal?: NodeJS.Signals | null;
  /** Emitted instead of running, the way a missing program is reported. */
  readonly error?: Error;
  /** Runs, writes what it was given, and never exits. */
  readonly hang?: boolean;
  /** Throws out of `spawn` itself, the way a bad argument does. */
  readonly throws?: Error;
  /** A tool that gave up before reading its input: EPIPE, one way or the other. */
  readonly stdinFails?: 'throw' | 'error';
}

interface Fake {
  readonly calls: SpawnCall[];
  readonly written: string[];
  readonly killed: (NodeJS.Signals | undefined)[];
  readonly spawn: PipeSpawnLike;
}

/**
 * A filter that behaves on a later tick, because a real one does: the module
 * registers its listeners after `spawn` has returned.
 */
function fakeFilter(behaviour: Behaviour): Fake {
  const calls: SpawnCall[] = [];
  const written: string[] = [];
  const killed: (NodeJS.Signals | undefined)[] = [];
  const spawn: PipeSpawnLike = (file, args, options) => {
    if (behaviour.throws !== undefined) throw behaviour.throws;
    calls.push({ file, args, options });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const input = new EventEmitter();
    const stdin = Object.assign(input, {
      end: (chunk: string): unknown => {
        if (behaviour.stdinFails === 'throw') throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        written.push(chunk);
        if (behaviour.stdinFails === 'error') input.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        return undefined;
      },
    });
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: (signal?: NodeJS.Signals): unknown => {
        killed.push(signal);
        return true;
      },
    });
    setTimeout(() => {
      if (behaviour.error !== undefined) {
        child.emit('error', behaviour.error);
        return;
      }
      for (const chunk of behaviour.stdout ?? []) stdout.emit('data', chunk);
      for (const chunk of behaviour.stderr ?? []) stderr.emit('data', chunk);
      if (behaviour.hang === true) return;
      child.emit('close', behaviour.code === undefined ? 0 : behaviour.code, behaviour.signal ?? null);
    }, 0);
    return child;
  };
  return { calls, written, killed, spawn };
}

describe('pipeThrough', () => {
  it('hands the diff to the tool and gives back what it wrote', async () => {
    const filter = fakeFilter({ stdout: ['\u001b[32m+ added\u001b[39m\n', '\u001b[31m- gone\u001b[39m\n'] });
    const result = await pipeThrough(['delta', '--paging=never'], 'diff --git a/x b/x\n', { spawn: filter.spawn });

    expect(result).toEqual({ ok: true, text: '\u001b[32m+ added\u001b[39m\n\u001b[31m- gone\u001b[39m\n' });
    expect(filter.calls).toEqual([{ file: 'delta', args: ['--paging=never'], options: { stdio: ['pipe', 'pipe', 'pipe'] } }]);
    expect(filter.written).toEqual(['diff --git a/x b/x\n']);
  });

  it('puts a character back together when the pipe split it', async () => {
    const snowman = Buffer.from('☃', 'utf8');
    const filter = fakeFilter({ stdout: [snowman.subarray(0, 1), snowman.subarray(1)] });

    expect(await pipeThrough(['delta'], '', { spawn: filter.spawn })).toEqual({ ok: true, text: '☃' });
  });

  it('is a reason, not a throw, when the tool exits non-zero', async () => {
    const filter = fakeFilter({ code: 2, stderr: ['\n', 'delta: unknown flag --nope\nusage: delta\n'] });

    expect(await pipeThrough(['delta', '--nope'], 'diff', { spawn: filter.spawn })).toEqual({
      ok: false,
      reason: 'delta exited with status 2: delta: unknown flag --nope',
    });
  });

  it('says nothing it was not told when the tool failed silently', async () => {
    const filter = fakeFilter({ code: 1 });

    expect(await pipeThrough(['delta'], 'diff', { spawn: filter.spawn })).toEqual({ ok: false, reason: 'delta exited with status 1' });
  });

  it('is a reason when the tool was killed', async () => {
    const filter = fakeFilter({ code: null, signal: 'SIGSEGV' });

    expect(await pipeThrough(['delta'], 'diff', { spawn: filter.spawn })).toEqual({ ok: false, reason: 'delta was stopped by SIGSEGV' });
  });

  it('is a reason when the tool could not be started', async () => {
    const missing = fakeFilter({ error: Object.assign(new Error('spawn delta ENOENT'), { code: 'ENOENT' }) });
    expect(await pipeThrough(['delta'], 'diff', { spawn: missing.spawn })).toEqual({ ok: false, reason: 'could not run delta: spawn delta ENOENT' });

    const broken = fakeFilter({ throws: new TypeError('bad argument') });
    expect(await pipeThrough(['delta'], 'diff', { spawn: broken.spawn })).toEqual({ ok: false, reason: 'could not run delta: bad argument' });
  });

  it('kills a tool that will not finish, and says how long it waited', async () => {
    const filter = fakeFilter({ stdout: ['half a diff'], hang: true });
    const result = await pipeThrough(['delta'], 'diff', { spawn: filter.spawn, timeoutMs: 20 });

    expect(result).toEqual({ ok: false, reason: 'delta took longer than 20ms' });
    expect(filter.killed).toEqual(['SIGTERM']);
  });

  it('waits ten seconds by default', () => {
    expect(PIPE_TIMEOUT_MS).toBe(10_000);
  });

  it('gives up on a tool that writes more than anyone would read', async () => {
    const flood = Buffer.alloc(MAX_PIPE_BYTES + 1, 0x61);
    const filter = fakeFilter({ stdout: [flood], hang: true });
    const result = await pipeThrough(['delta'], 'diff', { spawn: filter.spawn, timeoutMs: 1_000 });

    expect(result).toEqual({ ok: false, reason: 'delta produced more than 4 MB of output' });
    expect(filter.killed).toEqual(['SIGTERM']);
  });

  it('refuses an empty argv rather than spawning nothing', async () => {
    expect(await pipeThrough([], 'diff')).toEqual({ ok: false, reason: 'there is no command to run' });
    expect(await pipeThrough([''], 'diff')).toEqual({ ok: false, reason: 'there is no command to run' });
  });

  it('survives a tool that closed its input before reading it', async () => {
    const threw = fakeFilter({ stdout: ['done'], stdinFails: 'throw' });
    expect(await pipeThrough(['delta'], 'diff', { spawn: threw.spawn })).toEqual({ ok: true, text: 'done' });

    // The asynchronous half of the same thing: an unlistened `error` on stdin
    // would take the process down rather than the diff.
    const complained = fakeFilter({ stdout: ['done'], stdinFails: 'error' });
    expect(await pipeThrough(['delta'], 'diff', { spawn: complained.spawn })).toEqual({ ok: true, text: 'done' });
  });
});

/* -------------------------------------------------------------------------- */
/* The path lookup, against real files                                        */
/* -------------------------------------------------------------------------- */

describe('isOnPath', () => {
  let bin: string;
  let empty: string;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'artemis-tools-test-'));
    bin = join(root, 'bin');
    empty = join(root, 'empty');
    await mkdir(bin);
    await mkdir(empty);
    await writeFile(join(bin, 'delta'), '#!/bin/sh\n', 'utf8');
    await chmod(join(bin, 'delta'), 0o755);
    await writeFile(join(bin, 'notes.txt'), 'not a program', 'utf8');
    await chmod(join(bin, 'notes.txt'), 0o644);
    await writeFile(join(bin, 'delta.cmd'), 'echo', 'utf8');
  });

  it('finds an executable on one of the path entries', () => {
    expect(isOnPath('delta', { PATH: [empty, bin].join(':') }, 'linux')).toBe(true);
    expect(isOnPath('delta', { PATH: empty }, 'linux')).toBe(false);
    expect(isOnPath('bat', { PATH: bin }, 'linux')).toBe(false);
  });

  it('does not count a file nobody can run', () => {
    expect(isOnPath('notes.txt', { PATH: bin }, 'linux')).toBe(false);
  });

  it('answers no when there is no path at all', () => {
    expect(isOnPath('delta', {}, 'linux')).toBe(false);
    expect(isOnPath('delta', { PATH: '' }, 'linux')).toBe(false);
  });

  // A real `PATHEXT` is upper case, and on Windows so is the file system's
  // opinion of `delta.cmd`. Here the file system is the one under the test
  // runner, so the extensions are written the way the files were.
  it('tries the Windows extensions, and splits the path on semicolons', () => {
    expect(isOnPath('delta', { Path: [empty, bin].join(';'), PATHEXT: '.exe;.cmd' }, 'win32')).toBe(true);
    expect(isOnPath('notes', { Path: bin, PATHEXT: '.exe;.cmd' }, 'win32')).toBe(false);
    expect(isOnPath('notes.txt', { Path: bin }, 'win32')).toBe(true);
  });
});
