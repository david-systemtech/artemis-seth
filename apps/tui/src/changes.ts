/**
 * What this session changed, and how to take the last change back.
 * ============================================================================
 *
 * An agent rewrites a file, the diff scrolls past in the transcript, and then
 * it is gone. Nothing in the terminal can say which files this session has
 * touched, and nothing can put one of them back. Every other CLI answers this
 * somehow — Claude Code has `/diff` and checkpoints, Gemini `/restore` and
 * `/rewind`, OpenCode `/undo` over git snapshots, Aider a commit per edit — and
 * the answer here is a ledger: one record per *file* of every successful
 * file-editing tool call, each carrying the content that file had immediately
 * **before** the tool ran, plus the totals that let a status line say
 * `3 files · +42 -7`.
 *
 * ## Why pre-images rather than a git snapshot
 *
 * A snapshot scheme has to run before the edit too, and the only thing it can
 * capture is the whole work tree — including whatever the person happened to be
 * writing themselves at that moment. Undoing then means sweeping up their
 * uncommitted work along with the agent's, and by restore time the two are
 * indistinguishable. Reading one file is different in kind: it scopes the undo
 * to exactly the file the agent named, it leaves the index and the stash alone,
 * and it works in a directory that is not a repository at all — which is
 * precisely where there is no other way back.
 *
 * The TUI can do this because it sees `tool.start`: the call has been announced
 * and has not run yet, so the old content is still on disk. That is the one
 * moment it is available, so the read happens there, on every recognised edit,
 * before anyone knows whether the call will even be approved. The snapshot is
 * thrown away on any ending other than `ok`.
 *
 * It is a read racing a tool, and the race is not winnable in general: a
 * provider that has already written the file by the time its event reaches us
 * yields a pre-image equal to the post-image, and the undo is then a harmless
 * no-op rather than a wrong restore. Everything here is arranged so that the
 * failure modes are "cannot undo" and never "undid the wrong thing".
 *
 * ## One call, several files
 *
 * A patch tool rewrites four files in one call, and a ledger that kept only the
 * first of them would be wrong in both directions: the file list would be short
 * by three, and `/undo` would put one file back and leave its neighbours
 * rewritten while reporting success. So every file the call names is read at
 * the same moment — before any of them has been written — and each becomes its
 * own record, because restoring is a decision a person makes one file at a
 * time. A single-file call keeps the provider's call id as its handle, which is
 * the id a person sees; the files of a multi-file one take `id#1`, `id#2`, …
 *
 * Some calls name a file without saying what they did to it. Those are recorded
 * too — a file the agent touched is worth naming even with no diff to show —
 * with zero counts, no read of the disk at all, and no way back: there is no
 * pre-image to restore and none could be invented, so `/undo` says that rather
 * than writing something plausible over the file.
 *
 * ## The guard
 *
 * A restore that blindly writes the pre-image back would destroy work: the
 * agent may have edited the same file twice, the person may have saved it in
 * their editor, a formatter may have run. So each record also keeps a hash of
 * the file as it stood when the call finished, and {@link ChangeLedger.undo}
 * refuses unless the file on disk still matches that hash. A successful undo
 * drops the record and writes nothing new to the ledger — taking a change back
 * is not itself a change, and an undo that recorded one could be undone in
 * turn, which is a loop rather than a feature.
 *
 * ## Bounds
 *
 * A session can edit a large file a thousand times, and none of this is worth a
 * gigabyte of retained strings. Three caps, all of them silent: the last
 * {@link MAX_CHANGES} edits keep their pre-image, a file over
 * {@link MAX_SNAPSHOT_BYTES} is recorded as unrestorable rather than copied,
 * and the retained pre-images together stay under {@link MAX_LEDGER_BYTES}, the
 * oldest dropping out first. The per-file *totals* are not bounded — they are
 * two integers per path, and "files changed" would otherwise start lying after
 * the fiftieth edit.
 *
 * ## Shapes
 *
 * `before` is a tagged union rather than a string with sentinel values, because
 * a file whose entire content is the word `absent` is not a missing file and
 * the difference decides whether undo deletes it.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { JsonObject } from '@rx-artemis/protocol';
import { detectFileEdits, type FileEdit } from '@rx-artemis/transcript';

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** How many edits keep a pre-image. Older ones still count towards the totals. */
export const MAX_CHANGES = 50;

