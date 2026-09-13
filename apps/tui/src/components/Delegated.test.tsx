/**
 * The strip says what is running, and only what is running.
 *
 * Every case here is one the transcript gets wrong by construction: work that
 * is still going but whose tool call has already closed, a workflow whose one
 * elapsed time says nothing about how far through it is, and a fan-out big
 * enough to take the screen if nothing bounded it.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { BackgroundTask, WorkflowAgent } from '@rx-artemis/protocol';

import { DelegatedStrip, delegatedRows, summarizePhases } from './Delegated.js';

const NOW = 1_700_000_000_000;

const task = (over: Partial<BackgroundTask> & { readonly id: string }): BackgroundTask => ({
  kind: 'local_subagent',
  description: 'do the thing',
  status: 'running',
  startedAt: NOW - 1_000,
  ...over,
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe('delegatedRows', () => {
  it('names a subagent by its type and says what it is doing', () => {
    const { rows } = delegatedRows(
      [
        task({
          id: 'a',
          subagentType: 'Explore',
          description: 'auth call sites',
          startedAt: NOW - 72_000,
          lastToolName: 'Grep',
          totalTokens: 24_100,
        }),
      ],
      NOW,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('Explore');
    expect(rows[0]?.description).toBe('auth call sites');
    // `24k` rather than `24.1k`: the transcript's own formatter drops the
    // decimal past ten thousand, and the strip uses it rather than a second
    // opinion, so a token count reads the same here as on the status line.
    expect(rows[0]?.detail).toBe('1m 12s · Grep · 24k tok');
  });

  it('drops settled work rather than lingering on it', () => {
    // `state.tasks` keeps settled rows on purpose — the moment a task finishes
    // is the moment its result is worth reading — but this strip answers "what
    // is running", and a row that stayed would make it mean nothing in
    // particular. The whole thing goes when the last task settles.
    const tasks = [
      task({ id: 'done', status: 'completed', endedAt: NOW - 500 }),
      task({ id: 'failed', status: 'failed' }),
      task({ id: 'stopped', status: 'stopped' }),
    ];
    expect(delegatedRows(tasks, NOW).rows).toEqual([]);
  });

  it('keeps pending and paused work, which is live in every sense that matters', () => {
    const tasks = [task({ id: 'queued', status: 'pending' }), task({ id: 'held', status: 'paused' })];
    expect(delegatedRows(tasks, NOW).rows.map((row) => row.id)).toEqual(['queued', 'held']);
  });

  it('leaves ambient housekeeping to /tasks', () => {
    // The provider's own guidance for these is "do not show this inline", and
    // the strip is as inline as it gets.
    const tasks = [task({ id: 'chore', ambient: true }), task({ id: 'real' })];
    expect(delegatedRows(tasks, NOW).rows.map((row) => row.id)).toEqual(['real']);
  });

  it('bounds itself and counts the rest', () => {
    // A fan-out of twelve must not take the transcript's screen.
    const tasks = Array.from({ length: 12 }, (_, i) => task({ id: `t${String(i)}` }));
    const { rows, hidden } = delegatedRows(tasks, NOW);
    expect(rows).toHaveLength(3);
    expect(hidden).toBe(9);
    // In the order they were delegated, and the same three next second: a row
    // that reorders as its neighbours settle is a row the eye has to find again.
    expect(rows.map((row) => row.id)).toEqual(['t0', 't1', 't2']);
  });

  it('believes the provider’s own duration over the time since we heard of it', () => {
    // They differ by however long the CLI took to tell us, and the provider is
    // measuring the work.
    const { rows } = delegatedRows(
      [task({ id: 'a', startedAt: NOW - 1_000, durationMs: 65_000 })],
      NOW,
    );
    expect(rows[0]?.detail).toBe('1m 5s');
  });

  it('keeps the name over the readout when the terminal is narrow', () => {
    // The right-hand half does not shrink, so every character of it is one
    // taken off the name of the thing running — and the name is the part worth
    // having. Elapsed alone still answers "is this stuck".
    const one = task({ id: 'a', subagentType: 'Explore', lastToolName: 'Grep', totalTokens: 24_100 });
    expect(delegatedRows([one], NOW, 120).rows[0]?.detail).toBe('1.0s · Grep · 24k tok');
    expect(delegatedRows([one], NOW, 50).rows[0]?.detail).toBe('1.0s');
  });

  it('does not print a task’s own name twice', () => {
    const { rows } = delegatedRows([task({ id: 'a', kind: 'local_bash', description: 'Shell' })], NOW);
    expect(rows[0]?.label).toBe('Shell');
    expect(rows[0]?.description).toBe('');
  });

  it('shows a kind it has never heard of rather than a shrug', () => {
    // `kind` is an open string by contract: a row reading `local_sandbox` is a
    // fact, and one reading "Task" tells the reader nothing.
    const { rows } = delegatedRows([task({ id: 'a', kind: 'local_sandbox' })], NOW);
    expect(rows[0]?.label).toBe('local_sandbox');
  });
});

describe('summarizePhases', () => {
  const agent = (over: Partial<WorkflowAgent> & { readonly index: number }): WorkflowAgent => ({
    label: `agent-${String(over.index)}`,
    state: 'progress',
    ...over,
  });

  it('counts each phase in declared order', () => {
    const progress = [
      agent({ index: 0, phaseIndex: 0, phaseTitle: 'Review', state: 'done' }),
      agent({ index: 1, phaseIndex: 1, phaseTitle: 'Verify', state: 'done' }),
      agent({ index: 2, phaseIndex: 0, phaseTitle: 'Review', state: 'done' }),
      agent({ index: 3, phaseIndex: 1, phaseTitle: 'Verify', state: 'progress' }),
      agent({ index: 4, phaseIndex: 0, phaseTitle: 'Review', state: 'error' }),
      agent({ index: 5, phaseIndex: 1, phaseTitle: 'Verify', state: 'start' }),
    ];
    // An error is finished too: a phase that is waiting on nothing must not
    // read as though it were still working.
    expect(summarizePhases(progress)).toBe('Review 3/3 · Verify 1/3');
  });

  it('keeps a title an earlier agent established', () => {
    const progress = [
      agent({ index: 0, phaseIndex: 0, phaseTitle: 'Review' }),
      agent({ index: 1, phaseIndex: 0 }),
    ];
    expect(summarizePhases(progress)).toBe('Review 0/2');
  });

  it('still counts a workflow whose script never called phase()', () => {
    const progress = [agent({ index: 0, state: 'done' }), agent({ index: 1 })];
    expect(summarizePhases(progress)).toBe('1/2 agents');
  });

  it('stops naming phases before the readout takes the row', () => {
    const progress = Array.from({ length: 6 }, (_, i) =>
      agent({ index: i, phaseIndex: i, phaseTitle: `Phase${String(i)}` }),
    );
    expect(summarizePhases(progress)).toBe('Phase0 0/1 · Phase1 0/1 · Phase2 0/1 · …');
  });

  it('has nothing to say about a task that is not a workflow', () => {
    expect(summarizePhases(undefined)).toBe('');
    expect(summarizePhases([])).toBe('');
  });
});

describe('DelegatedStrip', () => {
  it('draws nothing when nothing is delegated', async () => {
    // The common case, and it must cost nothing: a conversation that never
    // delegates is laid out exactly as it was before the strip existed.
    const { lastFrame } = render(<DelegatedStrip tasks={[]} />);
    await tick();
    expect(lastFrame()).toBe('');
  });

  it('draws nothing when every task has settled', async () => {
    const { lastFrame } = render(
      <DelegatedStrip tasks={[task({ id: 'a', status: 'completed', endedAt: NOW })]} />,
    );
    await tick();
    expect(lastFrame()).toBe('');
  });

  it('shows the live work and defers the rest to /tasks', async () => {
    const tasks = [
      task({ id: 'a', subagentType: 'Explore', description: 'auth call sites' }),
      task({ id: 'b', subagentType: 'Plan', description: 'migration steps' }),
      task({ id: 'c', kind: 'local_workflow', workflowName: 'review-changes', description: 'a long paragraph' }),
      task({ id: 'd', subagentType: 'Explore', description: 'the fourth one' }),
      task({ id: 'e', subagentType: 'Explore', description: 'the fifth one' }),
    ];
    const { lastFrame } = render(<DelegatedStrip tasks={tasks} />);
    await tick();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Explore');
    expect(frame).toContain('auth call sites');
    expect(frame).toContain('Plan');
    expect(frame).toContain('+2 more · /tasks');
    // A workflow is known by its name; its description is a paragraph.
    expect(frame).not.toContain('a long paragraph');
    expect(frame).not.toContain('the fifth one');
  });
});
