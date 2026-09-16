import { describe, expect, it } from 'vitest';

import {
  EMPTY_EDITOR,
  HISTORY_LIMIT,
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
  editorOf,
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
  type EditorState,
} from './editor.js';

/*
 * A buffer is written with `|` where the cursor is, and read back the same way,
 * so a failure reads as the text someone would have been looking at rather than
 * as a pair of offsets.
 */
const buffer = (marked: string): EditorState => editorOf(marked.replace('|', ''), marked.indexOf('|'));
const shown = (state: EditorState): string => `${state.text.slice(0, state.cursor)}|${state.text.slice(state.cursor)}`;

/** Typed by hand, one character at a time — which is what undo coalesces. */
const type = (state: EditorState, text: string): EditorState =>
  [...text].reduce((next, char) => insert(next, char), state);

describe('reading the buffer', () => {
  it('always has at least one line', () => {
    expect(lines(EMPTY_EDITOR)).toEqual(['']);
    expect(lines(editorOf('a\nb'))).toEqual(['a', 'b']);
    expect(lines(editorOf('a\n'))).toEqual(['a', '']);
  });

  it('turns the offset into a row and a column', () => {
    expect(cursorPosition(buffer('|'))).toEqual({ row: 0, col: 0 });
    expect(cursorPosition(buffer('ab|c'))).toEqual({ row: 0, col: 2 });
    expect(cursorPosition(buffer('ab|\ncd'))).toEqual({ row: 0, col: 2 });
    expect(cursorPosition(buffer('ab\n|cd'))).toEqual({ row: 1, col: 0 });
    expect(cursorPosition(buffer('ab\ncd|'))).toEqual({ row: 1, col: 2 });
  });

  it('knows which line it is on, and an empty buffer is on both', () => {
    expect(onFirstLine(EMPTY_EDITOR)).toBe(true);
    expect(onLastLine(EMPTY_EDITOR)).toBe(true);
    expect(onFirstLine(buffer('a|b'))).toBe(true);
    expect(onLastLine(buffer('a|b'))).toBe(true);
    expect(onFirstLine(buffer('a|\nb'))).toBe(true);
    expect(onLastLine(buffer('a|\nb'))).toBe(false);
    expect(onFirstLine(buffer('a\n|b'))).toBe(false);
    expect(onLastLine(buffer('a\n|b'))).toBe(true);
  });

  it('sees a trailing backslash on the line the cursor is on, and only there', () => {
    expect(endsWithContinuation(buffer('foo \\|'))).toBe(true);
    expect(endsWithContinuation(buffer('fo|o \\'))).toBe(true);
    expect(endsWithContinuation(buffer('foo|'))).toBe(false);
    expect(endsWithContinuation(buffer('one \\\n|two'))).toBe(false);
    expect(endsWithContinuation(buffer('one\ntwo \\|'))).toBe(true);
  });

  it('reads the cell under the cursor, a surrogate pair kept whole', () => {
    expect(cellAt('abc', 1)).toBe('b');
    expect(cellAt('abc', 3)).toBe('');
    expect(cellAt('a😀', 1)).toBe('😀');
  });
});

describe('editorWindow', () => {
  it('shows every line while they fit', () => {
    expect(editorWindow(0, 1, 8)).toEqual({ top: 0, size: 1 });
    expect(editorWindow(3, 4, 8)).toEqual({ top: 0, size: 4 });
  });

  it('keeps the cursor row in view once the text outgrows the box', () => {
    expect(editorWindow(0, 10, 8)).toEqual({ top: 0, size: 8 });
    expect(editorWindow(5, 10, 8)).toEqual({ top: 1, size: 8 });
    // At the end of a growing draft the cursor settles on the bottom row.
    expect(editorWindow(9, 10, 8)).toEqual({ top: 2, size: 8 });
  });

  it('survives a count of nothing', () => {
    expect(editorWindow(0, 0, 8)).toEqual({ top: 0, size: 1 });
  });
});

describe('inserting', () => {
  it('puts text in at the cursor', () => {
    expect(shown(insert(buffer('ac|'), 'b'))).toBe('acb|');
    expect(shown(insert(buffer('a|c'), 'b'))).toBe('ab|c');
    expect(shown(insert(EMPTY_EDITOR, 'hello'))).toBe('hello|');
  });

  it('folds line endings and drops the control characters a paste can carry', () => {
    expect(insert(EMPTY_EDITOR, 'a\r\nb\rc').text).toBe('a\nb\nc');
    expect(insert(EMPTY_EDITOR, 'a\u0007b\u001Bc').text).toBe('abc');
    expect(insert(EMPTY_EDITOR, 'a\tb').text).toBe('a\tb');
  });

  it('is a no-op when there is nothing left to insert', () => {
    const state = buffer('a|');
    expect(insert(state, '')).toBe(state);
    expect(insert(state, '\u0007')).toBe(state);
  });
});

