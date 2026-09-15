/**
 * `@path` mentions: what to offer, and in what order.
 * ============================================================================
 *
 * Naming a file to the agent is the most common thing anyone types into the
 * composer, and typing it out in full is the slowest. So `@` starts a
 * completion, and this module is everything that completion needs that is not
 * a terminal: the list of candidate paths, the scorer that ranks them against
 * what has been typed, the memory of what was picked before, and the two
 * string operations that find the token under the cursor and write the answer
 * back into it. The popup is left to the component; nothing here draws.
 *
 * Four decisions worth knowing:
 *
 *  - **Git is the file list when there is one.** `git ls-files --cached
 *    --others --exclude-standard` is the only listing that already knows what
 *    a project considers its own: it includes files never committed and
 *    excludes `node_modules`, build output and everything else the ignore
 *    rules name, without this module having to guess. Outside a work tree
 *    there is a walk, with a hand-written skip list, which is a guess and is
 *    therefore the fallback rather than the rule.
 *  - **The scorer is a small dynamic program, not a greedy scan.** The cheap
 *    way to score a fuzzy match is to take the first subsequence you find and
 *    grade it; that way `co/Comp` scores `packages/core/src/adapters/compose.ts`
 *    above `apps/tui/src/components/Composer.tsx`, because `co` lands
 *    consecutively on `core` while the greedy scan misses that it could have
 *    landed on the `co` of `components` too. Ranking the wrong file first is
 *    the whole failure mode of a completion, so the match is chosen by an
 *    exact best-path search over the (short) query and the (short) path,
 *    which costs a few hundred additions per candidate.
 *  - **Frecency is a bonus, not a sort key.** A path picked often and lately
 *    is worth about as much as a couple of word-boundary bonuses: enough to
 *    win between near-identical candidates, never enough to float an
 *    irrelevant file above a good textual match. With nothing typed there is
 *    no textual match to respect, so then it is the whole order.
 *  - **A mention token starts at an `@` that follows whitespace.** Otherwise
 *    every email address in a message is a half-finished completion.
 */

import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { tuiStateDir, type PreferencesDirInputs } from './preferences.js';

const run = promisify(execFile);

/** Code-unit order, so a listing does not depend on anybody's locale. */
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// The file list
// ---------------------------------------------------------------------------

/** How many paths a walk will collect before it stops looking. */
export const DEFAULT_FILE_LIMIT = 20_000;

const GIT_TIMEOUT_MS = 5_000;
/** A repository with more path bytes than this gets a truncated list, not a stall. */
const GIT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Directories the walk never enters. Everything here is either not source
 * (`node_modules`), or generated from source (`dist`, `out`, `.tsbuild`), or
 * the repository's own bookkeeping (`.git`) — and all of them are large, which
 * is what makes them worth naming rather than paying for.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules', 'dist', 'out', '.tsbuild']);

export interface ListFilesOptions {
  /** Most paths to return. Default {@link DEFAULT_FILE_LIMIT}. */
  readonly limit?: number;
  /** How long `git` gets. Default 5 s. */
  readonly timeoutMs?: number;
  /** `false` to walk even inside a work tree. Default: git when it answers. */
  readonly git?: boolean;
}

/**
 * The files under `cwd`, as paths relative to it with forward slashes,
 * whichever platform this is.
 *
 * Git first, then the walk. Git is asked rather than interrogated: running
 * `ls-files` and taking a failure to mean "not a repository" is one process
 * instead of two, and covers the other reasons it could fail — no `git` on
 * `PATH`, a broken index, a timeout — with the same fallback.
 *
 * Directories are not entries. A directory is not something a message can
 * refer to, and a list with both in it makes the completion ambiguous about
 * what Enter accepts.
 */
export async function listFiles(cwd: string, options: ListFilesOptions = {}): Promise<readonly string[]> {
  const limit = options.limit ?? DEFAULT_FILE_LIMIT;
  if (limit <= 0) return [];
  const tracked = options.git === false ? undefined : await gitFiles(cwd, options.timeoutMs ?? GIT_TIMEOUT_MS);
  const found = tracked ?? (await walkFiles(cwd, limit));
  // The index lists a path once per stage while a merge is unresolved, so a
  // conflicted file would otherwise appear two or three times in the popup.
  return [...new Set(found)].sort(byPath).slice(0, limit);
}

