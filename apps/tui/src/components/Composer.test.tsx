import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import { COMMANDS } from '../commands.js';
import type { HistoryScope } from '../history.js';
import {
  Composer,
  type ComposerClipboard,
  type ComposerHandle,
  type FileIndex,
  type HistoryLookup,
  type PastedImage,
} from './Composer.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/*
 * The bytes a terminal sends, named. Everything here goes through Ink's own
 * key parsing, so a test that passes is a test of the keys someone will really
 * press rather than of a hand-made `key` object.
 */
const ENTER = '\r';
const CTRL_J = '\n';
const SHIFT_ENTER = '\u001B[13;2u'; // Only a terminal that reports modifiers sends this.
const UP = '\u001B[A';
const DOWN = '\u001B[B';
const LEFT = '\u001B[D';
const CTRL_A = '\u0001';
const CTRL_K = '\u000B';
const CTRL_U = '\u0015';
const CTRL_W = '\u0017';
const CTRL_Y = '\u0019';
const CTRL_UNDERSCORE = '\u001F';
const ALT_B = '\u001Bb';
const ALT_D = '\u001Bd';
const HOME = '\u001B[H';
const END = '\u001B[F';
const TAB = '\t';

const PLACEHOLDER = 'message, or / for commands';

/** A frame's lines, so "on its own row" can be asserted. */
const rowsOf = (frame: string | undefined): readonly string[] => (frame ?? '').split('\n');
const rowWith = (frame: string | undefined, text: string): number =>
  rowsOf(frame).findIndex((line) => line.includes(text));

const composer = (props: Partial<Parameters<typeof Composer>[0]> = {}) =>
  render(<Composer onSubmit={() => undefined} live={false} locked={false} {...props} />);

/** Keystrokes in order, a tick apart, as Ink delivers them. */
const press = async (stdin: { write: (data: string) => void }, ...keys: readonly string[]): Promise<void> => {
  for (const key of keys) {
    stdin.write(key);
    await tick();
  }
};

describe('Composer', () => {
  it('offers the placeholder until something is typed', async () => {
    const { lastFrame } = composer();
    await tick();
    expect(lastFrame()).toContain(PLACEHOLDER);
  });

  it('shows what is typed, and the cursor sits where the next character goes', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, 'h', 'i');
    expect(lastFrame()).toContain('hi');
    expect(lastFrame()).not.toContain(PLACEHOLDER);
    // The cursor is drawn, not remembered: moving it and typing proves where
    // it was, which a stripped-of-colour frame cannot show directly.
    await press(stdin, LEFT, 'X');
    expect(lastFrame()).toContain('hXi');
  });

  it('Ctrl+J opens a second row, and so does Shift+Enter where a terminal sends it', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit });
    await tick();
    await press(stdin, 'alpha', CTRL_J, 'beta');
    const alpha = rowWith(lastFrame(), 'alpha');
    const beta = rowWith(lastFrame(), 'beta');
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(beta).toBe(alpha + 1);
    expect(onSubmit).not.toHaveBeenCalled();

    await press(stdin, SHIFT_ENTER, 'gamma');
    expect(rowWith(lastFrame(), 'gamma')).toBe(beta + 1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('says how to get a newline once there is more than one line', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    expect(lastFrame()).not.toContain('Ctrl+J for a newline');
    await press(stdin, 'one', CTRL_J);
    expect(lastFrame()).toContain('Shift+Enter or Ctrl+J for a newline · Enter sends');
  });

  it('a line ending in a backslash continues instead of sending', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit });
    await tick();
    await press(stdin, 'note \\', ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Ctrl+J for a newline');
    expect(lastFrame()).not.toContain('note \\');
    expect(lastFrame()).toContain('note');
  });

  it('Enter sends every line as one message and leaves the box empty', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit });
    await tick();
    await press(stdin, 'alpha', CTRL_J, 'beta', ENTER);
    expect(onSubmit).toHaveBeenCalledWith('alpha\nbeta', []);
    expect(lastFrame()).toContain(PLACEHOLDER);
    expect(lastFrame()).not.toContain('alpha');
  });

  it('will not send an empty message', async () => {
    const onSubmit = vi.fn();
    const { stdin } = composer({ onSubmit });
    await tick();
    await press(stdin, '   ', ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Ctrl+W takes a whole path in one press', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, 'see /usr/local/bin/node', CTRL_W);
    expect(lastFrame()).toContain('see');
    expect(lastFrame()).not.toContain('/usr/local/bin/node');
  });

  it('Ctrl+K, Ctrl+U and Ctrl+Y round-trip a line', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, 'hello world', CTRL_A, CTRL_K);
    expect(lastFrame()).toContain(PLACEHOLDER);
    await press(stdin, CTRL_Y);
    expect(lastFrame()).toContain('hello world');
    await press(stdin, CTRL_U);
    expect(lastFrame()).toContain(PLACEHOLDER);
    await press(stdin, CTRL_Y);
    expect(lastFrame()).toContain('hello world');
  });

  it('Alt+B and Alt+D move and delete by word', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, 'alpha beta', ALT_B, ALT_D);
    expect(lastFrame()).toContain('alpha');
    expect(lastFrame()).not.toContain('beta');
    await press(stdin, ALT_B, 'X');
    expect(lastFrame()).toContain('Xalpha');
  });

  it('Home and End reach the ends of the line', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, 'alpha beta', HOME, 'X');
    expect(lastFrame()).toContain('Xalpha beta');
    await press(stdin, END, 'Y');
    expect(lastFrame()).toContain('Xalpha betaY');
  });

  it('Ctrl+_ takes back the last edit', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, 'a', 'b', 'c');
    expect(lastFrame()).toContain('abc');
    await press(stdin, CTRL_U);
    expect(lastFrame()).toContain(PLACEHOLDER);
    await press(stdin, CTRL_UNDERSCORE);
    expect(lastFrame()).toContain('abc');
  });

  it('hands ↑ on the first line and ↓ on the last back to the app', async () => {
    const onArrowOverflow = vi.fn();
    const { stdin } = composer({ onArrowOverflow });
    await tick();
    await press(stdin, 'one line');
    await press(stdin, UP);
    expect(onArrowOverflow).toHaveBeenLastCalledWith('up');
    await press(stdin, DOWN);
    expect(onArrowOverflow).toHaveBeenLastCalledWith('down');
    expect(onArrowOverflow).toHaveBeenCalledTimes(2);
  });

  it('keeps ↑ for itself while there is a line above to move to', async () => {
    const onArrowOverflow = vi.fn();
    const { stdin } = composer({ onArrowOverflow });
    await tick();
    await press(stdin, 'alpha', CTRL_J, 'beta');
    await press(stdin, UP);
    expect(onArrowOverflow).not.toHaveBeenCalled();
    // Now on the first line, so the next press is the app's.
    await press(stdin, UP);
    expect(onArrowOverflow).toHaveBeenCalledWith('up');
  });

  it('takes a paste whole, one trailing newline dropped, and does not send it', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit });
    await tick();
    await press(stdin, 'one\r\ntwo\n');
    expect(onSubmit).not.toHaveBeenCalled();
    const one = rowWith(lastFrame(), 'one');
    expect(rowWith(lastFrame(), 'two')).toBe(one + 1);
    await press(stdin, ENTER);
    expect(onSubmit).toHaveBeenCalledWith('one\ntwo', []);
  });

  it('clips at eight rows and counts what is out of sight', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, 'r01\nr02\nr03\nr04\nr05\nr06\nr07\nr08\nr09\nr10');
    expect(lastFrame()).toContain('↑ 2 more');
    expect(lastFrame()).toContain('r10');
    expect(lastFrame()).not.toContain('r01');
    expect(lastFrame()).not.toContain('r02');

    // Walking back up brings the top into view and the bottom out of it.
    await press(stdin, UP, UP, UP, UP, UP);
    expect(lastFrame()).toContain('r01');
    expect(lastFrame()).toContain('↓ 2 more');
    expect(lastFrame()).not.toContain('↑');
    expect(lastFrame()).not.toContain('r10');
  });

  it('touches nothing while it is not the focus', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit, isActive: false });
    await tick();
    await press(stdin, 'ignored', ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain(PLACEHOLDER);
  });
});

