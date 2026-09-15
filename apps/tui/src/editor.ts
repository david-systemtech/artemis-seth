/**
 * The composer's text buffer.
 *
 * A prompt worth writing is often more than one line — a pasted stack trace, a
 * list of paths, a sentence someone wants to break themselves — so the box you
 * type into needs an editing model rather than a string and an index. It lives
 * here, away from Ink, because every rule in it is a rule about text and can be
 * settled by calling a function: where Ctrl+W stops, what Ctrl+U takes, which
 * column ↑ lands on. The component's whole job is turning keystrokes into these
 * calls and drawing what comes back.
 *
 * The state is immutable and every operation returns a new one, which is what
 * lets React hold it in `useState` and what makes undo nothing more than a list
 * of the states that came before. The decisions worth knowing:
 *
 *  - The cursor is a character offset into `text`, never a row and a column:
 *    one number cannot disagree with itself. Rows and columns are derived when
 *    something needs to draw them. An offset never lands inside a surrogate
 *    pair, so an emoji is one step to walk over and one backspace to remove.
 *  - The buffer holds `\n` and no other control character. A paste arrives with
 *    whatever line endings the program it came from uses, and a terminal can
 *    deliver a stray control byte for a key nothing here claims; both are
 *    scrubbed on the way in, because `lines()` would otherwise lie and a rogue
 *    escape would redraw the row.
 *  - The kill ring is one string, not a ring. Ctrl+W, Ctrl+U, Ctrl+K and Alt+D
 *    each replace it and Ctrl+Y puts it back. A real ring is a second thing to
 *    learn for a box you type a message into.
 *  - Undo folds a burst of single characters into one entry, and the burst is
 *    broken by whitespace, by moving the cursor and by every other operation.
 *    One press should take back the word just typed; taking back one letter at
 *    a time is not what anyone means by undo. The history is bounded, because a
 *    draft that is never sent must not grow without limit.
 *  - Words are readline's: letters and digits, so Alt+B and Alt+F walk through
 *    `--flag=value` in pieces. Ctrl+W measures by whitespace instead and takes
 *    the whole of it, which is what is wanted when the thing to remove is a
 *    path — and it never crosses a line, so one press cannot eat two lines.
 */

/** A point in the buffer's past: what the text was, and where the cursor sat. */
interface Snapshot {
  readonly text: string;
  readonly cursor: number;
}

export interface EditorState {
  readonly text: string;
  /** Character offset into `text`. Never inside a surrogate pair. */
  readonly cursor: number;
  /** What the last kill took, ready for `yank`. */
  readonly kill: string;
  /** Oldest first, bounded by `HISTORY_LIMIT`. */
  readonly history: readonly Snapshot[];
  /**
   * The column ↑ and ↓ are aiming for. Set while walking rows and cleared by
   * everything else, so a walk down through a short line and out the other side
   * comes back to the column it started in — and so nothing else has to
   * remember that it must be forgotten.
   */
  readonly goalColumn: number | null;
  /** Whether the next single-character insert joins the last undo entry. */
  readonly coalescing: boolean;
}

/** Undo entries kept. Enough for any draft, small enough to stop growing. */
export const HISTORY_LIMIT = 64;

export const EMPTY_EDITOR: EditorState = {
  text: '',
  cursor: 0,
  kill: '',
  history: [],
  goalColumn: null,
  coalescing: false,
};