/** `undefined` when git could not answer, which is the signal to walk instead. */
async function gitFiles(cwd: string, timeout: number): Promise<readonly string[] | undefined> {
  // `-z` because a filename may contain a newline, and without it git quotes
  // and escapes such names into something that is no longer a path.
  const args = ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  try {
    const { stdout } = await run('git', args, { cwd, timeout, maxBuffer: GIT_MAX_BYTES, encoding: 'utf8', windowsHide: true });
    return splitTerminated(stdout);
  } catch (error) {
    // A repository too large for the buffer still hands back everything it
    // wrote before the cap; a partial list beats no completion at all.
    const partial = partialStdout(error);
    return partial === undefined ? undefined : splitTerminated(partial);
  }
}

function partialStdout(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('stdout' in error)) return undefined;
  const stdout = (error as { readonly stdout?: unknown }).stdout;
  return typeof stdout === 'string' && stdout.length > 0 ? stdout : undefined;
}

/**
 * Split NUL-*terminated* output. The final piece is dropped because in whole
 * output it is empty, and in output cut short by the size cap it is half a
 * path — which is worse than one path fewer.
 */
function splitTerminated(stdout: string): readonly string[] {
  const pieces = stdout.split('\0');
  pieces.pop();
  return pieces.filter((piece) => piece.length > 0);
}

/**
 * The walk. Depth-first in name order so that the same tree always yields the
 * same list, including when the cap cuts it short.
 *
 * Symlinks are neither listed nor followed. Following them risks walking the
 * whole disk through one link, and telling a link to a file from a link to a
 * directory costs a `stat` per entry — hundreds in a directory of links — for
 * a kind of entry that is rare among a project's own sources.
 */
async function walkFiles(root: string, limit: number): Promise<readonly string[]> {
  const found: string[] = [];

  const visit = async (directory: string, prefix: string): Promise<void> => {
    let entries: readonly Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // Unreadable, gone, or not a directory: it contributes nothing.
      return;
    }
    const sorted = [...entries].sort((a, b) => byPath(a.name, b.name));
    const descend: { readonly directory: string; readonly prefix: string }[] = [];
    for (const entry of sorted) {
      if (found.length >= limit) return;
      if (entry.isFile()) found.push(prefix + entry.name);
      // `isDirectory()` is already false for a symlink, which is how "never
      // follow one" is enforced.
      else if (entry.isDirectory() && !isSkipped(entry.name)) descend.push({ directory: join(directory, entry.name), prefix: `${prefix}${entry.name}/` });
    }
    for (const child of descend) {
      if (found.length >= limit) return;
      await visit(child.directory, child.prefix);
    }
  };

  await visit(root, '');
  return found;
}

/** Dot-directories go too: `.venv`, `.next`, `.cache` — none of them are the project. */
const isSkipped = (name: string): boolean => SKIPPED_DIRECTORIES.has(name) || name.startsWith('.');

// ---------------------------------------------------------------------------
// The scorer
// ---------------------------------------------------------------------------

/** What a path is worth against a query, and where the match landed. */
export interface FileMatch {
  readonly path: string;
  readonly score: number;
  /** Offsets into `path` of the matched characters, for highlighting. */
  readonly indices: readonly number[];
}

/** The part of {@link Frecency} the matcher needs, so a test can stand in for it. */
export interface FrecencyLike {
  boost(path: string): number;
}

export interface FuzzyMatchOptions {
  /** Most results to return. Default {@link DEFAULT_MATCH_LIMIT}. */
  readonly limit?: number;
  /** Where "picked this one before" comes from. */
  readonly frecency?: FrecencyLike;
}

export const DEFAULT_MATCH_LIMIT = 12;

/** Every matched character is worth this much before bonuses. */
const MATCH = 16;
/** Landing after a `/`, `-`, `_`, `.` or space, or at the very start. */
const BONUS_BOUNDARY = 8;
/** Landing on the capital of a camelCase hump, which is a word start too. */
const BONUS_CAMEL = 7;
/** Landing on the first character of the basename — the part people type. */
const BONUS_BASENAME = 12;
/** Landing immediately after the previous match: runs read as one word. */
const BONUS_CONSECUTIVE = 10;
/** Typing a filename exactly should not have to out-argue the path it sits in. */
const BONUS_EXACT_BASENAME = 64;
/** Skipping characters costs; the first skipped one costs the most. */
const GAP_START = 3;
const GAP_EXTEND = 1;

