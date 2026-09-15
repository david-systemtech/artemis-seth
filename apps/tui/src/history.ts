/**
 * What was typed, remembered across launches.
 * ============================================================================
 *
 * The composer forgot everything the moment a prompt was sent. A typo in a
 * forty-word instruction meant typing all forty again, and a prompt worth
 * reusing tomorrow had to be kept somewhere else entirely — a scratch file, a
 * note, the scrollback if it was still there. Every shell solved this decades
 * ago and solved it the same way, so this stores what they store and answers
 * the two questions they answer: what did I just type (Up), and what did I
 * type that had *this* in it (reverse search).
 *
 * **JSONL, appended to, never rewritten in place.** One line per prompt is the
 * whole reason for the format: appending is a single `appendFile` of one line,
 * which cannot lose the lines already on disk and cannot be interrupted into a
 * shorter file, and two terminals open on the same machine interleave rather
 * than clobber each other — none of which a JSON document rewritten whole can
 * promise. A prompt is frequently several lines of text; JSON escapes the
 * newlines, so "one entry per line" holds for multi-line prompts without a
 * delimiter to invent, escape and get wrong.
 *
 * **The file is never trusted.** It is appended to by processes that can be
 * killed between the write and the newline, so the last line may be half an
 * object; it is plain text in a state directory, so it may have been edited by
 * hand or concatenated by a script. A line that does not parse, or parses into
 * the wrong shape, is therefore skipped rather than raised: a missing file, a
 * truncated tail and a mangled middle all mean *less history*, which is the
 * same promise `preferences.ts` and `cache.ts` make — reading state back is
 * never something a launch gets to fail on. A truncated tail costs one line
 * and only one: a file that does not end in a newline has lost the end of its
 * last entry, so the next append opens with a newline of its own rather than
 * gluing a good entry onto a broken one and losing them both.
 *
 * **It is capped, because otherwise it grows for years.** Past
 * `HISTORY_MAX_ENTRIES` the file is rewritten to the newest
 * `HISTORY_KEPT_ENTRIES`, whole and atomically — temp file then rename, the
 * way `preferences.ts` writes — so a crash mid-rewrite leaves the old file
 * rather than half of a new one. Keeping half the cap rather than trimming one
 * line per prompt means the rewrite is paid once every couple of thousand
 * prompts instead of on every prompt after the first two thousand.
 *
 * **Two rules borrowed from readline**, because a history that remembers
 * everything is harder to walk than one that forgets a little: a blank prompt
 * is never stored, and sending the same text twice in a row stores it once
 * (`HISTCONTROL=ignoredups`). What is *offered* is de-duplicated further —
 * `recent` and `search` return each distinct text once, at its newest position
 * — so a prompt sent twenty times over a morning is one row to press Up
 * through, not twenty. The entries themselves stay as they were written,
 * because a folder-scoped or session-scoped view needs the occurrence, not
 * just the text.
 *
 * **Scope, because "what did I type" usually means "here".** The same machine
 * holds prompts from every project, and the one wanted while standing in a
 * repo is nearly always a prompt typed in that repo, so every read takes a
 * scope: this session, this folder, or everything. It is the caller's choice
 * rather than a stored preference; a search that comes up empty in a folder is
 * one key from being a search over all of it.
 *
 * `HistoryCursor` is the walking, and it knows nothing about files: a list of
 * texts and the draft that was on screen when walking began, so that walking
 * back down past the newest entry returns the draft instead of clearing it.
 * That is what every shell does, and it is the thing people notice the moment
 * it is missing.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { tuiStateDir, type PreferencesDirInputs } from './preferences.js';

/** One prompt, as it went to a provider. */
export interface HistoryEntry {
  /** When it was sent. */
  readonly ts: number;
  /** Exactly what was typed, newlines and all. */
  readonly text: string;
  /** The folder it was sent from, which is how the folder scope filters. */
  readonly cwd: string;
  /** The conversation it belonged to, when there was one. */
  readonly sessionId?: string;
}

/** What a caller knows at send time. `ts` defaults to now. */
export interface HistoryAppend {
  readonly text: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly ts?: number;
}