/*
 * The slash menu.
 *
 * The rule these tests hold to is the one people already know from Claude Code:
 * a row is highlighted only when what was typed really is the start of a
 * command's name, an alias, or a word inside one — and Enter runs the
 * highlighted row. When nothing is highlighted Enter means what it has always
 * meant, so a mistyped command reaches the agent as the text it is.
 */
describe('Composer: the slash menu', () => {
  const MENU_HINT = '↑↓ move · Tab complete · Enter run';
  const marked = (frame: string | undefined): readonly string[] =>
    rowsOf(frame).filter((line) => line.includes('❯'));

  it('offers what a half-typed command could mean, the first row highlighted', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, '/mo');
    const model = rowWith(lastFrame(), '/model');
    expect(model).toBeGreaterThan(0);
    expect(rowsOf(lastFrame())[model]).toContain('❯');
    expect(rowsOf(lastFrame())[model + 1]).toContain('/mode');
    expect(rowsOf(lastFrame())[model + 1]).not.toContain('❯');
    expect(lastFrame()).toContain(MENU_HINT);
  });

  it('↓ moves the highlight, and Tab fills in the row it is on', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, '/mo', DOWN);
    const model = rowWith(lastFrame(), '/model');
    expect(rowsOf(lastFrame())[model]).not.toContain('❯');
    expect(rowsOf(lastFrame())[model + 1]).toContain('❯');

    await press(stdin, TAB);
    // Completed, with the space that ends the command word — so the menu has
    // closed and what is left is a command waiting for its arguments.
    expect(lastFrame()).toContain('/mode');
    expect(lastFrame()).not.toContain('/model');
    expect(lastFrame()).not.toContain(MENU_HINT);
  });

  it('Enter runs the highlighted row, as if its name had been typed out', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit });
    await tick();
    await press(stdin, '/mo', DOWN, ENTER);
    expect(onSubmit).toHaveBeenCalledWith('/mode', []);
    expect(lastFrame()).toContain(PLACEHOLDER);
  });

  it('highlights nothing for a typo, and sends it as typed', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit });
    await tick();
    await press(stdin, '/mdoel');
    // The only `❯` in the frame is the composer's own prompt.
    expect(marked(lastFrame())).toHaveLength(1);
    expect(lastFrame()).not.toContain(MENU_HINT);
    await press(stdin, ENTER);
    expect(onSubmit).toHaveBeenCalledWith('/mdoel', []);
  });

  it('finds a command by an alias and runs it under its real name', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit });
    await tick();
    await press(stdin, '/exit');
    const quit = rowWith(lastFrame(), '/quit');
    expect(quit).toBeGreaterThan(0);
    expect(rowsOf(lastFrame())[quit]).toContain('❯');
    await press(stdin, ENTER);
    expect(onSubmit).toHaveBeenCalledWith('/quit', []);
  });

  it('offers a bridged skill by the word someone would look for', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({
      onSubmit,
      providerCommands: ['artemis-skills:code-review', 'compact'],
    });
    await tick();
    await press(stdin, '/review');
    expect(lastFrame()).toContain('/artemis-skills:code-review');
    expect(lastFrame()).toContain('skill');
    expect(lastFrame()).not.toContain('/compact');
    // Fully qualified, which is the only form the provider will answer to.
    await press(stdin, ENTER);
    expect(onSubmit).toHaveBeenCalledWith('/artemis-skills:code-review', []);
  });

  it('keeps ↑ while the menu is open, and hands it back once it closes', async () => {
    const onArrowOverflow = vi.fn();
    const { lastFrame, stdin } = composer({ onArrowOverflow });
    await tick();
    await press(stdin, '/mo', UP);
    // ↑ on the first row wraps to the last rather than scrolling the
    // conversation out from under a menu someone is reading.
    expect(onArrowOverflow).not.toHaveBeenCalled();
    const model = rowWith(lastFrame(), '/model');
    expect(rowsOf(lastFrame())[model + 1]).toContain('❯');

    // A space ends the command word, the menu closes, and the arrow is the
    // app's again.
    await press(stdin, ' ', UP);
    expect(onArrowOverflow).toHaveBeenCalledWith('up');
  });

  it('a lone slash is the whole menu, clipped and counted', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, '/');
    const profile = rowWith(lastFrame(), '/profile');
    expect(rowsOf(lastFrame())[profile]).toContain('❯');
    // The menu shows eight rows; whatever the command table grows to, the rest is counted.
    expect(lastFrame()).toContain(`↓ ${String(COMMANDS.length - 8)} more`);
  });
});

