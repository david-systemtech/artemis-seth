/**
 * The box you type into.
 *
 * A multi-line editor over `editor.ts`, built on `useInput` rather than a text
 * input package so that the keys the TUI cares about — Esc to interrupt, `/` to
 * hint commands, Enter to send — are decided in one place. The component holds
 * one piece of state, the buffer, and every keystroke is one call into the
 * model: nothing about where a word ends, or which column ↑ lands on, is
 * decided here.
 *
 * Enter sends, because that is what Enter does in a chat, so a newline is
 * something to ask for. There are three ways to ask. Ctrl+J, which every
 * terminal can send and which arrives as a bare line feed. Shift+Enter, which
 * only some can: without the kitty keyboard protocol a terminal sends the same
 * carriage return for Enter and Shift+Enter and nothing here can tell them
 * apart, which is why the hint names Ctrl+J as well. And a line ending in a
 * backslash, the shell's own convention, where Enter drops the backslash and
 * opens the next line instead of sending.
 *
 * The box grows with the text to eight lines and then scrolls, counting what is
 * out of sight above and below, for the reason the picker does the same: a long
 * paste would otherwise push the conversation off the top of the screen.
 *
 * ↑ and ↓ belong to the text while there is text to move through. The presses
 * that run off the first and last line are handed back through
 * `onArrowOverflow`, which is how an arrow still has exactly one owner (see
 * app.tsx's "Who has the keys"): the composer moves the cursor, or the app
 * scrolls, never both on one keystroke. While the slash menu is open the arrows
 * are its, ahead of both — the text is one word, so there is no second line for
 * them to reach, and a menu you cannot walk is a list.
 *
 * That menu is the other thing `/` does. While the text is a single word
 * beginning with a slash, the rows under the box are the commands it could
 * mean, the first of them highlighted; Tab fills the highlighted one in and
 * Enter runs it, as if its name had been typed out in full. Nothing is
 * highlighted when nothing matched, which is what keeps a typo — `/mdoel` — a
 * message to the agent rather than a command someone else guessed at. Esc is
 * deliberately not bound: Esc interrupts the turn, and a popup that swallowed
 * it would fight the app for the one key that has to work.
 *
 * It owns no state of the conversation. It reports a submission and shows what
 * it is told: whether the agent is working (so Enter means "steer" rather than
 * "start"), whether the provider can even take a message right now, and any
 * one-line reason the last submission was refused.
 *
 * ## What was typed comes back
 *
 * Three things put words into the box that the keystroke itself did not type,
 * and all three lean on one channel.
 *
 * **The channel is a handle**, not a controlled `value` prop and not a seed
 * paired with a nonce: `ref` gives the app `setText`, `getText` and
 * `isCapturing`. The buffer is not a string — it is text, a cursor, a kill
 * ring and an undo stack — so a prop that could only push a string would
 * either flatten all of that or need a counter to fake an event out of a
 * value, and the app would still have no way to *read* it. Reading is half of
 * what is wanted: whether the box is empty, and what is in it to hand to an
 * external editor. `setText` goes in through `replaceAll`, so whatever it
 * replaced is one undo away.
 *
 * **↑ and ↓ walk the history** once the text has no line left to offer them.
 * The walk lives here rather than in app.tsx because every question it has to
 * answer is one only the composer can: whether the slash menu is open, whether
 * the buffer is empty, and — the one that matters — whether the text has been
 * edited since the last press. That last is not tracked but noticed, the same
 * way the menu notices a stale highlight: the walk remembers the text it put
 * in the box, and a buffer that is not that text ends it, so the next ↑ starts
 * a fresh walk with whatever is now typed as its draft. No bookkeeping spread
 * through twenty key branches, and nothing to forget to clear.
 *
 * The history arrives as a prop — `recent` and `search`, the two methods of
 * `PromptHistory` that reading needs — so the composer neither opens a file
 * nor knows where one lives, and a test can hand it two arrays. Its scopes
 * come with it, best first, which is how ↑ prefers the prompts typed in this
 * folder and falls through to everything when there are none.
 *
 * **↑ on an empty box takes a queued message back** first, when there is one
 * to take. The composer cannot know that — the queue is the conversation's —
 * so it asks, and `onTakeBackQueued` answers with the words or with nothing;
 * nothing means carry on into the history. Asking rather than being told is
 * what keeps one keystroke with one owner: emptiness and the menu are known
 * here, the queue is known there, and the answer settles it in one place.
 *
 * **Ctrl+R is the reverse search**, bash's, drawn as a row under the box: the
 * query on the left and the match in the box itself, where the cursor already
 * is, with the draft set aside whole — the editor state, not the string — so
 * Esc puts back the buffer that was there, undo stack and all. Ctrl+R again
 * steps to an older match, Ctrl+S cycles the scope, Tab and → keep the match
 * to edit, Enter sends exactly what the box is showing, and Backspace past the
 * start of the query cancels, because a search with nothing in it is not a
 * search.
 *
 * Esc is the one key this has to take back from the app, which interrupts the
 * turn with it. Ink has no stop-propagation — every active `useInput` sees
 * every keystroke — so the app asks the handle whether the composer is
 * capturing Esc before acting on it. That flag is a ref rather than state, and
 * it is lowered in an effect rather than in the key handler: both handlers run
 * inside one dispatch, before any render, so a flag lowered as the search
 * closes would already read as lowered when the app looks, and the Esc that
 * closed the search would interrupt the turn as well.
 *
 * Tab is the same bargain the other way about. The app moves the focus with
 * it and this fills in the highlighted row with it, so the app asks
 * `hasPopup()` and stands down while either popup is open — otherwise one
 * press finished the word and moved the keyboard off the box that had just
 * finished it. `?` needs no such bargain: with nothing typed it is the key
 * map, answered here, because the app cannot stop this inserting the
 * character on the press it acted on.
 *
 * ## `@` names a file
 *
 * An `@` after whitespace opens the same kind of popup the slash menu uses,
 * over the files under the working directory. None of the thinking is here:
 * `fileIndex.ts` finds the token under the cursor, ranks the paths against
 * what has been typed into it, and writes the chosen one back over the token.
 * What this decides is which keystroke means which of those. ↑ and ↓ are the
 * popup's while it is open, ahead of the text and the history, for the reason
 * they are the menu's. Tab and Enter both insert — and Enter inserting is the
 * point: the popup is a word being finished, not a message being sent, so the
 * send is the *next* Enter. Esc is not bound here either.
 *
 * The two popups are never open together. A single word beginning with a slash
 * is a command being typed, and no command's name has an `@` in it, so the
 * slash wins by being asked first.
 *
 * The list is not this component's to build. It arrives as `fileIndex`, one
 * object per working directory, and `list()` is called at most once per
 * object: the first time the text contains an `@` at all. That is the last
 * moment before an answer is wanted and long after the first keystroke was
 * drawn, which is what keeps a repository of twenty thousand files out of the
 * way of someone typing "hello". A different directory is a different object,
 * and a different object is a fresh listing. Until it lands the popup says
 * `loading…` rather than lying with an empty list, and a query that matched
 * nothing says `no match`.
 *
 * What is *sent* is the other half. The message keeps its `@path` text, which
 * is what tells the agent which file was meant where, and the paths travel
 * beside it as `onSubmit`'s second argument for the app to attach. Only paths
 * the listing knows travel: an address, an `@media`, a path typed before the
 * list arrived are all left as the words they already were — and the app
 * checks each of the rest on disk before reading it, because a listing is a
 * snapshot and files move. The row under the box names everything that will
 * go, so what travels is never a guess.
 *
 * ## `;;` is a snippet
 *
 * The third popup under the box, over the templates somebody has saved.
 * `snippets.ts` owns the trigger and says why it is two semicolons and why the
 * ones in `foo();;` are not it; the rows are the names it could mean, matched
 * the way the picker matches — a subsequence over the name, with the body's
 * first line dimmed beside it, because a name half-remembered is recognised by
 * the words it stood for. Tab and Enter both expand, for the reason they both
 * insert a path: this is a word being finished, not a message being sent.
 *
 * Three popups, one at a time, and the order is the order the sigils are
 * reached: a single word beginning with a slash is a command, then an `@` is a
 * file, then `;;` is a snippet. No two can claim the same token — no command's
 * name has an `@` in it and neither sigil begins a `;;` — so asking in order is
 * all the arbitration there is to do.
 *
 * What expanding leaves behind is the part worth explaining. A template's holes
 * come back from `expand` as offsets, and those become tab stops: Tab walks to
 * the next, Shift+Tab to the one before, and the Tab after the last lands on
 * `$0` — or, in a body that named none, on the end of the hole it was in —
 * and puts the stops away. The editor has no selection, so a stop with a
 * default is not selected but *pending*: the cursor sits at the front of it and
 * the first thing typed or pasted takes the whole default out. Deleting the
 * range on arrival would have been fewer moving parts and the wrong feature —
 * Tab pressed straight through a template would have wiped every default it
 * came with, which is the one thing defaults are for. Moving the cursor ends
 * the pending too, because somebody who has gone to look at a default is
 * somebody who means to edit it rather than replace it.
 *
 * The offsets are noticed rather than maintained, the way a history walk is.
 * They are remembered against the text they were measured in, and every render
 * asks one question of the buffer: is everything outside the current hole
 * still where it was? Then the hole has grown or shrunk and the rest slides;
 * otherwise somebody has moved on and the stops go. That is one rule in one
 * place instead of bookkeeping in twenty key branches — and it is why only a
 * send and Ctrl+U say anything about stops outright, both of them taking away
 * the whole line the holes were in.
 *
 * ## A big paste is a chip
 *
 * Pasting a four-hundred-line stack trace into a box eight rows tall loses the
 * message it was going to illustrate: the words above it scroll away and the
 * cursor is somewhere in the middle of somebody else's Java. So a paste of more
 * than a few lines is stood in for by one token — `[Pasted #1 · 412 lines ·
 * Node stack trace from app.tsx:1442]` — and the text is kept beside the
 * buffer until the message is sent, when every chip becomes its content again.
 * What the agent receives is what was pasted; what the person sees while
 * typing is one line they can move past.
 *
 * The last part of that token is `pasteKind.ts`'s, and it is the part worth
 * having: every terminal can say how many lines went in, and none of them says
 * what the lines *were*, which is the only way to tell at a glance that the
 * paste was the wrong one. The same reading decides how the chip goes out —
 * a trace, a diff, a log, JSON or code is fenced on the way to the agent, with
 * the language on the fence where there is one to name — unless the words
 * around the chip have already opened a fence, in which case the person has
 * said what they want. Prose and a URL go out exactly as they came in, since
 * fencing a paragraph only tells the agent something untrue about it.
 *
 * The chip is a marker *in the text* rather than a decoration beside it, which
 * is what makes every other key keep working: the cursor walks over it, the
 * history stores the expanded message, `@` still completes around it, and the
 * box still measures what it will actually send. The one key that has to know
 * about it is Backspace, which takes a chip whole — half a chip is not a thing
 * anybody meant to have.
 *
 * Numbers are never reused, even after a chip is rubbed out, because undo can
 * put it back: two `#1`s in one draft would expand to the same text and lose
 * the other. They start again at one once the message has gone.
 *
 * Ink 7 has bracketed paste — `usePaste`, which turns on `\x1b[?2004h` and
 * hands the pasted string over whole, on a channel `useInput` never sees — so
 * that is what a chip is made from. The older test, "more than one character
 * at once", stays for the terminal that ignores the sequence, but it only ever
 * inserts: `\x1b[200~` is the terminal *saying* a paste happened, while a long
 * chunk is a guess that a key repeat, a chunked read and an input method all
 * satisfy, and standing in for something somebody typed is the worse of the
 * two mistakes.
 *
 * ## The clipboard, the editor, the stash
 *
 * **Ctrl+V** is for what the keyboard cannot type. `clipboard.ts` is asked for
 * an image first, and an image becomes `[Image #1]` in the text and an
 * attachment beside it — the chip is where the picture was meant, which is
 * worth more to the agent than an unplaced file. A clipboard holding text
 * instead falls through to the paste path, so Ctrl+V is never a dead key, and a
 * clipboard holding neither says so in one dim line.
 *
 * **Ctrl+G** hands the draft to `$EDITOR`. Chips are expanded on the way out,
 * which is also how the content of one can be read: there is no other key for
 * it, and opening the editor is what somebody who wants to see four hundred
 * lines was going to do anyway. The terminal handover is not this component's —
 * the app owns Ink's instance and does it in one place — so this gets a
 * promise: the edited text, or nothing if the edit was abandoned.
 *
 * **Ctrl+S** sets the draft aside and gives it back. One slot, because a stack
 * of stashes is a list to manage and this is for the interruption — a question
 * to ask before the paragraph is finished. The cursor comes back where it was,
 * since what is set aside is the editor state and not a string.
 *
 * ## `!` is a shell
 *
 * `!` on an empty box turns the composer into a prompt: `$` for a glyph, a cyan
 * border so it cannot be mistaken for a message, and Enter runs the line rather
 * than sending it. `!cmd` runs and the output becomes a row in the transcript;
 * `!!cmd` runs and hands the output to the agent as a message, which is the
 * short way to ask about what just happened. Running the thing is the app's —
 * this reports a command and a flag.
 *
 * Esc leaves, and so does Backspace on an empty line, which is how a shell
 * prompt has always been left. Esc is taken back from the app the same way the
 * reverse search takes it and only while the line is empty: a half-typed
 * command must not swallow the one key that interrupts a turn.
 *
 * The prompt history is the shell history too, with the `!` kept on the front
 * of what was stored. ↑ in shell mode offers only the entries that have it, and
 * ↑ in the box offers only the entries that do not, so one file holds two lists
 * and neither hands back the other's lines.
 */

