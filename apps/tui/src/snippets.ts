/**
 * Saved prompts, with holes in them.
 * ============================================================================
 *
 * What people already do is keep a notes file of prompts that worked and paste
 * one in, editing the parts that change. That is a snippet with slots, done by
 * hand, and the editing by hand is where it goes wrong: the paste arrives
 * carrying yesterday's branch, or the path from the other repo, and the model
 * is asked a question nobody meant to ask. So the template is stored with its
 * holes marked, and the terminal does the filling and puts the cursor in the
 * first one.
 *
 * Lighter than a skill, heavier than a stash. A skill is instructions for the
 * agent, versioned with the project and shared with a team; a snippet is one
 * person's phrasing of one request, so it lives beside their history and their
 * preferences rather than in the repo, and nothing but a person ever writes it.
 *
 * **The template language is small on purpose**, and it is the one already in
 * everybody's editor: `$1`, `$2`, … are slots, `${1:like this}` is a slot with
 * a default, `$0` is where the cursor should come to rest, and `$$` is a
 * literal dollar. Everything else is text — in particular `@src/thing.ts` is
 * text, so that an `@path` in a body reaches the composer as if it had been
 * typed and the `@` popup handles it there. This file knows nothing about
 * files, and nothing about the popup.
 *
 * **Expansion is arithmetic, not editing.** {@link expand} answers with the
 * finished text, the offset the cursor belongs at, and the ranges of the slots
 * that are still empty — so the composer sets its buffer and its cursor in one
 * go, and Tab has a list of stops to walk rather than a search to redo. That is
 * also why it is a pure function over a string: the interesting cases are
 * off-by-one cases, and they are testable without a terminal.
 *
 * **Arguments fill slots in order, and the last slot takes the rest.** The
 * composer passes the words typed after the name, so `$1` is the first word,
 * `$2` the second — except that the highest-numbered slot soaks up everything
 * left over, because the common snippet has one slot and the common argument is
 * a phrase. A slot nobody passed a word for keeps its default, or stays empty,
 * and is offered as a stop instead.
 *
 * **One JSON file, rewritten whole, atomically, unreadable-means-none** — the
 * promise `preferences.ts` and `history.ts` make, for the same reason: reading
 * state back is never something a launch gets to fail on. Snippets are written
 * in alphabetical order and an entry may leave out its timestamp, because this
 * is a file someone will open in an editor and add one to by hand, and it
 * should diff cleanly and forgive them when they do.
 *
 * Nothing ships in it. A starter set would be three prompts in somebody else's
 * voice, sitting above their own in every list forever; {@link EXAMPLE_SNIPPETS}
 * is there for a `--examples` flag to copy in for anyone who wants a shape to
 * edit, and is examples only.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { tuiStateDir, type PreferencesDirInputs } from './preferences.js';

/** One saved template. */
export interface Snippet {
  /** Lower-case letters, digits and dashes: what is typed after `/snip`. */
  readonly name: string;
  /** The template, slots and all. See the file header. */
  readonly body: string;
  /** When it was last written. `0` for an entry added by hand without one. */
  readonly updatedAt: number;
}

/** A name and a body, before there is anything to say about when. */
export interface SnippetTemplate {
  readonly name: string;
  readonly body: string;
}

const NAME = /^[a-z0-9-]+$/;

/** Whether `name` is a name this file will store: `[a-z0-9-]+`. */
export function isSnippetName(name: string): boolean {
  return NAME.test(name);
}

/**
 * The name `input` was trying to be — `Fix Tests` is `fix-tests` — or `null` if
 * there is nothing left of it once the punctuation is gone.
 *
 * Saving is the one moment a person types a name rather than picks one, and
 * refusing a capital letter there is pedantry when the intent is obvious. What
 * is *stored* is still only ever `[a-z0-9-]+`, so the trigger stays one word.
 */
export function toSnippetName(input: string): string | null {
  const name = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name.length > 0 ? name : null;
}

const FILE_VERSION = 1;
const FILE_NAME = 'snippets.json';

interface FileShape {
  readonly version: number;
  readonly snippets: readonly Snippet[];
}