describe('moving', () => {
  it('goes left and right, and stops at the ends', () => {
    expect(shown(left(buffer('ab|c')))).toBe('a|bc');
    expect(shown(right(buffer('ab|c')))).toBe('abc|');
    const start = buffer('|abc');
    const end = buffer('abc|');
    expect(left(start)).toBe(start);
    expect(right(end)).toBe(end);
  });

  it('crosses a line break one step at a time', () => {
    expect(shown(left(buffer('a\n|b')))).toBe('a|\nb');
    expect(shown(right(buffer('a|\nb')))).toBe('a\n|b');
  });

  it('steps over a surrogate pair rather than into it', () => {
    expect(shown(left(buffer('a😀|b')))).toBe('a|😀b');
    expect(shown(right(buffer('a|😀b')))).toBe('a😀|b');
  });

  it('goes to the start and end of the line the cursor is on', () => {
    expect(shown(lineStart(buffer('one\ntw|o\nthree')))).toBe('one\n|two\nthree');
    expect(shown(lineEnd(buffer('one\ntw|o\nthree')))).toBe('one\ntwo|\nthree');
    expect(shown(lineStart(buffer('one\n|two')))).toBe('one\n|two');
  });

  it('goes to the start and end of the whole buffer', () => {
    expect(shown(bufferStart(buffer('one\ntw|o')))).toBe('|one\ntwo');
    expect(shown(bufferEnd(buffer('one\ntw|o')))).toBe('one\ntwo|');
  });
});

describe('moving by line', () => {
  it('keeps the column, and keeps aiming for it through a short line', () => {
    const start = buffer('hell|o\nhi\nworld');
    const middle = down(start);
    expect(shown(middle)).toBe('hello\nhi|\nworld');
    expect(shown(down(middle))).toBe('hello\nhi\nworl|d');
  });

  it('forgets the column it was aiming for as soon as anything else moves', () => {
    const wandered = left(down(buffer('hell|o\nhi\nworld')));
    expect(shown(wandered)).toBe('hello\nh|i\nworld');
    expect(shown(down(wandered))).toBe('hello\nhi\nw|orld');
  });

  it('comes back up to the same column', () => {
    expect(shown(up(buffer('hello\nwor|ld')))).toBe('hel|lo\nworld');
  });

  it('does nothing at the top and at the bottom, which is the overflow signal', () => {
    const first = buffer('hel|lo\nworld');
    const last = buffer('hello\nwor|ld');
    expect(up(first)).toBe(first);
    expect(down(last)).toBe(last);
    expect(up(EMPTY_EDITOR)).toBe(EMPTY_EDITOR);
    expect(down(EMPTY_EDITOR)).toBe(EMPTY_EDITOR);
  });

  it('never lands inside a surrogate pair', () => {
    // Column 1 of the line below is the middle of the emoji; the cursor stops
    // in front of it rather than between its halves.
    expect(shown(down(buffer('a|bc\n😀x')))).toBe('abc\n|😀x');
  });
});

describe('moving by word', () => {
  it('walks forward to the end of the next word', () => {
    expect(shown(wordRight(buffer('|foo, bar')))).toBe('foo|, bar');
    expect(shown(wordRight(buffer('foo|, bar')))).toBe('foo, bar|');
    expect(shown(wordRight(buffer('fo|o bar')))).toBe('foo| bar');
    expect(shown(wordRight(buffer('foo bar|')))).toBe('foo bar|');
  });

  it('walks back to the start of the word behind it', () => {
    expect(shown(wordLeft(buffer('foo, bar|')))).toBe('foo, |bar');
    expect(shown(wordLeft(buffer('foo, |bar')))).toBe('|foo, bar');
    expect(shown(wordLeft(buffer('fo|o bar')))).toBe('|foo bar');
    expect(shown(wordLeft(buffer('|foo')))).toBe('|foo');
  });

  it('treats punctuation as readline does, so a flag is several words', () => {
    expect(shown(wordRight(buffer('|--flag=value')))).toBe('--flag|=value');
    expect(shown(wordRight(buffer('--flag|=value')))).toBe('--flag=value|');
    expect(shown(wordLeft(buffer('--flag=value|')))).toBe('--flag=|value');
  });

  it('crosses a line break, which is just another non-word character', () => {
    expect(shown(wordRight(buffer('foo|\nbar')))).toBe('foo\nbar|');
    expect(shown(wordLeft(buffer('foo\n|bar')))).toBe('|foo\nbar');
  });
});

