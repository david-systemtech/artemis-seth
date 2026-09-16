/**
 * The tools the person already has.
 * ============================================================================
 *
 * Every agent terminal ships its own diff highlighter and its own pager, and
 * none of them defers to the ones already installed on the machine. Git has
 * deferred for twenty years: `core.pager`, `diff.external`, `$PAGER`, and the
 * whole `delta` ecosystem that exists because of it. Somebody who has spent an
 * afternoon on their `delta` theme should see that theme when Artemis shows
 * them a diff, and somebody who has never heard of `delta` should see nothing
 * different from before.
 *
 * This module is the *detection and the argv*, and nothing else: which program
 * is worth running and which arguments it takes. Who runs it, and what happens
 * to the terminal while it does, belongs to the caller — for one very sharp
 * reason.
 *
 * ## Two ways to run one of these, and they are not interchangeable
 *
 *  - **A tool that takes the terminal has to be handed it.** `less`, and `bat
 *    --paging=always`, switch to the alternate screen, put the terminal in raw
 *    mode and own standard input until the person presses `q`. Ink is doing all
 *    three of those things already and two programs cannot. So anything that
 *    comes back from {@link externalPager} or {@link externalViewer} must be
 *    spawned with `stdio: 'inherit'` *inside* the same `useApp().suspendTerminal`
 *    that Ctrl+G uses to hand the draft to `$EDITOR` — see `externalEditor.ts`
 *    for the shape of it and `app.tsx`'s `editExternally` for the handover.
 *    Nothing in this file suspends anything, on purpose: that would make every
 *    rule in here impossible to settle without a real terminal, and these rules
 *    are the ones that actually go wrong.
 *  - **{@link pipeThrough} is the other path, the non-interactive one.** A diff
 *    coloured by `delta` and then shown inside Artemis's own `TextView` never
 *    takes the terminal at all: the text goes in on standard input, the ANSI
 *    comes back on standard output, and the reader the person already knows
 *    scrolls it. Which is why every diff argv here carries `--paging=never` — a
 *    tool that decided to page would fork `less` onto a terminal Ink still
 *    owns, and the first thing anyone would see is a dead prompt.
 *
 * ## The rest of the decisions
 *
 *  - **An override is trusted; a fallback is looked up.** `ARTEMIS_DIFF` and
 *    `ARTEMIS_PAGER` are command *lines*, not program names — `delta --dark
 *    --side-by-side` has to work — so they are split exactly the way `$EDITOR`
 *    is: quotes group, backslashes stay backslashes because a Windows path is
 *    mostly backslashes, and nothing is ever handed to a shell. They are *not*
 *    checked against `PATH`: someone who typed one meant it, and if it is
 *    misspelled the failure says so when it runs. Everything else is only
 *    offered once it has been found on `PATH`.
 *  - **`off` is the off switch**, on either variable, in any case. It is worth
 *    having because the alternative — unsetting `ARTEMIS_DIFF` and uninstalling
 *    `delta` — is not one.
 *  - **`null` is never an error.** It means Artemis's own renderer and its own
 *    reader, which is what it did before any of this existed. Every one of
 *    these functions is allowed to answer "nothing", and the caller has a
 *    perfectly good answer for that already.
 *  - **Synchronous on purpose.** Whether there is a tool decides what the
 *    status line says and what a key does, and the frame wants that before it
 *    is drawn rather than a tick later; it is a handful of `access` calls on
 *    `PATH`. Nothing here caches — resolve it once at launch and hold on to the
 *    result, which is also what keeps a test free to change `PATH` between two
 *    calls. Only {@link pipeThrough}, which starts a process, is a promise.
 *  - **Everything the world provides is a parameter**: the environment, the
 *    `PATH` lookup, the platform and the process spawner. Tests assert the
 *    exact argv, so the suite passes identically on a machine with none of
 *    these tools installed and on one with all of them.
 */

import { spawn as spawnProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { splitCommand } from './externalEditor.js';

// ---------------------------------------------------------------------------
// What a tool is, and what this module needs from the world
// ---------------------------------------------------------------------------

/** A program to run, and the name to put in the status line while it runs. */
export interface ExternalTool {
  /** The program first, then its arguments. Never empty, never shell syntax. */
  readonly argv: readonly string[];
  /** What the person calls it: `delta`, `bat`, `less`. */
  readonly label: string;
}

/** Whether a bare command name can be found on `PATH`, without spawning anything. */
export type OnPathFn = (command: string) => boolean;

export interface ExternalToolDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly which?: OnPathFn;
  /** `process.platform`, or what a test says it is. Only the `PATH` lookup reads it. */
  readonly platform?: string;
}