/** Which slice of the history a read is about. See the file header. */
export type HistoryScope =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'folder'; readonly cwd: string }
  | { readonly kind: 'all' };

/** One row of a reverse search. */
export interface HistoryMatch {
  readonly text: string;
  readonly cwd: string;
  readonly ts: number;
  /** Where the query matched, for highlighting. `0` when there was no query. */
  readonly index: number;
}

/** Past this many entries the file is rewritten. */
export const HISTORY_MAX_ENTRIES = 4000;
/** What a rewrite keeps: the newest this many entries. */
export const HISTORY_KEPT_ENTRIES = 2000;

const FILE_NAME = 'history.jsonl';

/** Where the history lives unless a caller says otherwise. */
export function defaultHistoryPath(inputs: PreferencesDirInputs = {}): string {
  return join(tuiStateDir(inputs), FILE_NAME);
}

export class PromptHistory {
  readonly #path: string;
  /** Oldest first, exactly as on disk, so appending is pushing. */
  #entries: HistoryEntry[];
  /** True when the file's last line was cut short and the next append must close it. */
  #healTail: boolean;
  /** Writes are chained so two quick appends land in the order they were made. */
  #writing: Promise<void> = Promise.resolve();

  private constructor(path: string, loaded: LoadedFile) {
    this.#path = path;
    this.#entries = loaded.entries;
    this.#healTail = loaded.truncatedTail;
  }

  /** Read the file, skipping whatever cannot be read. A missing file is an empty history. */
  static async load(path: string = defaultHistoryPath()): Promise<PromptHistory> {
    return new PromptHistory(path, await readEntries(path));
  }

  /** How many entries are remembered, occurrences and all. */
  get size(): number {
    return this.#entries.length;
  }

  /**
   * Remember one prompt; the file catches up in the background.
   *
   * Blank text and an immediate repeat of the last entry are dropped here
   * rather than at read time, so they never reach the file at all.
   */
  append(input: HistoryAppend): void {
    const text = input.text;
    if (text.trim().length === 0) return;
    const last = this.#entries[this.#entries.length - 1];
    if (last !== undefined && last.text === text) return;

    const ts = input.ts ?? Date.now();
    const entry: HistoryEntry =
      input.sessionId === undefined
        ? { ts, text, cwd: input.cwd }
        : { ts, text, cwd: input.cwd, sessionId: input.sessionId };
    this.#entries.push(entry);

    // The decision is made here, in order, so the queued writes agree with
    // what is in memory however they interleave with later appends.
    if (this.#entries.length > HISTORY_MAX_ENTRIES) {
      this.#entries = this.#entries.slice(-HISTORY_KEPT_ENTRIES);
      const snapshot = [...this.#entries];
      this.#healTail = false; // A rewrite ends the file on a newline by construction.
      this.#queue(() => this.#rewrite(snapshot));
    } else {
      const prefix = this.#healTail ? '\n' : '';
      this.#healTail = false;
      this.#queue(() => this.#appendLine(prefix, entry));
    }
  }

  /** Resolves once every `append` so far is on disk (or has given up). */
  flush(): Promise<void> {
    return this.#writing;
  }

  /**
   * The distinct texts in `scope`, newest first — a text that recurs appears
   * once, at its newest position. This is the list `HistoryCursor` walks.
   */
  recent(scope: HistoryScope): readonly string[] {
    return this.search('', scope).map((match) => match.text);
  }

  /**
   * Reverse search: the entries in `scope` whose text contains `query`,
   * case-insensitively, newest first, each distinct text once with the offset
   * the match was found at.
   *
   * An empty query is not a match on everything but `recent(scope)` — the same
   * texts in the same order, each reported at index `0` since there is nothing
   * to highlight — so a search field that has just been opened already shows
   * the history rather than nothing.
   */
  search(query: string, scope: HistoryScope, limit?: number): readonly HistoryMatch[] {
    const needle = query.toLowerCase();
    const matches: HistoryMatch[] = [];
    const seen = new Set<string>();
    for (let i = this.#entries.length - 1; i >= 0; i -= 1) {
      const entry = this.#entries[i];
      if (entry === undefined || !inScope(entry, scope)) continue;
      if (seen.has(entry.text)) continue;
      const index = needle.length === 0 ? 0 : entry.text.toLowerCase().indexOf(needle);
      if (index < 0) continue;
      seen.add(entry.text);
      matches.push({ text: entry.text, cwd: entry.cwd, ts: entry.ts, index });
      if (limit !== undefined && matches.length >= limit) break;
    }
    return matches;
  }

  #queue(write: () => Promise<void>): void {
    this.#writing = this.#writing.then(write).catch(() => undefined);
  }