import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';

import { readClipboardImage, readClipboardText } from '../clipboard.js';
import { matchCommands } from '../commands.js';
import {
  EMPTY_EDITOR,
  type EditorState,
  backspace,
  bufferEnd,
  bufferStart,
  cellAt,
  clear,
  continueLine,
  cursorPosition,
  deleteForward,
  deleteWordLeft,
  deleteWordRight,
  down,
  editorWindow,
  endsWithContinuation,
  insert,
  killToLineEnd,
  killToLineStart,
  left,
  lineEnd,
  lineStart,
  lines,
  newline,
  onFirstLine,
  onLastLine,
  replaceAll,
  right,
  undo,
  up,
  wordLeft,
  wordRight,
  yank,
} from '../editor.js';
import { fuzzyMatch, mentionAt, replaceMention, type FileMatch, type FrecencyLike } from '../fileIndex.js';
import { HistoryCursor, type HistoryMatch, type HistoryScope } from '../history.js';
import { classifyPaste, expandChip, pasteMarker, type PasteClassification } from '../pasteKind.js';
import {
  expand as expandTemplate,
  expandInText,
  snippetAt,
  type Expansion,
  type SlotRange,
  type SnippetTemplate,
} from '../snippets.js';
import { ACCENT } from '../theme.js';
import { Completions, type CompletionItem } from './Completions.js';
import { filterItems } from './Picker.js';

/** Lines drawn at once before the box scrolls instead of growing. */
const MAX_ROWS = 8;

/** Paths offered at once. The popup sits over the conversation; the menu's own window. */
const MENTION_ROWS = 8;

const MENTION_HINT = '↑↓ move · Tab/Enter insert';

/** Snippets offered at once: the same window the file popup gets, under the same box. */
const SNIPPET_ROWS = 8;

const SNIPPET_HINT = '↑↓ move · Tab/Enter expand';

/** How much of a body's first line stands beside the name before it is cut. */
const SNIPPET_DETAIL_CHARS = 48;

/** Ctrl+_ , which most terminals send as a unit separator and no letter. */
const UNDO_INPUT = '\u001F';

const NEWLINE_HINT = 'Shift+Enter or Ctrl+J for a newline · Enter sends';

const SEARCH_HINT = 'Ctrl+R older · Ctrl+S scope · Tab edits · Enter sends · Esc cancels';

/**
 * A paste past either of these stands in the box as a chip.
 *
 * Three lines, because four is already taller than the hint under the box and
 * a snippet worth reading back while typing is one or two; eight hundred
 * characters, because a paragraph of prose is a paste someone means to edit and
 * a minified line is not. Either is enough on its own: one very long line
 * wraps to a screenful just as surely as fifty short ones.
 */
const PASTE_CHIP_LINES = 3;
const PASTE_CHIP_CHARS = 800;

/** How long a word under the box stays up before it goes away by itself. */
const FLASH_MS = 2_000;

const SHELL_PLACEHOLDER = 'shell command · Esc leaves';
const SHELL_HINT = 'Enter runs · !cmd sends the output to the agent · Esc leaves';

/** What a shell line is stored as in the prompt history, and recalled by. */
const SHELL_PREFIX = '!';

/** Everything: both the last resort and the only sensible default. */
const ALL_SCOPE: HistoryScope = { kind: 'all' };
const DEFAULT_SCOPES: readonly HistoryScope[] = [ALL_SCOPE];

/** What a row is typed as: `/attach <path>` is run by sending `/attach`. */
function commandWord(usage: string): string {
  return usage.split(' ')[0] ?? usage;
}

/**
 * The reading half of `PromptHistory`, which is all the composer wants.
 *
 * An interface rather than the class, so nothing here depends on a file being
 * on disk: `PromptHistory` satisfies it as it stands, and a test hands over
 * two arrays.
 */
export interface HistoryLookup {
  recent(scope: HistoryScope): readonly string[];
  search(query: string, scope: HistoryScope, limit?: number): readonly HistoryMatch[];
}

/** The two methods of `Frecency` the popup needs: reading an order, writing a pick. */
export interface MentionMemory extends FrecencyLike {
  /** This path was just chosen, so it floats next time. */
  record(path: string): void;
}

/**
 * Where `@` looks, and what it remembers.
 *
 * The composer neither lists a directory nor opens a file. It is handed one of
 * these per working directory, asks it for the paths once, and tells it which
 * one was picked; everything behind the two methods — git, a walk, a file of
 * counts — is `fileIndex.ts`'s business, and a test hands over an array and a
 * `record` that does nothing.
 */
