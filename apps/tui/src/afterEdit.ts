/**
 * The project's own checks, run after the agent has edited something.
 * ============================================================================
 *
 * Aider has had this loop since long before the rest of them: `--auto-lint`
 * and `--auto-test` run the project's own commands as soon as edits land, and a
 * failure goes straight back to the model. Nobody else picked it up, and the
 * reason is visible in the design — a terminal that returns every failure on
 * its own initiative is a terminal that can spend an afternoon, and a plan
 * window, arguing with a flaky test while its owner is at lunch.
 *
 * So the loop is here with one deliberate break in it. Artemis runs the command
 * and *offers* the failure; one key sends it. That is the whole of the
 * difference from Aider, and it is why every rule below is really a rule about
 * what is worth interrupting somebody for.
 *
 *  - **Only a turn that finished, and changed something.** An interrupted turn
 *    is one whose edits are half-written by definition, and a turn that touched
 *    no files cannot have broken anything by editing them. {@link
 *    AfterEdit.shouldRun} is those two facts and the third one — that somebody
 *    set a command for this directory at all — and nothing else decides it.
 *  - **Two minutes, not the shell's one.** `!git status` answers in
 *    milliseconds and a minute is a generous ceiling for it; `pnpm test` is a
 *    different kind of wait, and killing a suite that was nearly through is how
 *    a feature gets turned off for good. Past two minutes it is killed and says
 *    so, because a check that never comes back is worse than one that did not
 *    finish.
 *  - **How it ended is kept apart from what it said.** `runShell` puts its own
 *    explanation — `exit 1`, `timed out after 120s`, `killed by SIGKILL` — on
 *    the last line of the output, and only ever on a failure. {@link
 *    AfterEditResult.exitLine} is that line lifted back out, because the status
 *    flash has room for `exit 1` and not for a stack trace, and the transcript
 *    row should hold what the compiler wrote rather than what this module
 *    appended to it.
 *  - **The same failure is offered once.** Two identical failures in a row mean
 *    the second is not news: either nothing changed in between, or the agent
 *    tried the same thing twice. Both are cases where an offer is noise and a
 *    handover is a bill. What is kept is a hash rather than the text, because
 *    the text can be a quarter of a megabyte and this object lives as long as
 *    the process; a check that passes clears it, which is what makes "in a row"
 *    mean what it says.
 *  - **Nothing here throws, and nothing here draws.** A missing shell, a
 *    directory that is gone, a command that never ends: each is a result with
 *    `ok: false`, because the caller is a turn that has just ended and has one
 *    row to fill either way. Which row, which key, and what the status line
 *    says belong to `app.tsx`; this file only decides what is true.
 */

import { createHash } from 'node:crypto';

import { clipOutput, runShell, type ShellDeps, type ShellResult } from './shell.js';

/**
 * How long a check may run before it is killed.
 *
 * Twice the shell's minute and then some: a lint is seconds, a typecheck is
 * tens of them, and a test suite is the one people actually configure.
 */
export const AFTER_EDIT_TIMEOUT_MS = 120_000;

/**
 * Lines of a failure the agent is given.
 *
 * The same number the shell keeps, and for the same reason: the first lines of
 * a failing suite are the failure, and the rest is the runner repeating itself.
 */
export const AFTER_EDIT_HANDOFF_LINES = 200;

/** What a finished turn has to say about whether the checks should run. */
export interface AfterEditTurn {
  /** Files this turn edited, from the change ledger. */
  readonly editedFiles: number;
  /** The `run.end` reason. Only `completed` is a turn that meant to stop. */
  readonly reason: string;
  /** This directory's command, or nothing if none was ever set. */
  readonly command: string | undefined;
}

/** What the checks did. */
export interface AfterEditResult {
  /** The command exited zero: nothing to show anybody. */
  readonly ok: boolean;
  /** The command as it was run, for the row and for the handover. */
  readonly command: string;
  /** What it wrote, both streams, already clipped — without the line below. */
  readonly output: string;
  /** Wall clock, so the flash can say how long somebody waited. */
  readonly durationMs: number;
  /** How it ended, on a failure: `exit 1`, a timeout, a signal, a dead shell. */
  readonly exitLine?: string;
}

/** The world, so a test can run the checks without a shell. */
export interface AfterEditDeps extends ShellDeps {
  /** `Date.now` unless a test says otherwise. */
  readonly now?: () => number;
}

/**
 * The checks for one terminal: how to run them, how to say what happened, and
 * what the agent is told when somebody asks for that.
 *
 * A class for one piece of state only — the last failure that was offered. The
 * rest would be free functions, and are written as if they were.
 */
export class AfterEdit {
  /** The fingerprint of the failure last offered, or nothing. See the header. */
  #lastFailure: string | undefined;