/*
 * What was typed coming back: the queue, the history, and the reverse search.
 *
 * The history here is an object, not a file. `PromptHistory` is tested where it
 * lives, over a real directory; what these tests are about is which key reaches
 * for it and what lands in the box, so the lists are written out and every
 * assertion is a frame or a submission.
 */
const CTRL_R = '\u0012';
const CTRL_S = '\u0013';
const ESC = '\u001B';
const RIGHT = '\u001B[C';
const BACKSPACE = '\u007F';

const FOLDER: HistoryScope = { kind: 'folder', cwd: '/w' };
const SCOPES: readonly HistoryScope[] = [FOLDER, { kind: 'all' }];

/*
 * A lone Esc is held back by Ink for a moment, in case it turns out to be the
 * first byte of a sequence, so it needs longer than a press that is delivered
 * the instant it is written.
 */
const pressEscape = async (stdin: { write: (data: string) => void }): Promise<void> => {
  await press(stdin, ESC);
  await tick();
};

/** A history that is nothing but lists — newest first, one per scope kind. */
const fakeHistory = (lists: Partial<Record<HistoryScope['kind'], readonly string[]>>): HistoryLookup => ({
  recent: (scope) => lists[scope.kind] ?? [],
  search: (query, scope, limit) => {
    const needle = query.toLowerCase();
    const found = (lists[scope.kind] ?? [])
      .filter((text) => text.toLowerCase().includes(needle))
      .map((text) => ({ text, cwd: '/w', ts: 0, index: text.toLowerCase().indexOf(needle) }));
    return limit === undefined ? found : found.slice(0, limit);
  },
});

describe('Composer: what was typed comes back', () => {
  it('↑ on an empty box takes the newest queued message back', async () => {
    const onTakeBackQueued = vi.fn<() => string | undefined>(() => 'also check the migration script');
    const onArrowOverflow = vi.fn();
    const { lastFrame, stdin } = composer({
      onTakeBackQueued,
      onArrowOverflow,
      history: fakeHistory({ all: ['a remembered prompt'] }),
    });
    await tick();
    await press(stdin, UP);
    expect(onTakeBackQueued).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain('also check the migration script');
    // The queue wins over both of the other things ↑ could have meant.
    expect(lastFrame()).not.toContain('a remembered prompt');
    expect(onArrowOverflow).not.toHaveBeenCalled();
  });

  it('asks the queue only while the box is empty, so ↑ on a draft is the history', async () => {
    const onTakeBackQueued = vi.fn<() => string | undefined>(() => 'queued words');
    const { lastFrame, stdin } = composer({
      onTakeBackQueued,
      history: fakeHistory({ all: ['a remembered prompt'] }),
    });
    await tick();
    await press(stdin, 'half typed', UP);
    expect(onTakeBackQueued).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('a remembered prompt');
  });

  it('↑ walks back through the history and ↓ walks forward to the draft', async () => {
    const { lastFrame, stdin } = composer({ history: fakeHistory({ all: ['newest prompt', 'older prompt'] }) });
    await tick();
    await press(stdin, 'half typed');

    await press(stdin, UP);
    expect(lastFrame()).toContain('newest prompt');
    expect(lastFrame()).toContain('history 1/2 · ↓ back to draft');

    await press(stdin, UP);
    expect(lastFrame()).toContain('older prompt');
    expect(lastFrame()).toContain('history 2/2');

    // The oldest is where it stops rather than wrapping round to the newest.
    await press(stdin, UP);
    expect(lastFrame()).toContain('older prompt');

    await press(stdin, DOWN);
    expect(lastFrame()).toContain('newest prompt');
    await press(stdin, DOWN);
    expect(lastFrame()).toContain('half typed');
    expect(lastFrame()).not.toContain('history 1/2');
  });

  it('an edit ends the walk, and the next ↑ starts a new one from what is typed now', async () => {
    const { lastFrame, stdin } = composer({ history: fakeHistory({ all: ['a remembered prompt'] }) });
    await tick();
    await press(stdin, UP);
    expect(lastFrame()).toContain('history 1/1');

    await press(stdin, '!');
    expect(lastFrame()).not.toContain('history 1/1');

    // A fresh walk, whose draft is the edited text — which is what ↓ returns.
    await press(stdin, UP);
    expect(lastFrame()).toContain('history 1/1');
    await press(stdin, DOWN);
    expect(lastFrame()).toContain('a remembered prompt!');
  });

  it('a remembered prompt of several lines lands whole', async () => {
    const { lastFrame, stdin } = composer({ history: fakeHistory({ all: ['first line\nsecond line'] }) });
    await tick();
    await press(stdin, UP);
    const first = rowWith(lastFrame(), 'first line');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(rowWith(lastFrame(), 'second line')).toBe(first + 1);
  });

  it('prefers the prompts typed in this folder, and falls through when there are none', async () => {
    const here = composer({
      history: fakeHistory({ folder: ['typed here'], all: ['typed anywhere', 'typed here'] }),
      historyScopes: SCOPES,
    });
    await tick();
    await press(here.stdin, UP);
    expect(here.lastFrame()).toContain('typed here');
    expect(here.lastFrame()).toContain('history 1/1');

    const elsewhere = composer({ history: fakeHistory({ all: ['typed anywhere'] }), historyScopes: SCOPES });
    await tick();
    await press(elsewhere.stdin, UP);
    expect(elsewhere.lastFrame()).toContain('typed anywhere');
  });

  it('hands ↑ back to the app when there is nothing to recall', async () => {
    const onArrowOverflow = vi.fn();
    const { stdin } = composer({ onArrowOverflow, history: fakeHistory({}), historyScopes: SCOPES });
    await tick();
    await press(stdin, UP);
    expect(onArrowOverflow).toHaveBeenCalledWith('up');
  });

  it('lets the app put text in the box and read it back', async () => {
    const ref = createRef<ComposerHandle>();
    const { lastFrame, stdin } = composer({ ref });
    await tick();
    expect(ref.current?.getText()).toBe('');

    ref.current?.setText('opened in $EDITOR and saved');
    await tick();
    expect(lastFrame()).toContain('opened in $EDITOR and saved');
    expect(ref.current?.getText()).toBe('opened in $EDITOR and saved');

    // Through the editor, so what it replaced is one undo away.
    await press(stdin, CTRL_UNDERSCORE);
    expect(lastFrame()).toContain(PLACEHOLDER);
  });
});