export interface FileIndex {
  /** The paths under the working directory, relative to it, forward slashes. */
  list(): Promise<readonly string[]>;
  /** What settles a near-tie, and where an accepted path is written down. */
  readonly frecency: MentionMemory;
}

/** An `@` that starts a token: at the very start of the text, or after whitespace. */
const MENTION_TOKEN = /(?:^|\s)@(\S+)/gu;

/**
 * The `@paths` in `text` that the listing knows, in the order they appear and
 * once each.
 *
 * Filtering against the listing is the point rather than a nicety: it is what
 * keeps an address, an `@media` and half a typed path as the words they are.
 */
function mentionsIn(text: string, known: ReadonlySet<string>): readonly string[] {
  if (known.size === 0) return [];
  const found: string[] = [];
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const path = match[1];
    if (path !== undefined && known.has(path) && !found.includes(path)) found.push(path);
  }
  return found;
}

/**
 * The buffer with its cursor at `offset`.
 *
 * `editor.ts` keeps its cursor moves private — everything it exports moves by a
 * character, a word or a line — so the walk is made of its own steps. That is
 * what it costs to land on an offset somebody else counted, and it is what
 * buys the two things that matter: a move is never an undo entry, and a cursor
 * never lands inside a surrogate pair.
 */
function cursorAt(state: EditorState, offset: number): EditorState {
  let next = state;
  while (next.cursor > offset) {
    const back = left(next);
    if (back.cursor === next.cursor) break;
    next = back;
  }
  while (next.cursor < offset) {
    const on = right(next);
    if (on.cursor === next.cursor) break;
    next = on;
  }
  return next;
}

/**
 * `replaceAll`, with the cursor left somewhere other than the end.
 *
 * A path completed in the middle of a sentence wants the cursor just past the
 * space it added, not past the rest of the line; a template wants it in the
 * first hole. `editor.ts`'s whole-text replacement ends at the end, so the walk
 * back to either is {@link cursorAt}'s.
 */
function replaceLeavingCursor(state: EditorState, text: string, cursor: number): EditorState {
  return cursorAt(replaceAll(state, text), cursor);
}

/**
 * The saved snippets, as the composer reads them.
 *
 * The two methods of `Snippets` that reading needs, for the reason
 * {@link HistoryLookup} is an interface rather than the class: nothing here
 * should depend on a file being on disk, and a test hands over an array.
 */
export interface SnippetLookup {
  /** Every snippet, in the order they should be offered — alphabetical, as it happens. */
  list(): readonly SnippetTemplate[];
  /** One by name: what `/snip name` looks up and what a chosen row expands. */
  get(name: string): { readonly body: string } | undefined;
}

/**
 * The holes a template left behind, and the text they were counted in.
 *
 * `at` is the one the cursor is in. `text` is what keeps the rest honest: an
 * offset means nothing without the buffer it was measured against, and
 * comparing the two is how an edit is noticed rather than tracked.
 */
interface Stops {
  readonly slots: readonly SlotRange[];
  readonly at: number;
  /** Where `$0` was: the stop after the last hole, and the last one there is. */
  readonly final?: number;
  readonly text: string;
}

/** The stops an expansion leaves, or nothing when it left no hole to fill. */
function stopsFrom(expansion: Expansion, text: string): Stops | null {
  if (expansion.slots.length === 0) return null;
  const stops: Stops = { slots: expansion.slots, at: 0, text };
  return expansion.final === undefined ? stops : { ...stops, final: expansion.final };
}

/**
 * `stops` moved to where they are in `text`, or `null` when the edit was not
 * one they survive.
 *
 * Asked the other way round from a diff, because a diff of two strings is
 * ambiguous exactly where it matters — typing a `b` into an empty hole in `ab`
 * is indistinguishable from typing one after it — and an ambiguity resolved
 * against the person would throw the template away mid-word. So the question
 * is not *what* changed but whether anything outside the hole did: what stands
 * before it must be untouched and what stands after it must be the same text,
 * moved by the difference in length. If so the hole has grown or shrunk and
 * everything past it slides; if not, somebody has moved on and there is
 * nothing left to walk. One comparison, once per render, instead of every key
 * that touches the buffer remembering it must adjust some numbers.
 */
function stopsIn(stops: Stops, text: string): Stops | null {
  if (stops.text === text) return stops;
  const current = stops.slots[stops.at];
  if (current === undefined) return null;

  const old = stops.text;
  const delta = text.length - old.length;
  const end = current.end + delta;
  // A hole cannot be rubbed out past its own front: that is a Backspace at the
  // start of it, which is somebody leaving rather than filling.
  if (end < current.start) return null;
  if (text.slice(0, current.start) !== old.slice(0, current.start)) return null;
  if (text.slice(end) !== old.slice(current.end)) return null;

  const moved: Stops = {
    text,
    at: stops.at,
    slots: stops.slots.map((slot, index) => {
      if (index < stops.at) return slot;
      if (index === stops.at) return { start: slot.start, end };
      return { start: slot.start + delta, end: slot.end + delta };
    }),
  };
  if (stops.final === undefined) return moved;
  // `$0` can sit before the hole as easily as after it, and only what is after
  // it moved.
  return { ...moved, final: stops.final >= current.end ? stops.final + delta : stops.final };
}

/** How many stops Tab has still to take you to, `$0` counted. */
function stopsLeft(stops: Stops): number {
  return stops.slots.length - 1 - stops.at + (stops.final === undefined ? 0 : 1);
}

/** The row under the box while there are holes left in what was expanded. */
function stopsHint(remaining: number): string {
  return remaining === 0 ? 'Tab leaves the last slot' : `Tab next slot · ${String(remaining)} left`;
}

/** The first line of a body, cut to fit the column beside the name. */
function firstBodyLine(body: string): string {
  const line = (body.split('\n', 1)[0] ?? '').trim();
  return line.length > SNIPPET_DETAIL_CHARS ? `${line.slice(0, SNIPPET_DETAIL_CHARS - 1)}…` : line;
}

/**
 * An image that came off the clipboard, ready for the app to attach.
 *
 * Bytes rather than a path, because there is no file: `attachments.ts` builds
 * the protocol's `Attachment` from either.
 */
export interface PastedImage {
  /** `clipboard-1.png` — the chip's own number, so two pastes are two files. */
  readonly name: string;
  readonly mediaType: 'image/png';
  readonly bytes: Uint8Array;
}

/**
 * The two clipboard reads Ctrl+V needs.
 *
 * An interface rather than the module, so a test hands over an image without a
 * desktop session and the suite never shells out. `clipboard.ts` satisfies it
 * as it stands, and is the default.
 */
export interface ComposerClipboard {
  readImage(): Promise<{ readonly bytes: Uint8Array; readonly mediaType: 'image/png' } | null>;
  readText(): Promise<string | null>;
}

const REAL_CLIPBOARD: ComposerClipboard = {
  readImage: () => readClipboardImage(),
  readText: () => readClipboardText(),
};

/**
 * Something standing in the text for more than it says.
 *
 * The marker is the truth: a chip exists exactly as long as its marker is in
 * the buffer, so deleting one, undoing that, and cutting and pasting the text
 * all do the obvious thing without a single line of bookkeeping.
 */
type Chip =
  | {
      readonly kind: 'paste';
      readonly number: number;
      readonly marker: string;
      readonly text: string;
      /** What the text turned out to be: the marker's label, and the fence it goes out in. */
      readonly paste: PasteClassification;
    }
  | { readonly kind: 'image'; readonly number: number; readonly marker: string; readonly image: PastedImage };

/** What the app can do to the box from outside a keystroke. */
export interface ComposerHandle {
  /** Replace the text, undoably, with the cursor at its end. */
  setText(text: string): void;
  /** What is in the box right now. */
  getText(): string;
  /**
   * True while the composer owns Esc — its reverse search is open, or it is a
   * shell prompt with nothing typed at it.
   */
  isCapturing(): boolean;
  /**
   * True while the composer owns Tab — a popup is open on a row Tab would fill
   * in, or a snippet left holes for it to walk.
   *
   * Asked for the same reason {@link isCapturing} is, about a different key:
   * the app toggles the focus with Tab, the composer completes with it, and
   * Ink hands the press to both. Two owners for one keystroke was a Tab that
   * finished the word *and* moved the keyboard off the box it had just
   * finished it in.
   */
  hasPopup(): boolean;
  /**
   * Expand the named snippet over the whole draft, its slots filled from
   * `words`, and leave the cursor in the first hole that is left. False when
   * there is no snippet of that name, which is `/snip`'s to report.
   *
   * Here rather than in the app for the reason {@link setText} is: what comes
   * back from an expansion is a buffer, a cursor and a list of stops, and only
   * this component has anywhere to put the last two.
   */
  expandSnippet(name: string, words: readonly string[]): boolean;
}

/**
 * A walk through the history, alive for exactly as long as the text it put in
 * the box is still the text in the box.
 */
interface Walk {
  /** What this walk last wrote. Any other buffer means someone has edited. */
  readonly text: string;
  readonly cursor: HistoryCursor;
  /** How many entries there are to walk, for the hint. */
  readonly total: number;
  /** `-1` is the draft, `0` the newest entry — the cursor's own numbering. */
  readonly position: number;
}

