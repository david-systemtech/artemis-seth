/**
 * What the after-edit checks promise: they run only when a turn finished and
 * changed something, a failure keeps both what the command said and how it
 * ended, the agent is handed something a person would have pasted, and the same
 * failure is never offered twice running.
 *
 * The shell is a fake, so nothing is spawned and the suite gives the same answer
 * on a machine with no `/bin/sh` and no test runner.
 */

import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  AFTER_EDIT_TIMEOUT_MS,
  AfterEdit,
  type AfterEditResult,
  type AfterEditTurn,
} from './afterEdit.js';
import type { ShellChild, ShellSpawn } from './shell.js';

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** What the fake check does: what it writes, and how it ends. */
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

/** A clock that moves by `step` every time it is read. */
function fakeClock(step: number): () => number {
  let at = 1_000;
  return () => {
    const was = at;
    at += step;
    return was;
  };
}

const turn = (patch: Partial<AfterEditTurn> = {}): AfterEditTurn => ({
  editedFiles: 2,
  reason: 'completed',
  command: 'pnpm test',
  ...patch,
});

const failure = (patch: Partial<AfterEditResult> = {}): AfterEditResult => ({
  ok: false,
  command: 'pnpm test',
  output: 'FAIL src/thing.test.ts',
  durationMs: 4_210,
  exitLine: 'exit 1',
  ...patch,
});

describe('AfterEdit.shouldRun', () => {
  it('runs after a turn that finished and edited something, with a command set', () => {
    expect(new AfterEdit().shouldRun(turn())).toBe(true);
  });

  it('does not run when the turn did not mean to stop', () => {
    // An interrupted turn's edits are half-written by definition, and Esc is
    // often pressed *because* the edit was going wrong.
    const checks = new AfterEdit();
    expect(checks.shouldRun(turn({ reason: 'interrupted' }))).toBe(false);
    expect(checks.shouldRun(turn({ reason: 'error' }))).toBe(false);
    expect(checks.shouldRun(turn({ reason: 'permission_denied' }))).toBe(false);
    expect(checks.shouldRun(turn({ reason: 'disposed' }))).toBe(false);
  });

  it('does not run when nothing was edited, or no command was ever set', () => {
    const checks = new AfterEdit();
    expect(checks.shouldRun(turn({ editedFiles: 0 }))).toBe(false);
    expect(checks.shouldRun(turn({ command: undefined }))).toBe(false);
    expect(checks.shouldRun(turn({ command: '   ' }))).toBe(false);
  });
});

describe('AfterEdit.run', () => {
  it('hands the project’s command to the shell in the working directory, and times it', async () => {
    const { calls, spawn } = fakeShell({ stdout: ['42 passed\n'] });
    const result = await new AfterEdit().run('pnpm -s test', '/work/repo', {
      spawn,
      platform: 'linux',
      now: fakeClock(4_210),
    });

    expect(calls).toEqual([{ file: '/bin/sh', args: ['-c', 'pnpm -s test'], cwd: '/work/repo' }]);
    expect(result).toEqual({ ok: true, command: 'pnpm -s test', output: '42 passed', durationMs: 4_210 });
    // A pass has nothing to explain, so there is no ending line at all.
    expect(result.exitLine).toBeUndefined();
  });

  it('a failure keeps what the command said, and how it ended, apart', async () => {
    const { spawn } = fakeShell({ stdout: ['FAIL src/a.test.ts\n'], stderr: ['1 failed\n'], code: 1 });
    const result = await new AfterEdit().run('pnpm test', '/work/repo', { spawn, platform: 'linux', now: fakeClock(900) });

    expect(result.ok).toBe(false);
    expect(result.output).toBe('FAIL src/a.test.ts\n1 failed');
    expect(result.exitLine).toBe('exit 1');
    expect(result.durationMs).toBe(900);
  });

  it('a check that failed silently is an ending and no output', async () => {
    const { spawn } = fakeShell({ code: 2 });
    const result = await new AfterEdit().run('tsc -b', '/work/repo', { spawn, platform: 'linux' });
    expect(result.output).toBe('');
    expect(result.exitLine).toBe('exit 2');
  });

  it('kills a check that will not end, and says that is what happened', async () => {
    // Two minutes by default, overridden here so the suite does not wait them.
    expect(AFTER_EDIT_TIMEOUT_MS).toBe(120_000);
    const { spawn } = fakeShell({ stdout: ['running tests…\n'], hang: true });
    const result = await new AfterEdit().run('pnpm test', '/work/repo', { spawn, platform: 'linux', timeoutMs: 20 });

    expect(result.ok).toBe(false);
    expect(result.output).toBe('running tests…');
    expect(result.exitLine).toMatch(/^timed out after/u);
  });

  it('a shell that never started is a result, not a throw', async () => {
    const { spawn } = fakeShell({ error: new Error('spawn /bin/sh ENOENT') });
    const result = await new AfterEdit().run('pnpm test', '/gone', { spawn, platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(result.output).toBe('');
    expect(result.exitLine).toContain('ENOENT');
  });

  it('is clipped, so a runner that printed a thousand lines is not a thousand-line row', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `row ${String(i)}`).join('\n');
    const { spawn } = fakeShell({ stdout: [lines] });
    const result = await new AfterEdit().run('pnpm test', '/work/repo', { spawn, platform: 'linux' });
    expect(result.output.split('\n')).toHaveLength(201);
    expect(result.output).toContain('… 300 more lines');
  });
});