/*
 * The reverse search.
 *
 * Held to bash's semantics, because they are the ones in everybody's fingers:
 * the match is shown in the box itself rather than beside it, so what Enter
 * sends is what can be read on screen, and Esc gives back the draft it
 * displaced.
 */
describe('Composer: Ctrl+R', () => {
  const SEARCHABLE = ['fix the flaky test', 'fix the build', 'write the release notes'];
  const searcher = (props: Partial<Parameters<typeof Composer>[0]> = {}) =>
    composer({
      history: fakeHistory({ folder: SEARCHABLE, all: [...SEARCHABLE, 'typed anywhere'] }),
      historyScopes: SCOPES,
      ...props,
    });

  it('opens a row under the box, showing the newest prompt in the scope', async () => {
    const { lastFrame, stdin } = searcher();
    await tick();
    await press(stdin, CTRL_R);
    expect(lastFrame()).toContain('reverse-i-search [folder]:');
    expect(lastFrame()).toContain('Ctrl+R older · Ctrl+S scope · Tab edits · Enter sends · Esc cancels');
    expect(lastFrame()).toContain('fix the flaky test');
  });

  it('narrows as the query is typed, and Ctrl+R steps to an older match', async () => {
    const { lastFrame, stdin } = searcher();
    await tick();
    await press(stdin, CTRL_R, 'fix');
    expect(lastFrame()).toContain('reverse-i-search [folder]: fix · 1/2');
    expect(lastFrame()).toContain('fix the flaky test');

    await press(stdin, CTRL_R);
    expect(lastFrame()).toContain('reverse-i-search [folder]: fix · 2/2');
    expect(lastFrame()).toContain('fix the build');
    expect(lastFrame()).not.toContain('flaky');

    // The oldest match is where stepping stops.
    await press(stdin, CTRL_R);
    expect(lastFrame()).toContain('fix the build');
  });

  it('says when a query matches nothing, and keeps the last match that did', async () => {
    const { lastFrame, stdin } = searcher();
    await tick();
    await press(stdin, CTRL_R, 'build', 'zz');
    expect(lastFrame()).toContain('reverse-i-search [folder]: buildzz · no match');
    expect(lastFrame()).toContain('fix the build');
  });

  it('Tab keeps the match in the box to be edited', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = searcher({ onSubmit });
    await tick();
    await press(stdin, CTRL_R, 'flaky', TAB);
    expect(lastFrame()).not.toContain('reverse-i-search');
    expect(lastFrame()).toContain('fix the flaky test');
    expect(onSubmit).not.toHaveBeenCalled();

    // The cursor is at the end of what was accepted, ready to be added to.
    await press(stdin, ' again');
    expect(lastFrame()).toContain('fix the flaky test again');
  });

  it('→ accepts the match as well, for the hand already on the arrows', async () => {
    const { lastFrame, stdin } = searcher();
    await tick();
    await press(stdin, CTRL_R, 'build', RIGHT);
    expect(lastFrame()).not.toContain('reverse-i-search');
    expect(lastFrame()).toContain('fix the build');
  });

  it('Enter sends the match', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = searcher({ onSubmit });
    await tick();
    await press(stdin, CTRL_R, 'build', ENTER);
    expect(onSubmit).toHaveBeenCalledWith('fix the build', []);
    expect(lastFrame()).not.toContain('reverse-i-search');
    expect(lastFrame()).toContain(PLACEHOLDER);
  });

  it('Esc puts the draft back', async () => {
    const { lastFrame, stdin } = searcher();
    await tick();
    await press(stdin, 'half typed', CTRL_R, 'flaky');
    expect(lastFrame()).toContain('fix the flaky test');
    expect(lastFrame()).not.toContain('half typed');

    await pressEscape(stdin);
    expect(lastFrame()).not.toContain('reverse-i-search');
    expect(lastFrame()).toContain('half typed');
  });

  it('Backspace past the start of the query cancels', async () => {
    const { lastFrame, stdin } = searcher();
    await tick();
    await press(stdin, 'half typed', CTRL_R, 'f');
    expect(lastFrame()).toContain('reverse-i-search [folder]: f ·');
    await press(stdin, BACKSPACE);
    expect(lastFrame()).toContain('reverse-i-search [folder]:');
    await press(stdin, BACKSPACE);
    expect(lastFrame()).not.toContain('reverse-i-search');
    expect(lastFrame()).toContain('half typed');
  });

  it('Ctrl+S widens the scope without losing the query', async () => {
    const { lastFrame, stdin } = searcher();
    await tick();
    await press(stdin, CTRL_R, 'typed');
    expect(lastFrame()).toContain('reverse-i-search [folder]: typed · no match');

    await press(stdin, CTRL_S);
    expect(lastFrame()).toContain('reverse-i-search [all]: typed · 1/1');
    expect(lastFrame()).toContain('typed anywhere');
  });

  it('owns Esc only while the row is open, and says so through its handle', async () => {
    const ref = createRef<ComposerHandle>();
    const { stdin } = searcher({ ref });
    await tick();
    expect(ref.current?.isCapturing()).toBe(false);

    await press(stdin, CTRL_R);
    expect(ref.current?.isCapturing()).toBe(true);

    await pressEscape(stdin);
    expect(ref.current?.isCapturing()).toBe(false);
  });

  it('does nothing without a history to search', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, 'half typed', CTRL_R);
    expect(lastFrame()).not.toContain('reverse-i-search');
    expect(lastFrame()).toContain('half typed');
  });
});