/** A file larger than this is not copied into memory; it is marked unrestorable. */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** Ceiling on every retained pre-image together. The oldest go first. */
export const MAX_LEDGER_BYTES = 16 * 1024 * 1024;

/**
 * Snapshots waiting for their `tool.end`.
 *
 * The protocol promises an end for every start, but a provider that dies
 * mid-call does not get to leak the pre-image of every file it touched.
 */
const MAX_PENDING = 50;

/** How long `git` gets for one of the three commands `/diff` runs. */
const GIT_TIMEOUT_MS = 5_000;

/** Bigger than any diff anybody reads in a terminal, and a bound on the pipe. */
const GIT_MAX_BYTES = 16 * 1024 * 1024;

/** Characters of assembled diff text handed back to the caller. */
const MAX_DIFF_CHARS = 256 * 1024;

/** Untracked paths listed before the rest is summarised as a count. */
const MAX_UNTRACKED_LISTED = 50;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The file as it was before the edit.
 *
 * `too large` and `unknown` are records of *why* there is nothing to restore,
 * kept rather than dropped so that `/undo` can say so instead of claiming the
 * change never happened.
 */
export type PreImage =
  | { readonly kind: 'content'; readonly text: string }
  /** There was no file. Undoing means deleting the one the tool created. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'too large'; readonly bytes: number }
  /** Unreadable, or not text: binary content cannot survive the round trip. */
  | { readonly kind: 'unknown' }
  /**
   * Never read, because the call named the file and described no change to it.
   * Distinct from `unknown`, which is a file that was there and would not be
   * read: this one was deliberately left alone.
   */
  | { readonly kind: 'not taken' };

/** One file of one successful file-editing tool call. */
export interface Change {
  /**
   * The handle `/undo` takes: the provider's tool call id, or `id#1`, `id#2`, …
   * when one call edited several files and each needs addressing on its own.
   */
  readonly id: string;
  /** Absolute, resolved against the ledger's `cwd`. */
  readonly path: string;
  /** When the call started, not when it finished. */
  readonly ts: number;
  readonly added: number;
  readonly removed: number;
  readonly before: PreImage;
  /** The diff itself, exactly as the transcript renders it. */
  readonly edit: FileEdit;
}

/** One file's share of the session, for the status line and the `/diff` list. */
export interface ChangedFile {
  /** Absolute. */
  readonly path: string;
  /** How it reads on screen: relative to `cwd` when it is under it. */
  readonly label: string;
  readonly added: number;
  readonly removed: number;
  /** How many recorded edits touched it. */
  readonly edits: number;
  /** When the last of them started. */
  readonly last: number;
}

/** A `tool.start`, reduced to what the ledger needs. */
export interface ToolStartLike {
  /** `toolCallId`. What pairs this with its end. */
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject | undefined;
  /** Defaults to the clock. */
  readonly ts?: number;
}

/** A `tool.end`, reduced to what the ledger needs. */
export interface ToolEndLike {
  readonly id: string;
  /** `ok` promotes the snapshot; `error`, `denied` and `cancelled` drop it. */
  readonly status: string;
}

export type UndoResult =
  | { readonly ok: true; readonly path: string; readonly action: 'restored' | 'deleted' }
  | { readonly ok: false; readonly reason: string };