describe('backspace and delete', () => {
  it('takes the character behind the cursor', () => {
    expect(shown(backspace(buffer('ab|c')))).toBe('a|c');
    const start = buffer('|abc');
    expect(backspace(start)).toBe(start);
  });

  it('takes the character ahead of the cursor', () => {
    expect(shown(deleteForward(buffer('ab|c')))).toBe('ab|');
    const end = buffer('abc|');
    expect(deleteForward(end)).toBe(end);
  });

  it('joins lines when it takes a line break', () => {
    expect(shown(backspace(buffer('a\n|b')))).toBe('a|b');
    expect(shown(deleteForward(buffer('a|\nb')))).toBe('a|b');
  });

  it('takes an emoji whole, from either side', () => {
    expect(shown(backspace(buffer('a😀|b')))).toBe('a|b');
    expect(shown(deleteForward(buffer('a|😀b')))).toBe('a|b');
  });
});

describe('Ctrl+W, back to whitespace', () => {
  it('removes a whole path in one press', () => {
    const cut = deleteWordLeft(buffer('see /usr/local/bin/node|'));
    expect(shown(cut)).toBe('see |');
    expect(cut.kill).toBe('/usr/local/bin/node');
  });

  it('removes a whole flag and its value in one press', () => {
    expect(shown(deleteWordLeft(buffer('run --flag=value|')))).toBe('run |');
  });

  it('steps back over trailing spaces first', () => {
    expect(shown(deleteWordLeft(buffer('foo bar   |')))).toBe('foo |');
  });

  it('never crosses a line: it clears the indent, then takes the break alone', () => {
    const word = deleteWordLeft(buffer('foo\n  bar|'));
    expect(shown(word)).toBe('foo\n  |');
    const indent = deleteWordLeft(word);
    expect(shown(indent)).toBe('foo\n|');
    const join = deleteWordLeft(indent);
    expect(shown(join)).toBe('foo|');
    expect(join.kill).toBe('\n');
  });

  it('does nothing at the start of the buffer', () => {
    const start = buffer('|foo');
    expect(deleteWordLeft(start)).toBe(start);
  });
});

describe('Alt+D, the word ahead', () => {
  it('takes the next word and puts it in the kill', () => {
    const first = deleteWordRight(buffer('|foo, bar'));
    expect(shown(first)).toBe('|, bar');
    expect(first.kill).toBe('foo');
    const second = deleteWordRight(first);
    expect(shown(second)).toBe('|');
    expect(second.kill).toBe(', bar');
  });

  it('does nothing at the end of the buffer', () => {
    const end = buffer('foo|');
    expect(deleteWordRight(end)).toBe(end);
  });
});

describe('Ctrl+K, to the end of the line', () => {
  it('takes the rest of the line', () => {
    const killed = killToLineEnd(buffer('foo |bar\nbaz'));
    expect(shown(killed)).toBe('foo |\nbaz');
    expect(killed.kill).toBe('bar');
  });

  it('takes the line break when there is nothing else left on the line', () => {
    const joined = killToLineEnd(buffer('foo|\nbaz'));
    expect(shown(joined)).toBe('foo|baz');
    expect(joined.kill).toBe('\n');
  });

  it('does nothing at the end of the buffer', () => {
    const end = buffer('foo|');
    expect(killToLineEnd(end)).toBe(end);
  });
});

describe('Ctrl+U, to the start of the line', () => {
  it('takes the line so far', () => {
    const killed = killToLineStart(buffer('foo\nbar baz|'));
    expect(shown(killed)).toBe('foo\n|');
    expect(killed.kill).toBe('bar baz');
  });

  it('takes the whole buffer when already at the start of the line', () => {
    const killed = killToLineStart(buffer('foo\n|bar'));
    expect(shown(killed)).toBe('|');
    expect(killed.kill).toBe('foo\nbar');
  });

  it('does nothing to an empty buffer', () => {
    expect(killToLineStart(EMPTY_EDITOR)).toBe(EMPTY_EDITOR);
  });
});