/** An open reverse search: the query, where it is looking, what it displaced. */
interface Search {
  readonly query: string;
  /** Into the scopes the composer was given; Ctrl+S moves it on. */
  readonly scopeIndex: number;
  /** The buffer as it was when the search opened, so Esc is lossless. */
  readonly draft: EditorState;
  readonly matches: readonly HistoryMatch[];
  /** Which match is showing; Ctrl+R steps it towards the older ones. */
  readonly at: number;
}

/**
 * What a keystroke adds to the search query.
 *
 * The editor scrubs control bytes on the way into the buffer; the query is a
 * plain string and did not. Ink folds only Ctrl+A..Z back into letters, so a
 * chord like Ctrl+] arrives as a bare U+001D that would otherwise land in the
 * query as an invisible character nothing matches. Newlines become spaces, as
 * a pasted phrase is still one phrase.
 */
function typedForQuery(input: string): string {
  return input.replace(/[\r\n]+/gu, ' ').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '');
}

export interface ComposerProps {
  /**
   * What was typed, the `@paths` in it that name a real file — in order, once
   * each — and any images pasted into it.
   *
   * The text keeps the mentions and has its paste chips expanded back into
   * what they stood for, so what arrives here is the whole message. The second
   * and third arguments are what the app turns into attachments; the third is
   * absent when nothing was pasted, which is nearly always.
   */
  readonly onSubmit: (text: string, mentions: readonly string[], images?: readonly PastedImage[]) => void;
  /** The agent is mid-turn. Enter steers; the hint says so. */
  readonly live: boolean;
  /** The provider cannot take a message until the turn ends. */
  readonly locked: boolean;
  /** Why the last submission was refused, if it was. */
  readonly notice?: string;
  /** Names of files queued to go with the next message. */
  readonly attachments?: readonly string[];
  /** The provider's own slash commands, offered beside the TUI's. */
  readonly providerCommands?: readonly string[];
  readonly isActive?: boolean;
  /**
   * ↑ on the first line, ↓ on the last, once the history has had its say:
   * the app's to do something with.
   */
  readonly onArrowOverflow?: (direction: 'up' | 'down') => void;
  /** What `@` completes against. Without it `@` is an ordinary character. */
  readonly fileIndex?: FileIndex;
  /**
   * What `;;` offers and what `/snip` expands. Without it `;;` is two
   * semicolons and {@link ComposerHandle.expandSnippet} finds nothing.
   */
  readonly snippets?: SnippetLookup;
  /** What ↑ and Ctrl+R read. Without it neither key does anything new. */
  readonly history?: HistoryLookup;
  /** The slices ↑ prefers and Ctrl+S cycles, best first. */
  readonly historyScopes?: readonly HistoryScope[];
  /**
   * ↑ on an empty box asks for the newest queued message back. The words, or
   * nothing at all when there is no queue — which means "carry on".
   */
  readonly onTakeBackQueued?: () => string | undefined;
  /** What Ctrl+V reads. The real clipboard unless a test says otherwise. */
  readonly clipboard?: ComposerClipboard;
  /**
   * Ctrl+G: the draft with its chips expanded, and back the edited text — or
   * nothing at all, which is an edit that was abandoned or never started.
   *
   * The composer does not run the editor: handing the terminal over is the
   * app's, because the app is what holds Ink's instance. Without this prop
   * Ctrl+G does nothing.
   */
  readonly onExternalEdit?: (text: string) => Promise<string | undefined>;
  /**
   * A line typed at the shell prompt. `send` is the `!!` form: run it, then
   * give the output to the agent. Without this prop `!` is a character.
   */
  readonly onShell?: (command: string, options: { readonly send: boolean }) => void;
  /**
   * `?` on an empty box: the key map, which the app draws over everything.
   *
   * The composer's rather than the app's because only the composer knows the
   * box is empty, and because Ink has no stop-propagation — a `?` the app
   * acted on would be a `?` this inserted on the same press. Without this
   * prop `?` is punctuation everywhere, as it is anywhere but the first
   * column.
   */
  readonly onHelp?: () => void;
  /** React 19 passes this through as a prop; see {@link ComposerHandle}. */
  readonly ref?: React.Ref<ComposerHandle>;
}