const DELIMITERS: ReadonlySet<string> = new Set(['/', '\\', '-', '_', '.', ' ']);

const NO_INDICES: readonly number[] = [];

/**
 * `paths` ranked against `query`, best first.
 *
 * Characters must appear in order, case-insensitively; anything else is not a
 * candidate. Ties go to the shorter path and then to path order, so the list
 * never reshuffles between keystrokes that do not change the ranking.
 *
 * An empty query is not a match of everything — it is the state before typing,
 * and the useful answer there is what was picked before, then alphabetical.
 */
export function fuzzyMatch(query: string, paths: readonly string[], options: FuzzyMatchOptions = {}): readonly FileMatch[] {
  const limit = options.limit ?? DEFAULT_MATCH_LIMIT;
  if (limit <= 0) return [];
  const frecency = options.frecency;
  const boost = (path: string): number => frecency?.boost(path) ?? 0;

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    // Alphabetical rather than shortest-first below the boosts: with no query
    // there is nothing that makes a short path a better guess, and a list in
    // path order is one somebody can read down.
    return [...paths]
      .map((path) => ({ path, score: boost(path), indices: NO_INDICES }))
      .sort((a, b) => b.score - a.score || byPath(a.path, b.path))
      .slice(0, limit);
  }

  const needle = alignedLower(trimmed);
  const matches: FileMatch[] = [];
  for (const path of paths) {
    const scored = scorePath(needle, path);
    if (scored !== null) matches.push({ path, score: scored.score + boost(path), indices: scored.indices });
  }
  return matches.sort(byRank).slice(0, limit);
}

const byRank = (a: FileMatch, b: FileMatch): number =>
  b.score - a.score || a.path.length - b.path.length || byPath(a.path, b.path);

/**
 * `value` in lower case, one character per character, so an offset into the
 * result is an offset into the original. A few characters lower-case to two
 * (`İ`), which would slide every later index by one and mis-highlight the
 * rest of the path; those are left alone.
 */
function alignedLower(value: string): string {
  const lower = value.toLowerCase();
  if (lower.length === value.length) return lower;
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    const folded = character.toLowerCase();
    out += folded.length === character.length ? folded : character;
  }
  return out;
}

/**
 * The best-scoring way to match `needle` (already lower case) in `path`, or
 * `null` if it does not occur in order.
 *
 * `best[i][j]` is the best score for the first `i + 1` query characters when
 * the `i`th of them lands on `j`. Reaching `j` is either a step from `j - 1`,
 * which earns the consecutive bonus, or a jump from some earlier `k`, which
 * pays for the gap; the best `k` is carried along in a running maximum
 * (rewritten so the distance-dependent penalty factors out), which is what
 * keeps this linear in the path length per query character.
 */
function scorePath(needle: string, path: string): { readonly score: number; readonly indices: readonly number[] } | null {
  const haystack = alignedLower(path);
  const width = haystack.length;
  const height = needle.length;
  if (height === 0 || height > width || !occursInOrder(needle, haystack)) return null;

  const basenameStart = haystack.lastIndexOf('/') + 1;
  const best: number[] = new Array<number>(height * width).fill(-Infinity);
  const cameFrom: number[] = new Array<number>(height * width).fill(-1);

  const first = needle.charCodeAt(0);
  for (let j = 0; j < width; j += 1) {
    if (haystack.charCodeAt(j) === first) best[j] = MATCH + bonusAt(path, haystack, j, basenameStart);
  }

  for (let i = 1; i < height; i += 1) {
    const row = i * width;
    const previous = row - width;
    const code = needle.charCodeAt(i);
    // The best `k` no closer than two behind, held as `best[k] + GAP_EXTEND * k`
    // so that subtracting the gap penalty needs only today's `j`.
    let carried = -Infinity;
    let carriedFrom = -1;
    for (let j = i; j < width; j += 1) {
      const k = j - 2;
      if (k >= 0) {
        const candidate = (best[previous + k] ?? -Infinity) + GAP_EXTEND * k;
        if (candidate > carried) {
          carried = candidate;
          carriedFrom = k;
        }
      }
      if (haystack.charCodeAt(j) !== code) continue;
      const stepped = (best[previous + j - 1] ?? -Infinity) + BONUS_CONSECUTIVE;
      const jumped = carried - GAP_START - GAP_EXTEND * (j - 2);
      if (stepped === -Infinity && jumped === -Infinity) continue;
      const character = MATCH + bonusAt(path, haystack, j, basenameStart);
      if (stepped >= jumped) {
        best[row + j] = character + stepped;
        cameFrom[row + j] = j - 1;
      } else {
        best[row + j] = character + jumped;
        cameFrom[row + j] = carriedFrom;
      }
    }
  }

  const last = (height - 1) * width;
  let end = -1;
  let score = -Infinity;
  for (let j = height - 1; j < width; j += 1) {
    const candidate = best[last + j] ?? -Infinity;
    if (candidate > score) {
      score = candidate;
      end = j;
    }
  }
  if (end < 0) return null;

  const indices: number[] = new Array<number>(height).fill(0);
  for (let i = height - 1, j = end; i >= 0; i -= 1) {
    indices[i] = j;
    j = cameFrom[i * width + j] ?? -1;
  }

  // Typing a whole filename is not a fuzzy query, it is an answer.
  if (haystack.slice(basenameStart) === needle) score += BONUS_EXACT_BASENAME;
  return { score, indices };
}

