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

import {
  DelegatedStrip,
  delegatedRows,
  summarizePhases,
  MAX_AGENT_ROWS,
  type DelegatedRow,
} from './Delegated.js';

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

  it('names a delegated agent before its type has arrived', () => {
    // The first `background.tasks` of a fan-out carries `kind: 'local_agent'`
    // and no `subagentType` — observed on a live run — so for one frame this
    // map is the only thing standing between the reader and a row labelled
    // `local_agent`. The type takes over the moment it lands.
    expect(delegatedRows([task({ id: 'a', kind: 'local_agent' })], NOW).rows[0]?.label).toBe('Subagent');
    expect(
      delegatedRows([task({ id: 'a', kind: 'local_agent', subagentType: 'Explore' })], NOW).rows[0]?.label,
    ).toBe('Explore');
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

/** One agent inside a workflow, as the workflow reports it. */
const inner = (over: Partial<WorkflowAgent> & { readonly index: number }): WorkflowAgent => ({
  label: `agent-${String(over.index)}`,
  state: 'progress',
  ...over,
});

/** A workflow task carrying agents of its own. */
const workflow = (agents: readonly WorkflowAgent[]): BackgroundTask =>
  task({
    id: 'w',
    kind: 'local_workflow',
    workflowName: 'review-changes',
    description: 'a long paragraph',
    workflowProgress: agents,
  });

const UNFOLDED = { expanded: new Set(['w']) };

describe('delegatedRows · what can be done to a row', () => {
  it('says which rows open onto a conversation and which only stop', () => {
    // Three different answers, and none of them guessable from the row's text:
    // a delegated agent has a transcript filed under the id the task list
    // carries, a backgrounded shell never had one, and a workflow's own id has
    // none because the transcripts belong to the agents inside it.
    const { rows } = delegatedRows(
      [
        task({ id: 'agent', kind: 'local_agent', subagentType: 'Explore' }),
        task({ id: 'shell', kind: 'local_bash', description: 'pnpm test' }),
        workflow([inner({ index: 0 })]),
      ],
      NOW,
    );

    expect(rows.map((row) => [row.kind, row.openable, row.stoppable])).toEqual([
      ['task', true, true],
      ['task', false, true],
      ['task', false, true],
    ]);
    expect(rows[0]?.agentId).toBe('agent');
    expect(rows[1]?.agentId).toBeUndefined();
    // Only the workflow can be opened up, and only it draws a fold glyph.
    expect(rows.map((row) => row.unfoldable)).toEqual([false, false, true]);
  });

  it('has nothing to unfold on a workflow that has not reported an agent yet', () => {
    const { rows } = delegatedRows([workflow([])], NOW);
    expect(rows[0]?.unfoldable).toBe(false);
  });

  it('leaves a workflow folded until it is asked', () => {
    // The strip is spending the transcript's own lines. Agents appear because
    // somebody pressed `→` on that row, never because a workflow started.
    const { rows } = delegatedRows([workflow([inner({ index: 0 })])], NOW);
    expect(rows).toHaveLength(1);
  });

  it('unfolds a workflow into its agents, with phase, type, elapsed and state', () => {
    const { rows } = delegatedRows(
      [
        workflow([
          inner({
            index: 0,
            phaseTitle: 'Review',
            agentType: 'Explore',
            durationMs: 40_000,
            state: 'done',
            agentId: 'ag-0',
          }),
          inner({ index: 1, phaseTitle: 'Verify', agentType: 'Plan', startedAt: NOW - 12_000 }),
        ]),
      ],
      NOW,
      120,
      UNFOLDED,
    );

    expect(rows.map((row) => row.kind)).toEqual(['task', 'agent', 'agent']);
    expect(rows[1]).toMatchObject({
      taskId: 'w',
      agentId: 'ag-0',
      label: 'Review',
      description: 'Explore',
      detail: '40s · done',
      // The one place in the terminal a workflow's agent can be opened from:
      // they are not tasks and never appear in the task list.
      openable: true,
      // There is no per-agent stop, and `x` here killing the whole workflow is
      // not what the key would have meant.
      stoppable: false,
    });
    expect(rows[2]).toMatchObject({ label: 'Verify', detail: '12s · progress', openable: false });
    expect(rows[2]?.agentId).toBeUndefined();
  });

  it('will not offer to open an agent that has not run', () => {
    // Queued, or answered from the workflow's journal: either way there is no
    // conversation behind the row, and no elapsed time to print beside a state
    // that says so itself.
    const { rows } = delegatedRows([workflow([inner({ index: 0, state: 'start' })])], NOW, 120, UNFOLDED);
    expect(rows[1]?.detail).toBe('start');
    expect(rows[1]?.openable).toBe(false);
  });

  it('names an agent by its own label when the script never called phase()', () => {
    const { rows } = delegatedRows(
      [workflow([inner({ index: 0, label: 'build:chat-reliability' })])],
      NOW,
      120,
      UNFOLDED,
    );
    expect(rows[1]?.label).toBe('build:chat-reliability');
  });

  it('holds the agents in the order the script declared them', () => {
    // The whole array is replaced on every progress message, so the order it
    // arrives in is not a promise; the ordinal is.
    const { rows } = delegatedRows(
      [
        workflow([
          inner({ index: 2, phaseTitle: 'C' }),
          inner({ index: 0, phaseTitle: 'A' }),
          inner({ index: 1, phaseTitle: 'B' }),
        ]),
      ],
      NOW,
      120,
      UNFOLDED,
    );
    expect(rows.filter((row) => row.kind === 'agent').map((row) => row.label)).toEqual(['A', 'B', 'C']);
  });

  it('caps an unfolded workflow separately from the tasks, and counts the rest', () => {
    // A reader who opened this row asked to see inside it, so the cap is the
    // larger one — but a fan-out of twenty still must not take the screen.
    const agents = Array.from({ length: 12 }, (_, i) => inner({ index: i }));
    const { rows, hidden, hiddenAgents } = delegatedRows([workflow(agents)], NOW, 120, UNFOLDED);

    expect(rows.filter((row) => row.kind === 'agent')).toHaveLength(MAX_AGENT_ROWS);
    expect(hiddenAgents.get('w')).toBe(12 - MAX_AGENT_ROWS);
    // The top-level count is untouched by unfolding: one task, all of it shown.
    expect(hidden).toBe(0);
  });

  it('unfolds nothing for a task that has no agents to show', () => {
    const { rows, hiddenAgents } = delegatedRows(
      [task({ id: 'w', subagentType: 'Explore' })],
      NOW,
      120,
      UNFOLDED,
    );
    expect(rows).toHaveLength(1);
    expect(hiddenAgents.size).toBe(0);
  });
});

describe('DelegatedStrip · the cursor', () => {
  const two = [
    task({ id: 'a', kind: 'local_agent', subagentType: 'Explore', description: 'auth call sites' }),
    task({ id: 'b', kind: 'local_agent', subagentType: 'Plan', description: 'migration steps' }),
  ];

  const lineWith = (frame: string | undefined, text: string): string =>
    (frame ?? '').split('\n').find((line) => line.includes(text)) ?? '';

  it('draws the cursor only while it has the focus', async () => {
    // The composer's cursor and this one must never both be lit — the rail's
    // rule, and the reason the rail draws its own the same way.
    const idle = render(<DelegatedStrip tasks={two} />);
    await tick();
    expect(idle.lastFrame()).not.toContain('❯');

    const lit = render(<DelegatedStrip tasks={two} focused selected={1} />);
    await tick();
    expect(lineWith(lit.lastFrame(), 'Plan')).toContain('❯');
    expect(lineWith(lit.lastFrame(), 'Explore')).not.toContain('❯');
  });

  it('says what its keys do, and says it only when the keys are live', async () => {
    const idle = render(<DelegatedStrip tasks={two} />);
    await tick();
    expect(idle.lastFrame()).not.toContain('Enter open');

    const lit = render(<DelegatedStrip tasks={two} focused />);
    await tick();
    expect(lit.lastFrame()).toContain('↑↓ · Enter open · x stop · → unfold · ← fold · Esc back');
  });

  it('hands the app the row under the cursor, clamped to the rows that exist', async () => {
    // Rows go as their work settles, so a selection the app set two seconds ago
    // can be past the end by the time it is drawn.
    const seen: { readonly row: DelegatedRow | undefined; readonly index: number }[] = [];
    render(
      <DelegatedStrip
        tasks={two}
        focused
        selected={9}
        onSelect={(row, index) => seen.push({ row, index })}
      />,
    );
    await tick();

    expect(seen.at(-1)?.index).toBe(1);
    expect(seen.at(-1)?.row?.id).toBe('b');
    expect(seen.at(-1)?.row?.openable).toBe(true);
  });

  it('tells the app there is nothing to act on when it is not focused', async () => {
    const seen: (DelegatedRow | undefined)[] = [];
    render(<DelegatedStrip tasks={two} selected={0} onSelect={(row) => seen.push(row)} />);
    await tick();
    expect(seen.at(-1)).toBeUndefined();
  });

  it('shows an unfolded workflow’s agents, and counts the ones it has no room for', async () => {
    const agents = [
      inner({
        index: 0,
        phaseTitle: 'Review',
        agentType: 'Explore',
        durationMs: 40_000,
        state: 'done',
        agentId: 'ag-0',
      }),
      ...Array.from({ length: 11 }, (_, i) => inner({ index: i + 1, phaseTitle: 'Verify' })),
    ];

    const folded = render(<DelegatedStrip tasks={[workflow(agents)]} />);
    await tick();
    expect(folded.lastFrame()).toContain('▸');
    expect(folded.lastFrame()).not.toContain('↳');

    const open = render(<DelegatedStrip tasks={[workflow(agents)]} expanded={new Set(['w'])} />);
    await tick();
    const frame = open.lastFrame() ?? '';
    expect(frame).toContain('▾');
    expect(frame).toContain('↳ Review · Explore · 40s · done');
    expect(frame).toContain(`+${String(12 - MAX_AGENT_ROWS)} more`);
  });
});