/** A buffer holding `text`, cursor at the end unless told otherwise. */
export function editorOf(text: string, cursor?: number): EditorState {
  const clean = normalise(text);
  return { ...EMPTY_EDITOR, text: clean, cursor: place(clean, cursor ?? clean.length) };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** The logical lines. Always at least one, even for an empty buffer. */
export function lines(state: EditorState): readonly string[] {
  return state.text.split('\n');
}

export function cursorPosition(state: EditorState): { readonly row: number; readonly col: number } {
  const before = state.text.slice(0, state.cursor);
  const lastBreak = before.lastIndexOf('\n');
  return { row: before.split('\n').length - 1, col: state.cursor - (lastBreak + 1) };
}

export function onFirstLine(state: EditorState): boolean {
  return cursorPosition(state).row === 0;
}

export function onLastLine(state: EditorState): boolean {
  return cursorPosition(state).row === lines(state).length - 1;
}

/**
 * Whether the line the cursor is on ends in a backslash — the shell's own way
 * of saying "there is more coming", which is how Enter can mean "another line"
 * without a key only some terminals can send. A doubled backslash is not an
 * escape here: the rule is the one that can be seen at the end of the line.
 */
export function endsWithContinuation(state: EditorState): boolean {
  const { start, end } = lineRange(state);
  return state.text.slice(start, end).endsWith('\\');
}

/** The character at `col` of `line`, a surrogate pair kept whole, or ''. */
export function cellAt(line: string, col: number): string {
  const code = line.codePointAt(col);
  return code === undefined ? '' : String.fromCodePoint(code);
}

/**
 * The rows to draw so that the cursor's row is one of them.
 *
 * The same rule as the picker's window, for the same reason: derived from the
 * cursor rather than remembered, so a scroll offset held in state cannot
 * disagree with the text after an edit changed how many lines there are. Once
 * the buffer outgrows the box the row is kept roughly centred, which at the end
 * of a growing draft settles into "the cursor sits on the bottom row".
 */
export function editorWindow(
  row: number,
  count: number,
  maxRows: number,
): { readonly top: number; readonly size: number } {
  const size = Math.max(1, Math.min(maxRows, count));
  const top = Math.max(0, Math.min(row - Math.floor(size / 2), count - size));
  return { top, size };
}

/* -------------------------------------------------------------------------- */
/* Moving                                                                     */
/* -------------------------------------------------------------------------- */

export function left(state: EditorState): EditorState {
  return state.cursor === 0 ? state : move(state, stepLeft(state.text, state.cursor));
}

export function right(state: EditorState): EditorState {
  return state.cursor === state.text.length ? state : move(state, stepRight(state.text, state.cursor));
}

export function up(state: EditorState): EditorState {
  return vertical(state, -1);
}

export function down(state: EditorState): EditorState {
  return vertical(state, 1);
}

export function lineStart(state: EditorState): EditorState {
  return move(state, lineRange(state).start);
}

export function lineEnd(state: EditorState): EditorState {
  return move(state, lineRange(state).end);
}

export function bufferStart(state: EditorState): EditorState {
  return move(state, 0);
}

export function bufferEnd(state: EditorState): EditorState {
  return move(state, state.text.length);
}

export function wordLeft(state: EditorState): EditorState {
  return move(state, wordBefore(state.text, state.cursor));
}

export function wordRight(state: EditorState): EditorState {
  return move(state, wordAfter(state.text, state.cursor));
}

/* -------------------------------------------------------------------------- */
/* Editing                                                                    */
/* -------------------------------------------------------------------------- */

export function insert(state: EditorState, input: string): EditorState {
  const text = normalise(input);
  if (text.length === 0) return state;
  const next = state.text.slice(0, state.cursor) + text + state.text.slice(state.cursor);
  const cursor = state.cursor + text.length;
  // One code point typed by hand joins the burst already being recorded; a
  // paste is always its own undo entry, however short it is.
  const single = [...text].length === 1;
  const coalescing = single && !/\s/u.test(text);
  if (single && state.coalescing) return { ...state, text: next, cursor, goalColumn: null, coalescing };
  return { ...edit(state, next, cursor), coalescing };
}

export function newline(state: EditorState): EditorState {
  const next = `${state.text.slice(0, state.cursor)}\n${state.text.slice(state.cursor)}`;
  return edit(state, next, state.cursor + 1);
}

/**
 * Enter on a line that ends in a backslash: the backslash goes, a line opens
 * after it, and the cursor lands on the new line ready to keep typing — no
 * matter where on the line it was when Enter was pressed.
 */
export function continueLine(state: EditorState): EditorState {
  if (!endsWithContinuation(state)) return newline(state);
  const { end } = lineRange(state);
  return edit(state, `${state.text.slice(0, end - 1)}\n${state.text.slice(end)}`, end);
}

export function backspace(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  const from = stepLeft(state.text, state.cursor);
  return edit(state, state.text.slice(0, from) + state.text.slice(state.cursor), from);
}

export function deleteForward(state: EditorState): EditorState {
  if (state.cursor === state.text.length) return state;
  const to = stepRight(state.text, state.cursor);
  return edit(state, state.text.slice(0, state.cursor) + state.text.slice(to), state.cursor);
}

/**
 * Ctrl+W. Back over any spaces, then back to the last whitespace before them,
 * so one press removes a whole path or a whole `--flag=value` rather than the
 * fragment readline's word rules would leave behind. At the start of a line it
 * takes the line break and nothing more, which joins the lines without eating
 * the word above.
 */
export function deleteWordLeft(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  const { start } = lineRange(state);
  if (state.cursor === start) return cut(state, state.cursor - 1, state.cursor);
  let from = state.cursor;
  while (from > start && isBlank(state.text, from - 1)) from -= 1;
  while (from > start && !isBlank(state.text, from - 1)) from -= 1;
  return cut(state, from, state.cursor);
}

/** Alt+D: the word ahead, by readline's reckoning of a word. */
export function deleteWordRight(state: EditorState): EditorState {
  const to = wordAfter(state.text, state.cursor);
  return to === state.cursor ? state : cut(state, state.cursor, to);
}

/**
 * Ctrl+K: the rest of the line. Standing at the end of one, it takes the line
 * break instead, which is how a line gets joined to the one below it.
 */
export function killToLineEnd(state: EditorState): EditorState {
  const { end } = lineRange(state);
  if (state.cursor < end) return cut(state, state.cursor, end);
  if (end < state.text.length) return cut(state, end, end + 1);
  return state;
}

/**
 * Ctrl+U: back to the start of the line — and the whole buffer when already
 * there, which is what this key did when the composer had only one line and is
 * the fastest way to abandon a draft.
 */
export function killToLineStart(state: EditorState): EditorState {
  const { start } = lineRange(state);
  if (state.cursor > start) return cut(state, start, state.cursor);
  if (state.text.length === 0) return state;
  return { ...edit(state, '', 0), kill: state.text };
}

/** Ctrl+Y: put the last kill back at the cursor. The kill survives it. */
export function yank(state: EditorState): EditorState {
  if (state.kill.length === 0) return state;
  const next = state.text.slice(0, state.cursor) + state.kill + state.text.slice(state.cursor);
  return edit(state, next, state.cursor + state.kill.length);
}

/** Ctrl+_: back to the state before the last edit. Moving is not editing. */
export function undo(state: EditorState): EditorState {
  const previous = state.history.at(-1);
  if (previous === undefined) return state;
  return {
    ...EMPTY_EDITOR,
    text: previous.text,
    cursor: place(previous.text, previous.cursor),
    kill: state.kill,
    history: state.history.slice(0, -1),
  };
}

/** Everything replaced — what tab completion does — and undoable. */
export function replaceAll(state: EditorState, text: string): EditorState {
  const clean = normalise(text);
  return edit(state, clean, clean.length);
}

/**
 * Sent: an empty buffer with no history to undo back into a message that has
 * already gone. The kill stays, so Ctrl+Y still reaches the last thing cut.
 */
export function clear(state: EditorState): EditorState {
  return { ...EMPTY_EDITOR, kill: state.kill };
}

/* -------------------------------------------------------------------------- */
/* Inner workings                                                             */
/* -------------------------------------------------------------------------- */

/** Letters and digits, as readline counts a word. */
const WORD = /[\p{L}\p{N}]/u;

/** Every control character the buffer refuses, tab and line feed excepted. */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/gu;

/**
 * Line endings folded to `\n`, and every other control character dropped: a
 * paste can carry a `\r`, a form feed or an escape, none of which the buffer
 * can hold without lying about how many lines it has or about what a row looks
 * like. Tabs survive, because a tab is text someone meant to paste.
 */
function normalise(text: string): string {
  return text.replace(/\r\n?/gu, '\n').replace(CONTROL, '');
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

/** An offset inside `text`, nudged off the tail of a surrogate pair. */
function place(text: string, index: number): number {
  const at = clamp(index, 0, text.length);
  const code = text.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff ? at - 1 : at;
}

function stepLeft(text: string, index: number): number {
  const previous = text.charCodeAt(index - 1);
  return previous >= 0xdc00 && previous <= 0xdfff ? Math.max(0, index - 2) : index - 1;
}

function stepRight(text: string, index: number): number {
  const code = text.codePointAt(index);
  return index + (code !== undefined && code > 0xffff ? 2 : 1);
}

/** Where the cursor's line begins and ends, the break itself excluded. */
function lineRange(state: EditorState): { readonly start: number; readonly end: number } {
  const start = state.cursor === 0 ? 0 : state.text.lastIndexOf('\n', state.cursor - 1) + 1;
  const end = state.text.indexOf('\n', state.cursor);
  return { start, end: end === -1 ? state.text.length : end };
}

/** The offset row `row` begins at, clamped to the last line. */
function rowStart(text: string, row: number): number {
  let offset = 0;
  for (let step = 0; step < row; step += 1) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return offset;
    offset = next + 1;
  }
  return offset;
}

function isWord(text: string, index: number): boolean {
  const char = text[index];
  return char !== undefined && WORD.test(char);
}

/** Whitespace that is not a line break: Ctrl+W's measure. */
function isBlank(text: string, index: number): boolean {
  const char = text[index];
  return char !== undefined && char !== '\n' && /\s/u.test(char);
}

function wordAfter(text: string, cursor: number): number {
  let index = cursor;
  while (index < text.length && !isWord(text, index)) index += 1;
  while (index < text.length && isWord(text, index)) index += 1;
  return index;
}

function wordBefore(text: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && !isWord(text, index - 1)) index -= 1;
  while (index > 0 && isWord(text, index - 1)) index -= 1;
  return index;
}

