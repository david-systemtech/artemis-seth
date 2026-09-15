/**
 * The strip shows the words, and it stays small.
 *
 * Both halves matter. The words are the point — a count already existed on the
 * status line and could not say which messages it was counting — and the size
 * is what lets the strip live in the transcript's column: someone who types six
 * follow-ups while the agent works must not lose the screen to the list of them.
 * The width cases are here because a terminal is as narrow as its owner made it,
 * and a row that spends its cells on a label has spent them on furniture.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';

import type { QueuedMessage } from '../conversation.js';
import { QueuedStrip, queuedRows } from './QueuedStrip.js';

const TS = 1_700_000_000_000;

const queued = (over: Partial<QueuedMessage> & { readonly id: string }): QueuedMessage => ({
  text: 'do the other thing too',
  delivery: 'next-tool-break',
  ts: TS,
  ...over,
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe('queuedRows', () => {
  it('keeps the order the provider will read them in', () => {
    const { rows, hidden } = queuedRows([
      queued({ id: 'a', text: 'also check the migration script' }),
      queued({ id: 'b', text: 'and rerun the e2e suite' }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
    expect(rows.map((row) => row.text)).toEqual([
      'also check the migration script',
      'and rerun the e2e suite',
    ]);
    expect(hidden).toBe(0);
  });

  it('says when each one expects to be read', () => {
    const { rows } = queuedRows([
      queued({ id: 'a' }),
      queued({ id: 'b', delivery: 'after-turn' }),
    ]);
    // Not the same promise: one is with the provider already, the other is not.
    expect(rows.map((row) => row.label)).toEqual(['next tool break', 'after this turn']);
  });

  it('bounds itself and counts the rest', () => {
    const many = Array.from({ length: 7 }, (_, i) => queued({ id: `q${String(i)}`, text: `message ${String(i)}` }));
    const { rows, hidden } = queuedRows(many, 100);
    expect(rows).toHaveLength(3);
    expect(hidden).toBe(4);
    // The next three to be read, not the last three typed: the strip answers
    // what the agent is about to be told.
    expect(rows.map((row) => row.id)).toEqual(['q0', 'q1', 'q2']);
  });

  it('cuts the text to the room the width leaves it', () => {
    // 60 columns less the padding, the glyph, the gap and the label is 40.
    const { rows } = queuedRows([queued({ id: 'a', text: 'x'.repeat(80) })], 60);
    expect(rows[0]?.text).toHaveLength(40);
    expect(rows[0]?.text.endsWith('…')).toBe(true);
  });

  it('gives up the label before it gives up the words', () => {
    const long = queued({ id: 'a', text: 'x'.repeat(80) });
    // Narrow: no label, and the text takes the fifteen cells it freed.
    expect(queuedRows([long], 50).rows[0]?.label).toBe('');
    expect(queuedRows([long], 50).rows[0]?.text).toHaveLength(45);
    expect(queuedRows([long], 100).rows[0]?.label).toBe('next tool break');
  });

  it('flattens a pasted message into one line', () => {
    // What arrives is whatever was typed, newlines and all; a row is one row.
    const { rows } = queuedRows([queued({ id: 'a', text: 'first line\n\nsecond   line' })]);
    expect(rows[0]?.text).toBe('first line second line');
  });

  it('has nothing to say when nothing is waiting', () => {
    expect(queuedRows([]).rows).toEqual([]);
    expect(queuedRows([]).hidden).toBe(0);
  });
});

describe('QueuedStrip', () => {
  it('draws nothing when nothing is waiting', async () => {
    // The common case, and it must cost nothing: a conversation that never
    // steers is laid out exactly as it was before the strip existed.
    const { lastFrame } = render(<QueuedStrip messages={[]} />);
    await tick();
    expect(lastFrame()).toBe('');
  });

  it('heads the list with the way out of it', async () => {
    const { lastFrame } = render(<QueuedStrip messages={[queued({ id: 'a', text: 'one more thing' })]} />);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Queued · ↑ takes the newest back');
    expect(frame).toContain('↳ one more thing');
    expect(frame).toContain('next tool break');
  });

  it('shows three and counts the fourth', async () => {
    const messages = [
      queued({ id: 'a', text: 'check the migration script' }),
      queued({ id: 'b', text: 'rerun the e2e suite' }),
      queued({ id: 'c', text: 'then push the branch', delivery: 'after-turn' }),
      queued({ id: 'd', text: 'and open the pull request' }),
    ];
    const { lastFrame } = render(<QueuedStrip messages={messages} columns={80} />);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('check the migration script');
    expect(frame).toContain('rerun the e2e suite');
    expect(frame).toContain('then push the branch');
    expect(frame).toContain('after this turn');
    expect(frame).toContain('+1 more');
    expect(frame).not.toContain('and open the pull request');
  });

  it('truncates a message too long for the row', async () => {
    const text = 'please also take a look at the retry logic in the uploader, which I think double-counts attempts';
    const { lastFrame } = render(<QueuedStrip messages={[queued({ id: 'a', text })]} columns={60} />);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('please also take a look at the retry');
    expect(frame).toContain('…');
    expect(frame).not.toContain('double-counts');
  });
});