/*
 * `@` names a file.
 *
 * The index here is an array. `fileIndex.ts` is tested where it lives, over a
 * real directory and against the scorer; what these tests are about is which
 * keystroke opens the popup, which one inserts, and what travels beside the
 * message when it goes.
 */
const MENTION_HINT = '↑↓ move · Tab/Enter insert';

const COMPOSER_PATH = 'apps/tui/src/components/Composer.tsx';
const COMPLETIONS_PATH = 'apps/tui/src/components/Completions.tsx';

const PATHS: readonly string[] = ['README.md', 'apps/tui/src/app.tsx', COMPOSER_PATH, COMPLETIONS_PATH];

interface FakeIndex {
  readonly index: FileIndex;
  /** The paths `record` was told about, in order. */
  readonly recorded: readonly string[];
  /** Hand over the listing, for an index made to answer late. */
  readonly land: () => void;
}

/**
 * An index over an array, which either answers at once or waits to be told to.
 * `boost` stands in for the frecency file: a number per path, no clock.
 */
const fakeIndex = (
  options: { readonly paths?: readonly string[]; readonly late?: boolean; readonly boost?: Readonly<Record<string, number>> } = {},
): FakeIndex => {
  const paths = options.paths ?? PATHS;
  const recorded: string[] = [];
  let land = (): void => undefined;
  const listing =
    options.late === true
      ? new Promise<readonly string[]>((resolve) => {
          land = () => {
            resolve(paths);
          };
        })
      : Promise.resolve(paths);
  return {
    index: {
      list: () => listing,
      frecency: {
        boost: (path: string) => options.boost?.[path] ?? 0,
        record: (path: string) => {
          recorded.push(path);
        },
      },
    },
    recorded,
    land: () => {
      land();
    },
  };
};

describe('Composer: naming a file with @', () => {
  it('offers the paths that match, the best of them highlighted', async () => {
    const { index } = fakeIndex();
    const { lastFrame, stdin } = composer({ fileIndex: index });
    await tick();
    await press(stdin, 'look at @comp');

    const composerRow = rowWith(lastFrame(), COMPOSER_PATH);
    const completionsRow = rowWith(lastFrame(), COMPLETIONS_PATH);
    expect(composerRow).toBeGreaterThan(0);
    expect(rowsOf(lastFrame())[composerRow]).toContain('❯');
    expect(completionsRow).toBe(composerRow + 1);
    expect(rowsOf(lastFrame())[completionsRow]).not.toContain('❯');
    // The files that have nothing to do with `comp` are not in the list.
    expect(lastFrame()).not.toContain('README.md');
    expect(lastFrame()).toContain(MENTION_HINT);
  });

  it('↓ moves the highlight, and Tab inserts the row it lands on', async () => {
    const { index, recorded } = fakeIndex();
    const { lastFrame, stdin } = composer({ fileIndex: index });
    await tick();
    await press(stdin, 'look at @comp', DOWN);
    expect(rowsOf(lastFrame())[rowWith(lastFrame(), COMPLETIONS_PATH)]).toContain('❯');

    await press(stdin, TAB);
    // Written over the token, with the space that means the next word can
    // just be typed — and the popup is gone, because there is no token left.
    expect(lastFrame()).toContain(`look at @${COMPLETIONS_PATH}`);
    expect(lastFrame()).not.toContain(MENTION_HINT);
    expect(recorded).toEqual([COMPLETIONS_PATH]);
  });

  it('Enter inserts rather than sends; the next Enter sends, carrying the path', async () => {
    const onSubmit = vi.fn();
    const { index } = fakeIndex();
    const { lastFrame, stdin } = composer({ onSubmit, fileIndex: index });
    await tick();
    await press(stdin, 'read @comp', ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain(`read @${COMPOSER_PATH}`);

    await press(stdin, ENTER);
    expect(onSubmit).toHaveBeenCalledWith(`read @${COMPOSER_PATH} `, [COMPOSER_PATH]);
    expect(lastFrame()).toContain(PLACEHOLDER);
  });

  it('leaves a path nobody has heard of as the words it is', async () => {
    const onSubmit = vi.fn();
    const { index } = fakeIndex();
    const { lastFrame, stdin } = composer({ onSubmit, fileIndex: index });
    await tick();
    await press(stdin, 'see @nope/missing.ts');
    expect(lastFrame()).toContain('no match');

    await press(stdin, ENTER);
    expect(onSubmit).toHaveBeenCalledWith('see @nope/missing.ts', []);
  });

  it('inserts into the middle of a sentence and leaves the cursor after the path', async () => {
    const { index } = fakeIndex();
    const { lastFrame, stdin } = composer({ fileIndex: index });
    await tick();
    await press(stdin, 'rewrite @comp for me', LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, TAB);
    expect(lastFrame()).toContain(`rewrite @${COMPOSER_PATH} for me`);
    // The cursor is where the space left it, which typing proves.
    await press(stdin, 'X');
    expect(lastFrame()).toContain(`rewrite @${COMPOSER_PATH} Xfor me`);
  });

  it('a command word beats it: / at the start wins', async () => {
    const { index } = fakeIndex();
    const { lastFrame, stdin } = composer({ fileIndex: index });
    await tick();
    await press(stdin, '/mo');
    expect(lastFrame()).toContain('/model');

    // Still one word beginning with a slash, so the `@` is a character in a
    // command's name and nothing else.
    await press(stdin, '@comp');
    expect(lastFrame()).not.toContain(MENTION_HINT);
    expect(lastFrame()).not.toContain(COMPOSER_PATH);
  });

  it('opens once the command word has ended, because then it is arguments', async () => {
    const { index } = fakeIndex();
    const { lastFrame, stdin } = composer({ fileIndex: index });
    await tick();
    await press(stdin, '/attach @comp');
    expect(lastFrame()).toContain(COMPOSER_PATH);
    expect(lastFrame()).toContain(MENTION_HINT);
  });

  it('says loading… until the listing lands', async () => {
    const { index, land } = fakeIndex({ late: true });
    const { lastFrame, stdin } = composer({ fileIndex: index });
    await tick();
    await press(stdin, '@comp');
    expect(lastFrame()).toContain('loading…');
    expect(lastFrame()).not.toContain(COMPOSER_PATH);

    land();
    await tick();
    expect(lastFrame()).not.toContain('loading…');
    expect(lastFrame()).toContain(COMPOSER_PATH);
  });

  it('with nothing typed, offers what was picked before and then path order', async () => {
    const { index } = fakeIndex({ boost: { [COMPLETIONS_PATH]: 40 } });
    const { lastFrame, stdin } = composer({ fileIndex: index });
    await tick();
    await press(stdin, 'about @');

    const picked = rowWith(lastFrame(), COMPLETIONS_PATH);
    expect(rowsOf(lastFrame())[picked]).toContain('❯');
    expect(rowWith(lastFrame(), 'README.md')).toBe(picked + 1);
    expect(rowWith(lastFrame(), 'apps/tui/src/app.tsx')).toBe(picked + 2);
  });

  it('names what will travel in the row under the box', async () => {
    const { index } = fakeIndex();
    const { lastFrame, stdin } = composer({ fileIndex: index, attachments: ['shot.png'] });
    await tick();
    await press(stdin, 'read @comp', TAB);
    const row = rowWith(lastFrame(), '⎘');
    expect(rowsOf(lastFrame())[row]).toContain('shot.png');
    expect(rowsOf(lastFrame())[row]).toContain(COMPOSER_PATH);
    expect(rowsOf(lastFrame())[row]).toContain('goes with the next message');
  });
});

/*
 * The last of the box: what a paste turns into, what the clipboard puts in it,
 * where Ctrl+G sends it, what Ctrl+S sets aside, and the shell behind `!`.
 *
 * Every outside thing is a fake — a clipboard that is two functions, an editor
 * that is a promise, a shell that is a spy — so nothing is spawned, nothing is
 * read off a real desktop, and each test is about which keystroke means what.
 */
const CTRL_V = '\u0016';
const CTRL_G = '\u0007';

/** What a terminal with bracketed paste sends around pasted text. */
const pasted = (text: string): string => `\u001B[200~${text}\u001B[201~`;

const LONG_PASTE = Array.from({ length: 12 }, (_, i) => `line ${String(i + 1)}`).join('\n');

/** PNG bytes only by their signature, which is all `readClipboardImage` promises. */
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02);