describe('AfterEdit.summarize', () => {
  it('says how long a pass took, and nothing else', () => {
    expect(new AfterEdit().summarize({ ok: true, command: 'pnpm test', output: '', durationMs: 4_210 })).toBe(
      'checks passed in 4.2s',
    );
  });

  it('names the ending and then names the key', () => {
    // A failure nobody knows what to do with is a failure they scroll past.
    expect(new AfterEdit().summarize(failure())).toBe('checks failed: exit 1 · Enter sends the output to the agent');
    expect(new AfterEdit().summarize(failure({ exitLine: 'timed out after 120s' }))).toBe(
      'checks failed: timed out after 120s · Enter sends the output to the agent',
    );
  });
});

describe('AfterEdit.handOff', () => {
  it('fences the output under the command that failed, with the ending underneath', () => {
    expect(new AfterEdit().handOff(failure())).toBe(
      'After your edits, `pnpm test` failed:\n```\nFAIL src/thing.test.ts\nexit 1\n```',
    );
  });

  it('is the ending alone when the command said nothing', () => {
    expect(new AfterEdit().handOff(failure({ output: '', exitLine: 'exit 1' }))).toBe(
      'After your edits, `pnpm test` failed:\n```\nexit 1\n```',
    );
  });

  it('cuts a long failure to two hundred lines, keeping how it ended', () => {
    const output = Array.from({ length: 500 }, (_, i) => `row ${String(i)}`).join('\n');
    const message = new AfterEdit().handOff(failure({ output }));
    expect(message).toContain('row 0');
    expect(message).toContain('… 300 more lines');
    expect(message).not.toContain('row 400');
    expect(message.endsWith('exit 1\n```')).toBe(true);
  });
});

/*
 * The dedupe.
 *
 * Aider's loop sends every failure; this one offers it, and an offer repeated
 * word for word is how a person learns to ignore the offer.
 */
describe('AfterEdit dedupe', () => {
  it('offers a failure once, and not again while it is the same failure', () => {
    const checks = new AfterEdit();
    expect(checks.isNewFailure(failure())).toBe(true);
    expect(checks.isNewFailure(failure())).toBe(false);
    // A different duration is the same failure: the clock is not the news.
    expect(checks.isNewFailure(failure({ durationMs: 9_000 }))).toBe(false);
  });

  it('offers a failure that has changed, in its output or in its ending', () => {
    const checks = new AfterEdit();
    expect(checks.isNewFailure(failure())).toBe(true);
    expect(checks.isNewFailure(failure({ output: 'FAIL src/other.test.ts' }))).toBe(true);
    expect(checks.isNewFailure(failure({ output: 'FAIL src/other.test.ts', exitLine: 'exit 2' }))).toBe(true);
  });

  it('offers the same failure again once a check has passed in between', () => {
    // A pass is what makes "twice in a row" stop being true.
    const checks = new AfterEdit();
    expect(checks.isNewFailure(failure())).toBe(true);
    expect(checks.isNewFailure({ ok: true, command: 'pnpm test', output: '', durationMs: 10 })).toBe(false);
    expect(checks.isNewFailure(failure())).toBe(true);
  });

  it('treats another command failing the same way as another failure', () => {
    const checks = new AfterEdit();
    expect(checks.isNewFailure(failure({ command: 'pnpm lint', output: '', exitLine: 'exit 1' }))).toBe(true);
    expect(checks.isNewFailure(failure({ command: 'pnpm test', output: '', exitLine: 'exit 1' }))).toBe(true);
  });

  it('forgets on request, for the check somebody asked for by hand', () => {
    const checks = new AfterEdit();
    expect(checks.isNewFailure(failure())).toBe(true);
    checks.forget();
    expect(checks.isNewFailure(failure())).toBe(true);
  });
});
