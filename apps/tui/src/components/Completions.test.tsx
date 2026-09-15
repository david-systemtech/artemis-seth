/*
 * The popup's four jobs: line the rows up, say which one Enter would run, admit
 * when it is showing only part of the list, and stay out of the way when there
 * is nothing to show.
 *
 * The frames are read as text. Colour and weight are Ink's to apply and a
 * terminal's to honour, and a test that asserted escape sequences would be a
 * test of chalk; what matters here is that the row still reads as one word after
 * being cut into bold and unbold pieces.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';

import { Completions, type CompletionItem } from './Completions.js';

const rowsOf = (frame: string | undefined): readonly string[] => (frame ?? '').split('\n');
const rowWith = (frame: string | undefined, text: string): string =>
  rowsOf(frame).find((line) => line.includes(text)) ?? '';

const numbered = (count: number): readonly CompletionItem[] =>
  Array.from({ length: count }, (_unused, index) => ({
    key: `c${String(index)}`,
    label: `/c${String(index).padStart(2, '0')}`,
  }));

describe('Completions', () => {
  it('draws nothing at all when there is nothing to offer', () => {
    const { lastFrame } = render(<Completions items={[]} selected={null} />);
    expect(lastFrame()).toBe('');
  });

  it('lines the details up under one another, however wide the labels are', () => {
    const { lastFrame } = render(
      <Completions
        items={[
          { key: 'help', label: '/help', detail: 'List these commands' },
          { key: 'review', label: '/artemis-skills:code-review', detail: 'plugin skill' },
        ]}
        selected={0}
      />,
    );
    const short = rowWith(lastFrame(), '/help');
    const long = rowWith(lastFrame(), '/artemis-skills:code-review');
    expect(short.indexOf('List these commands')).toBe(long.indexOf('plugin skill'));
  });

  it('marks the selected row, and only that row', () => {
    const { lastFrame } = render(
      <Completions
        items={[
          { key: 'model', label: '/model' },
          { key: 'mode', label: '/mode' },
        ]}
        selected={1}
      />,
    );
    const [first, second] = rowsOf(lastFrame());
    expect(first).toContain('/model');
    expect(first).not.toContain('❯');
    expect(second).toContain('/mode');
    expect(second).toContain('❯');
    expect(rowsOf(lastFrame()).filter((line) => line.includes('❯'))).toHaveLength(1);
  });

  it('marks nothing when nothing is selected', () => {
    const { lastFrame } = render(
      <Completions
        items={[
          { key: 'model', label: '/model' },
          { key: 'mode', label: '/mode' },
        ]}
        selected={null}
      />,
    );
    expect(lastFrame()).toContain('/model');
    expect(lastFrame()).not.toContain('❯');
  });

  it('keeps the label whole where characters were matched', () => {
    const { lastFrame } = render(
      <Completions
        items={[{ key: 'review', label: '/code-review', detail: 'skill', indices: [1, 2, 3, 4, 6, 7] }]}
        selected={0}
      />,
    );
    expect(lastFrame()).toContain('/code-review');
  });

  it('shows a window around the selection and counts what is out of sight', () => {
    const { lastFrame } = render(<Completions items={numbered(12)} selected={6} maxRows={4} />);
    expect(lastFrame()).toContain('↑ 4 more');
    expect(lastFrame()).toContain('↓ 4 more');
    expect(lastFrame()).toContain('/c06');
    expect(lastFrame()).not.toContain('/c00');
    expect(lastFrame()).not.toContain('/c11');
  });

  it('counts only below while the selection is still at the top', () => {
    const { lastFrame } = render(<Completions items={numbered(12)} selected={0} maxRows={4} />);
    // The `↑↓` of the hint line is not a count of hidden rows.
    expect(lastFrame()).not.toMatch(/↑ \d+ more/u);
    expect(lastFrame()).toContain('↓ 8 more');
  });

  it('says what the keys do, and takes a caller’s wording instead', () => {
    const items = [{ key: 'model', label: '/model' }];
    const { lastFrame } = render(<Completions items={items} selected={0} />);
    expect(lastFrame()).toContain('↑↓ move · Tab complete · Enter run');

    const custom = render(<Completions items={items} selected={0} hint="Tab to fill in" />);
    expect(custom.lastFrame()).toContain('Tab to fill in');
    expect(custom.lastFrame()).not.toContain('Enter run');
  });
});