export function Composer({
  onSubmit,
  live,
  locked,
  notice,
  attachments = [],
  providerCommands = [],
  isActive = true,
  onArrowOverflow,
  fileIndex,
  snippets,
  history,
  historyScopes = DEFAULT_SCOPES,
  onTakeBackQueued,
  clipboard = REAL_CLIPBOARD,
  onExternalEdit,
  onShell,
  onHelp,
  ref,
}: ComposerProps): React.JSX.Element {
  const [buffer, setBuffer] = useState(EMPTY_EDITOR);
  /*
   * The highlighted row, remembered against the text it was chosen on. Any edit
   * to the text makes it stale, and a stale index over a fresh list is exactly
   * how Enter runs a command nobody chose — so it is thrown away rather than
   * kept in step, and the menu falls back to its first row.
   */
  const [picked, setPicked] = useState<{ readonly text: string; readonly index: number } | null>(null);
  const value = buffer.text;

  /*
   * The box is a shell prompt. Nothing else changes about it — the same
   * buffer, the same editing keys, the same history — but `/` is a path, `@`
   * is an email address and Enter runs rather than sends, so both popups stand
   * down and the glyph and the border say which box this is.
   */
  const [shell, setShell] = useState(false);

  // A single word beginning with a slash is a command being typed. Whitespace
  // of any kind ends that: what follows is arguments, or a second line.
  const typingCommand = !shell && value.startsWith('/') && !/\s/u.test(value);
  const menu = typingCommand ? matchCommands(value, providerCommands) : [];
  const selected =
    menu.length === 0
      ? null
      : picked !== null && picked.text === value
        ? Math.max(0, Math.min(picked.index, menu.length - 1))
        : 0;
  const highlighted = selected === null ? undefined : menu[selected];

  /*
   * A walk, and the walk that is still live. Remembered against the text it
   * wrote for the same reason `picked` is: an edit must end it, and noticing
   * that here is one line, where clearing it in every branch that touches the
   * buffer is twenty and one of them would be forgotten.
   */
  const [walk, setWalk] = useState<Walk | null>(null);
  const walking = walk !== null && walk.text === value ? walk : null;

  const [search, setSearch] = useState<Search | null>(null);

  /*
   * What the chips in the box stand for.
   *
   * A ref and not state, because nothing here is drawn: a chip is visible as
   * the marker it put in the buffer, and the buffer is the state. Keeping it
   * out of the render is also what makes it safe to read and write inside the
   * handler for a key — two pastes on two ticks number themselves correctly
   * without waiting for a render in between.
   */
  const chips = useRef<readonly Chip[]>([]);

  /** The draft Ctrl+S set aside: the whole editor state, so the cursor comes back. */
  const [stash, setStash] = useState<EditorState | null>(null);

  /*
   * A word under the box that goes away by itself — what the clipboard is
   * doing, what the stash just did. Not `notice`, which is the app's and stays
   * until the app takes it down: this is the feedback for a key that did
   * something invisible.
   */
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFlash = (text: string | null): void => {
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = null;
    setFlash(text);
    if (text === null) return;
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null;
      setFlash(null);
    }, FLASH_MS);
    flashTimer.current.unref?.();
  };
  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  /*
   * `@`, and the files it could mean.
   *
   * The listing is asked for once per index — the identity of the object is
   * the directory it lists — and only once the text has an `@` in it at all.
   * That trigger is the cheapest honest one: it catches a pasted message as
   * well as a typed `@`, and it costs nothing at all for the messages that
   * name no file, which is most of them. A listing that fails is an empty one,
   * because a completion is not worth an error in front of a prompt.
   */
  const [listed, setListed] = useState<{ readonly index: FileIndex; readonly paths: readonly string[] } | null>(null);
  const requested = useRef<FileIndex | null>(null);
  const couldName = fileIndex !== undefined && value.includes('@');
  useEffect(() => {
    if (fileIndex === undefined || !couldName || requested.current === fileIndex) return;
    requested.current = fileIndex;
    void fileIndex.list().then(
      (found) => {
        setListed({ index: fileIndex, paths: found });
      },
      () => {
        setListed({ index: fileIndex, paths: [] });
      },
    );
  }, [fileIndex, couldName]);
  // Compared rather than cleared: a new directory arrives as a new index, and
  // the last one's paths must not answer for it, even for a frame.
  const paths = listed !== null && listed.index === fileIndex ? listed.paths : null;

  /*
   * The slash menu wins. The only word the two could both claim is one that
   * begins with a slash and has an `@` in it, and that word is someone typing
   * a command. A reverse search owns the whole keyboard, this included.
   */
  const mention =
    fileIndex === undefined || typingCommand || shell || search !== null ? null : mentionAt(value, buffer.cursor);
  const query = mention === null ? null : mention.query;
  const suggestions = useMemo<readonly FileMatch[]>(() => {
    if (fileIndex === undefined || query === null || paths === null) return [];
    return fuzzyMatch(query, paths, { limit: MENTION_ROWS, frecency: fileIndex.frecency });
  }, [fileIndex, query, paths]);
  /*
   * The highlighted path, on the same terms as `picked`: remembered against
   * the token it was chosen over, so any edit — which is a new query and a new
   * list — falls back to the first row rather than pointing somewhere else.
   */
  const [pickedPath, setPickedPath] = useState<{ readonly token: string; readonly index: number } | null>(null);
  const token = mention === null ? '' : `${String(mention.start)} ${mention.query}`;
  const mentionSelected =
    suggestions.length === 0
      ? null
      : pickedPath !== null && pickedPath.token === token
        ? Math.max(0, Math.min(pickedPath.index, suggestions.length - 1))
        : 0;
  const mentionChoice = mentionSelected === null ? undefined : suggestions[mentionSelected];
  /** What is in the box that will travel as a file: the row under it says so too. */
  const known = useMemo(() => new Set(paths ?? []), [paths]);
  const mentions = useMemo(() => mentionsIn(value, known), [value, known]);

  /*
   * `;;`, and the snippets it could mean.
   *
   * Asked last of the three: the slash menu has already claimed a word that
   * starts with one, and `@` a token that starts with one. Nothing to defer
   * loading here — a dozen templates are already in memory, which is the whole
   * difference between this list and the repository the `@` popup lists.
   */
  const snippetToken =
    snippets === undefined || typingCommand || shell || search !== null || mention !== null
      ? null
      : snippetAt(value, buffer.cursor);
  const snippetQuery = snippetToken === null ? null : snippetToken.name;
  /*
   * The picker's own matching rather than the `@` popup's: `fuzzyMatch` is
   * shaped for paths — a basename bonus, a bonus for landing after a slash, a
   * frecency table to break ties — and a snippet's name is one lower-case word
   * with none of that in it. `filterItems` is the plain subsequence, it hands
   * back the offsets `Completions` draws bold, and with nothing typed yet it
   * gives the whole list in the order it arrived. The body's first line is
   * attached after matching rather than passed in as a detail, so what the
   * rows answer to is the name, as the trigger promises.
   */
  const snippetRows = useMemo<readonly CompletionItem[]>(() => {
    if (snippets === undefined || snippetQuery === null) return [];
    const saved = snippets.list();
    const bodies = new Map(saved.map((snippet) => [snippet.name, snippet.body]));
    return filterItems(saved.map((snippet) => ({ key: snippet.name, label: snippet.name })), snippetQuery)
      .slice(0, SNIPPET_ROWS)
      .map((match) => ({
        key: match.item.key,
        label: match.item.label,
        detail: firstBodyLine(bodies.get(match.item.key) ?? ''),
        indices: match.indices,
      }));
  }, [snippets, snippetQuery]);
  /** The highlighted row, on the same terms as `pickedPath`: stale means the first row. */
  const [pickedSnippet, setPickedSnippet] = useState<{ readonly token: string; readonly index: number } | null>(null);
  const snippetTokenKey = snippetToken === null ? '' : `${String(snippetToken.start)} ${snippetToken.name}`;
  const snippetSelected =
    snippetRows.length === 0
      ? null
      : pickedSnippet !== null && pickedSnippet.token === snippetTokenKey
        ? Math.max(0, Math.min(pickedSnippet.index, snippetRows.length - 1))
        : 0;
  const snippetChoice = snippetSelected === null ? undefined : snippetRows[snippetSelected];

  /*
   * The holes the last expansion left, as they were when they were counted,
   * and where they are now. Derived for the reason `walking` is: an edit that
   * has nothing to do with them must end them, and noticing that in one place
   * is a rule, where clearing them in every branch that touches the buffer is
   * twenty chances to forget. Undo brings them back with the text, which is
   * what undo is for.
   */
  const [tabStops, setTabStops] = useState<Stops | null>(null);
  const stops = tabStops === null ? null : stopsIn(tabStops, value);
  const stop = stops === null ? undefined : stops.slots[stops.at];
  /**
   * The default still standing under the cursor, if there is one.
   *
   * Pending means nothing has happened here yet: the text is the text the stop
   * was counted in and the cursor is still where Tab put it, at the front of
   * the hole. Then the next character replaces the whole default, which is
   * what the editor's missing selection would have done. One move of the
   * cursor — a Left, a Ctrl+A — and it is an ordinary place in the line again,
   * because somebody who has gone to look at the default is somebody who means
   * to keep it.
   */
  const landed = tabStops?.text === value && buffer.cursor === stop?.start;
  const pending = landed && stop !== undefined && stop.end > stop.start ? stop : null;

  /*
   * Read by the app, on the same keystroke the composer is answering, so it
   * cannot be state: state is a render away. It is raised as the search opens
   * and lowered only after the render that closed it, which is what keeps the
   * Esc that closed a search from also interrupting the turn.
   */
  const capturing = useRef(false);
  useEffect(() => {
    // An empty shell line owns Esc for the same reason and on the same terms.
    // With a command half typed it does not: the key that stops a turn matters
    // more than the key that leaves a prompt, and Backspace leaves it too.
    capturing.current = isActive && (search !== null || (shell && value.length === 0));
  }, [isActive, search, shell, value]);

  /*
   * Tab's own flag, read by the app on the press it is deciding about — and
   * lowered in an effect rather than in the handler, exactly as `capturing`
   * is: the Tab that fills in the last row must not also move the focus, and
   * a flag lowered as the menu closed would already read as lowered when the
   * app looked at it.
   */
  const popupOpen =
    highlighted !== undefined || mentionChoice !== undefined || snippetChoice !== undefined || stops !== null;
  const popup = useRef(false);
  useEffect(() => {
    popup.current = isActive && popupOpen;
  }, [isActive, popupOpen]);

  // Focus moving away ends a search rather than leaving a row on screen that
  // no key can reach: the composer stops answering keys entirely when it is
  // not the focus.
  useEffect(() => {
    if (isActive || search === null) return;
    setBuffer(search.draft);
    setSearch(null);
  }, [isActive, search]);

  useImperativeHandle(
    ref,
    () => ({
      setText: (text: string) => {
        setBuffer((current) => replaceAll(current, text));
      },
      getText: () => buffer.text,
      isCapturing: () => capturing.current,
      hasPopup: () => popup.current,
      expandSnippet: (name: string, words: readonly string[]) => {
        const body = snippets?.get(name)?.body;
        if (body === undefined) return false;
        // The whole draft, because `/snip` was typed into an empty box or over
        // something the person has finished with — and undoably, so the box
        // they had is one press away either way.
        const expansion = expandTemplate(body, words);
        setBuffer((current) => replaceLeavingCursor(current, expansion.text, expansion.cursor));
        setTabStops(stopsFrom(expansion, expansion.text));
        return true;
      },
    }),
    [buffer, snippets],
  );

  /**
   * Write the chosen path over the token under the cursor, and remember that
   * it was chosen. `fileIndex.ts` decides what the text and the cursor become;
   * the space it leaves after the path is why the next word can just be typed.
   */
  const acceptMention = (path: string): void => {
    if (mention === null) return;
    const written = replaceMention(value, mention.start, mention.end, `@${path}`);
    setBuffer((current) => replaceLeavingCursor(current, written.text, written.cursor));
    fileIndex?.frecency.record(path);
    setPickedPath(null);
  };

  /**
   * Write the chosen snippet over the `;;token` under the cursor. `snippets.ts`
   * decides what the text, the cursor and the holes become; nothing is added
   * after it, because a template is the sentence rather than a word in one.
   */
  const acceptSnippet = (name: string): void => {
    const body = snippets?.get(name)?.body;
    if (snippetToken === null || body === undefined) return;
    const written = expandInText(value, snippetToken.start, snippetToken.end, expandTemplate(body));
    setBuffer((current) => replaceLeavingCursor(current, written.text, written.cursor));
    setTabStops(stopsFrom(written, written.text));
    setPickedSnippet(null);
  };

  /** Put the cursor at the front of `index`'s hole, and count edits from here. */
  const goToStop = (index: number): void => {
    if (stops === null) return;
    const target = stops.slots[index];
    if (target === undefined) return;
    setBuffer((current) => cursorAt(current, target.start));
    setTabStops({ ...stops, at: index });
  };

  /**
   * Tab: the next hole, or `$0` once there are none left — and then the stops
   * are done with, because a template with nothing left to fill is a message.
   * A body that named no `$0` leaves the cursor at the end of its last hole,
   * since there is nowhere else it asked for.
   */
  const nextStop = (): void => {
    if (stops === null) return;
    if (stops.at + 1 < stops.slots.length) {
      goToStop(stops.at + 1);
      return;
    }
    const rest = stops.final ?? stop?.end;
    if (rest !== undefined) setBuffer((current) => cursorAt(current, rest));
    setTabStops(null);
  };

  /** Shift+Tab: the hole before this one, and nowhere at all from the first. */
  const previousStop = (): void => {
    if (stops === null || stops.at === 0) return;
    goToStop(stops.at - 1);
  };

  /**
   * Text going in where the cursor is — and over the whole of a hole's default
   * when one is still pending, which is what stands in for the selection the
   * editor has not got. Through `replaceAll`, so the default that was replaced
   * is one undo away, as a completed path or a rubbed-out chip is.
   */
  const typeInto = (input: string): void => {
    if (pending === null) {
      setBuffer((current) => insert(current, input));
      return;
    }
    const text = value.slice(0, pending.start) + input + value.slice(pending.end);
    setBuffer((current) => replaceLeavingCursor(current, text, pending.start + input.length));
  };

  /** Put `text` in the box, undoably, and hand back the buffer that makes. */
  const put = (text: string): EditorState => {
    const next = replaceAll(buffer, text);
    setBuffer(next);
    return next;
  };

  /**
   * Run a query and show what it found — which is every key the search row
   * answers, since opening, typing, rubbing out, stepping older and changing
   * scope all come down to "look again, then put the match in the box".
   */
  const searchFor = (query: string, scopeIndex: number, wanted: number, draft: EditorState): void => {
    const count = historyScopes.length;
    const index = count === 0 ? 0 : ((scopeIndex % count) + count) % count;
    const scope = historyScopes[index] ?? ALL_SCOPE;
    const matches = history === undefined ? [] : history.search(query, scope);
    const at = matches.length === 0 ? 0 : Math.min(Math.max(wanted, 0), matches.length - 1);
    setSearch({ query, scopeIndex: index, draft, matches, at });
    const match = matches[at];
    // A query that matches nothing leaves the last good match on screen, as
    // bash does: the row says `no match`, and nothing that was found is lost.
    if (match !== undefined) put(match.text);
  };

  /* ---------------------------------------------------------------------- */
  /* Chips                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * `text` with every paste chip in it back to being what it stood for, in the
   * fence its kind asks for. `pasteKind.ts` decides both; this only knows the
   * order to put the chips back in.
   */
  const expand = (text: string): string =>
    chips.current.reduce(
      (out, chip) => (chip.kind === 'paste' ? expandChip(out, chip.marker, chip.text, chip.paste) : out),
      text,
    );

  /** The images whose chips are still in `text`: one backspaced away does not travel. */
  const imagesIn = (text: string): readonly PastedImage[] =>
    chips.current.flatMap((chip) => (chip.kind === 'image' && text.includes(chip.marker) ? [chip.image] : []));

  /**
   * The next number of its kind, counted from the highest ever used rather
   * than from how many there are. A chip that was rubbed out is one undo from
   * coming back, and two of a number would expand to one text.
   */
  const nextNumber = (kind: Chip['kind']): number =>
    chips.current.reduce((highest, chip) => (chip.kind === kind ? Math.max(highest, chip.number) : highest), 0) + 1;

  /** Remember the chip and type its marker where the cursor is. */
  const addChip = (chip: Chip): void => {
    chips.current = [...chips.current, chip];
    setBuffer((current) => insert(current, chip.marker));
  };

  /** Forget every chip that `kept` — what is left of the draft — no longer names. */
  const keepChipsIn = (kept: string): void => {
    chips.current = chips.current.filter((chip) => kept.includes(chip.marker));
  };

  /** The chip the cursor is sitting just past, if it is: the longest wins. */
  const chipEndingAt = (text: string, cursor: number): Chip | undefined => {
    const before = text.slice(0, cursor);
    let found: Chip | undefined;
    for (const chip of chips.current) {
      if (before.endsWith(chip.marker) && (found === undefined || chip.marker.length > found.marker.length)) found = chip;
    }
    return found;
  };

  /**
   * Text arriving all at once, from wherever it came.
   *
   * Line endings are normalised and a single trailing newline — the one a
   * terminal adds when you copy a whole line — is dropped rather than
   * inserted, because it would otherwise sit invisibly at the end of the
   * message. A paste never submits by itself.
   *
   * `bracketed` is whether the *terminal* said this was a paste. Only then is
   * a long one turned into a chip, and the distinction is worth keeping:
   * `\x1b[200~` is a fact, while "more than one character at once" is a guess
   * that a fast key repeat, a chunked read and an input method all satisfy.
   * Standing in for text somebody actually typed would be the worse mistake of
   * the two, so the guess still just inserts, exactly as it always has.
   */
  const paste = (raw: string, bracketed: boolean): void => {
    const text = raw.replace(/\r\n?/gu, '\n').replace(/\n$/u, '');
    if (text.length === 0) return;
    if (search !== null) {
      // A pasted query is still a query; its line breaks would be a row the
      // search cannot draw, so they become spaces.
      searchFor(search.query + typedForQuery(text), search.scopeIndex, 0, search.draft);
      return;
    }
    const rows = text.split('\n').length;
    const big = rows > PASTE_CHIP_LINES || text.length > PASTE_CHIP_CHARS;
    // Not at the `$`: a shell command is a line, not a document, so there is
    // nothing a chip could usefully stand for and nowhere for it to be read.
    if (!bracketed || shell || !big) {
      // Through the same door a typed character goes through: a path pasted
      // into `@${1:path/to/file}` is exactly what that hole was asking for.
      typeInto(text);
      return;
    }
    const number = nextNumber('paste');
    // Read once, here, and kept: what the text is cannot change while it sits
    // in a chip, and a keystroke is no place to classify four hundred lines
    // over again.
    const classified = classifyPaste(text);
    addChip({
      kind: 'paste',
      number,
      marker: pasteMarker(number, rows, classified.label),
      text,
      paste: classified,
    });
  };

  /*
   * Bracketed paste, which Ink 7 turns on (`\x1b[?2004h`) for as long as this
   * hook is mounted and turns off again when it goes. While it is listening a
   * paste never reaches `useInput` at all — Ink keeps the two on separate
   * channels — so there is exactly one route in for every terminal made this
   * century, and the length test down in `useInput` is what is left for one
   * that ignores the sequence.
   */
  usePaste(
    (text) => {
      paste(text, true);
    },
    { isActive },
  );

  /* ---------------------------------------------------------------------- */
  /* Ctrl+V, Ctrl+G, Ctrl+S                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * An image first, then whatever text is there.
   *
   * Falling through to the text is what keeps Ctrl+V from being a key that
   * works only after a screenshot: the overwhelmingly common clipboard holds
   * words, and the terminal's own paste is not always bound to anything the
   * person can reach.
   */
  const pasteFromClipboard = async (): Promise<void> => {
    showFlash('pasting…');
    const image = await clipboard.readImage();
    if (image !== null) {
      const number = nextNumber('image');
      addChip({
        kind: 'image',
        number,
        marker: `[Image #${String(number)}]`,
        image: { name: `clipboard-${String(number)}.png`, mediaType: 'image/png', bytes: image.bytes },
      });
      showFlash(null);
      return;
    }
    const text = await clipboard.readText();
    if (text !== null && text.length > 0) {
      // Ctrl+V is as certain a paste as a bracketed one: nobody typed this.
      paste(text, true);
      showFlash(null);
      return;
    }
    showFlash('no image on the clipboard');
  };

  /** Ctrl+G. Chips go out expanded, which is also the only way to read one. */
  const editElsewhere = async (): Promise<void> => {
    if (onExternalEdit === undefined) return;
    const edited = await onExternalEdit(expand(value));
    if (edited === undefined) return;
    keepChipsIn(stash?.text ?? '');
    setBuffer((current) => replaceAll(current, edited));
  };

  /** Ctrl+S. One slot: set the draft aside, or take back what is in it. */
  const stashOrRestore = (): void => {
    if (value.length === 0) {
      if (stash === null) return;
      setBuffer(stash);
      setStash(null);
      return;
    }
    setStash(buffer);
    setBuffer(clear);
    showFlash('stashed · Ctrl+S restores');
  };

  /**
   * Send what is in the box: chips expanded, images beside the words.
   *
   * One place, because the reverse search sends too, and because expanding is
   * the step that must not be forgotten — a message that went with `[Pasted
   * #1 · 412 lines]` in it would be a message about nothing.
   */
  const sendBuffer = (text: string): void => {
    const expanded = expand(text);
    const images = imagesIn(text);
    const named = mentionsIn(expanded, known);
    /*
     * Emptied before the message is handed over rather than after.
     * `/snip` is answered on this very keystroke and answers by putting a
     * template back in the box, and a clear queued *after* that would throw it
     * away — so the order here is what makes a command able to reply into the
     * box it was typed in. Whatever holes were still to fill have gone out
     * unfilled, which is an answer too.
     */
    keepChipsIn(stash?.text ?? '');
    setBuffer(clear);
    setTabStops(null);
    // The third argument is left off when there is nothing in it, so the
    // ordinary message is the ordinary two-argument call it has always been.
    if (images.length === 0) onSubmit(expanded, named);
    else onSubmit(expanded, named, images);
  };

  /**
   * The best scope that has anything in it: this folder, then everything.
   *
   * Shell lines and messages are the same file and two lists. A line stored
   * with its `!` is a shell line; ↑ at the `$` offers those with the `!` taken
   * off, and ↑ in the box offers the rest, so neither prompt ever hands back
   * the other's history.
   */
  const recentTexts = (): readonly string[] => {
    if (history === undefined) return [];
    const mine = (texts: readonly string[]): readonly string[] =>
      shell
        ? texts.flatMap((text) => (text.startsWith(SHELL_PREFIX) ? [text.slice(SHELL_PREFIX.length)] : []))
        : texts.filter((text) => !text.startsWith(SHELL_PREFIX));
    for (const scope of historyScopes) {
      const texts = mine(history.recent(scope));
      if (texts.length > 0) return texts;
    }
    return [];
  };

  /**
   * ↑ that the text had no line left for. True when it was spent here, which
   * is what stops the app scrolling the conversation on the same press.
   */
  const recallOlder = (): boolean => {
    if (walking !== null) {
      const next = put(walking.cursor.up());
      setWalk({ ...walking, text: next.text, position: Math.min(walking.position + 1, walking.total - 1) });
      return true;
    }
    if (value.length === 0) {
      // Empty box first, and only empty: with anything typed, ↑ is history,
      // so the two never compete for the same press.
      const back = onTakeBackQueued?.();
      if (back !== undefined) {
        put(back);
        return true;
      }
    }
    const texts = recentTexts();
    if (texts.length === 0) return false;
    // Whatever is typed becomes the draft, which is what walking back down
    // past the newest entry returns to.
    const cursor = new HistoryCursor(texts, value);
    const next = put(cursor.up());
    setWalk({ text: next.text, cursor, total: texts.length, position: 0 });
    return true;
  };

  /** ↓ likewise, and only a walk in progress has anything to do with it. */
  const recallNewer = (): boolean => {
    if (walking === null) return false;
    const next = put(walking.cursor.down());
    setWalk({ ...walking, text: next.text, position: Math.max(walking.position - 1, -1) });
    return true;
  };

  useInput(
    (input, key) => {
      /*
       * An open reverse search has the keyboard, ahead of everything — the
       * newline keys included, because inside a search every one of them
       * means something else.
       */
      if (search !== null) {
        if (key.escape) {
          setBuffer(search.draft);
          setSearch(null);
          return;
        }
        if (key.return) {
          /*
           * What the box is showing is what goes. That is the whole promise of
           * putting the match in the box rather than beside it, and it is also
           * the honest answer when the last keystroke matched nothing: the
           * words on screen are the words sent.
           */
          setSearch(null);
          if (value.trim().length === 0) {
            setBuffer(search.draft);
            return;
          }
          sendBuffer(value);
          return;
        }
        if (key.tab || key.rightArrow) {
          // Accept and stay. The match is already the buffer, so closing the
          // row is all there is to do, and the cursor is at its end.
          setSearch(null);
          return;
        }
        if (key.ctrl && input === 'r') {
          searchFor(search.query, search.scopeIndex, search.at + 1, search.draft);
          return;
        }
        if (key.ctrl && input === 's') {
          searchFor(search.query, search.scopeIndex + 1, 0, search.draft);
          return;
        }
        if (key.backspace || key.delete) {
          // Rubbing out the last of the query is a cancel, because a search
          // with nothing in it is not a search.
          if (search.query.length === 0) {
            setBuffer(search.draft);
            setSearch(null);
            return;
          }
          searchFor(search.query.slice(0, -1), search.scopeIndex, 0, search.draft);
          return;
        }
        if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow) return;
        if (input.length === 0 || input === '\n') return;
        // A pasted query is still a query; its line breaks would be a row the
        // search cannot draw, so they become spaces.
        searchFor(search.query + typedForQuery(input), search.scopeIndex, 0, search.draft);
        return;
      }
      /*
       * Leaving the shell prompt: Esc, and Backspace off the front of an empty
       * line, which is how every shell-inside-an-editor has been left. Only
       * while the line is empty — see `capturing` — so the app still has Esc
       * for the turn while there is a command half typed.
       */
      if (shell && value.length === 0 && (key.escape || key.backspace)) {
        setShell(false);
        return;
      }
      /*
       * The newline keys come first, because each of them is a Return that
       * must not be read as "send". Shift+Enter and Option+Enter only arrive
       * as their own keystroke from a terminal that reports modifiers; Ctrl+J
       * is a bare line feed, which Ink names `enter` and leaves unmodified,
       * and the same key under the kitty protocol which reports it as Ctrl
       * with the letter.
       */
      if ((key.return && (key.shift || key.meta)) || input === '\n' || (key.ctrl && input === 'j')) {
        setBuffer(newline);
        return;
      }
      if (key.return) {
        /*
         * The file popup takes Enter before anything else can: what it means
         * there is "that one", and the message goes on the Enter after. A
         * popup that sent instead would attach a file and end the sentence in
         * the same keystroke, which is not what anyone meant by picking a row.
         */
        if (mentionChoice !== undefined) {
          acceptMention(mentionChoice.path);
          return;
        }
        // And the snippet popup on the same terms: Enter here means "that
        // one", and the message goes on the Enter after the holes are filled.
        if (snippetChoice !== undefined) {
          acceptSnippet(snippetChoice.key);
          return;
        }
        if (endsWithContinuation(buffer)) {
          setBuffer(continueLine);
          return;
        }
        /*
         * Enter at the `$` runs the line. A second `!` in front of it — the
         * first having been spent entering shell mode — is the form that hands
         * the output to the agent afterwards, which is `!!` as it was typed.
         * The box empties but the prompt stays: a shell is a place you run
         * more than one thing, and Esc is how it is left.
         */
        if (shell) {
          const typed = value.trim();
          const send = typed.startsWith(SHELL_PREFIX);
          const command = (send ? typed.slice(SHELL_PREFIX.length) : typed).trim();
          if (command.length === 0) return;
          onShell?.(command, { send });
          setBuffer(clear);
          return;
        }
        /*
         * Enter on a highlighted row runs it — by submitting the words someone
         * would have typed to run it themselves. Everything downstream, the
         * parser above all, sees exactly what it always saw, and the composer
         * still knows nothing about what any command does.
         */
        if (highlighted !== undefined) {
          onSubmit(commandWord(highlighted.usage), []);
          setBuffer(clear);
          return;
        }
        if (value.trim().length === 0 && attachments.length === 0) return;
        sendBuffer(value);
        return;
      }
      if (key.backspace) {
        /*
         * A chip is one thing, so one press takes all of it. Through
         * `replaceAll`, which means the chip is one undo from coming back —
         * and why a chip's number is never handed out twice.
         */
        const chip = chipEndingAt(value, buffer.cursor);
        if (chip !== undefined) {
          const start = buffer.cursor - chip.marker.length;
          setBuffer((current) => replaceLeavingCursor(current, value.slice(0, start) + value.slice(buffer.cursor), start));
          return;
        }
        setBuffer(backspace);
        return;
      }
      if (key.delete) {
        setBuffer(deleteForward);
        return;
      }
      if (key.leftArrow) {
        setBuffer(key.ctrl || key.meta ? wordLeft : left);
        return;
      }
      if (key.rightArrow) {
        setBuffer(key.ctrl || key.meta ? wordRight : right);
        return;
      }
      if (key.upArrow || key.downArrow) {
        // A modified arrow is the app's half-screen scroll, never the text's.
        if (key.shift || key.ctrl || key.meta) return;
        if (mentionSelected !== null) {
          // The file popup walks for the same reason the menu does, and wraps
          // for the same reason the picker does.
          const step = key.upArrow ? -1 : 1;
          setPickedPath({ token, index: (mentionSelected + step + suggestions.length) % suggestions.length });
          return;
        }
        if (snippetSelected !== null) {
          const step = key.upArrow ? -1 : 1;
          setPickedSnippet({
            token: snippetTokenKey,
            index: (snippetSelected + step + snippetRows.length) % snippetRows.length,
          });
          return;
        }
        if (selected !== null) {
          // The open menu takes a plain arrow ahead of the text and ahead of
          // the app: the text is one word, so it has no second line to move
          // to, and scrolling the conversation out from under a menu someone
          // is reading is not what they asked for. Walking off either end
          // comes back round, as it does in the picker.
          const step = key.upArrow ? -1 : 1;
          setPicked({ text: value, index: (selected + step + menu.length) % menu.length });
          return;
        }
        /*
         * Off the end of the text, the press is offered to the history and
         * only then to the app: ↑ means "what did I type" far more often than
         * it means "scroll one line", and a recalled prompt is a keystroke
         * that scrolling would have thrown away. Shift or Ctrl with an arrow
         * still moves the conversation half a screen, from anywhere.
         */
        if (key.upArrow) {
          if (!onFirstLine(buffer)) {
            setBuffer(up);
            return;
          }
          if (recallOlder()) return;
          onArrowOverflow?.('up');
          return;
        }
        if (!onLastLine(buffer)) {
          setBuffer(down);
          return;
        }
        if (recallNewer()) return;
        onArrowOverflow?.('down');
        return;
      }
      if (key.home) {
        setBuffer(key.ctrl ? bufferStart : lineStart);
        return;
      }
      if (key.end) {
        setBuffer(key.ctrl ? bufferEnd : lineEnd);
        return;
      }
      if (key.ctrl) {
        // Readline's editing keys. Anything else with Ctrl — Ctrl+C above all
        // — belongs to the app, so it is left alone rather than swallowed.
        switch (input) {
          case 'a':
            setBuffer(lineStart);
            return;
          case 'e':
            setBuffer(lineEnd);
            return;
          case 'u':
            setBuffer(killToLineStart);
            // The line the holes were in has gone; so have they.
            setTabStops(null);
            return;
          case 'k':
            setBuffer(killToLineEnd);
            return;
          case 'y':
            setBuffer(yank);
            return;
          case 'w':
            setBuffer(deleteWordLeft);
            return;
          case 'r':
            // Reverse search, over the buffer that is there — which Esc will
            // put back exactly as it is now, undo stack and all.
            if (history !== undefined) searchFor('', 0, 0, buffer);
            return;
          case 'v':
            // The clipboard, for the picture a keyboard cannot type. The
            // terminal's own paste — if it has one bound — comes in as a
            // bracketed paste instead and never reaches here.
            void pasteFromClipboard();
            return;
          case 'g':
            void editElsewhere();
            return;
          case 's':
            // Only out here: inside the search row Ctrl+S cycles the scope,
            // which the branch above answered before this could.
            stashOrRestore();
            return;
          case '_':
            setBuffer(undo);
            return;
          default:
            return;
        }
      }
      if (input === UNDO_INPUT) {
        setBuffer(undo);
        return;
      }
      if (key.meta) {
        // Alt with a letter, which is how Ink reports the Escape-prefixed
        // sequence a terminal sends for it.
        switch (input) {
          case 'b':
            setBuffer(wordLeft);
            return;
          case 'f':
            setBuffer(wordRight);
            return;
          case 'd':
            setBuffer(deleteWordRight);
            return;
          default:
            return;
        }
      }
      if (key.tab) {
        // The path the popup is on, written over the token it was typed into.
        if (mentionChoice !== undefined) {
          acceptMention(mentionChoice.path);
          return;
        }
        // Then the snippet the other popup is on, over the `;;token`.
        if (snippetChoice !== undefined) {
          acceptSnippet(snippetChoice.key);
          return;
        }
        // Fill in the highlighted row — the canonical name, prefix and all,
        // which is what makes a bridged `/plugin:command` typeable. Through
        // the editor, so one undo gets back the letters that were typed.
        if (highlighted !== undefined) {
          setBuffer((current) => replaceAll(current, `${commandWord(highlighted.usage)} `));
          return;
        }
        // With no row to fill in, Tab walks the holes the last expansion left.
        if (stops !== null) {
          if (key.shift) previousStop();
          else nextStop();
        }
        return;
      }
      if (key.escape || input.length === 0) return;
      /*
       * `!` with nothing typed is the shell, and only then: anywhere else in a
       * message it is punctuation, and a box that turned into a prompt halfway
       * through a sentence would be unusable. Without an `onShell` there is
       * nothing to run, so it stays punctuation everywhere.
       */
      if (input === SHELL_PREFIX && !shell && value.length === 0 && onShell !== undefined) {
        setShell(true);
        return;
      }
      /*
       * `?` with nothing typed opens the key map, on the same terms as `!` and
       * for the same reason it is answered here rather than in the app: the
       * box would otherwise take the character on the very press the overlay
       * went up, and there would be a `?` waiting under it on the way back.
       */
      if (input === '?' && !shell && value.length === 0 && onHelp !== undefined) {
        onHelp();
        return;
      }
      // More than one character at once, from a terminal that did not say it
      // was a paste — the ones that do never get here, because `usePaste` took
      // it first. Same normalising, no chip: see `paste`.
      if (input.length > 1) {
        paste(input, false);
        return;
      }
      typeInto(input);
    },
    { isActive },
  );

  const rows = lines(buffer);
  const { row, col } = cursorPosition(buffer);
  const { top, size } = editorWindow(row, rows.length, MAX_ROWS);
  const hiddenBelow = rows.length - top - size;
  const placeholder = shell
    ? SHELL_PLACEHOLDER
    : locked
      ? 'working — wait for this turn'
      : live
        ? 'steer the agent…'
        : 'message, or / for commands';
  /** Everything one row under the box promises: what was attached, and what was named. */
  const carried = [...attachments, ...mentions];
  /*
   * The glyph and the border are the whole of what says which box this is. A
   * shell command sent to an agent and a message run by a shell are both bad
   * enough to be worth a colour of their own, so the prompt is a `$` and the
   * border is cyan — the theme's own, like every other colour here.
   */
  const prompt = (
    <Text color={shell ? 'cyan' : locked ? undefined : ACCENT} dimColor={!shell && locked} bold>
      {shell ? '$ ' : '❯ '}
    </Text>
  );

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={shell ? 'cyan' : isActive ? ACCENT : undefined}
        borderDimColor={!isActive}
        paddingX={1}
      >
        {top > 0 && <Text dimColor>{`  ↑ ${String(top)} more`}</Text>}
        {value.length === 0 ? (
          <Text>
            {prompt}
            {isActive ? <Text inverse> </Text> : ' '}
            <Text dimColor>{placeholder}</Text>
          </Text>
        ) : (
          rows.slice(top, top + size).map((line, offset) => {
            const index = top + offset;
            // The cursor is an inverse cell on its own row, and an inverse
            // space where the row has run out of characters to stand on.
            const at = index === row ? cellAt(line, col) || ' ' : '';
            return (
              <Text key={index} wrap="wrap">
                {index === 0 ? prompt : '  '}
                {index === row ? (
                  <>
                    {line.slice(0, col)}
                    {isActive ? <Text inverse>{at}</Text> : at}
                    {line.slice(col + at.length)}
                  </>
                ) : (
                  line
                )}
              </Text>
            );
          })
        )}
        {hiddenBelow > 0 && <Text dimColor>{`  ↓ ${String(hiddenBelow)} more`}</Text>}
      </Box>
      {/*
       * One line under the box for whatever the arrows are doing: the search
       * and its keys while it is open, where a walk has got to while one is
       * running, and otherwise the newline hint that was always here. They are
       * never wanted at once — the search *is* the arrows' owner while it is
       * open — so they share the row rather than stacking up under the box.
       */}
      {search !== null ? (
        <>
          <Text dimColor>
            {`  reverse-i-search [${historyScopes[search.scopeIndex]?.kind ?? ALL_SCOPE.kind}]: ${search.query}`}
            {search.matches.length === 0
              ? ' · no match'
              : ` · ${String(search.at + 1)}/${String(search.matches.length)}`}
          </Text>
          <Text dimColor>
            {'  '}
            {SEARCH_HINT}
          </Text>
        </>
      ) : (
        <>
          {walking !== null && walking.position >= 0 && (
            <Text dimColor>
              {`  history ${String(walking.position + 1)}/${String(walking.total)} · ↓ back to draft`}
            </Text>
          )}
          {shell ? (
            <Text dimColor>
              {'  '}
              {SHELL_HINT}
            </Text>
          ) : stops !== null ? (
            /* What Tab is for while a template still has holes in it, which is
               also the only sign on screen that it has any. */
            <Text dimColor>
              {'  '}
              {stopsHint(stopsLeft(stops))}
            </Text>
          ) : (
            (rows.length > 1 || row > 0) && (
              <Text dimColor>
                {'  '}
                {NEWLINE_HINT}
              </Text>
            )
          )}
        </>
      )}
      {/*
       * What a key just did that left nothing on screen to show for it: the
       * clipboard being read, a draft set aside, a shell command running. Its
       * own row rather than `notice`'s, because it takes itself down again and
       * a refusal does not.
       */}
      {flash !== null && (
        <Text dimColor>
          {'  '}
          {flash}
        </Text>
      )}
      <Completions
        items={menu.map((match) => ({
          key: match.key,
          label: match.usage,
          detail: match.summary,
          indices: match.indices,
        }))}
        selected={selected}
      />
      {/*
       * The files `@` could mean. `loading…` and `no match` are rows of their
       * own rather than a list with one apologetic entry in it, because
       * neither is something Tab should be able to insert.
       */}
      {mention !== null &&
        (paths === null ? (
          <Text dimColor>{'  loading…'}</Text>
        ) : suggestions.length === 0 ? (
          <Text dimColor>{'  no match'}</Text>
        ) : (
          <Completions
            items={suggestions.map((match) => ({ key: match.path, label: match.path, indices: match.indices }))}
            selected={mentionSelected}
            maxRows={MENTION_ROWS}
            hint={MENTION_HINT}
          />
        ))}
      {/* The snippets `;;` could mean. `no match` for the same reason the `@`
          popup says it: a row Tab could expand is the only thing in the list. */}
      {snippetToken !== null &&
        (snippetRows.length === 0 ? (
          <Text dimColor>{'  no match'}</Text>
        ) : (
          <Completions items={snippetRows} selected={snippetSelected} maxRows={SNIPPET_ROWS} hint={SNIPPET_HINT} />
        ))}
      {carried.length > 0 && (
        <Text dimColor>
          {'  ⎘ '}
          {carried.join(', ')} · goes with the next message
          {attachments.length > 0 ? ' · /attach clear' : ''}
        </Text>
      )}
      {notice !== undefined && (
        <Text color="yellow">
          {'  '}
          {notice}
        </Text>
      )}
    </Box>
  );
}