export interface DiffToolDeps extends ExternalToolDeps {
  /**
   * The columns the diff will be shown in. `delta` wraps to its own idea of the
   * terminal width otherwise, which is the *real* terminal — wider than the box
   * the text is about to be drawn in, so every long line would wrap twice.
   */
  readonly columns?: number;
}

interface Wired {
  readonly env: NodeJS.ProcessEnv;
  readonly which: OnPathFn;
}

function wire(deps: ExternalToolDeps): Wired {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  return { env, which: deps.which ?? ((command: string): boolean => isOnPath(command, env, platform)) };
}

// ---------------------------------------------------------------------------
// Finding a tool
// ---------------------------------------------------------------------------

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Whether `command` is on `PATH`.
 *
 * The same lookup a shell does — each `PATH` entry in order, and on Windows
 * each `PATHEXT` extension for a name that does not already carry one — rather
 * than running `which`, which would be a process started to find out whether a
 * process is worth starting. Executability is checked where it means something;
 * on Windows it does not, so existence is the whole test.
 *
 * `clipboard.ts` has the same function in an async shape, for the same reason
 * it is async there and synchronous here: that one is already inside an
 * `await`, and this one is answering a question a frame is waiting on.
 */
export function isOnPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  const windows = platform === 'win32';
  const raw = env['PATH'] ?? env['Path'] ?? '';
  // The separator follows the platform asked about, not the host's: a test
  // on a Windows host asking about Linux must split on the colon.
  const directories = raw.split(windows ? ';' : ':').filter((entry) => entry.length > 0);
  const extensions = windows && extname(command).length === 0 ? (env['PATHEXT'] ?? DEFAULT_PATHEXT).split(';').filter((entry) => entry.length > 0) : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      try {
        accessSync(join(directory, command + extension), windows ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        // Not here; try the next candidate.
      }
    }
  }
  return false;
}

/**
 * The name to show for a program that was named by a path.
 *
 * `ARTEMIS_DIFF=/opt/homebrew/bin/delta --dark` is still `delta` in the status
 * line. Backslashes are turned into slashes first because `basename` on a Linux
 * host has never heard of `C:\tools\delta.exe`, and the Windows suffix goes
 * because nobody says "delta dot exe".
 */
const EXECUTABLE_SUFFIX = /\.(?:exe|cmd|bat|com)$/i;

function labelFor(file: string): string {
  const name = basename(file.replaceAll('\\', '/')).replace(EXECUTABLE_SUFFIX, '');
  return name.length === 0 ? file : name;
}

/**
 * A configured command line as a tool, or `undefined` when the variable is
 * unset, blank, or nothing but quotes. `undefined` means "carry on looking",
 * which is what lets an empty `ARTEMIS_PAGER` behave like one that was never
 * exported — the shape a shell profile produces when a conditional did not fire.
 */
function commandTool(value: string | undefined): ExternalTool | undefined {
  const command = (value ?? '').trim();
  if (command.length === 0) return undefined;
  const argv = splitCommand(command);
  const file = argv[0];
  if (file === undefined || file.length === 0) return undefined;
  return { argv, label: labelFor(file) };
}

/**
 * An `ARTEMIS_*` override: a tool, `null` for `off`, `undefined` for unset.
 *
 * Three states rather than two, because "the person turned this off" and "the
 * person said nothing" are different answers and only one of them stops the
 * search.
 */
function override(value: string | undefined): ExternalTool | null | undefined {
  const command = (value ?? '').trim();
  if (command.toLowerCase() === 'off') return null;
  return commandTool(value);
}

const isOff = (value: string | undefined): boolean => (value ?? '').trim().toLowerCase() === 'off';

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/**
 * The program that should colour a unified diff, or `null` for Artemis's own
 * renderer.
 *
 * The order is the one git users would predict: their explicit choice, then
 * `delta`, then `diff-so-fancy`, then `bat`. `delta` first because it is the
 * one people configure on purpose and the only one that re-lays-out the diff
 * rather than recolouring it; `bat` last because it is a highlighter that
 * happens to know the diff grammar, not a diff tool, and anyone with both
 * installed meant the other one.
 *
 * Everything here reads a diff on standard input and writes one on standard
 * output, so the result is {@link pipeThrough}'s to run. `--paging=never` is
 * not optional: see the header.
 */