function occursInOrder(needle: string, haystack: string): boolean {
  let at = 0;
  for (let j = 0; j < haystack.length && at < needle.length; j += 1) {
    if (haystack.charCodeAt(j) === needle.charCodeAt(at)) at += 1;
  }
  return at === needle.length;
}

/** What the position of a match is worth, before consecutiveness and gaps. */
function bonusAt(path: string, haystack: string, index: number, basenameStart: number): number {
  const basename = index === basenameStart ? BONUS_BASENAME : 0;
  if (index === 0) return basename + BONUS_BOUNDARY;
  const before = haystack.charAt(index - 1);
  if (DELIMITERS.has(before)) return basename + BONUS_BOUNDARY;
  // A hump: the previous character is not upper case and this one is. Compared
  // against the folded copy rather than with a regular expression, so this
  // stays one comparison per candidate position.
  const humped = path.charAt(index - 1) === before && path.charAt(index) !== haystack.charAt(index);
  return basename + (humped ? BONUS_CAMEL : 0);
}

// ---------------------------------------------------------------------------
// What was picked before
// ---------------------------------------------------------------------------

interface FrecencyEntry {
  /** When it was last picked. */
  readonly at: number;
  /** How many times, ever. */
  readonly count: number;
}

interface StoredFrecency {
  readonly version?: unknown;
  readonly entries?: unknown;
}

const FRECENCY_VERSION = 1;
const FRECENCY_FILE = 'files.json';
/** A pick is worth half as much a fortnight later. */
const FRECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
/** The most a boost can be worth: a basename bonus and a couple of boundaries. */
const FRECENCY_MAX = 48;
/** Picks beyond this stop making a path more special. */
const FRECENCY_FULL_COUNT = 16;
/** How many paths the file keeps, so a long-lived install does not grow one forever. */
const FRECENCY_KEEP = 512;

/** Where the picks are remembered, beside the other things the terminal keeps. */
export function defaultFrecencyPath(inputs: PreferencesDirInputs = {}): string {
  return join(tuiStateDir(inputs), FRECENCY_FILE);
}

/**
 * Which paths were picked, how often, and how long ago.
 *
 * Both halves matter and neither alone is enough: counting only frequency
 * makes last month's refactor outrank this morning's work forever, and
 * counting only recency forgets the file someone lives in the moment they open
 * something else. So a count is worth less the older it is — an exponential
 * decay, which needs one timestamp per path instead of a history.
 *
 * `now` is a parameter everywhere rather than a read of the clock, because a
 * test cannot wait a fortnight.
 */
export class Frecency {
  readonly #entries = new Map<string, FrecencyEntry>();
  #path: string | undefined;

  constructor(path?: string) {
    this.#path = path;
  }

  /** What to add to a path's match score. Zero for a path never picked. */
  boost(path: string, now: number = Date.now()): number {
    const entry = this.#entries.get(path);
    if (entry === undefined) return 0;
    const age = Math.max(0, now - entry.at);
    const recency = 0.5 ** (age / FRECENCY_HALF_LIFE_MS);
    const often = Math.log2(1 + Math.min(entry.count, FRECENCY_FULL_COUNT)) / Math.log2(1 + FRECENCY_FULL_COUNT);
    return FRECENCY_MAX * recency * often;
  }

