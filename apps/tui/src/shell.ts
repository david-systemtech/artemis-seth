/**
 * Running a shell command from the composer, and what comes back.
 *
 * A prompt is often one `git status` away from the message somebody wanted to
 * write, and leaving the app to find out is how a train of thought ends. So
 * `!` in the composer runs a command here and the transcript keeps what it
 * said — either as a row of its own, or as the message the agent is then asked
 * about.
 *
 * The rules worth knowing, all of them here rather than in `app.tsx`, which
 * only wires this to a keystroke:
 *
 *  - **The shell is the platform's own**, `sh -c` everywhere but Windows and
 *    `cmd /c` there, and the command goes to it as one string. That is the
 *    point of the feature: a pipe, a glob and a `&&` are what somebody typed
 *    `!` for, and splitting the line ourselves would take all three away.
 *  - **Nothing here throws.** A shell that is missing, a directory that is
 *    gone, a command that never ends — each is an output and a failed flag,
 *    because the caller is a keystroke with a transcript row to fill, not an
 *    exception handler.
 *  - **stdout and stderr are one stream**, interleaved as they arrived, which
 *    is what a terminal would have shown. Which one a line came from is not a
 *    distinction the transcript draws, and separating them reorders the output
 *    of every command that writes to both.
 *  - **The output is bounded twice**: by bytes while it is arriving, so a
 *    runaway `cat` cannot fill memory, and by lines on the way out, because a
 *    thousand-line row is not something anybody reads in a conversation. What
 *    was cut is counted rather than silently dropped.
 *  - **A minute is the longest a command may take.** Past that it is killed and
 *    says so: the composer is waiting on this, and a prompt that never comes
 *    back is worse than a command that did not finish.
 */

import { spawn } from 'node:child_process';

/** How long a command may run before it is killed. */
export const SHELL_TIMEOUT_MS = 60_000;

/** Lines kept in the transcript row. The rest are counted. */
export const SHELL_MAX_LINES = 200;

/** Output held while it arrives. Beyond this the command is still run, but unheard. */
export const SHELL_MAX_BYTES = 256 * 1024;

/** What a command said, and whether it worked. */
export interface ShellResult {
  /** stdout and stderr as they arrived, trimmed of its trailing blank line. */
  readonly output: string;
  /** A non-zero exit, a signal, a timeout, or a shell that never started. */
  readonly failed: boolean;
  /** The exit status, when there was one. */
  readonly code?: number;
}

/** The parts of a spawned child this module reads. */
export interface ShellStream {
  setEncoding(encoding: 'utf8'): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
}

export interface ShellChild {
  readonly stdout: ShellStream | null;
  readonly stderr: ShellStream | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface ShellSpawnOptions {
  readonly cwd: string;
}

export type ShellSpawn = (file: string, args: readonly string[], options: ShellSpawnOptions) => ShellChild;

export interface ShellDeps {
  readonly spawn?: ShellSpawn;
  /** `process.platform` unless a test says otherwise. */
  readonly platform?: string;
  readonly timeoutMs?: number;
}

const defaultSpawn: ShellSpawn = (file, args, options) =>
  spawn(file, [...args], { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * The shell and the flag that hands it a whole command line.
 *
 * `/bin/sh` rather than the person's login shell: a command typed at a prompt
 * inside an agent terminal is a command, not a session, and `sh` starts without
 * reading anybody's profile — which is both faster and the only way two
 * machines give the same answer.
 */
export function shellFor(platform: string): { readonly file: string; readonly args: readonly string[] } {
  return platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c'] } : { file: '/bin/sh', args: ['-c'] };
}

/**
 * Keep the first `SHELL_MAX_LINES` lines and count the rest.
 *
 * The head rather than the tail because a command run from the composer is
 * nearly always one whose first lines are the answer — `ls`, `git status`, `git
 * diff --stat`. A command whose ending matters is one to run in a real
 * terminal, and the count says plainly that there was more.
 */
export function clipOutput(text: string, maxLines = SHELL_MAX_LINES): string {
  const rows = text.split('\n');
  if (rows.length <= maxLines) return text;
  const dropped = rows.length - maxLines;
  return [...rows.slice(0, maxLines), `… ${String(dropped)} more line${dropped === 1 ? '' : 's'}`].join('\n');
}

/**
 * Run `command` in `cwd` and report what it said.
 *
 * Every failure is part of the result rather than a rejection: the caller draws
 * one row either way.
 */
export async function runShell(command: string, cwd: string, deps: ShellDeps = {}): Promise<ShellResult> {
  const spawnImpl = deps.spawn ?? defaultSpawn;
  const { file, args } = shellFor(deps.platform ?? process.platform);
  const timeoutMs = deps.timeoutMs ?? SHELL_TIMEOUT_MS;

  let child: ShellChild;
  try {
    child = spawnImpl(file, [...args, command], { cwd });
  } catch (error) {
    return { output: `could not run a shell: ${messageOf(error)}`, failed: true };
  }

  return await new Promise<ShellResult>((resolve) => {
    let collected = '';
    let truncated = false;
    let settled = false;
    let timedOut = false;

    const take = (chunk: string): void => {
      if (truncated) return;
      const room = SHELL_MAX_BYTES - collected.length;
      if (chunk.length >= room) {
        collected += chunk.slice(0, Math.max(0, room));
        truncated = true;
        return;
      }
      collected += chunk;
    };

    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', take);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    const finish = (result: ShellResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (error) => {
      finish({ output: `could not run a shell: ${error.message}`, failed: true });
    });

    // `close` rather than `exit`: the pipes have been drained by then, so the
    // last line of output is never lost to a command that exits the moment it
    // has written it.
    child.on('close', (code, signal) => {
      const body = stripTrailingNewline(collected) + (truncated ? '\n… output stopped after 256 KB' : '');
      if (timedOut) {
        finish({ output: join(body, `timed out after ${String(Math.round(timeoutMs / 1000))}s`), failed: true });
        return;
      }
      if (signal !== null) {
        finish({ output: join(body, `killed by ${signal}`), failed: true });
        return;
      }
      const status = code ?? 0;
      // The exit status is only worth a line when it was not zero: a command
      // that worked says what it said, and nothing else.
      if (status !== 0) {
        finish({ output: join(body, `exit ${String(status)}`), failed: true, code: status });
        return;
      }
      finish({ output: clipOutput(body), failed: false, code: status });
    });
  });
}

/** The output and the line that explains how it ended, whichever of them exists. */
function join(body: string, note: string): string {
  const clipped = clipOutput(body);
  return clipped.length === 0 ? note : `${clipped}\n${note}`;
}

function stripTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