  async #appendLine(prefix: string, entry: HistoryEntry): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, prefix + serialise(entry), 'utf8');
  }

  async #rewrite(entries: readonly HistoryEntry[]): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${String(process.pid)}.tmp`;
    await writeFile(temp, entries.map(serialise).join(''), 'utf8');
    await rename(temp, this.#path);
  }
}

/**
 * Walking a history list, the way readline does.
 *
 * Position `-1` is the draft — whatever was in the composer when walking
 * started — and `0` upwards are the texts, newest first. Up goes older and
 * stops at the oldest rather than wrapping, because wrapping to the newest
 * entry after the oldest is indistinguishable from a redraw and loses the
 * person's place. Down goes newer and, one step past the newest, hands the
 * draft back: walking away from something half-typed and walking back to it
 * has to be lossless or nobody will risk the key.
 *
 * Pure, and holds no reference to storage: the list is whatever
 * `PromptHistory.recent` returned when walking began, so entries appended
 * during the walk cannot move the cursor out from under it.
 */
export class HistoryCursor {
  readonly #texts: readonly string[];
  readonly #draft: string;
  #position = -1;

  constructor(texts: readonly string[], draft: string) {
    this.#texts = texts;
    this.#draft = draft;
  }

  /** Step to an older entry and return it; the oldest is where it stops. */
  up(): string {
    if (this.#position + 1 < this.#texts.length) this.#position += 1;
    return this.current();
  }

  /** Step to a newer entry and return it; one past the newest is the draft. */
  down(): string {
    if (this.#position >= 0) this.#position -= 1;
    return this.current();
  }

  /** What should be in the composer right now. */
  current(): string {
    if (this.#position < 0) return this.#draft;
    return this.#texts[this.#position] ?? this.#draft;
  }

  /** True while the composer holds the draft rather than a remembered prompt. */
  atDraft(): boolean {
    return this.#position < 0;
  }
}

function inScope(entry: HistoryEntry, scope: HistoryScope): boolean {
  switch (scope.kind) {
    case 'session':
      return entry.sessionId === scope.sessionId;
    case 'folder':
      return entry.cwd === scope.cwd;
    case 'all':
      return true;
  }
}

function serialise(entry: HistoryEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

interface LoadedFile {
  readonly entries: HistoryEntry[];
  /** The file has content but does not end in a newline: its last entry was cut off. */
  readonly truncatedTail: boolean;
}

async function readEntries(path: string): Promise<LoadedFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { entries: [], truncatedTail: false };
  }

  const entries: HistoryEntry[] = [];
  for (const line of text.split('\n')) {
    // Trimmed so a stray `\r` from a file that has been through Windows, and
    // the empty tail after the final newline, are not parse failures.
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // Garbage, or the half line a killed process left behind.
    }
    const entry = toEntry(parsed);
    if (entry !== undefined) entries.push(entry);
  }
  return { entries, truncatedTail: text.length > 0 && !text.endsWith('\n') };
}

/** A parsed line, or nothing if it is not an entry after all. */
function toEntry(value: unknown): HistoryEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { ts, text, cwd, sessionId } = value as Partial<HistoryEntry>;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined;
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  if (typeof cwd !== 'string') return undefined;
  if (sessionId !== undefined && typeof sessionId !== 'string') return undefined;
  return sessionId === undefined ? { ts, text, cwd } : { ts, text, cwd, sessionId };
}