/**
 * The filesystem and the clock, injectable.
 *
 * Deliberately narrower than `node:fs/promises`: the encoding, the `force` on a
 * delete and the rest are this module's decisions, not a caller's, and a test
 * standing in for the disk should have four small functions to write rather
 * than four overloaded ones.
 */
export interface ChangeLedgerDeps {
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly stat: (path: string) => Promise<{ readonly size: number }>;
  /** Delete, and succeed when there is nothing there. */
  readonly rm: (path: string) => Promise<void>;
  readonly now: () => number;
}

export const nodeChangeDeps: ChangeLedgerDeps = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text, 'utf8'),
  stat: (path) => stat(path),
  rm: (path) => rm(path, { force: true }),
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/** What the file looked like at a point in time, cheaply comparable. */
type Image =
  | { readonly kind: 'absent' }
  | { readonly kind: 'hash'; readonly hash: string }
  /** Could not be read or is too large to hash: nothing can be verified. */
  | { readonly kind: 'unknown' };

interface Snapshot {
  readonly id: string;
  readonly path: string;
  readonly ts: number;
  readonly edit: FileEdit;
  readonly before: PreImage;
}

interface Totals {
  added: number;
  removed: number;
  edits: number;
  last: number;
}

/**
 * The file edits of one conversation.
 *
 * Fed every `tool.start` and `tool.end` — including a subagent's, since a
 * subagent's edits land on the same disk — and asked afterwards what changed.
 * Nothing here throws: a ledger that cannot read a file records that it could
 * not, and an undo that cannot be verified refuses. Losing the ability to
 * restore one file is a disappointment; an exception raised from an event
 * handler while a run streams is a crash.
 */
export class ChangeLedger {
  #cwd: string;
  readonly #deps: ChangeLedgerDeps;

  /** Keyed by tool call id, oldest first. Holds the *promise* of that call's
   *  snapshots so that an end arriving before the reads finish still waits. */
  readonly #pending = new Map<string, Promise<readonly Snapshot[]>>();

  /** Oldest first, so eviction is from the front and `last()` is the end. */
  #changes: Change[] = [];

  /** The file as it stood when each change finished, for the undo guard. */
  readonly #after = new Map<string, Image>();

  /** Sum of the retained pre-images, against {@link MAX_LEDGER_BYTES}. */
  #bytes = 0;

  /** Per file, across the whole session — never evicted. */
  readonly #totals = new Map<string, Totals>();

  constructor(cwd: string, deps: Partial<ChangeLedgerDeps> = {}) {
    this.#cwd = cwd;
    this.#deps = { ...nodeChangeDeps, ...deps };
  }

  /* ---------------------------------------------------------------------- */
  /* Events                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * A tool call has been announced. If it is an edit, read the file now.
   *
   * The returned promise is there for tests and for a caller that wants to
   * order something after the read; it never rejects, so `void ledger
   * .onToolStart(...)` from a synchronous event handler is correct.
   */
  async onToolStart(item: ToolStartLike): Promise<void> {
    const edits = detectFileEdits(item.name, item.input);
    if (edits.length === 0) return;
    const ts = item.ts ?? this.#deps.now();
    const taking = this.#snapshots(item.id, ts, edits);
    this.#pending.set(item.id, taking);
    this.#trimPending();
    await taking;
  }

  /** The call finished. On `ok` the snapshots become changes; otherwise they go. */
  async onToolEnd(item: ToolEndLike): Promise<void> {
    const taking = this.#pending.get(item.id);
    if (taking === undefined) return;
    this.#pending.delete(item.id);
    const snapshots = await taking;
    // A tool that failed, was denied or was cancelled did not edit anything —
    // and if it partially did, the pre-images are the wrong thing to trust.
    if (item.status !== 'ok') return;
    // In the order the call named the files, which is the order they are shown
    // in and the order the after-images have to be taken in.
    for (const snapshot of snapshots) await this.#record(snapshot);
  }

