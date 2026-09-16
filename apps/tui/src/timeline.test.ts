/**
 * What `/timeline` lists.
 *
 * Every conversation here is built the way the app builds one: a real
 * {@link TranscriptModel} fed hand-made provider events, flushed synchronously.
 * That is the point of the module — a turn is a stretch of the model, and the
 * interesting cases (a steer that splits a run, a replay with no run-end at
 * all, an edit that failed) only exist once the model has shaped the rows.
 *
 * The exceptions are the width cases at the foot, which assemble a {@link Turn}
 * directly: a `Turn` is this module's own shape rather than something the model
 * hands back, and a narrow terminal is easier to read about when the prompt
 * being clipped is on the same screen as the number it is clipped to.
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent, RunEndReason } from '@rx-artemis/protocol';
import { TranscriptModel, syncScheduler } from '@rx-artemis/transcript';

import { timelineLines, timelineSummary, turnsOf, type Turn, type TurnOutcome } from './timeline.js';

/** One event of a run, minus the envelope — which the harness fills in. */
type Draft = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, 'runId' | 'seq' | 'ts'> : never) : never;

/** A draft, optionally placing itself in time or on a run of its own. */
type Event = Draft & { readonly ts?: number; readonly runId?: string };

/** 2026-03-05 14:02 local, so `14:02` is what a line reads whatever the box's timezone. */
const AT = new Date(2026, 2, 5, 14, 2).getTime();

/** Five minutes later, and a different clock reading. */
const LATER = new Date(2026, 2, 5, 14, 7).getTime();

/** A model with these events applied, one millisecond apart unless placed. */
function transcript(...events: readonly Event[]): TranscriptModel {
  const model = new TranscriptModel(syncScheduler);
  events.forEach((event, index) => {
    model.apply({ ...event, runId: event.runId ?? 'run_1', seq: index, ts: event.ts ?? AT + index } as AgentEvent);
  });
  model.flush();
  return model;
}

/** A turn that ran a command, edited a file, read one, and finished. */
function worked(): TranscriptModel {
  return transcript(
    {
      type: 'text.complete',
      role: 'user',
      messageId: 'run_1:prompt:1',
      text: 'Fix the failing test in the parser.\nIt is the one about escapes.',
    },
    { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'pnpm test' } },
    { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: '1 failed', durationMs: 4200 },
    { type: 'tool.start', toolCallId: 'c2', name: 'Read', input: { file_path: '/code/artemis/src/parser.ts' } },
    { type: 'tool.end', toolCallId: 'c2', status: 'ok', durationMs: 30 },
    {
      type: 'tool.start',
      toolCallId: 'c3',
      name: 'Edit',
      input: { file_path: '/code/artemis/src/parser.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
    },
    { type: 'tool.end', toolCallId: 'c3', status: 'ok', durationMs: 120 },
    { type: 'text.complete', role: 'assistant', messageId: 'm1', blockIndex: 0, text: 'Fixed.' },
    {
      type: 'run.end',
      reason: 'completed',
      durationMs: 66_000,
      usage: {
        scope: 'final',
        tokens: { inputTokens: 9_000, outputTokens: 400, cacheReadInputTokens: 200 },
        costUsd: 0.04,
      },
    },
    // A second turn, stopped by hand five minutes later.
    { type: 'text.complete', role: 'user', messageId: 'run_2:prompt:1', text: 'Ship it.', ts: LATER, runId: 'run_2' },
    { type: 'tool.start', toolCallId: 'c4', name: 'Bash', input: { command: 'git push' }, ts: LATER + 1, runId: 'run_2' },
    { type: 'tool.end', toolCallId: 'c4', status: 'ok', durationMs: 900, ts: LATER + 2, runId: 'run_2' },
    {
      type: 'run.end',
      reason: 'interrupted',
      durationMs: 12_000,
      usage: { scope: 'final', tokens: { inputTokens: 1_500, outputTokens: 20 }, costUsd: 0.01 },
      ts: LATER + 3,
      runId: 'run_2',
    },
  );
}

/* -------------------------------------------------------------------------- */

