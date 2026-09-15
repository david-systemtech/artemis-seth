/**
 * Handing a draft to `$EDITOR` and taking it back.
 * ============================================================================
 *
 * Some messages are too long to write in a box that is four rows tall. The
 * answer every tool that asks for prose has settled on — `git commit`, `crontab
 * -e`, `visudo` — is to write what there is to a file, run the editor the
 * person already configured, and read the file back when it exits. That is all
 * this does.
 *
 * **The caller has to hand over the terminal.** `vim` and `nano` take over the
 * screen: they switch to the alternate buffer, put the terminal in raw mode and
 * expect to own standard input until they exit. Ink is doing all three of those
 * things already, and two programs cannot. So before calling this, the caller
 * must leave the alternate screen, stop Ink rendering and release stdin, and
 * afterwards put all of it back. This module deliberately does none of that: it
 * would make every rule in here — the argv split, the temp file, the exit
 * status — impossible to settle without a terminal, and those are the rules
 * that actually go wrong.
 *
 * The decisions worth knowing:
 *
 *  - **`$VISUAL` before `$EDITOR`.** The convention is that `VISUAL` is the
 *    full-screen editor and `EDITOR` is the line editor of last resort; a
 *    person who set both meant the first.
 *  - **The editor variable is a command line, not a program.** `code --wait`
 *    is the documented way to use VS Code as an editor and is worthless split
 *    on nothing. So it is split on whitespace, honouring quotes, because the
 *    Windows form is `"C:\Program Files\Editor\ed.exe" -w` and the path has a
 *    space in it. Backslashes are *not* escape characters here, for the same
 *    reason: that path is mostly backslashes. Nothing is ever handed to a
 *    shell — the split is ours, so there is no metacharacter to be surprised by.
 *  - **A fresh private directory per edit, with a `.md` file in it.** The
 *    extension is what gets the editor to wrap prose and highlight a fenced
 *    block; the private directory is what keeps two edits, or two copies of
 *    Artemis, from picking the same name. The directory goes afterwards, every
 *    time, including when the editor failed.
 *  - **A non-zero exit throws the draft away unread.** `:cq` in vim is how a
 *    person says "forget it", and every tool that uses `$EDITOR` this way reads
 *    it as a cancellation. Reading the file anyway would send a message they
 *    just tried to abandon.
 *  - **One trailing newline is stripped.** Editors add one on save whether the
 *    text wanted it or not; a message that ends in a blank line still gets to,
 *    because only one is taken.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What the editor left behind, or why there is nothing to take. */
export type ExternalEditResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

/** The parts of a spawned child this module waits on. */
export interface SpawnedLike {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface SpawnOptionsLike {
  /** Always `'inherit'`: the editor gets the terminal, exactly as it is. */
  readonly stdio: 'inherit';
}

export type SpawnLike = (file: string, args: readonly string[], options: SpawnOptionsLike) => SpawnedLike;

export interface ExternalEditorDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn?: SpawnLike;
  /** Where the private directory is made. `os.tmpdir` by default. */
  readonly tmpdir?: () => string;
}

const defaultSpawn: SpawnLike = (file, args, options) => spawn(file, [...args], { stdio: options.stdio });

/** The file the editor is pointed at. `.md`, because a message is prose. */
const DRAFT_NAME = 'message.md';

/**
 * Split a command line on whitespace, honouring double and single quotes.
 *
 * Quotes group and then disappear, so `"C:\Program Files\x.exe" -w` is two
 * arguments and the first has its space. An unterminated quote takes the rest
 * of the line rather than failing, because the alternative is telling somebody
 * their `$EDITOR` is malformed when what they meant is obvious.
 */
export function splitCommand(command: string): readonly string[] {
  const parts: string[] = [];
  let current: string | null = null;
  let quote: '"' | "'" | null = null;
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current = (current ?? '') + character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      // An empty pair of quotes is still an argument, so the token starts here.
      current ??= '';
      continue;
    }
    if (/\s/.test(character)) {
      if (current !== null) parts.push(current);
      current = null;
      continue;
    }
    current = (current ?? '') + character;
  }
  if (current !== null) parts.push(current);
  return parts;
}

/**
 * Open `initial` in the person's editor and return what they saved.
 *
 * Every failure is a `reason` meant to be shown as it is: the caller has a
 * status line, not an exception handler.
 */
export async function editInExternalEditor(initial: string, deps: ExternalEditorDeps = {}): Promise<ExternalEditResult> {
  const env = deps.env ?? process.env;
  const configured = (env['VISUAL'] ?? '').trim() || (env['EDITOR'] ?? '').trim();
  if (configured.length === 0) return { ok: false, reason: 'neither VISUAL nor EDITOR is set' };
  const argv = splitCommand(configured);
  const file = argv[0];
  if (file === undefined || file.length === 0) return { ok: false, reason: 'the editor command is empty' };

  let directory: string;
  try {
    directory = await mkdtemp(join((deps.tmpdir ?? tmpdir)(), 'artemis-edit-'));
  } catch (error) {
    // A temp directory that cannot be made is not an exception the composer
    // should have to catch; it is one more thing to say in the status line.
    return { ok: false, reason: `could not make a temporary directory: ${messageOf(error)}` };
  }
  const path = join(directory, DRAFT_NAME);
  try {
    await writeFile(path, initial, 'utf8');
    const ended = await runEditor(deps.spawn ?? defaultSpawn, file, [...argv.slice(1), path]);
    if (ended !== null) return { ok: false, reason: ended };
    return { ok: true, text: stripTrailingNewline(await readFile(path, 'utf8')) };
  } catch (error) {
    return { ok: false, reason: `could not edit the message: ${messageOf(error)}` };
  } finally {
    // Even on the way out with an error: the draft is either in hand or
    // deliberately abandoned, and neither is worth leaving in the temp dir.
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** `null` when the editor exited cleanly; otherwise the reason it did not. */
async function runEditor(spawnImpl: SpawnLike, file: string, args: readonly string[]): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (reason: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(reason);
    };
    let child: SpawnedLike;
    try {
      child = spawnImpl(file, args, { stdio: 'inherit' });
    } catch (error) {
      // A synchronous throw is a bad argument rather than a missing program,
      // but it reaches the person the same way as one.
      finish(`could not run ${file}: ${messageOf(error)}`);
      return;
    }
    // Both events can arrive — a failed spawn emits `error` and then `exit`
    // with a null code — so the first one to speak is the answer.
    child.on('error', (error: Error) => {
      finish(`could not run ${file}: ${error.message}`);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) finish(null);
      else if (code !== null) finish(`editor exited with status ${String(code)}`);
      else finish(`editor was stopped by ${signal ?? 'a signal'}`);
    });
  });
}

/**
 * One newline, and the carriage return in front of it: a file saved on Windows
 * ends `\r\n`, which is one newline however many bytes it took.
 */
function stripTrailingNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