  /** A new conversation. Optionally a new working directory with it. */
  reset(cwd?: string): void {
    if (cwd !== undefined) this.#cwd = cwd;
    this.#pending.clear();
    this.#changes = [];
    this.#after.clear();
    this.#totals.clear();
    this.#bytes = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Reading                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Every recorded change, newest first. */
  changes(): readonly Change[] {
    return [...this.#changes].reverse();
  }

  /** The change `/undo` would take back with no argument. */
  last(): Change | undefined {
    return this.#changes.at(-1);
  }

  /** Per-file totals across the session, most recently touched first. */
  files(): readonly ChangedFile[] {
    const files: ChangedFile[] = [];
    for (const [path, totals] of this.#totals) {
      files.push({ path, label: this.#label(path), added: totals.added, removed: totals.removed, edits: totals.edits, last: totals.last });
    }
    return files.sort((a, b) => b.last - a.last || byText(a.label, b.label));
  }

  /* ---------------------------------------------------------------------- */
  /* Undo                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Put one change back: the named one, or the most recent.
   *
   * Refuses unless the file still looks exactly as it did when the call
   * finished. Anything else — a later edit to the same file, a save from the
   * person's editor, a formatter — means the pre-image is no longer the right
   * thing to write, and writing it would delete work nobody asked to lose.
   */
  async undo(id?: string): Promise<UndoResult> {
    const change = id === undefined ? this.last() : this.#changes.find((candidate) => candidate.id === id);
    if (change === undefined) {
      return { ok: false, reason: id === undefined ? 'there is nothing to undo' : 'that change is not in this session’s ledger' };
    }

    const label = this.#label(change.path);
    const before = change.before;
    // Nothing was ever read for this one, so there is nothing to write back and
    // no after-image to check it against.
    if (before.kind === 'not taken') {
      return { ok: false, reason: 'this edit carried no content to restore' };
    }
    if (before.kind === 'too large') return { ok: false, reason: `${label} was too large to snapshot before the edit` };
    if (before.kind === 'unknown') return { ok: false, reason: `${label} could not be read before the edit` };

    const after = this.#after.get(change.id) ?? { kind: 'unknown' as const };
    if (after.kind === 'unknown') return { ok: false, reason: `${label} could not be read after the edit` };
    const current = await this.#imageOf(change.path);
    if (!sameImage(current, after)) return { ok: false, reason: 'the file has changed since' };

    try {
      if (before.kind === 'absent') await this.#deps.rm(change.path);
      else await this.#deps.writeFile(change.path, before.text);
    } catch (error) {
      return { ok: false, reason: `${label} could not be written: ${describe(error)}` };
    }

    this.#forget(change);
    return { ok: true, path: change.path, action: before.kind === 'absent' ? 'deleted' : 'restored' };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * One snapshot per file the call named, all read at the same moment.
   *
   * In parallel rather than in sequence: the call is already announced and the
   * tool is free to start writing, so the window in which the files still hold
   * their old contents is exactly as long as these reads take.
   */
  async #snapshots(
    id: string,
    ts: number,
    edits: readonly FileEdit[],
  ): Promise<readonly Snapshot[]> {
    return Promise.all(
      edits.map(async (edit, index) => {
        const path = resolve(this.#cwd, edit.path);
        return {
          id: handle(id, index, edits.length),
          path,
          ts,
          edit,
          before:
            edit.summaryOnly === true
              ? ({ kind: 'not taken' } as const)
              : await this.#preImage(path),
        };
      }),
    );
  }

  async #preImage(path: string): Promise<PreImage> {
    let size: number;
    try {
      size = (await this.#deps.stat(path)).size;
    } catch (error) {
      // A path that is not there is the ordinary case for a file write, and the
      // only one where undo means deleting rather than restoring.
      return isMissing(error) ? { kind: 'absent' } : { kind: 'unknown' };
    }
    if (size > MAX_SNAPSHOT_BYTES) return { kind: 'too large', bytes: size };
    let text: string;
    try {
      text = await this.#deps.readFile(path);
    } catch {
      return { kind: 'unknown' };
    }
    // Decoded as UTF-8, so bytes that are not text came back as replacement
    // characters and writing them back would corrupt the file. A NUL is the
    // one marker that says "binary" without a false positive worth worrying
    // about; a lone replacement character in genuine text is left alone.
    if (text.includes('\u0000')) return { kind: 'unknown' };
    return { kind: 'content', text };
  }

  async #record(snapshot: Snapshot): Promise<void> {
    // A file that was never read has nothing to guard: the after-image exists
    // to prove the pre-image is still the right thing to write, and there is no
    // pre-image here.
    const after: Image =
      snapshot.before.kind === 'not taken'
        ? { kind: 'unknown' }
        : await this.#imageOf(snapshot.path);
    const change: Change = {
      id: snapshot.id,
      path: snapshot.path,
      ts: snapshot.ts,
      added: snapshot.edit.added,
      removed: snapshot.edit.removed,
      before: snapshot.before,
      edit: snapshot.edit,
    };
    this.#insert(change);
    this.#after.set(change.id, after);
    if (change.before.kind === 'content') this.#bytes += Buffer.byteLength(change.before.text, 'utf8');
    this.#fold(change, 1);
    this.#trim();
  }

  /**
   * Keep the list in start order.
   *
   * Two calls that end in the same tick resolve their reads in whichever order
   * the disk answers, and "the last change" must not depend on that. Start
   * order is the order the agent asked for the edits, which is the order a
   * person watched them happen.
   */
  #insert(change: Change): void {
    let at = this.#changes.length;
    while (at > 0 && (this.#changes[at - 1]?.ts ?? 0) > change.ts) at -= 1;
    this.#changes.splice(at, 0, change);
  }

  /** The file as it is right now, cheap enough to run on every end and undo. */
  async #imageOf(path: string): Promise<Image> {
    let size: number;
    try {
      size = (await this.#deps.stat(path)).size;
    } catch (error) {
      return isMissing(error) ? { kind: 'absent' } : { kind: 'unknown' };
    }
    if (size > MAX_SNAPSHOT_BYTES) return { kind: 'unknown' };
    try {
      return { kind: 'hash', hash: createHash('sha256').update(await this.#deps.readFile(path), 'utf8').digest('hex') };
    } catch {
      return { kind: 'unknown' };
    }
  }

  /** Add (`1`) or take away (`-1`) one change's share of its file's totals. */
  #fold(change: Change, sign: 1 | -1): void {
    const totals = this.#totals.get(change.path);
    if (totals === undefined) {
      if (sign < 0) return;
      this.#totals.set(change.path, { added: change.added, removed: change.removed, edits: 1, last: change.ts });
      return;
    }
    totals.added = Math.max(0, totals.added + sign * change.added);
    totals.removed = Math.max(0, totals.removed + sign * change.removed);
    totals.edits += sign;
    if (totals.edits <= 0) this.#totals.delete(change.path);
    // `last` is left where it was on the way down: it is a sort key, and the
    // file *was* touched then even if the touch has since been undone.
    else if (sign > 0) totals.last = Math.max(totals.last, change.ts);
  }

  /** Undone: gone from the ledger and from the totals, as if it never ran. */
  #forget(change: Change): void {
    const at = this.#changes.indexOf(change);
    if (at >= 0) this.#changes.splice(at, 1);
    this.#release(change);
    this.#fold(change, -1);
  }

  /** Aged out: the pre-image goes, the totals stay. */
  #trim(): void {
    while (this.#changes.length > MAX_CHANGES || (this.#bytes > MAX_LEDGER_BYTES && this.#changes.length > 1)) {
      const oldest = this.#changes.shift();
      if (oldest === undefined) return;
      this.#release(oldest);
    }
  }

  #release(change: Change): void {
    this.#after.delete(change.id);
    if (change.before.kind === 'content') this.#bytes = Math.max(0, this.#bytes - Buffer.byteLength(change.before.text, 'utf8'));
  }

  #trimPending(): void {
    while (this.#pending.size > MAX_PENDING) {
      const oldest = this.#pending.keys().next();
      if (oldest.done === true) return;
      this.#pending.delete(oldest.value);
    }
  }

  #label(path: string): string {
    const within = relative(this.#cwd, path);
    if (within.length === 0 || within.startsWith('..') || isAbsolute(within)) return path;
    return within.split(sep).join('/');
  }
}

/**
 * The handle one file of one call is undone by.
 *
 * A call that edited a single file keeps the provider's own id: it is the id
 * the transcript shows, and it is what a person would type. Several files need
 * several handles, and a suffix keeps the call they came from legible in a way
 * a fresh identifier would not.
 */
const handle = (id: string, index: number, total: number): string =>
  total === 1 ? id : `${id}#${String(index + 1)}`;

const sameImage = (current: Image, after: Image): boolean => {
  if (current.kind === 'absent' && after.kind === 'absent') return true;
  return current.kind === 'hash' && after.kind === 'hash' && current.hash === after.hash;
};

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { readonly code?: unknown }).code === 'ENOENT';

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// The whole picture: git
// ---------------------------------------------------------------------------

export type GitDiffResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

export interface GitDiffDeps {
  /** Run `git` with these arguments in `cwd` and hand back stdout. Throws on a
   *  non-zero exit, which is how "not a repository" and "no HEAD" are read. */
  readonly run?: (args: readonly string[], cwd: string) => Promise<string>;
  readonly timeoutMs?: number;
}

/**
 * Everything different about the work tree, as `/diff` shows it.
 *
 * The ledger knows what *this session* did; this is the other question, the one
 * a person asks before committing: what is different from the last commit,
 * whoever changed it. So it is git's answer verbatim — stat first as a table of
 * contents, then the patch — rather than anything reconstructed here.
 *
 * Untracked files are named at the top because they are the half of the answer
 * `git diff` silently omits: a session whose whole output is three new files
 * would otherwise report nothing at all. Their contents are not shown; the
 * names are the part that is missing.
 *
 * A repository with no commits yet is diffed against the index, which is the
 * only thing there is to diff against, and where a `git diff` with no arguments
 * would show an empty answer for a directory full of new work.
 */
export async function gitDiff(cwd: string, deps: GitDiffDeps = {}): Promise<GitDiffResult> {
  const timeout = deps.timeoutMs ?? GIT_TIMEOUT_MS;
  const git = deps.run ?? ((args: readonly string[], at: string) => runGit(args, at, timeout));

  try {
    await git(['rev-parse', '--is-inside-work-tree'], cwd);
  } catch (error) {
    if (isMissingBinary(error)) return { ok: false, reason: 'git is not on PATH' };
    return { ok: false, reason: `${cwd} is not a git repository` };
  }

  const committed = await succeeds(git(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd));
  const against = committed ? ['HEAD'] : ['--cached'];

  const [status, stat_, patch] = await Promise.all([
    orEmpty(git(['status', '--porcelain', '-z'], cwd)),
    orEmpty(git(['diff', '--no-color', '--stat', ...against], cwd)),
    orEmpty(git(['diff', '--no-color', ...against], cwd)),
  ]);

  const sections: string[] = [];
  const untracked = untrackedPaths(status);
  if (untracked.length > 0) {
    const listed = untracked.slice(0, MAX_UNTRACKED_LISTED).map((path) => `  ${path}`);
    if (untracked.length > listed.length) listed.push(`  … and ${String(untracked.length - listed.length)} more`);
    sections.push(`Untracked:\n${listed.join('\n')}`);
  }
  if (stat_.trim().length > 0) sections.push(stat_.trimEnd());
  if (patch.trim().length > 0) sections.push(patch.trimEnd());

  const text = sections.join('\n\n');
  if (text.length <= MAX_DIFF_CHARS) return { ok: true, text };
  return { ok: true, text: `${text.slice(0, MAX_DIFF_CHARS)}\n… ${String(text.length - MAX_DIFF_CHARS)} more characters not shown` };
}

async function runGit(args: readonly string[], cwd: string, timeout: number): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd, timeout, maxBuffer: GIT_MAX_BYTES, encoding: 'utf8', windowsHide: true });
  return stdout;
}

