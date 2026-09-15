/*
 * The overlay's job is to be readable and to get out of the way, so that is
 * what is checked: that every group of the map reaches the screen, that a wide
 * terminal gets the rows in half the height, that a short one scrolls and says
 * how much is left, that the four closing keys close it, and that a binding
 * nobody has wired yet admits as much.
 *
 * Frames are read as text. Colour is Ink's to apply and the terminal's to
 * honour; asserting escape sequences would be a test of chalk.
 *
 * One quirk of the harness is worth knowing: `ink-testing-library` reports a
 * stdout a hundred columns wide, so a frame asked for at 120 is clipped at its
 * right edge. Nothing here depends on that edge — the number of lines and
 * which column a row starts in are both unaffected.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import { KEYMAP } from '../keymap.js';
import { Help, helpLines } from './Help.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/** The border, the title and the legend: four lines that are not rows. */
const FURNITURE = 4;

const ESC = '';
const PAGE_DOWN = `${ESC}[6~`;
const PAGE_UP = `${ESC}[5~`;
const DOWN = `${ESC}[B`;

const rowsOf = (frame: string | undefined): readonly string[] => (frame ?? '').split('\n');

/** Tall enough that nothing scrolls, so a frame is the whole map. */
const WHOLE = 200;

async function frameAt(columns: number, rows: number): Promise<string> {
  const { lastFrame } = render(<Help columns={columns} rows={rows} onClose={() => undefined} />);
  await tick();
  return lastFrame() ?? '';
}

describe('Help', () => {
  it('draws every group in the map, with its keys', async () => {
    const frame = await frameAt(80, WHOLE);
    for (const group of KEYMAP) expect(frame).toContain(group.title);
    expect(frame).toContain('Ctrl+W');
    expect(frame).toContain('Rub out the word before the cursor');
    expect(frame).toContain('/attach <path>');
  });

  it('runs the rows down two columns past a hundred, and one below', async () => {
    const narrow = rowsOf(await frameAt(80, WHOLE));
    const wide = rowsOf(await frameAt(120, WHOLE));
    // The same rows in half the height, give or take the one row a column may
    // hand over rather than end on a heading.
    const halved = Math.ceil((narrow.length - FURNITURE) / 2) + FURNITURE;
    expect(wide.length).toBeLessThan(narrow.length);
    expect(wide.length).toBeGreaterThanOrEqual(halved);
    expect(wide.length).toBeLessThanOrEqual(halved + 1);
  });

  it('puts the second column beside the first, not under it', async () => {
    const first = KEYMAP[0]?.title ?? '';
    const headingIn = (frame: string): string => rowsOf(frame).find((line) => line.includes(first)) ?? '';
    // The first heading is one short word. Anything out past the first column
    // on its line can only be the second column.
    const beyond = (line: string): string => line.slice(58).replaceAll('│', '').trim();
    expect(beyond(headingIn(await frameAt(120, WHOLE)))).not.toBe('');
    expect(beyond(headingIn(await frameAt(80, WHOLE)))).toBe('');
  });

  it('marks a binding that is decided but not yet wired', async () => {
    const frame = await frameAt(80, WHOLE);
    const line = rowsOf(frame).find((row) => row.includes('Shift+Tab')) ?? '';
    expect(line).toContain('(soon)');
    expect(rowsOf(frame).find((row) => row.includes('Ctrl+T ')) ?? '').not.toContain('(soon)');
  });

  it('scrolls when the map is taller than the terminal, and says how much is left', async () => {
    const { lastFrame, stdin } = render(<Help columns={80} rows={12} onClose={() => undefined} />);
    await tick();
    const first = lastFrame() ?? '';
    expect(first).toContain(KEYMAP[0]?.title ?? '');
    expect(first).toContain('more below');

    stdin.write(PAGE_DOWN);
    await tick();
    const paged = lastFrame() ?? '';
    expect(paged).not.toBe(first);
    expect(paged).not.toContain(KEYMAP[0]?.title ?? '');

    stdin.write(PAGE_UP);
    await tick();
    expect(lastFrame()).toBe(first);

    stdin.write(DOWN);
    await tick();
    expect(lastFrame()).not.toBe(first);
  });

  it('goes no further than the end of the map', async () => {
    const { lastFrame, stdin } = render(<Help columns={80} rows={12} onClose={() => undefined} />);
    await tick();
    for (let press = 0; press < 12; press += 1) stdin.write(PAGE_DOWN);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/quit');
    expect(frame).not.toContain('more below');
  });

  it('closes on ?, q, Esc and Enter', async () => {
    for (const press of ['?', 'q', ESC, '\r']) {
      const onClose = vi.fn();
      const { stdin } = render(<Help columns={80} rows={24} onClose={onClose} />);
      await tick();
      stdin.write(press);
      await tick();
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  });

  it('answers nothing while something in front of it has the keys', async () => {
    const onClose = vi.fn();
    const { stdin } = render(<Help columns={80} rows={24} onClose={onClose} isActive={false} />);
    await tick();
    stdin.write('q');
    await tick();
    expect(onClose).not.toHaveBeenCalled();
  });
});

/*
 * The pure half. `/help` is meant to print these same rows into the transcript
 * one day, which only works if the lines are a function of the width and
 * nothing else.
 */
describe('helpLines', () => {
  it('gives one row per binding, in the order the map gives them', () => {
    const bindings = KEYMAP.flatMap((group) => group.keys);
    const lines = helpLines(80);
    expect(lines.length).toBe(bindings.length);
    expect(lines[0]?.key).toBe(bindings[0]?.keys.join(' '));
  });

  it('opens each group with its title, and only there', () => {
    const titled = helpLines(80).flatMap((line) => (line.group === undefined ? [] : [line.group]));
    expect(titled).toEqual(KEYMAP.map((group) => group.title));
  });

  it('cuts what it says to fit the column it was asked about', () => {
    const wide = helpLines(200);
    const narrow = helpLines(80);
    const longest = (lines: readonly { readonly does: string }[]): number =>
      lines.reduce((width, line) => Math.max(width, line.does.length), 0);
    expect(longest(narrow)).toBeLessThan(longest(wide));
    expect(narrow.some((line) => line.does.endsWith('…'))).toBe(true);
  });

  it('carries the planned flag through', () => {
    const planned = helpLines(80).filter((line) => line.planned === true);
    expect(planned.map((line) => line.key)).toEqual(['Shift+Tab', 'Ctrl+O']);
  });

  it('is pure', () => {
    expect(helpLines(80)).toEqual(helpLines(80));
  });
});