const fakeClipboard = (contents: { readonly image?: Uint8Array; readonly text?: string }): ComposerClipboard => ({
  readImage: () =>
    Promise.resolve(contents.image === undefined ? null : ({ bytes: contents.image, mediaType: 'image/png' } as const)),
  readText: () => Promise.resolve(contents.text ?? null),
});

describe('Composer: a big paste is a chip', () => {
  it('stands in for a long paste, and sends what it stood for', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit });
    await tick();
    await press(stdin, 'look at ', pasted(LONG_PASTE));

    expect(lastFrame()).toContain('[Pasted #1 · 12 lines]');
    expect(lastFrame()).not.toContain('line 7');

    await press(stdin, ENTER);
    expect(onSubmit).toHaveBeenCalledWith(`look at ${LONG_PASTE}`, []);
  });

  it('leaves a short paste as the words it is', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit });
    await tick();
    await press(stdin, pasted('one\ntwo'));
    expect(lastFrame()).toContain('one');
    expect(lastFrame()).not.toContain('Pasted #');

    await press(stdin, ENTER);
    expect(onSubmit).toHaveBeenCalledWith('one\ntwo', []);
  });

  it('a very long single line is a chip too', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, pasted('x'.repeat(900)));
    expect(lastFrame()).toContain('[Pasted #1 · 1 line]');
  });

  it('numbers them up, and expands every one on send', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit });
    await tick();
    await press(stdin, pasted(LONG_PASTE), ' and ', pasted('a\nb\nc\nd\ne'));

    expect(lastFrame()).toContain('[Pasted #1 · 12 lines]');
    expect(lastFrame()).toContain('[Pasted #2 · 5 lines]');

    await press(stdin, ENTER);
    expect(onSubmit).toHaveBeenCalledWith(`${LONG_PASTE} and a\nb\nc\nd\ne`, []);
  });

  it('Backspace takes a chip whole, and the letter before it on the next press', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, 'see', pasted(LONG_PASTE));
    expect(lastFrame()).toContain('[Pasted #1');

    await press(stdin, BACKSPACE);
    expect(lastFrame()).not.toContain('Pasted #');
    expect(lastFrame()).toContain('see');

    await press(stdin, BACKSPACE);
    expect(lastFrame()).toContain('se');
    expect(lastFrame()).not.toContain('see');
  });

  it('a chip rubbed out does not travel, and the next one takes a fresh number', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit });
    await tick();
    await press(stdin, pasted(LONG_PASTE), BACKSPACE, 'never mind: ', pasted('a\nb\nc\nd'));

    expect(lastFrame()).toContain('[Pasted #2 · 4 lines]');
    await press(stdin, ENTER);
    expect(onSubmit).toHaveBeenCalledWith('never mind: a\nb\nc\nd', []);
  });

  it('starts again at one once the message has gone', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, pasted(LONG_PASTE), ENTER);
    await press(stdin, pasted(LONG_PASTE));
    expect(lastFrame()).toContain('[Pasted #1');
  });

  it('a terminal that did not say it was a paste still just types it', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, LONG_PASTE);
    expect(lastFrame()).not.toContain('Pasted #');
    expect(lastFrame()).toContain('line 12');
  });
});