export function externalDiffTool(deps: DiffToolDeps = {}): ExternalTool | null {
  const wired = wire(deps);
  const chosen = override(wired.env['ARTEMIS_DIFF']);
  if (chosen !== undefined) return chosen;
  if (wired.which('delta')) return { argv: ['delta', '--paging=never', ...widthArgument(deps.columns)], label: 'delta' };
  if (wired.which('diff-so-fancy')) return { argv: ['diff-so-fancy'], label: 'diff-so-fancy' };
  // `--color=always` because bat, unlike delta, honours "is stdout a terminal"
  // and this one never is; `--style=plain` because the diff already has its own
  // markers and a second set of line numbers beside them is noise.
  if (wired.which('bat')) return { argv: ['bat', '--language=diff', '--paging=never', '--style=plain', '--color=always'], label: 'bat' };
  return null;
}

/** A width `delta` can use, or nothing at all when the caller did not measure. */
function widthArgument(columns: number | undefined): readonly string[] {
  if (columns === undefined || !Number.isFinite(columns) || columns < 1) return [];
  return [`--width=${String(Math.floor(columns))}`];
}

// ---------------------------------------------------------------------------
// The pager
// ---------------------------------------------------------------------------

/**
 * The program that should show a long answer, or `null` for Artemis's own
 * reader.
 *
 * `$PAGER` is honoured because it is the variable everyone already has set, but
 * `PAGER=cat` is not: `cat` is not a pager, it is how a person turns a pager
 * *off* for a script, and obeying it here would dump a thousand lines into a
 * terminal and lose them — which is the exact thing the reader was opened to
 * avoid. So `cat` falls through, and the person who genuinely wants nothing
 * external has `ARTEMIS_PAGER=off`, which is unambiguous.
 *
 * `less` is the fallback with git's own flags: `-R` so the ANSI already in the
 * text is colour rather than `ESC[32m`, `-F` so an answer shorter than the
 * screen prints and returns instead of making someone press `q` for four lines,
 * and `-X` so it does not clear the screen on exit and take the answer with it.
 *
 * **Whatever comes back takes the terminal.** It has to be run under the Ink
 * suspension described in the header.
 */
export function externalPager(deps: ExternalToolDeps = {}): ExternalTool | null {
  const wired = wire(deps);
  const chosen = override(wired.env['ARTEMIS_PAGER']);
  if (chosen !== undefined) return chosen;
  const configured = commandTool(wired.env['PAGER']);
  if (configured !== undefined && configured.label !== 'cat') return configured;
  if (wired.which('less')) return { argv: ['less', '-R', '-F', '-X'], label: 'less' };
  return null;
}

/**
 * The program that should open `path` read-only, or `null` for Artemis's own
 * reader.
 *
 * `bat` before the pager, which is the one place the order is not "the person's
 * choice first": a file opened to be *read* wants line numbers and syntax
 * highlighting, `bat` is the tool that has both, and `bat` is also a pager, so
 * nothing is lost by preferring it. `--paging=always` rather than `auto`
 * because `auto` would print a short file and hand back a terminal that has
 * already been suspended, leaving the file on screen under a redrawn Ink frame.
 *
 * `ARTEMIS_PAGER=off` stops this too. It is the switch that means "do not take
 * my terminal", and a viewer takes it exactly as hard as a pager does.
 *
 * **Whatever comes back takes the terminal**, same as {@link externalPager}.
 */
export function externalViewer(path: string, deps: ExternalToolDeps = {}): ExternalTool | null {
  const wired = wire(deps);
  if (isOff(wired.env['ARTEMIS_PAGER'])) return null;
  if (wired.which('bat')) return { argv: ['bat', '--paging=always', '--style=numbers', path], label: 'bat' };
  const pager = externalPager(deps);
  if (pager === null) return null;
  return { argv: [...pager.argv, path], label: pager.label };
}

// ---------------------------------------------------------------------------
// Running one without giving up the terminal
// ---------------------------------------------------------------------------

/** How long a filter gets before it is killed and disbelieved. */
export const PIPE_TIMEOUT_MS = 10_000;

/**
 * As much output as any of this is worth. A diff that renders to more than this
 * was never going to be read, and the memory is real.
 */
export const MAX_PIPE_BYTES = 4 * 1024 * 1024;

/** The filtered text, or why there is none. `reason` is meant to be shown as it is. */
export type PipeResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

/** The part of a child's output stream this module listens to. */
export interface PipeStreamLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** The part of a child's input stream this module writes to. */
export interface PipeStdinLike {
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(chunk: string): unknown;
}

