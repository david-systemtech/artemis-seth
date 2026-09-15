import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import { Composer } from './Composer.js';

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
    expect(onSubmit).toHaveBeenCalledWith('alpha\nbeta');
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
    expect(onSubmit).toHaveBeenCalledWith('one\ntwo');
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
    expect(onSubmit).toHaveBeenCalledWith('/mode');
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
    expect(onSubmit).toHaveBeenCalledWith('/mdoel');
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
    expect(onSubmit).toHaveBeenCalledWith('/quit');
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
    expect(onSubmit).toHaveBeenCalledWith('/artemis-skills:code-review');
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
    expect(lastFrame()).toContain('↓ 3 more');
  });
});