const succeeds = async (promise: Promise<unknown>): Promise<boolean> => {
  try {
    await promise;
    return true;
  } catch {
    return false;
  }
};

/** One command failing is a thinner answer, not an error in front of the user. */
const orEmpty = async (promise: Promise<string>): Promise<string> => {
  try {
    return await promise;
  } catch {
    return '';
  }
};

const isMissingBinary = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { readonly code?: unknown }).code === 'ENOENT';

/**
 * The `??` entries of `git status --porcelain -z`.
 *
 * `-z` because a filename may contain a newline, which the quoted format
 * escapes into something that is no longer a path. Each record is `XY path`;
 * a rename or copy adds a *second* NUL-separated field for the source, which is
 * skipped here so that an old path is never mistaken for the next record's
 * status.
 */
function untrackedPaths(stdout: string): readonly string[] {
  const records = stdout.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    if (status.startsWith('R') || status.startsWith('C')) index += 1;
    if (status === '??') paths.push(record.slice(3));
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Saying it in a line
// ---------------------------------------------------------------------------

/**
 * `3 files · +42 -7`, for the status bar.
 *
 * Empty for an untouched session, because a bar that says `0 files` is a bar
 * that spends columns saying nothing happened. Under pressure the churn goes
 * before the count: `3 files` still answers "has anything changed", which is
 * the question a glance at a status line is asking.
 */
export function summarizeFiles(files: readonly ChangedFile[], columns: number = Number.POSITIVE_INFINITY): string {
  if (files.length === 0) return '';
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
  }
  const count = `${String(files.length)} file${files.length === 1 ? '' : 's'}`;
  const full = `${count} · +${String(added)} -${String(removed)}`;
  if (full.length <= columns) return full;
  if (count.length <= columns) return count;
  return count.slice(0, Math.max(0, Math.floor(columns)));
}