  /** This path was just chosen. */
  record(path: string, now: number = Date.now()): void {
    const entry = this.#entries.get(path);
    this.#entries.set(path, { at: now, count: (entry?.count ?? 0) + 1 });
  }

  /**
   * Read the file, if there is one. A missing or unreadable file means nothing
   * is remembered, which is exactly how a fresh install behaves — a completion
   * is never something a cache file gets to break.
   */
  async load(path: string | undefined = this.#path): Promise<void> {
    if (path === undefined) return;
    this.#path = path;
    let parsed: StoredFrecency | null;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8')) as StoredFrecency | null;
    } catch {
      return;
    }
    if (parsed === null || parsed.version !== FRECENCY_VERSION) return;
    const entries = parsed.entries;
    if (typeof entries !== 'object' || entries === null) return;
    for (const [path_, value] of Object.entries(entries)) {
      if (typeof value !== 'object' || value === null) continue;
      const { at, count } = value as Partial<FrecencyEntry>;
      if (typeof at === 'number' && typeof count === 'number' && count > 0) this.#entries.set(path_, { at, count });
    }
  }

  /**
   * Write what is remembered, atomically, keeping only the paths worth the most
   * so the file stays small. A failure is swallowed: losing the order of a
   * completion list is not worth an error in front of someone's prompt.
   */
  async save(): Promise<void> {
    const path = this.#path;
    if (path === undefined) return;
    const kept = [...this.#entries.entries()]
      .sort((a, b) => this.boost(b[0]) - this.boost(a[0]) || byPath(a[0], b[0]))
      .slice(0, FRECENCY_KEEP);
    const file = { version: FRECENCY_VERSION, entries: Object.fromEntries(kept) };
    try {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${String(process.pid)}.tmp`;
      await writeFile(temp, JSON.stringify(file, null, 2), 'utf8');
      await rename(temp, path);
    } catch {
      // Nothing to do about it and nothing worth saying.
    }
  }
}

// ---------------------------------------------------------------------------
// The token under the cursor
// ---------------------------------------------------------------------------

/** An `@token` in the composer's text: where it is, and what has been typed into it. */
export interface Mention {
  /** Offset of the `@`. */
  readonly start: number;
  /** Offset one past the token's last character. */
  readonly end: number;
  /** Everything after the `@`, which is empty the moment it is typed. */
  readonly query: string;
}

const isSpace = (character: string): boolean => character.length > 0 && /\s/.test(character);

/**
 * The mention the cursor is in, or `null`.
 *
 * The token is found by walking back to the nearest whitespace and asking
 * whether what starts there is an `@`. That is the rule that keeps
 * `ada@example.com` out of it — its `@` is mid-token — while still allowing an
 * `@` inside the path, as `@packages/@scope/thing` has.
 *
 * The cursor may sit anywhere from just after the `@` to the end of the token;
 * on the `@` itself it is not a mention yet, because nothing has been typed and
 * the next keystroke may well be to the left of it. The query is the whole
 * token rather than the part before the cursor, so that arrowing back into a
 * path to fix a letter does not narrow the list to a prefix of it.
 */
export function mentionAt(text: string, cursor: number): Mention | null {
  if (cursor < 0 || cursor > text.length) return null;
  let start = cursor;
  while (start > 0 && !isSpace(text.charAt(start - 1))) start -= 1;
  if (text.charAt(start) !== '@' || cursor <= start) return null;
  let end = cursor;
  while (end < text.length && !isSpace(text.charAt(end))) end += 1;
  return { start, end, query: text.slice(start + 1, end) };
}

/**
 * Write `replacement` over the token at `[start, end)`, leaving the cursor
 * past it and past one space — because the next thing typed after picking a
 * file is another word, and having to press space first is a bug people report
 * as "it ate my typing".
 *
 * The `@` is part of what is replaced, so the caller decides whether the
 * mention keeps its sigil. A space already following the token is reused
 * rather than doubled.
 */
export function replaceMention(text: string, start: number, end: number, replacement: string): { readonly text: string; readonly cursor: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const tail = after.startsWith(' ') ? after : ` ${after}`;
  return { text: `${before}${replacement}${tail}`, cursor: start + replacement.length + 1 };
}