describe('Ctrl+Y, the last kill back', () => {
  it('round-trips a kill to the end of the line', () => {
    const killed = killToLineEnd(buffer('hello |world'));
    expect(shown(yank(killed))).toBe('hello world|');
  });

  it('puts it wherever the cursor is now, and keeps it for a second press', () => {
    const moved = bufferStart(killToLineEnd(buffer('hello |world')));
    const once = yank(moved);
    expect(shown(once)).toBe('world|hello ');
    expect(shown(yank(once))).toBe('worldworld|hello ');
  });

  it('does nothing when nothing has been killed', () => {
    const state = buffer('foo|');
    expect(yank(state)).toBe(state);
  });
});

describe('newlines', () => {
  it('splits the line at the cursor', () => {
    expect(shown(newline(buffer('foo|bar')))).toBe('foo\n|bar');
  });

  it('drops the trailing backslash and opens the next line', () => {
    expect(shown(continueLine(buffer('foo \\|')))).toBe('foo \n|');
  });

  it('continues from wherever the cursor is on the line', () => {
    expect(shown(continueLine(buffer('fo|o\\')))).toBe('foo\n|');
  });

  it('is an ordinary newline when the line does not end in a backslash', () => {
    expect(shown(continueLine(buffer('foo|bar')))).toBe('foo\n|bar');
  });
});

describe('undo', () => {
  it('takes back one edit', () => {
    const state = insert(buffer('foo|'), '!');
    expect(shown(undo(state))).toBe('foo|');
  });

  it('takes back a word-ish burst of typing, whitespace breaking the bursts', () => {
    const typed = type(EMPTY_EDITOR, 'hello world');
    expect(shown(typed)).toBe('hello world|');
    const once = undo(typed);
    expect(shown(once)).toBe('hello |');
    expect(shown(undo(once))).toBe('|');
  });

  it('breaks the burst when the cursor moves', () => {
    const typed = insert(left(type(EMPTY_EDITOR, 'abc')), 'X');
    expect(shown(typed)).toBe('abX|c');
    expect(shown(undo(typed))).toBe('ab|c');
  });

  it('keeps a paste as one entry of its own', () => {
    const pasted = insert(insert(EMPTY_EDITOR, 'hello'), '!');
    expect(shown(undo(pasted))).toBe('hello|');
    expect(shown(undo(undo(pasted)))).toBe('|');
  });

  it('takes back a kill, the kill ring untouched', () => {
    const killed = killToLineStart(buffer('draft|'));
    const back = undo(killed);
    expect(shown(back)).toBe('draft|');
    expect(back.kill).toBe('draft');
  });

  it('does nothing when there is nothing to take back', () => {
    expect(undo(EMPTY_EDITOR)).toBe(EMPTY_EDITOR);
    // A buffer opened on text that was never typed here has nothing behind it.
    const opened = editorOf('typed before');
    expect(undo(opened)).toBe(opened);
  });

  it('stops remembering past the limit', () => {
    let state = EMPTY_EDITOR;
    for (let step = 0; step < HISTORY_LIMIT + 10; step += 1) state = newline(state);
    expect(state.history).toHaveLength(HISTORY_LIMIT);
    for (let step = 0; step < HISTORY_LIMIT; step += 1) state = undo(state);
    expect(state.history).toHaveLength(0);
    expect(lines(state)).toHaveLength(11);
  });
});

describe('replacing and clearing', () => {
  it('replaces everything and can be taken back', () => {
    const completed = replaceAll(buffer('/pro|'), '/profile ');
    expect(shown(completed)).toBe('/profile |');
    expect(shown(undo(completed))).toBe('/pro|');
  });

  it('empties the buffer on submit but keeps the last kill', () => {
    const cleared = clear(killToLineStart(buffer('sent|')));
    expect(shown(cleared)).toBe('|');
    expect(cleared.history).toHaveLength(0);
    expect(cleared.kill).toBe('sent');
  });
});

describe('editorOf', () => {
  it('opens at the end unless told otherwise, and never inside a pair', () => {
    expect(shown(editorOf('abc'))).toBe('abc|');
    expect(shown(editorOf('abc', 1))).toBe('a|bc');
    expect(shown(editorOf('a😀b', 2))).toBe('a|😀b');
    expect(shown(editorOf('abc', 99))).toBe('abc|');
    expect(shown(editorOf('abc', -5))).toBe('|abc');
  });

  it('normalises what it is given', () => {
    expect(editorOf('a\r\nb').text).toBe('a\nb');
  });
});