/**
 * One `path +N -M` line per file, for a picker.
 *
 * The counts are the fixed part and the path is the variable one, so the path
 * is what gives way: shortened from the left, which keeps the filename — the
 * end everybody reads — and loses the directory prefix that several rows
 * probably share anyway. Padded into a column so the numbers line up, since
 * ragged numbers are the thing that makes a list like this hard to scan.
 */
export function fileLines(files: readonly ChangedFile[], columns: number = Number.POSITIVE_INFINITY): readonly string[] {
  const rows = files.map((file) => ({ label: file.label, counts: `+${String(file.added)} -${String(file.removed)}` }));
  const widest = rows.reduce((width, row) => Math.max(width, row.counts.length), 0);
  // One width for every row, measured once: the column only lines up if the
  // padding is the same on the row that needed it and the row that did not.
  const room = Math.floor(columns) - widest - 2;
  const labels = room < 4 ? 0 : rows.reduce((width, row) => Math.max(width, Math.min(row.label.length, room)), 0);
  return rows.map((row) => {
    const counts = row.counts.padStart(widest, ' ');
    if (room < 4) return `${row.label}  ${counts}`;
    return `${shortenLeft(row.label, room).padEnd(labels, ' ')}  ${counts}`;
  });
}

const shortenLeft = (text: string, width: number): string =>
  text.length <= width ? text : width <= 1 ? '…' : `…${text.slice(text.length - (width - 1))}`;