/** Where the snippets live unless a caller says otherwise. */
export function defaultSnippetsPath(inputs: PreferencesDirInputs = {}): string {
  return join(tuiStateDir(inputs), FILE_NAME);
}

/**
 * The saved snippets, and the file they are kept in.
 *
 * Changes land in memory immediately and on disk shortly after: a save is a
 * keystroke away from the next one, and the person typing should never wait on
 * a rename. Writes are chained so two quick changes cannot race, and
 * {@link flush} is how a test — or a process about to exit — waits for the disk
 * to catch up.
 */
export class Snippets {
  readonly #path: string;
  readonly #snippets: Map<string, Snippet>;
  /** Writes are chained so two quick changes cannot race each other's rename. */
  #writing: Promise<void> = Promise.resolve();

  private constructor(path: string, snippets: Map<string, Snippet>) {
    this.#path = path;
    this.#snippets = snippets;
  }

  /** Read the file, skipping whatever cannot be read. A missing file is no snippets. */
  static async load(path: string = defaultSnippetsPath()): Promise<Snippets> {
    return new Snippets(path, await readSnippets(path));
  }

  /** Every snippet, alphabetically — the order the menu and the file are in. */
  list(): readonly Snippet[] {
    return [...this.#snippets.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One snippet by name, or nothing if there is no such name. */
  get(name: string): Snippet | undefined {
    return this.#snippets.get(name);
  }

  /**
   * Save `body` under `name`, replacing whatever was there; the file catches up
   * in the background.
   *
   * Throws on a name this file cannot store, rather than storing something the
   * trigger could never type again. Callers taking a name from a person should
   * put it through {@link toSnippetName} first, which is what makes the throw a
   * backstop rather than an error path.
   */
  set(name: string, body: string, now: number = Date.now()): Snippet {
    if (!isSnippetName(name)) throw new RangeError(`not a snippet name: ${JSON.stringify(name)}`);
    const snippet: Snippet = { name, body, updatedAt: now };
    this.#snippets.set(name, snippet);
    this.#queueWrite();
    return snippet;
  }

  /** Forget `name`; answers whether there was anything to forget. */
  remove(name: string): boolean {
    if (!this.#snippets.delete(name)) return false;
    this.#queueWrite();
    return true;
  }

  /** Resolves once every change so far is on disk (or has given up). */
  flush(): Promise<void> {
    return this.#writing;
  }

  #queueWrite(): void {
    // Snapshotted here, in order, so the queued writes agree with what was in
    // memory when each change was made however they interleave with later ones.
    const snapshot: FileShape = { version: FILE_VERSION, snippets: this.list() };
    this.#writing = this.#writing.then(() => this.#write(snapshot)).catch(() => undefined);
  }

  async #write(snapshot: FileShape): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${String(process.pid)}.tmp`;
    await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await rename(temp, this.#path);
  }
}

async function readSnippets(path: string): Promise<Map<string, Snippet>> {
  const snippets = new Map<string, Snippet>();
  let parsed: Partial<FileShape> | null;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<FileShape> | null;
  } catch {
    return snippets; // Missing, mangled, or half-written: no snippets, which is a fine way to open.
  }
  if (parsed === null || parsed.version !== FILE_VERSION || !Array.isArray(parsed.snippets)) return snippets;
  for (const entry of parsed.snippets) {
    const snippet = toSnippet(entry);
    // Later wins, so a file hand-edited into holding a name twice still opens
    // with one of them rather than with neither.
    if (snippet !== undefined) snippets.set(snippet.name, snippet);
  }
  return snippets;
}

/** One parsed entry, or nothing if it is not a snippet after all. */
function toSnippet(value: unknown): Snippet | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { name, body, updatedAt } = value as Partial<Snippet>;
  if (typeof name !== 'string' || !isSnippetName(name)) return undefined;
  if (typeof body !== 'string') return undefined;
  // A hand-written entry has no business inventing a timestamp for itself.
  const ts = typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0;
  return { name, body, updatedAt: ts };
}

// The template language
// ---------------------------------------------------------------------------