export interface PipedChildLike {
  readonly stdin: PipeStdinLike | null;
  readonly stdout: PipeStreamLike | null;
  readonly stderr?: PipeStreamLike | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface PipeSpawnOptionsLike {
  /** All three pipes: the diff goes in, the colour comes out, the complaint comes back. */
  readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
}

export type PipeSpawnLike = (file: string, args: readonly string[], options: PipeSpawnOptionsLike) => PipedChildLike;

export interface PipeDeps {
  readonly spawn?: PipeSpawnLike;
  /** {@link PIPE_TIMEOUT_MS} by default. A test passes a few milliseconds. */
  readonly timeoutMs?: number;
}

const defaultSpawn: PipeSpawnLike = (file, args, options) => spawnProcess(file, [...args], { stdio: [...options.stdio], windowsHide: true });

/**
 * Run `argv` with `input` on standard input and collect what it writes.
 *
 * The non-interactive half of this module: the tool is a filter, the terminal
 * stays Ink's, and the coloured text ends up in `TextView` like any other
 * string. Nothing throws — every way this can go wrong is a `reason`, because
 * the caller is a keystroke and the honest response to all of them is one line
 * in the status bar followed by Artemis's own rendering.
 *
 * `close` rather than `exit`, because `exit` can arrive while standard output
 * still has bytes in flight and the whole point of this is the bytes.
 */
export async function pipeThrough(argv: readonly string[], input: string, deps: PipeDeps = {}): Promise<PipeResult> {
  const file = argv[0];
  if (file === undefined || file.length === 0) return { ok: false, reason: 'there is no command to run' };
  const args = argv.slice(1);
  const timeoutMs = deps.timeoutMs ?? PIPE_TIMEOUT_MS;
  const spawnImpl = deps.spawn ?? defaultSpawn;

  return await new Promise<PipeResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: PipeResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    const fail = (reason: string): void => {
      finish({ ok: false, reason });
    };

    let child: PipedChildLike;
    try {
      child = spawnImpl(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      // A synchronous throw is a bad argument rather than a missing program,
      // but it reaches the person the same way one does.
      fail(`could not run ${file}: ${messageOf(error)}`);
      return;
    }

    // A decoder rather than `toString` per chunk: a pipe splits wherever it
    // likes, and colour escapes and box-drawing characters are exactly what a
    // diff tool emits at the end of a long line.
    const decoder = new StringDecoder('utf8');
    const out: string[] = [];
    const err: string[] = [];
    let bytes = 0;

    child.stdout?.on('data', (chunk: Buffer | string) => {
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes > MAX_PIPE_BYTES) {
        child.kill('SIGTERM');
        fail(`${file} produced more than ${describeBytes(MAX_PIPE_BYTES)} of output`);
        return;
      }
      out.push(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    });
    // A tool that cannot be read from is a tool that failed; `close` will say so.
    child.stdout?.on('error', () => undefined);

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (err.length < 16) err.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    child.stderr?.on('error', () => undefined);

    const stdin = child.stdin;
    if (stdin !== null && stdin !== undefined) {
      // A tool that has already decided to fail closes its end first; writing
      // then raises EPIPE, which is not news worth an unhandled error event.
      stdin.on('error', () => undefined);
      try {
        stdin.end(input);
      } catch {
        // Same thing, synchronously. The exit status is the real answer.
      }
    }

    child.on('error', (error: Error) => {
      fail(`could not run ${file}: ${error.message}`);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        out.push(decoder.end());
        finish({ ok: true, text: out.join('') });
        return;
      }
      if (code !== null) {
        fail(`${file} exited with status ${String(code)}${complaint(err)}`);
        return;
      }
      fail(`${file} was stopped by ${signal ?? 'a signal'}`);
    });

    timer = setTimeout(() => {
      // SIGTERM, not SIGKILL: a filter that is still writing should get the
      // chance to stop writing. It is already disbelieved either way.
      child.kill('SIGTERM');
      fail(`${file} took longer than ${describeMs(timeoutMs)}`);
    }, timeoutMs);
  });
}

/** The first thing the tool said on stderr, which is usually the whole story. */
function complaint(chunks: readonly string[]): string {
  const line = chunks
    .join('')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line === undefined ? '' : `: ${line}`;
}

const describeBytes = (count: number): string => `${String(Math.round(count / (1024 * 1024)))} MB`;

const describeMs = (ms: number): string => (ms % 1_000 === 0 ? `${String(ms / 1_000)}s` : `${String(ms)}ms`);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