/** A cursor somewhere else. Not an edit, so nothing is remembered. */
function move(state: EditorState, cursor: number): EditorState {
  return { ...state, cursor: place(state.text, cursor), goalColumn: null, coalescing: false };
}

function vertical(state: EditorState, step: -1 | 1): EditorState {
  const rows = lines(state);
  const { row, col } = cursorPosition(state);
  const target = row + step;
  if (target < 0 || target >= rows.length) return state;
  const goal = state.goalColumn ?? col;
  const line = rows[target] ?? '';
  const cursor = place(state.text, rowStart(state.text, target) + Math.min(goal, line.length));
  return { ...state, cursor, goalColumn: goal, coalescing: false };
}

/** A new text, the old one remembered so undo can get back to it. */
function edit(state: EditorState, text: string, cursor: number): EditorState {
  const history = [...state.history, { text: state.text, cursor: state.cursor }];
  return {
    text,
    cursor: place(text, cursor),
    kill: state.kill,
    history: history.length > HISTORY_LIMIT ? history.slice(history.length - HISTORY_LIMIT) : history,
    goalColumn: null,
    coalescing: false,
  };
}

/** An edit that fills the kill ring: everything Ctrl+Y can put back. */
function cut(state: EditorState, from: number, to: number): EditorState {
  return {
    ...edit(state, state.text.slice(0, from) + state.text.slice(to), from),
    kill: state.text.slice(from, to),
  };
}