describe('Composer: Ctrl+V', () => {
  it('puts an image chip in the text and hands the image over on send', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit, clipboard: fakeClipboard({ image: PNG }) });
    await tick();
    await press(stdin, 'what is wrong with ', CTRL_V);
    await tick();

    expect(lastFrame()).toContain('[Image #1]');

    await press(stdin, ENTER);
    expect(onSubmit).toHaveBeenCalledWith(
      'what is wrong with [Image #1]',
      [],
      [{ name: 'clipboard-1.png', mediaType: 'image/png', bytes: PNG }],
    );
  });

  it('numbers a second image up and sends both', async () => {
    const onSubmit = vi.fn<(text: string, mentions: readonly string[], images?: readonly PastedImage[]) => void>();
    const { lastFrame, stdin } = composer({ onSubmit, clipboard: fakeClipboard({ image: PNG }) });
    await tick();
    await press(stdin, CTRL_V);
    await tick();
    await press(stdin, ' then ', CTRL_V);
    await tick();
    expect(lastFrame()).toContain('[Image #1]');
    expect(lastFrame()).toContain('[Image #2]');

    await press(stdin, ENTER);
    expect(onSubmit.mock.calls[0]?.[2]?.map((image) => image.name)).toEqual(['clipboard-1.png', 'clipboard-2.png']);
  });

  it('an image chip rubbed out does not travel', async () => {
    const onSubmit = vi.fn();
    const { stdin } = composer({ onSubmit, clipboard: fakeClipboard({ image: PNG }) });
    await tick();
    await press(stdin, CTRL_V);
    await tick();
    await press(stdin, BACKSPACE, 'never mind', ENTER);
    expect(onSubmit).toHaveBeenCalledWith('never mind', []);
  });

  it('falls back to the text on the clipboard, chip and all', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit, clipboard: fakeClipboard({ text: LONG_PASTE }) });
    await tick();
    await press(stdin, CTRL_V);
    await tick();
    expect(lastFrame()).toContain('[Pasted #1 · 12 lines]');

    await press(stdin, ENTER);
    expect(onSubmit).toHaveBeenCalledWith(LONG_PASTE, []);
  });

  it('short text off the clipboard is just typed', async () => {
    const { lastFrame, stdin } = composer({ clipboard: fakeClipboard({ text: 'git bisect' }) });
    await tick();
    await press(stdin, CTRL_V);
    await tick();
    expect(lastFrame()).toContain('git bisect');
  });

  it('says so when there is nothing on it', async () => {
    const { lastFrame, stdin } = composer({ clipboard: fakeClipboard({}) });
    await tick();
    await press(stdin, CTRL_V);
    await tick();
    expect(lastFrame()).toContain('no image on the clipboard');
  });
});

describe('Composer: Ctrl+G', () => {
  it('sends the draft out and takes the edited text back', async () => {
    const onExternalEdit = vi.fn<(text: string) => Promise<string | undefined>>(() =>
      Promise.resolve('what the editor saved'),
    );
    const { lastFrame, stdin } = composer({ onExternalEdit });
    await tick();
    await press(stdin, 'half a thought', CTRL_G);
    await tick();

    expect(onExternalEdit).toHaveBeenCalledWith('half a thought');
    expect(lastFrame()).toContain('what the editor saved');
    expect(lastFrame()).not.toContain('half a thought');
  });

  it('is how the content of a chip is read: it goes out expanded', async () => {
    const onExternalEdit = vi.fn<(text: string) => Promise<string | undefined>>((text) => Promise.resolve(text));
    const { lastFrame, stdin } = composer({ onExternalEdit });
    await tick();
    await press(stdin, pasted(LONG_PASTE), CTRL_G);
    await tick();

    expect(onExternalEdit).toHaveBeenCalledWith(LONG_PASTE);
    // And what came back is the text itself, so there is no chip left over.
    expect(lastFrame()).not.toContain('Pasted #');
    expect(lastFrame()).toContain('line 12');
  });

  it('an abandoned edit leaves the draft alone', async () => {
    const onExternalEdit = vi.fn<(text: string) => Promise<string | undefined>>(() => Promise.resolve(undefined));
    const { lastFrame, stdin } = composer({ onExternalEdit });
    await tick();
    await press(stdin, 'still here', CTRL_G);
    await tick();
    expect(lastFrame()).toContain('still here');
  });
});

describe('Composer: Ctrl+S sets a draft aside', () => {
  it('stashes what is typed and gives it back, cursor and all', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, 'the other thing', LEFT, LEFT, LEFT, LEFT, LEFT, CTRL_S);

    expect(lastFrame()).toContain(PLACEHOLDER);
    expect(lastFrame()).toContain('stashed · Ctrl+S restores');

    await press(stdin, CTRL_S);
    expect(lastFrame()).toContain('the other thing');
    // The cursor came back where it was, which typing proves.
    await press(stdin, 'X');
    expect(lastFrame()).toContain('the other Xthing');
  });

  it('does nothing on an empty box with nothing set aside', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, CTRL_S);
    expect(lastFrame()).toContain(PLACEHOLDER);
  });

  it('a message typed and sent in between is not what comes back', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = composer({ onSubmit });
    await tick();
    await press(stdin, 'set this aside', CTRL_S, 'something urgent', ENTER);
    expect(onSubmit).toHaveBeenCalledWith('something urgent', []);

    await press(stdin, CTRL_S);
    expect(lastFrame()).toContain('set this aside');
  });
});