/** Where a slot ended up in the expanded text. `start === end` when it is empty. */
export interface SlotRange {
  readonly start: number;
  readonly end: number;
}

/** An expanded template: what to put in the composer, and where to put the cursor. */
export interface Expansion {
  readonly text: string;
  /** Offset for the cursor: the first empty slot, else `$0`, else the end. */
  readonly cursor: number;
  /** The slots still to fill, in the order they appear, for Tab to walk. */
  readonly slots: readonly SlotRange[];
  /** Where `$0` was, if the body had one: the stop after the last slot. */
  readonly final?: number;
}

type Piece =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'slot'; readonly index: number; readonly fallback: string };

const isDigit = (character: string): boolean => character >= '0' && character <= '9';

/**
 * A body split into text and slots.
 *
 * Anything that is not a slot is text, including a `$` that begins nothing —
 * `$` at the end of a line, `$foo`, an unclosed `${1:`. A template is prose
 * with holes in it, and prose that happens to mention a dollar should survive
 * being saved; `$$` is there for the one case where the dollar is followed by a
 * digit and would otherwise be read as a slot.
 *
 * A default runs to the first `}`, which is the whole rule: no nesting, no
 * escapes, no slots inside defaults. A default that needs a brace is a body
 * that wants a slot with no default and the brace typed in.
 */
function parse(body: string): readonly Piece[] {
  const pieces: Piece[] = [];
  let literal = '';
  const flush = (): void => {
    if (literal.length > 0) {
      pieces.push({ kind: 'text', value: literal });
      literal = '';
    }
  };

  let i = 0;
  while (i < body.length) {
    if (body.charAt(i) !== '$') {
      literal += body.charAt(i);
      i += 1;
      continue;
    }
    const next = body.charAt(i + 1);
    if (next === '$') {
      literal += '$';
      i += 2;
      continue;
    }
    if (isDigit(next)) {
      let end = i + 1;
      while (end < body.length && isDigit(body.charAt(end))) end += 1;
      flush();
      pieces.push({ kind: 'slot', index: Number(body.slice(i + 1, end)), fallback: '' });
      i = end;
      continue;
    }
    if (next === '{') {
      const close = body.indexOf('}', i + 2);
      if (close !== -1) {
        const inner = body.slice(i + 2, close);
        const colon = inner.indexOf(':');
        const digits = colon === -1 ? inner : inner.slice(0, colon);
        if (digits.length > 0 && [...digits].every(isDigit)) {
          flush();
          pieces.push({ kind: 'slot', index: Number(digits), fallback: colon === -1 ? '' : inner.slice(colon + 1) });
          i = close + 1;
          continue;
        }
      }
    }
    literal += '$';
    i += 1;
  }
  flush();
  return pieces;
}

/**
 * Fill `body`'s slots with `args` and say where the cursor goes.
 *
 * `args` are the words typed after the snippet's name: the first fills `$1`,
 * the second `$2`, and the highest-numbered slot in the body takes everything
 * left over, so `explain $1` with three words explains all three rather than
 * the first. A slot with no argument keeps its default or stays empty, and is
 * listed in `slots` so Tab can come back to it; a repeated `$1` is filled the
 * same way in both places, and offered in both places when it is not.
 *
 * `$0` is never filled from `args` — it is a cursor position, not a hole — and
 * it is where `cursor` lands once every slot has a value.
 */
export function expand(body: string, args: readonly string[] = []): Expansion {
  const pieces = parse(body);
  let highest = 0;
  for (const piece of pieces) if (piece.kind === 'slot' && piece.index > highest) highest = piece.index;

  let text = '';
  const slots: SlotRange[] = [];
  let final: number | undefined;

  for (const piece of pieces) {
    if (piece.kind === 'text') {
      text += piece.value;
      continue;
    }
    if (piece.index === 0) {
      // The first `$0` wins; a second one is a template arguing with itself,
      // and its text still belongs in the output.
      if (final === undefined) final = text.length;
      text += piece.fallback;
      continue;
    }
    if (args.length >= piece.index) {
      // The last slot takes the rest, so the words after a one-slot snippet's
      // name arrive as the phrase they were typed as.
      text += piece.index === highest ? args.slice(piece.index - 1).join(' ') : (args[piece.index - 1] ?? '');
      continue;
    }
    const start = text.length;
    text += piece.fallback;
    slots.push({ start, end: text.length });
  }

  const cursor = slots[0]?.start ?? final ?? text.length;
  return final === undefined ? { text, cursor, slots } : { text, cursor, slots, final };
}