describe('turnsOf', () => {
  it('gives one turn per prompt, carrying the run-end figures and the files it touched', () => {
    const turns = turnsOf(worked());

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      index: 1,
      runId: 'run_1',
      ts: AT,
      prompt: 'Fix the failing test in the parser.',
      durationMs: 66_000,
      // Billable input, cached and uncached — what `tok` means everywhere else.
      tokens: 9_200,
      costUsd: 0.04,
      files: ['/code/artemis/src/parser.ts'],
      edits: 1,
      commands: 1,
      reads: 1,
      outcome: 'completed',
    });
    expect(turns[1]).toMatchObject({
      index: 2,
      runId: 'run_2',
      ts: LATER,
      prompt: 'Ship it.',
      durationMs: 12_000,
      tokens: 1_500,
      commands: 1,
      files: [],
      outcome: 'interrupted',
    });
  });

  it('points each turn at the user row it opens at', () => {
    const model = worked();
    const [first] = turnsOf(model);
    expect(model.getItem(first?.userItemId ?? '')).toMatchObject({ kind: 'user', text: expect.stringContaining('parser') });
  });

  it('counts a file once however many times the turn edits it, and every edit separately', () => {
    const model = transcript(
      { type: 'text.complete', role: 'user', messageId: 'u1', text: 'Tidy the module.' },
      {
        type: 'tool.start',
        toolCallId: 'c1',
        name: 'Edit',
        input: { file_path: '/code/a.ts', old_string: 'one', new_string: 'two' },
      },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok' },
      {
        type: 'tool.start',
        toolCallId: 'c2',
        name: 'Edit',
        input: { file_path: '/code/a.ts', old_string: 'three', new_string: 'four' },
      },
      { type: 'tool.end', toolCallId: 'c2', status: 'ok' },
      { type: 'tool.start', toolCallId: 'c3', name: 'Write', input: { file_path: '/code/b.ts', content: 'export const b = 1;\n' } },
      { type: 'tool.end', toolCallId: 'c3', status: 'ok' },
      // One call, three files, one of them already counted.
      {
        type: 'tool.start',
        toolCallId: 'c4',
        name: 'ApplyPatch',
        input: {
          changes: [
            { path: '/code/a.ts', kind: 'update' },
            { path: '/code/c.ts', kind: 'add' },
          ],
        },
      },
      { type: 'tool.end', toolCallId: 'c4', status: 'ok' },
      { type: 'run.end', reason: 'completed', durationMs: 5_000 },
    );

    expect(turnsOf(model)[0]).toMatchObject({
      files: ['/code/a.ts', '/code/b.ts', '/code/c.ts'],
      // Two edits to `a.ts`, the write, and the patch's two files.
      edits: 5,
    });
  });

  it('leaves out an edit that failed: a file the agent could not write is not a file it touched', () => {
    const model = transcript(
      { type: 'text.complete', role: 'user', messageId: 'u1', text: 'Rewrite the config.' },
      {
        type: 'tool.start',
        toolCallId: 'c1',
        name: 'Edit',
        input: { file_path: '/etc/hosts', old_string: 'a', new_string: 'b' },
      },
      { type: 'tool.end', toolCallId: 'c1', status: 'denied' },
      { type: 'tool.start', toolCallId: 'c2', name: 'Bash', input: { command: 'sudo true' } },
      { type: 'tool.end', toolCallId: 'c2', status: 'error', error: { code: 'unknown', message: 'exit 1' } },
      { type: 'run.end', reason: 'completed', durationMs: 1_000 },
    );

    // The command still ran, and is still counted: the counts measure what was
    // done, the files measure what changed.
    expect(turnsOf(model)[0]).toMatchObject({ files: [], edits: 0, commands: 1 });
  });

  it('leaves the open turn running until a run-end lands under it', () => {
    const model = transcript(
      { type: 'text.complete', role: 'user', messageId: 'u1', text: 'First question.' },
      { type: 'run.end', reason: 'completed', durationMs: 900, usage: { scope: 'final', tokens: { inputTokens: 10, outputTokens: 2 } } },
      { type: 'text.complete', role: 'user', messageId: 'u2', text: 'Second question.', ts: LATER },
      { type: 'tool.start', toolCallId: 'c1', name: 'Grep', input: { pattern: 'parse' }, ts: LATER + 1 },
    );

    const turns = turnsOf(model);
    expect(turns.map((turn) => turn.outcome)).toEqual(['silent', 'running']);
    expect(turns[1]?.durationMs).toBeUndefined();
    expect(turns[1]?.tokens).toBeUndefined();
  });

  it('names a run that produced nothing rather than reporting a turn that did work', () => {
    const model = transcript(
      { type: 'text.complete', role: 'user', messageId: 'u1', text: 'Are you there?' },
      { type: 'run.end', reason: 'completed', durationMs: 52, usage: { scope: 'final', tokens: { inputTokens: 0, outputTokens: 0 } } },
    );

    expect(turnsOf(model)[0]).toMatchObject({ outcome: 'silent', durationMs: 52, tokens: 0 });
  });

  it('reads every way a run can stop as one of the two unhappy endings', () => {
    const endings: readonly (readonly [RunEndReason, TurnOutcome])[] = [
      ['interrupted', 'interrupted'],
      ['disposed', 'interrupted'],
      ['permission_denied', 'interrupted'],
      ['error', 'error'],
      ['max_turns', 'error'],
      ['budget_exceeded', 'error'],
    ];

    for (const [reason, outcome] of endings) {
      const model = transcript(
        { type: 'text.complete', role: 'user', messageId: 'u1', text: 'Go.' },
        { type: 'text.complete', role: 'assistant', messageId: 'm1', blockIndex: 0, text: 'Working…' },
        { type: 'run.end', reason },
      );
      expect(turnsOf(model)[0]?.outcome, reason).toBe(outcome);
    }
  });

  it('carries the message of a run that failed, for the row to explain itself', () => {
    const model = transcript(
      { type: 'text.complete', role: 'user', messageId: 'u1', text: 'Deploy it.' },
      { type: 'text.complete', role: 'assistant', messageId: 'm1', blockIndex: 0, text: 'Starting.' },
      { type: 'run.end', reason: 'error', error: { code: 'unknown', message: 'provider hung up' } },
    );

    expect(turnsOf(model)[0]).toMatchObject({ outcome: 'error', error: 'provider hung up' });
  });

  it('gives a steer a turn of its own, and the figures to the turn the run-end landed in', () => {
    const model = transcript(
      { type: 'text.complete', role: 'user', messageId: 'u1', text: 'Start the work.' },
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'pnpm build' } },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok' },
      // Typed while the agent was working: one run, two turns.
      { type: 'text.complete', role: 'user', messageId: 'u2', text: 'Also update the docs.' },
      { type: 'tool.start', toolCallId: 'c2', name: 'Read', input: { file_path: '/code/README.md' } },
      { type: 'tool.end', toolCallId: 'c2', status: 'ok' },
      { type: 'run.end', reason: 'completed', durationMs: 30_000, usage: { scope: 'final', tokens: { inputTokens: 500, outputTokens: 5 } } },
    );

    const turns = turnsOf(model);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ commands: 1, outcome: 'completed' });
    expect(turns[0]?.durationMs).toBeUndefined();
    expect(turns[0]?.tokens).toBeUndefined();
    expect(turns[1]).toMatchObject({ reads: 1, outcome: 'completed', durationMs: 30_000, tokens: 500 });
  });

  it('does not call the last turn of a replayed conversation running', () => {
    const model = transcript(
      { type: 'text.complete', role: 'user', replay: true, messageId: '7c1f-aaaa', text: 'What does this do?' },
      { type: 'text.complete', role: 'assistant', replay: true, messageId: 'm1', blockIndex: 0, text: 'It parses.' },
      { type: 'text.complete', role: 'user', replay: true, messageId: '7c1f-bbbb', text: 'And this?' },
      { type: 'text.complete', role: 'assistant', replay: true, messageId: 'm2', blockIndex: 0, text: 'It prints.' },
    );

    // Stored history has no run-ends at all, so "no run-end yet" cannot mean
    // "still going" here.
    expect(turnsOf(model).map((turn) => turn.outcome)).toEqual(['completed', 'completed']);
    // And the provider's own uuid is not a run id.
    expect(turnsOf(model)[0]?.runId).toBeUndefined();
  });

  it('attributes nothing to a prompt that had not been typed yet', () => {
    const model = transcript(
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'git status' } },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok' },
      { type: 'text.complete', role: 'user', messageId: 'u1', text: 'What changed?' },
      { type: 'tool.start', toolCallId: 'c2', name: 'Read', input: { file_path: '/code/a.ts' } },
      { type: 'tool.end', toolCallId: 'c2', status: 'ok' },
      { type: 'run.end', reason: 'completed', durationMs: 1_000 },
    );

    const turns = turnsOf(model);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ commands: 0, reads: 1 });
  });

  it('orders turns by when they were asked, not by when they arrived', () => {
    const model = transcript(
      { type: 'text.complete', role: 'user', messageId: 'u1', text: 'Asked second.', ts: LATER },
      { type: 'run.end', reason: 'completed', durationMs: 1, ts: LATER + 1 },
      { type: 'text.complete', role: 'user', messageId: 'u2', text: 'Asked first.', ts: AT },
      { type: 'run.end', reason: 'completed', durationMs: 1, ts: AT + 1 },
    );

    expect(turnsOf(model).map((turn) => [turn.index, turn.prompt])).toEqual([
      [1, 'Asked first.'],
      [2, 'Asked second.'],
    ]);
  });

  it('is empty for a conversation nobody has spoken in', () => {
    expect(turnsOf(transcript())).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('timelineLines', () => {
  it('reads as the number, the clock and the prompt, with the figures alongside', () => {
    const turns = turnsOf(worked());
    const lines = timelineLines(turns, 100);

    expect(lines[0]).toEqual({
      id: turns[0]?.userItemId,
      text: '#1 · 14:02 · Fix the failing test in the parser.',
      detail: '1m 6s · 9.2k tok · $0.040 · 1 file',
    });
    expect(lines[1]).toEqual({
      id: turns[1]?.userItemId,
      text: '#2 · 14:07 · Ship it.',
      detail: '12s · 1.5k tok · $0.010 · interrupted',
    });
  });

  it('clips the prompt to the width and leaves the figures whole', () => {
    const lines = timelineLines(turnsOf(worked()), 80);
    const widest = Math.max(...lines.map((line) => line.detail.length));

    expect(lines[0]?.text).toBe('#1 · 14:02 · Fix the failing test in the…');
    expect(lines[0]?.detail).toBe('1m 6s · 9.2k tok · $0.040 · 1 file');
    // The text, the two spaces the picker puts between them, and the *widest*
    // detail — every row gets the same budget, so the prompts end in one place
    // rather than jittering with the length of each row's own figures.
    expect((lines[0]?.text.length ?? 0) + 2 + widest).toBe(80);
    expect(lines[1]?.detail).toBe('12s · 1.5k tok · $0.010 · interrupted');
  });

  it('keeps a readable stub of the prompt in a terminal too narrow for one', () => {
    const [line] = timelineLines([turn({ durationMs: 66_000, tokens: 9_200, costUsd: 0.04, files: ['/code/a.ts'] })], 40);
    expect(line?.text).toBe('#1 · 14:02 · Fix the failing…');
  });

  it('says how a turn ended when it ended in anything but finishing', () => {
    const details = (outcome: TurnOutcome): string | undefined =>
      timelineLines([turn({ outcome, durationMs: 2_000 })], 80)[0]?.detail;

    expect(details('completed')).toBe('2.0s');
    expect(details('interrupted')).toBe('2.0s · interrupted');
    expect(details('error')).toBe('2.0s · error');
    expect(details('silent')).toBe('2.0s · no reply');
    expect(details('running')).toBe('2.0s · running');
  });

  it('leaves the detail empty when a turn has told us nothing yet, and still heads the line', () => {
    const [line] = timelineLines([turn({ prompt: '', outcome: 'completed' })], 80);
    expect(line).toEqual({ id: 'u:1', text: '#1 · 14:02 · (no prompt)', detail: '' });
  });
});

/* -------------------------------------------------------------------------- */

describe('timelineSummary', () => {
  it('adds the turns up and counts each file once', () => {
    expect(timelineSummary(turnsOf(worked()))).toBe('2 turns · 1m 18s · 11k tok · $0.050 · 1 file');
  });

  it('counts a file edited in two turns as one file', () => {
    const turns = [
      turn({ index: 1, durationMs: 1_000, files: ['/code/a.ts', '/code/b.ts'] }),
      turn({ index: 2, durationMs: 2_000, files: ['/code/a.ts'] }),
    ];
    expect(timelineSummary(turns)).toBe('2 turns · 3.0s · 2 files');
  });

  it('says only what it knows about a turn still running', () => {
    expect(timelineSummary([turn({ outcome: 'running' })])).toBe('1 turn');
  });

  it('says so when there is nothing to list', () => {
    expect(timelineSummary([])).toBe('No turns yet');
  });
});

/** A turn assembled directly, for the cases that are about a number, not a model. */
function turn(over: Partial<Turn> = {}): Turn {
  return {
    index: 1,
    userItemId: 'u:1',
    ts: AT,
    prompt: 'Fix the failing test in the parser.',
    files: [],
    edits: 0,
    commands: 0,
    reads: 0,
    outcome: 'completed',
    ...over,
  };
}