  /**
   * Whether a turn that has just ended is one to run the checks after.
   *
   * All three conditions, because each of them on its own has a failure mode
   * somebody would report: no command is the default state of every directory,
   * no edits means checking what the last turn already checked, and an ending
   * that is not `completed` covers the Esc somebody pressed *because* they
   * could see the edit going wrong.
   */
  shouldRun(turn: AfterEditTurn): boolean {
    if (turn.reason !== 'completed') return false;
    if (turn.editedFiles < 1) return false;
    return turn.command !== undefined && turn.command.trim().length > 0;
  }

  /**
   * Run `command` in `cwd` and report what happened.
   *
   * Never rejects: `runShell` folds every way a command can fail into a result,
   * and this adds the clock and lifts out the ending line.
   */
  async run(command: string, cwd: string, deps: AfterEditDeps = {}): Promise<AfterEditResult> {
    const clock = deps.now ?? Date.now;
    const started = clock();
    const result = await runShell(command, cwd, { ...deps, timeoutMs: deps.timeoutMs ?? AFTER_EDIT_TIMEOUT_MS });
    // Measured around the whole call rather than taken from the shell, because
    // what the flash reports is how long the person waited.
    const durationMs = Math.max(0, clock() - started);
    const { body, ending } = partition(result);
    return {
      ok: !result.failed,
      command,
      output: body,
      durationMs,
      ...(ending === undefined ? {} : { exitLine: ending }),
    };
  }

  /**
   * One line for the status flash.
   *
   * A pass says how long it took and nothing else — the point of reporting a
   * pass at all is that the checks ran, and the duration is what tells somebody
   * whether leaving them on is costing them anything. A failure names the
   * ending and then names the key, because a failure nobody knows what to do
   * with is a failure they will scroll past.
   */
  summarize(result: AfterEditResult): string {
    if (result.ok) return `checks passed in ${seconds(result.durationMs)}`;
    return `checks failed: ${result.exitLine ?? 'failed'} · Enter sends the output to the agent`;
  }

  /**
   * The message the agent gets when somebody takes the offer.
   *
   * Fenced, with the command named above it and the ending underneath, which is
   * the shape a person would have pasted by hand. "After your edits" rather
   * than "fix this": the agent is being told what happened, and what to do
   * about it is a judgement it has the context to make and this module does
   * not.
   */
  handOff(result: AfterEditResult): string {
    const body = clipOutput(result.output, AFTER_EDIT_HANDOFF_LINES);
    const said = result.exitLine === undefined ? body : join(body, result.exitLine);
    return `After your edits, \`${result.command}\` ${result.ok ? 'passed' : 'failed'}:\n\`\`\`\n${said}\n\`\`\``;
  }

  /**
   * Whether this failure is worth offering — and remember that it was.
   *
   * Asked once per result, and it answers `false` for a pass: there is nothing
   * to offer, and a pass is also what ends a run of identical failures.
   */
  isNewFailure(result: AfterEditResult): boolean {
    if (result.ok) {
      this.#lastFailure = undefined;
      return false;
    }
    const digest = fingerprint(result);
    if (digest === this.#lastFailure) return false;
    this.#lastFailure = digest;
    return true;
  }

  /**
   * Forget what failed last, so an identical failure is offered again.
   *
   * For the moments where "in a row" stops being true without a check having
   * passed: the command was changed, the directory was, or somebody asked for
   * the checks by hand and therefore wants the answer.
   */
  forget(): void {
    this.#lastFailure = undefined;
  }
}

/**
 * What the command said, and the line saying how it ended.
 *
 * `runShell` appends its explanation as the last line, and only on a failure —
 * every failing path there joins one on, and a success joins none. So the split
 * is mechanical rather than a search for words that might be output.
 */
function partition(result: ShellResult): { readonly body: string; readonly ending: string | undefined } {
  if (!result.failed) return { body: result.output, ending: undefined };
  const lines = result.output.split('\n');
  return { body: lines.slice(0, -1).join('\n'), ending: lines[lines.length - 1] ?? '' };
}

/**
 * What is compared to decide whether a failure has been seen before.
 *
 * The command is part of it as well as the output: `pnpm lint` and `pnpm test`
 * both exiting 1 with nothing to say are two different problems, and somebody
 * who has just changed the command with `/check` is owed the answer to the new
 * one.
 */
function fingerprint(result: AfterEditResult): string {
  return createHash('sha256').update(`${result.command}\n${result.exitLine ?? ''}\n${result.output}`, 'utf8').digest('hex');
}

/** Seconds to one decimal: `0.4s`, `4.2s`, `120.0s`. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Two lines, unless the first of them is nothing. */
function join(body: string, ending: string): string {
  return body.length === 0 ? ending : `${body}\n${ending}`;
}
