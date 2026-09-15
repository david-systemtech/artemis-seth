/**
 * The diff renderer.
 *
 * What is worth testing here is not "does it colour a line green" but the two
 * things that make a diff navigable and that have a way of silently going
 * wrong:
 *
 *  1. **The number in the gutter is the right number.** A gutter that shows the
 *     old line number next to a `+` sends the reader to the wrong line in the
 *     file they are about to open, which is worse than showing no number at all
 *     — they would have looked it up rather than trusted it.
 *  2. **The default call still renders what it always rendered.** Two callers
 *     pass no options and neither is tested at this level; if a gutter appeared
 *     under them the diff would silently lose columns of code.
 *
 * Colour is asserted as bytes because that is the only thing a terminal sees,
 * and `env` is always passed explicitly: the machine running these tests may
 * well set `COLORTERM`, and a test that changes its mind depending on the
 * terminal it was started from is not a test.
 */

import { describe, expect, it } from 'vitest';

import { detectFileEdit, type FileEdit } from '@rx-artemis/transcript';

import { DIM, FG_OFF, GREEN, RED, RESET } from './ansi.js';
import { renderDiff } from './diff.js';

/** The tints the renderer keeps to itself; spelled out here so a change to either is caught. */
const BG_ADD = '\u001b[48;2;33;58;43m';
const BG_DEL = '\u001b[48;2;74;34;29m';
const BG_OFF = '\u001b[49m';

const NO_COLOR: NodeJS.ProcessEnv = {};
const TRUECOLOR: NodeJS.ProcessEnv = { COLORTERM: 'truecolor' };

/** What the reader sees, with the escape sequences taken off. */
function plain(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''));
}

function edited(): FileEdit {
  const edit = detectFileEdit('Edit', {
    file_path: 'example.txt',
    old_string: 'line one\nline two\nline three',
    new_string: 'line one\nline two changed\nline three',
  });
  if (edit === null) throw new Error('fixture is not an edit');
  return edit;
}

function written(): FileEdit {
  const edit = detectFileEdit('Write', { file_path: 'new.md', content: 'alpha\nbeta\ngamma' });
  if (edit === null) throw new Error('fixture is not a write');
  return edit;
}

/** A change late in a long file, so the numbers are three digits wide. */
function deepEdit(): FileEdit {
  const lines = Array.from({ length: 120 }, (_, i) => `line ${String(i + 1)}`);
  const after = [...lines];
  after[99] = 'line 100 changed';
  const edit = detectFileEdit('Edit', {
    file_path: 'long.txt',
    old_string: lines.join('\n'),
    new_string: after.join('\n'),
  });
  if (edit === null) throw new Error('fixture is not an edit');
  return edit;
}

describe('the gutter', () => {
  it('shows the new line number on additions and context, the old one on deletions', () => {
    const out = plain(renderDiff(edited(), 40, { columns: 100, env: NO_COLOR }));
    expect(out).toEqual([
      'example.txt  +1 -1',
      '1  line one',
      '2 -line two',
      '2 +line two changed',
      '3  line three',
    ]);
  });

  it('numbers a written file from its first line', () => {
    // A write has no original, so every row is an addition and the only number
    // available is the new one. It must still start at 1 rather than blank.
    const out = plain(renderDiff(written(), 40, { numbers: 'on', env: NO_COLOR }));
    expect(out.slice(1)).toEqual(['1 +alpha', '2 +beta', '3 +gamma']);
  });

  it('widens with the largest number it actually shows', () => {
    const out = plain(renderDiff(deepEdit(), 40, { numbers: 'on', env: NO_COLOR })).slice(1);
    // Three digits, right-aligned, so the ones and tens columns line up.
    expect(out).toContain('100 -line 100');
    expect(out).toContain('100 +line 100 changed');
    expect(out).toContain(' 99  line 99');
    // …and a one-line file does not pay for a width it has no use for.
    expect(plain(renderDiff(edited(), 40, { numbers: 'on', env: NO_COLOR }))[2]).toBe('2 -line two');
  });

  it('leaves the gutter blank on a gap and puts the glyph in the sign column', () => {
    const out = plain(renderDiff(deepEdit(), 40, { numbers: 'on', env: NO_COLOR }));
    const gap = out.find((line) => line.includes('⋮'));
    const add = out.find((line) => line.includes('+line 100 changed'));
    expect(gap).toBe('    ⋮ 96 unchanged');
    expect(gap?.indexOf('⋮')).toBe(add?.indexOf('+'));
  });
});

describe('when the gutter appears', () => {
  it('follows the terminal width under `auto`', () => {
    const numbered = (columns: number | undefined): boolean =>
      plain(renderDiff(edited(), 40, { ...(columns === undefined ? {} : { columns }), env: NO_COLOR }))[1] ===
      '1  line one';
    expect(numbered(100)).toBe(true);
    expect(numbered(200)).toBe(true);
    expect(numbered(99)).toBe(false);
    // A caller that never says how wide the terminal is gets the narrow answer:
    // guessing wide and being wrong costs the code its columns.
    expect(numbered(undefined)).toBe(false);
  });

  it('obeys `on` and `off` whatever the width says', () => {
    expect(plain(renderDiff(edited(), 40, { columns: 40, numbers: 'on', env: NO_COLOR }))[1]).toBe(
      '1  line one',
    );
    expect(plain(renderDiff(edited(), 40, { columns: 200, numbers: 'off', env: NO_COLOR }))[1]).toBe(
      '  line one',
    );
  });
});

