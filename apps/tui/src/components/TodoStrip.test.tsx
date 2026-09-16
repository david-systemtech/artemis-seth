/**
 * The checklist is drawn, it stays small, and it goes away.
 *
 * Three things are being protected here. That the collapsed line answers "how
 * far along and on what" in one row, because that is the whole bargain the
 * strip strikes for its place above the composer. That a twenty-step plan
 * cannot take the terminal. And that a finished list stops being drawn — a
 * strip that lingered with `5/5` parked over the composer would be a place
 * where nothing means anything in particular.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { AgentEvent } from '@rx-artemis/protocol';
import { TranscriptModel, syncScheduler, type TodoItem, type TodoStatus } from '@rx-artemis/transcript';

import { TodoStrip, todoRows } from './TodoStrip.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

const todo = (text: string, status: TodoStatus): TodoItem => ({ text, status });

/** Envelope filler; timestamps rise with position, which is what "latest" rests on. */
function stream(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): AgentEvent[] {
  return drafts.map((draft, index) => ({ ...draft, runId: 'run_1', seq: index, ts: 1000 + index })) as AgentEvent[];
}

/** A transcript holding one `TodoWrite` per list handed in. */
function transcriptWith(...lists: Array<readonly TodoItem[]>): TranscriptModel {
  const model = new TranscriptModel(syncScheduler);
  const events = stream(
    ...lists.map((items, index) => ({
      type: 'tool.start' as const,
      toolCallId: `c${String(index)}`,
      name: 'TodoWrite',
      input: { todos: items.map((item) => ({ content: item.text, status: item.status })) },
    })),
  );
  for (const event of events) model.apply(event);
  return model;
}

const PLAN: readonly TodoItem[] = [
  todo('read the schema', 'completed'),
  todo('write the migration', 'completed'),
  todo('run the migration', 'in_progress'),
  todo('rerun the e2e suite', 'pending'),
  todo('open the pull request', 'pending'),
];

describe('todoRows', () => {
  it('says how far along and what is being worked on, in one line', () => {
    const { header, rows } = todoRows(PLAN, false);
    expect(header).toBe('Todo  2/5 · » run the migration');
    // Collapsed is the header and nothing else; that is what buys it the room.
    expect(rows).toEqual([]);
  });

  it('points at the next thing when the agent has not said it started one', () => {
    const { header } = todoRows([todo('read the schema', 'completed'), todo('run the migration', 'pending')], false);
    expect(header).toBe('Todo  1/2 · » run the migration');
  });

  it('says so when there is nothing left', () => {
    const done = [todo('read the schema', 'completed'), todo('patch the old one', 'cancelled')];
    expect(todoRows(done, true).header).toBe('Todo  1/2 · all done');
  });

  it('gives each state its own glyph when the list is open', () => {
    const { rows } = todoRows(
      [
        todo('read the schema', 'completed'),
        todo('run the migration', 'in_progress'),
        todo('rerun the e2e suite', 'pending'),
        todo('patch the old migration', 'cancelled'),
      ],
      true,
    );

    expect(rows).toEqual([
      '✓ read the schema',
      '» run the migration',
      '☐ rerun the e2e suite',
      '✗ patch the old migration',
    ]);
  });

  it('draws eight and counts the rest', () => {
    const many = Array.from({ length: 12 }, (_, i) => todo(`step ${String(i)}`, 'pending'));
    const { rows } = todoRows(many, true, 80);
    expect(rows).toHaveLength(9);
    expect(rows.at(-1)).toBe('  +4 more');
    // The head of the list, in the agent's own order. The item being worked on
    // is in the header whatever the window does, so the window can stay simple.
    expect(rows[0]).toBe('☐ step 0');
  });

  it('cuts the item to the room the width leaves it', () => {
    const long = 'x'.repeat(200);
    // 60 columns less the padding, the glyph and its gap is 56.
    const { rows } = todoRows([todo(long, 'pending')], true, 60);
    expect(rows[0]).toHaveLength(58);
    expect(rows[0]?.endsWith('…')).toBe(true);
  });

  it('cuts the item in the header and keeps the count', () => {
    const { header } = todoRows([todo('y'.repeat(200), 'in_progress')], false, 60);
    expect(header.startsWith('Todo  0/1 · » ')).toBe(true);
    expect(header.endsWith('…')).toBe(true);
    // The count is the cheapest useful thing on the line; it is not the casualty.
    expect(header.length).toBeLessThanOrEqual(60);
  });
});