// The token under the cursor
// ---------------------------------------------------------------------------

/** What starts a snippet in the middle of a line. */
export const SNIPPET_TRIGGER = ';;';

/** A `;;token` in the composer's text: where it is, and what has been typed into it. */
export interface SnippetToken {
  /** Offset of the first `;`. */
  readonly start: number;
  /** Offset one past the token's last character. */
  readonly end: number;
  /** Everything after the `;;`, which is empty the moment the trigger is typed. */
  readonly name: string;
}

const isSpace = (character: string): boolean => character.length > 0 && /\s/.test(character);

/**
 * The snippet trigger the cursor is in, or `null`.
 *
 * The same rule as `mentionAt` in `fileIndex.ts`, with a different sigil: walk
 * back to the nearest whitespace and ask whether what starts there is `;;`.
 * That is what keeps the `;;` in `foo();;` out of it — those semicolons are
 * mid-token, and pasted code is full of them — while a `;;` at the start of a
 * line or after a space is always the trigger, because nothing else in prose
 * begins a word with two semicolons.
 *
 * The cursor may sit anywhere from just past the second `;` to the end of the
 * token; between the semicolons it is not a trigger yet. The name is the whole
 * token rather than the part before the cursor, so arrowing back to fix a
 * letter does not narrow the menu to a prefix of what is there.
 */
export function snippetAt(text: string, cursor: number): SnippetToken | null {
  if (cursor < 0 || cursor > text.length) return null;
  let start = cursor;
  while (start > 0 && !isSpace(text.charAt(start - 1))) start -= 1;
  if (!text.startsWith(SNIPPET_TRIGGER, start)) return null;
  if (cursor < start + SNIPPET_TRIGGER.length) return null;
  let end = cursor;
  while (end < text.length && !isSpace(text.charAt(end))) end += 1;
  return { start, end, name: text.slice(start + SNIPPET_TRIGGER.length, end) };
}

/**
 * Write `expansion` over the token at `[start, end)`, moving every offset it
 * reports into the composer's text.
 *
 * Unlike `replaceMention`, nothing is added after it: a mention is one word in
 * a sentence still being typed and wants its space, while a snippet is the
 * sentence — often several lines of it — and a space appended to the end of a
 * template is a space nobody asked for in front of whatever the cursor is
 * about to be sent back to.
 */
export function expandInText(text: string, start: number, end: number, expansion: Expansion): Expansion {
  const shifted: Expansion = {
    text: text.slice(0, start) + expansion.text + text.slice(end),
    cursor: start + expansion.cursor,
    slots: expansion.slots.map((slot) => ({ start: start + slot.start, end: start + slot.end })),
  };
  return expansion.final === undefined ? shifted : { ...shifted, final: start + expansion.final };
}

/**
 * Three snippets to copy in, for anyone who would rather edit an example than
 * face an empty list. Examples only: nothing ships with these, and a store that
 * has never been seeded has nothing in it at all.
 */
export const EXAMPLE_SNIPPETS: readonly SnippetTemplate[] = [
  {
    name: 'fix-tests',
    body: '`${1:pnpm test}` fails with:\n\n$0\n\nFix the first failure only, and fix the cause rather than the symptom. Change the test only if the test is what is wrong, and tell me which you did.',
  },
  {
    name: 'explain',
    body: 'Explain @${1:path/to/file}: what it is for, who calls it, and what would break if it went away. Start with the shape, then the surprises.',
  },
  {
    name: 'review-diff',
    body: 'Review the diff against ${1:main}. Correctness first, then naming and anything left behind. Quote the lines you mean and say what you would change — "this could be improved" is not a review.',
  },
];