describe('colour', () => {
  const addLine = (options: Parameters<typeof renderDiff>[2]): string =>
    renderDiff(edited(), 40, options)[3] ?? '';

  it('tints the row when the terminal advertises 24-bit colour', () => {
    for (const COLORTERM of ['truecolor', '24bit', 'TrueColor']) {
      const line = addLine({ env: { COLORTERM } });
      expect(line).toContain(BG_ADD);
      expect(line).toContain(BG_OFF);
      // The foreground is left to the terminal, so the reader keeps their own.
      expect(line).not.toContain(GREEN);
    }
    expect(addLine({ env: TRUECOLOR, columns: 80 })).not.toContain(GREEN);
    expect(renderDiff(edited(), 40, { env: TRUECOLOR })[2]).toContain(BG_DEL);
  });

  it('falls back to a coloured foreground when it does not', () => {
    expect(addLine({ env: NO_COLOR })).toBe(`${GREEN}+ line two changed${FG_OFF}`);
    expect(addLine({ env: { COLORTERM: '256color' } })).toContain(GREEN);
    expect(renderDiff(edited(), 40, { env: NO_COLOR })[2]).toBe(`${RED}- line two${FG_OFF}`);
  });

  it('lets the caller force either way', () => {
    expect(addLine({ color: 'ansi', env: TRUECOLOR })).toContain(GREEN);
    expect(addLine({ color: 'truecolor', env: NO_COLOR })).toContain(BG_ADD);
  });

  it('runs a tinted row out to the edge so it reads as a band', () => {
    const line = addLine({ color: 'truecolor', columns: 40, env: NO_COLOR });
    expect(plain([line])[0]).toHaveLength(40);
    // Untinted rows are not padded: trailing spaces on every context line would
    // be copied out with the code.
    expect(plain([addLine({ color: 'ansi', columns: 40, env: NO_COLOR })])[0]).toBe(
      '+ line two changed',
    );
  });
});

describe('gaps, cuts and caps', () => {
  it('says how many unchanged lines a gap stands for', () => {
    const out = plain(renderDiff(deepEdit(), 40, { env: NO_COLOR }));
    expect(out).toContain('⋮ 96 unchanged');
    // `⋯` stays reserved for output this renderer clipped, so the two are never
    // confused for one another.
    expect(out.filter((line) => line.includes('⋯'))).toEqual([]);
  });

  it('cuts a long line at the terminal width rather than wrapping it', () => {
    const long = 'x'.repeat(400);
    const edit = detectFileEdit('Edit', {
      file_path: `/${'deeply/nested/'.repeat(6)}name.ts`,
      old_string: `head\n${long}\ntail`,
      new_string: `head\n${long}!\ntail`,
    });
    const out = plain(renderDiff(edit as FileEdit, 40, { columns: 60, env: NO_COLOR }));
    for (const line of out) expect(line.length).toBeLessThanOrEqual(60);
    // Including the header, which keeps the counts and the end of the path.
    expect(out[0]?.startsWith('…')).toBe(true);
    expect(out[0]?.endsWith('+1 -1')).toBe(true);
  });

  it('caps the rows and counts what it left out', () => {
    const out = plain(renderDiff(deepEdit(), 3, { env: NO_COLOR }));
    expect(out).toHaveLength(5); // header + 3 rows + the cap line
    expect(out.at(-1)).toMatch(/^ {2}⋯ \d+ more lines$/);
    expect(renderDiff(edited(), 4, { env: NO_COLOR })).toHaveLength(5); // nothing left out, no cap
  });

  it('puts the cap line under the sign column when there is a gutter', () => {
    // Six rows in, the widest number shown is three digits, so the cap line is
    // indented to match them.
    const out = plain(renderDiff(deepEdit(), 6, { numbers: 'on', env: NO_COLOR }));
    expect(out.at(-1)).toMatch(/^ {4}⋯ \d+ more lines$/);
  });
});

describe('the call the two callers make', () => {
  it('renders exactly what it rendered before options existed', () => {
    const edit = edited();
    expect(renderDiff(edit, 30, { env: NO_COLOR })).toEqual([
      `${DIM}example.txt${RESET}  ${GREEN}+1${FG_OFF} ${RED}-1${FG_OFF}`,
      `${DIM}  line one${RESET}`,
      `${RED}- line two${FG_OFF}`,
      `${GREEN}+ line two changed${FG_OFF}`,
      `${DIM}  line three${RESET}`,
    ]);
  });

  it('keeps that shape whatever the terminal turns out to be', () => {
    // `renderDiff(edit)` reads the real environment for colour, so only the
    // text is asserted here — the layout must not move under a caller that
    // passes nothing.
    expect(plain([...renderDiff(edited())])).toEqual([
      'example.txt  +1 -1',
      '  line one',
      '- line two',
      '+ line two changed',
      '  line three',
    ]);
  });
});
