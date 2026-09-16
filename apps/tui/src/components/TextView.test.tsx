/**
 * The small reader `/diff` opens into.
 *
 * Real bytes through `stdin`, as the pager's tests do: `G` is an escape-free
 * capital and PgDn is a control sequence, and a test that called the handler
 * directly would pass while the terminal sent something else. What is asserted
 * is which lines are on screen, because that is the whole of what this is for.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import { TextView, bodyRowsFor, clampTop } from './TextView.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

const PAGE_UP = '[5~';
const PAGE_DOWN = '[6~';

/** Twenty numbered lines: enough that any of the screens below cuts it. */
const LINES = Array.from({ length: 20 }, (_, i) => `line ${String(i + 1)}`);

function open(props: Partial<React.ComponentProps<typeof TextView>> = {}): ReturnType<typeof render> {
  return render(
    <TextView title="Working tree" lines={LINES} columns={40} rows={10} onClose={() => undefined} {...props} />,
  );
}

describe('bodyRowsFor', () => {
  it('takes the borders, the title and the legend off the height', () => {
    expect(bodyRowsFor(10)).toBe(6);
    expect(bodyRowsFor(24)).toBe(20);
  });

  it('keeps a line on screen however small the terminal claims to be', () => {
    // A border round nothing answers no question at all.
    expect(bodyRowsFor(4)).toBe(1);
    expect(bodyRowsFor(0)).toBe(1);
    expect(bodyRowsFor(-5)).toBe(1);
  });
});

describe('clampTop', () => {
  it('stops at the last screenful rather than scrolling into nothing', () => {
    expect(clampTop(99, 20, 6)).toBe(14);
    expect(clampTop(-3, 20, 6)).toBe(0);
    expect(clampTop(5, 20, 6)).toBe(5);
  });

  it('pins a text that fits to the top', () => {
    expect(clampTop(4, 3, 6)).toBe(0);
    expect(clampTop(0, 0, 6)).toBe(0);
  });
});

describe('the text view', () => {
  it('opens at the top, with its title and its legend', async () => {
    const { lastFrame } = open();
    await tick();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Working tree');
    // Truncated rather than wrapped: a legend that folds onto a second row
    // pushes the box past the height it was given.
    expect(frame).toContain('↑↓ j k · PgUp PgDn');
    expect(lastFrame() ?? '').toMatch(/↑↓ j k .*\n╰/u);
    expect(frame).toContain('line 1');
    expect(frame).toContain('20 lines');
    // Six rows of text on a ten-row box: what is past them is not drawn.
    expect(frame).toContain('line 6');
    expect(frame).not.toContain('line 7');
  });

  it('scrolls a line at a time on the arrows and on j and k', async () => {
    const { lastFrame, stdin } = open();
    await tick();

    stdin.write('j');
    await tick();
    expect(lastFrame() ?? '').not.toContain('line 1\n');
    expect(lastFrame() ?? '').toContain('line 7');

    stdin.write('k');
    await tick();
    expect(lastFrame() ?? '').toContain('line 1');

    stdin.write('[B');
    await tick();
    expect(lastFrame() ?? '').toContain('line 7');
  });

  it('moves a screen on the page keys', async () => {
    const { lastFrame, stdin } = open();
    await tick();

    stdin.write(PAGE_DOWN);
    await tick();
    expect(lastFrame() ?? '').toContain('line 7');
    expect(lastFrame() ?? '').toContain('line 12');

    stdin.write(PAGE_UP);
    await tick();
    expect(lastFrame() ?? '').toContain('line 1');
  });

  it('goes to the ends on g and G, and says so in the percentage', async () => {
    const { lastFrame, stdin } = open();
    await tick();
    expect(lastFrame() ?? '').toContain('0%');

    stdin.write('G');
    await tick();
    // The last screenful, not one line past it.
    expect(lastFrame() ?? '').toContain('line 20');
    expect(lastFrame() ?? '').toContain('line 15');
    expect(lastFrame() ?? '').toContain('100%');

    stdin.write('g');
    await tick();
    expect(lastFrame() ?? '').toContain('line 1');
    expect(lastFrame() ?? '').toContain('0%');
  });

  it('will not scroll past the end however many keys are pressed', async () => {
    const { lastFrame, stdin } = open();
    await tick();
    for (let i = 0; i < 40; i += 1) stdin.write('j');
    await tick();
    expect(lastFrame() ?? '').toContain('line 20');
    expect(lastFrame() ?? '').toContain('line 15');
  });

  it('closes on q and on Esc', async () => {
    const onClose = vi.fn();
    const { stdin } = open({ onClose });
    await tick();

    stdin.write('q');
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);

    stdin.write('');
    await tick();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('answers nothing while something else has the keys', async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = open({ onClose, isActive: false });
    await tick();

    stdin.write('G');
    stdin.write('q');
    await tick();
    expect(onClose).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('line 1');
  });

  it('says so rather than drawing an empty box for no text', async () => {
    const { lastFrame } = open({ lines: [] });
    await tick();
    expect(lastFrame() ?? '').toContain('Nothing to show.');
    expect(lastFrame() ?? '').toContain('0 lines');
  });

  it('keeps the colour a diff arrives with', async () => {
    // `renderDiff` hands over ANSI; a view that re-wrapped or stripped it
    // would turn a red deletion into a plain line of code.
    const { lastFrame } = open({ lines: ['[32m+ added line[39m'] });
    await tick();
    expect(lastFrame() ?? '').toContain('[32m+ added line');
  });
});