describe('TodoStrip', () => {
  it('draws nothing for a conversation that never planned', async () => {
    const { lastFrame } = render(<TodoStrip transcript={new TranscriptModel(syncScheduler)} />);
    await tick();
    expect(lastFrame()).toBe('');
  });

  it('heads the collapsed strip with the count, the current item and the way in', async () => {
    const { lastFrame } = render(<TodoStrip transcript={transcriptWith(PLAN)} columns={80} />);
    await tick();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Todo  2/5 · » run the migration');
    expect(frame).toContain('Ctrl+T');
    // Collapsed: the list itself is not on screen.
    expect(frame).not.toContain('rerun the e2e suite');
  });

  it('shows the list with its glyphs when it is open', async () => {
    const { lastFrame } = render(<TodoStrip transcript={transcriptWith(PLAN)} expanded columns={80} />);
    await tick();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('✓ read the schema');
    expect(frame).toContain('» run the migration');
    expect(frame).toContain('☐ open the pull request');
  });

  it('goes away when the work is done and the list is shut', async () => {
    const done = [todo('read the schema', 'completed'), todo('run the migration', 'completed')];
    const { lastFrame } = render(<TodoStrip transcript={transcriptWith(done)} columns={80} />);
    await tick();
    // The finished checklist is a record, and records live in the transcript.
    expect(lastFrame()).toBe('');
  });

  it('still answers when the work is done and someone asked to see it', async () => {
    const done = [todo('read the schema', 'completed'), todo('run the migration', 'completed')];
    const { lastFrame } = render(<TodoStrip transcript={transcriptWith(done)} expanded columns={80} />);
    await tick();
    const frame = lastFrame() ?? '';

    // Answering a keypress with a blank screen is not an answer.
    expect(frame).toContain('Todo  2/2 · all done');
    expect(frame).toContain('✓ run the migration');
  });

  it('counts the steps it cannot fit', async () => {
    const many = Array.from({ length: 11 }, (_, i) => todo(`step ${String(i)}`, 'pending'));
    const { lastFrame } = render(<TodoStrip transcript={transcriptWith(many)} expanded columns={80} />);
    await tick();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('☐ step 7');
    expect(frame).toContain('+3 more');
    expect(frame).not.toContain('step 8');
  });

  it('redraws when the agent writes a new list', async () => {
    const transcript = transcriptWith([todo('read the schema', 'in_progress'), todo('run the migration', 'pending')]);
    const { lastFrame } = render(<TodoStrip transcript={transcript} columns={80} />);
    await tick();
    expect(lastFrame() ?? '').toContain('Todo  0/2 · » read the schema');

    transcript.apply(
      stream({
        type: 'tool.start',
        toolCallId: 'later',
        name: 'update_plan',
        input: {
          plan: [
            { step: 'read the schema', status: 'completed' },
            { step: 'run the migration', status: 'in_progress' },
          ],
        },
      })[0] as AgentEvent,
    );
    await tick();

    // A checklist that did not move with the plan would be worse than none.
    expect(lastFrame() ?? '').toContain('Todo  1/2 · » run the migration');
  });

  it('gives up the hint before it gives up the item', async () => {
    const { lastFrame } = render(<TodoStrip transcript={transcriptWith(PLAN)} columns={40} />);
    await tick();
    const frame = lastFrame() ?? '';

    expect(frame).not.toContain('Ctrl+T');
    expect(frame).toContain('run the migration');
  });
});
