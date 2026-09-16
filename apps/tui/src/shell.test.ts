/**
 * What `!` promises: the line goes to a shell whole, both streams come back as
 * one, a failure says how it failed, and nothing that can go wrong throws.
 *
 * The shell is a fake, so nothing is spawned and the suite gives the same
 * answer on a machine with no `/bin/sh`.
 */

import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { clipOutput, runShell, shellFor, type ShellChild, type ShellSpawn } from './shell.js';

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** What the fake shell does: what it writes, and how it ends. */
interface Behaviour {
  readonly stdout?: readonly string[];
  readonly stderr?: readonly string[];
  readonly code?: number | null;
  readonly signal?: NodeJS.Signals | null;
  /** Never ends by itself, so the timeout is what settles it. */
  readonly hang?: boolean;
  /** The spawn itself fails, as it does when the shell is not there. */
  readonly error?: Error;
}

function fakeShell(behaviour: Behaviour): { readonly calls: SpawnCall[]; readonly spawn: ShellSpawn } {
  const calls: SpawnCall[] = [];
  const spawn: ShellSpawn = (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(stdout, { setEncoding: () => undefined }),
      stderr: Object.assign(stderr, { setEncoding: () => undefined }),
      kill: () => {
        // A killed child still closes; the signal is what says it was killed.
        setTimeout(() => child.emit('close', null, 'SIGKILL'), 0);
        return true;
      },
    }) as unknown as ShellChild & EventEmitter;
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
  return { calls, spawn };
}

describe('shellFor', () => {
  it('hands the whole line to sh, and to cmd on Windows', () => {
    expect(shellFor('linux')).toEqual({ file: '/bin/sh', args: ['-c'] });
    expect(shellFor('darwin')).toEqual({ file: '/bin/sh', args: ['-c'] });
    expect(shellFor('win32').file).toBe('cmd.exe');
    expect(shellFor('win32').args).toContain('/c');
  });
});

describe('clipOutput', () => {
  it('leaves short output alone', () => {
    expect(clipOutput('one\ntwo')).toBe('one\ntwo');
  });

  it('keeps the head and counts what it cut', () => {
    const clipped = clipOutput(Array.from({ length: 205 }, (_, i) => `line ${String(i)}`).join('\n'));
    const rows = clipped.split('\n');
    expect(rows[0]).toBe('line 0');
    expect(rows[199]).toBe('line 199');
    expect(rows[200]).toBe('… 5 more lines');
    expect(clipped).not.toContain('line 200');
  });

  it('counts one cut line in the singular', () => {
    expect(clipOutput('a\nb\nc', 2)).toBe('a\nb\n… 1 more line');
  });
});

describe('runShell', () => {
  it('passes the command to the shell unsplit, in the directory it was given', async () => {
    const { calls, spawn } = fakeShell({ stdout: ['ok\n'] });
    const result = await runShell('git status | head -3 && echo done', '/work/repo', { spawn, platform: 'linux' });

    expect(calls).toEqual([{ file: '/bin/sh', args: ['-c', 'git status | head -3 && echo done'], cwd: '/work/repo' }]);
    expect(result).toEqual({ output: 'ok', failed: false, code: 0 });
  });

  it('gives back both streams as one, in the order they arrived', async () => {
    const { spawn } = fakeShell({ stdout: ['first\n'], stderr: ['a warning\n'] });
    const result = await runShell('build', '/work', { spawn, platform: 'linux' });
    expect(result.output).toBe('first\na warning');
    expect(result.failed).toBe(false);
  });

  it('a non-zero exit is a failure, and the status is the last line', async () => {
    const { spawn } = fakeShell({ stderr: ['not a git repository\n'], code: 128 });
    const result = await runShell('git log', '/tmp', { spawn, platform: 'linux' });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(128);
    expect(result.output).toBe('not a git repository\nexit 128');
  });

  it('a command that said nothing and failed is just its status', async () => {
    const { spawn } = fakeShell({ code: 1 });
    const result = await runShell('false', '/tmp', { spawn, platform: 'linux' });
    expect(result.output).toBe('exit 1');
    expect(result.failed).toBe(true);
  });

  it('cuts long output at two hundred lines', async () => {
    const { spawn } = fakeShell({ stdout: [Array.from({ length: 400 }, (_, i) => `row ${String(i)}`).join('\n')] });
    const result = await runShell('find .', '/tmp', { spawn, platform: 'linux' });
    expect(result.output.split('\n')).toHaveLength(201);
    expect(result.output).toContain('… 200 more lines');
  });

  it('kills a command that will not end, and says so', async () => {
    const { spawn } = fakeShell({ stdout: ['waiting…\n'], hang: true });
    const result = await runShell('sleep 900', '/tmp', { spawn, platform: 'linux', timeoutMs: 20 });
    expect(result.failed).toBe(true);
    expect(result.output).toBe('waiting…\ntimed out after 0s');
  });

  it('a shell that never started is a reason, not a throw', async () => {
    const { spawn } = fakeShell({ error: new Error('spawn /bin/sh ENOENT') });
    const result = await runShell('ls', '/tmp', { spawn, platform: 'linux' });
    expect(result.failed).toBe(true);
    expect(result.output).toContain('ENOENT');
  });

  it('a spawn that throws outright is a reason too', async () => {
    const spawn: ShellSpawn = () => {
      throw new Error('EACCES');
    };
    const result = await runShell('ls', '/nowhere', { spawn, platform: 'linux' });
    expect(result).toEqual({ output: 'could not run a shell: EACCES', failed: true });
  });

  it('names the signal when something else killed the command', async () => {
    const { spawn } = fakeShell({ code: null, signal: 'SIGTERM' });
    const result = await runShell('server', '/tmp', { spawn, platform: 'linux' });
    expect(result.failed).toBe(true);
    expect(result.output).toBe('killed by SIGTERM');
  });
});