describe('Composer: ! is a shell', () => {
  it('turns the box into a prompt, and Enter runs the line', async () => {
    const onShell = vi.fn();
    const { lastFrame, stdin } = composer({ onShell });
    await tick();
    await press(stdin, '!');

    expect(lastFrame()).toContain('shell command · Esc leaves');
    // The `!` was the key that opened the prompt, not a character in it.
    const glyph = rowWith(lastFrame(), '$');
    expect(glyph).toBeGreaterThanOrEqual(0);
    expect(rowsOf(lastFrame())[glyph]).not.toContain('!');

    await press(stdin, 'git status', ENTER);
    expect(onShell).toHaveBeenCalledWith('git status', { send: false });
    // The prompt stays: a shell is a place you run more than one thing.
    expect(lastFrame()).toContain('shell command · Esc leaves');
  });

  it('a second ! sends the output to the agent', async () => {
    const onShell = vi.fn();
    const { stdin } = composer({ onShell });
    await tick();
    await press(stdin, '!', '!pnpm test', ENTER);
    expect(onShell).toHaveBeenCalledWith('pnpm test', { send: true });
  });

  it('never runs anything through onSubmit', async () => {
    const onSubmit = vi.fn();
    const onShell = vi.fn();
    const { stdin } = composer({ onSubmit, onShell });
    await tick();
    await press(stdin, '!', 'ls', ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onShell).toHaveBeenCalledTimes(1);
  });

  it('Esc leaves it, and Backspace on an empty line does too', async () => {
    const onShell = vi.fn();
    const { lastFrame, stdin } = composer({ onShell });
    await tick();
    await press(stdin, '!');
    await pressEscape(stdin);
    expect(lastFrame()).toContain(PLACEHOLDER);
    expect(lastFrame()).not.toContain('shell command');

    await press(stdin, '!', 'ls', BACKSPACE, BACKSPACE);
    expect(lastFrame()).toContain('shell command · Esc leaves');
    await press(stdin, BACKSPACE);
    expect(lastFrame()).toContain(PLACEHOLDER);
  });

  it('owns Esc only while the line is empty, so a turn can still be interrupted', async () => {
    const ref = createRef<ComposerHandle>();
    const { stdin } = composer({ onShell: vi.fn(), ref });
    await tick();
    await press(stdin, '!');
    expect(ref.current?.isCapturing()).toBe(true);

    await press(stdin, 'sleep 90');
    expect(ref.current?.isCapturing()).toBe(false);
  });

  it('a slash is a path at the prompt, not a command', async () => {
    const { lastFrame, stdin } = composer({ onShell: vi.fn() });
    await tick();
    await press(stdin, '!', '/usr/bin/env');
    expect(lastFrame()).toContain('/usr/bin/env');
    expect(lastFrame()).not.toContain('/model');
  });

  it('↑ at the prompt recalls shell lines, and ↑ in the box recalls the rest', async () => {
    const history = fakeHistory({ all: ['!git status', 'write the release notes'] });
    const { lastFrame, stdin } = composer({ onShell: vi.fn(), history });
    await tick();

    await press(stdin, UP);
    expect(lastFrame()).toContain('write the release notes');
    expect(lastFrame()).not.toContain('git status');

    await press(stdin, CTRL_U, '!', UP);
    expect(lastFrame()).toContain('git status');
    expect(lastFrame()).not.toContain('release notes');
  });

  it('will not run an empty line', async () => {
    const onShell = vi.fn();
    const { stdin } = composer({ onShell });
    await tick();
    await press(stdin, '!', ENTER, '   ', ENTER);
    expect(onShell).not.toHaveBeenCalled();
  });

  it('with nothing to run it in, ! is a character like any other', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, '!');
    expect(lastFrame()).toContain('!');
    expect(lastFrame()).not.toContain('shell command');
  });
});

/*
 * The two keys the app and the box both have a use for.
 *
 * Ink has no stop-propagation: every active handler sees every press, so the
 * one that must not act is the one that asks. Esc is tested above, where the
 * reverse search is; these are the other two. Tab is asked about — the app
 * stands down while a row is highlighted — and `?` is answered here outright,
 * because the app cannot stop the box taking the character on the press it
 * acted on.
 */
describe('Composer: the keys it shares with the app', () => {
  it('says through its handle when Tab belongs to the slash menu', async () => {
    const ref = createRef<ComposerHandle>();
    const { lastFrame, stdin } = composer({ ref });
    await tick();
    expect(ref.current?.hasPopup()).toBe(false);

    await press(stdin, '/mod');
    expect(ref.current?.hasPopup()).toBe(true);

    // The press the app must not also act on: this one fills the row in, and
    // only the Tab after it is the one that moves the focus.
    await press(stdin, TAB);
    expect(lastFrame()).toContain('/model');
    expect(ref.current?.hasPopup()).toBe(false);
  });

  it('says the same about the popup under an @', async () => {
    const ref = createRef<ComposerHandle>();
    const { index } = fakeIndex();
    const { stdin } = composer({ ref, fileIndex: index });
    await tick();
    expect(ref.current?.hasPopup()).toBe(false);

    await press(stdin, 'look at @comp');
    expect(ref.current?.hasPopup()).toBe(true);

    await press(stdin, TAB);
    expect(ref.current?.hasPopup()).toBe(false);
  });

  it('? at an empty box opens the key map and leaves the box empty', async () => {
    const onHelp = vi.fn();
    const { lastFrame, stdin } = composer({ onHelp });
    await tick();
    await press(stdin, '?');
    expect(onHelp).toHaveBeenCalledTimes(1);
    // Otherwise the overlay goes up over a box with a stray `?` waiting in it.
    expect(lastFrame()).toContain(PLACEHOLDER);
  });

  it('? anywhere else in a message is punctuation', async () => {
    const onHelp = vi.fn();
    const { lastFrame, stdin } = composer({ onHelp });
    await tick();
    await press(stdin, 'why', '?');
    expect(onHelp).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('why?');
  });

  it('with nothing to open, ? is a character like any other', async () => {
    const { lastFrame, stdin } = composer();
    await tick();
    await press(stdin, '?');
    expect(lastFrame()).not.toContain(PLACEHOLDER);
    expect(lastFrame()).toContain('?');
  });
});
