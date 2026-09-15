/**
 * Three providers, three spellings, one checklist.
 *
 * The cases here are the real payloads — Claude's `TodoWrite`, Codex's
 * `update_plan`, Gemini's `write_todos` — plus the two failure modes that
 * matter: a shape nobody has written yet, which must still parse, and an
 * unrelated tool's array, which must not.
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@rx-artemis/protocol';

import { TranscriptModel, syncScheduler } from './transcript.js';
import { isTodoTool, latestTodos, parseTodos } from './todos.js';

/** Envelope filler, so the tests read as event bodies rather than plumbing. */
function stream(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): AgentEvent[] {
  return drafts.map((draft, index) => ({ ...draft, runId: 'run_1', seq: index, ts: 1000 + index })) as AgentEvent[];
}

describe('parseTodos', () => {
  it("reads Claude's TodoWrite", () => {
    const items = parseTodos('TodoWrite', {
      todos: [
        { content: 'read the schema', status: 'completed', activeForm: 'Reading the schema' },
        { content: 'run the migration', status: 'in_progress', activeForm: 'Running the migration' },
        { content: 'rerun the e2e suite', status: 'pending', activeForm: 'Rerunning the e2e suite' },
      ],
    });

    // `content` and not `activeForm`: one row in the gerund among three
    // imperatives reads as a different list.
    expect(items).toEqual([
      { text: 'read the schema', status: 'completed' },
      { text: 'run the migration', status: 'in_progress' },
      { text: 'rerun the e2e suite', status: 'pending' },
    ]);
  });

  it("reads Codex's update_plan, and ignores the prose it comes with", () => {
    const items = parseTodos('update_plan', {
      explanation: 'Starting on the migration now that the schema is read.',
      plan: [
        { step: 'read the schema', status: 'completed' },
        { step: 'run the migration', status: 'in_progress' },
      ],
    });

    expect(items).toEqual([
      { text: 'read the schema', status: 'completed' },
      { text: 'run the migration', status: 'in_progress' },
    ]);
  });

  it("reads Gemini's write_todos, cancellations and all", () => {
    const items = parseTodos('write_todos', {
      todos: [
        { description: 'read the schema', status: 'completed' },
        { description: 'patch the old migration', status: 'cancelled' },
        { description: 'run the migration', status: 'in_progress' },
      ],
    });

    // A step dropped on purpose is not a step left undone, so it keeps a state
    // of its own rather than being folded into `pending`.
    expect(items?.map((item) => item.status)).toEqual(['completed', 'cancelled', 'in_progress']);
  });

  it('parses a shape nobody has written yet', () => {
    // The point of the fallback: a fourth provider spelling the same idea a
    // fourth way should draw, not blank the strip with no clue why.
    const items = parseTodos('plan_update', {
      items: [
        { title: 'draft the ADR', state: 'DONE' },
        { title: 'circulate it', state: 'in-progress' },
        { title: 'merge it', state: 'not started' },
      ],
    });

    expect(items).toEqual([
      { text: 'draft the ADR', status: 'completed' },
      { text: 'circulate it', status: 'in_progress' },
      { text: 'merge it', status: 'pending' },
    ]);
  });

  it('keeps the entries that parse and drops the ones that do not', () => {
    // Half a checklist is still worth drawing.
    const items = parseTodos('TodoWrite', {
      todos: [
        { content: 'read the schema', status: 'completed' },
        { activeForm: 'Something with no content at all' },
        'not an object at all',
        { content: '   ', status: 'pending' },
        { content: 'run the migration', status: 'in_progress' },
      ],
    });

    expect(items?.map((item) => item.text)).toEqual(['read the schema', 'run the migration']);
  });

  it('takes a status it has never seen as pending rather than dropping the row', () => {
    const items = parseTodos('TodoWrite', {
      todos: [
        { content: 'read the schema', status: 'completed' },
        { content: 'run the migration', status: 'blocked-on-review' },
      ],
    });

    expect(items?.[1]).toEqual({ text: 'run the migration', status: 'pending' });
  });

  it('says nothing about a tool that is not a todo tool', () => {
    // Even when the input would have parsed: the name is half the test.
    expect(parseTodos('Bash', { todos: [{ content: 'ls', status: 'pending' }] })).toBeNull();
    expect(parseTodos('mcp__tracker__list_issues', { items: [{ title: 'x', status: 'done' }] })).toBeNull();
  });

  it('leaves ExitPlanMode alone, which names a plan and is not a list', () => {
    expect(isTodoTool('ExitPlanMode')).toBe(false);
    expect(parseTodos('ExitPlanMode', { plan: '## Steps\n\n1. Read the schema\n2. Migrate' })).toBeNull();
  });

  it('refuses an array that has no notion of done', () => {
    // A list of labels is not a checklist, whatever the tool is called — and
    // the difference is the only thing keeping the loose name test safe.
    expect(parseTodos('planner', { items: [{ title: 'one' }, { title: 'two' }] })).toBeNull();
  });

  it('refuses junk', () => {
    expect(parseTodos('TodoWrite', {})).toBeNull();
    expect(parseTodos('TodoWrite', { todos: [] })).toBeNull();
    expect(parseTodos('TodoWrite', { todos: 'read the schema' })).toBeNull();
    expect(parseTodos('TodoWrite', { todos: ['read the schema', 'migrate'] })).toBeNull();
    expect(parseTodos('TodoWrite', undefined)).toBeNull();
    expect(parseTodos('TodoWrite', null)).toBeNull();
    expect(parseTodos('TodoWrite', 'todos')).toBeNull();
  });

  it('ignores case and separators, so one rule covers every house style', () => {
    const input = { todos: [{ content: 'read the schema', status: 'pending' }] };
    expect(parseTodos('todo_write', input)).not.toBeNull();
    expect(parseTodos('TodoWrite', input)).not.toBeNull();
    expect(parseTodos('write-todos', input)).not.toBeNull();
    expect(parseTodos('mcp__planner__todo_write', input)).not.toBeNull();
  });
});

describe('latestTodos', () => {
  const build = (): TranscriptModel => new TranscriptModel(syncScheduler);

  it('has nothing to say about a transcript that never planned', () => {
    const model = build();
    for (const event of stream(
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'Looking around.' },
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
    )) {
      model.apply(event);
    }

    expect(latestTodos(model)).toBeNull();
  });

  it('takes the most recent list, not the first', () => {
    const model = build();
    for (const event of stream(
      { type: 'tool.start', toolCallId: 'c1', name: 'TodoWrite', input: { todos: [{ content: 'read the schema', status: 'in_progress' }] } },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok' },
      { type: 'tool.start', toolCallId: 'c2', name: 'Bash', input: { command: 'pnpm test' } },
      {
        type: 'tool.start',
        toolCallId: 'c3',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'read the schema', status: 'completed' },
            { content: 'run the migration', status: 'in_progress' },
          ],
        },
      },
    )) {
      model.apply(event);
    }

    const latest = latestTodos(model);
    expect(latest?.items.map((item) => item.text)).toEqual(['read the schema', 'run the migration']);
    expect(latest?.ts).toBe(1003);
  });

  it('reads a call that has not finished, and one that failed', () => {
    // The list is the call's *input*: it is true the moment it is written, and
    // a strip that waited for `tool.end` would blank itself for exactly as long
    // as the provider took to acknowledge the write.
    const running = build();
    running.apply(
      stream({
        type: 'tool.start',
        toolCallId: 'c1',
        name: 'update_plan',
        input: { plan: [{ step: 'run the migration', status: 'in_progress' }] },
      })[0] as AgentEvent,
    );
    expect(latestTodos(running)?.items).toEqual([{ text: 'run the migration', status: 'in_progress' }]);

    const failed = build();
    for (const event of stream(
      { type: 'tool.start', toolCallId: 'c1', name: 'update_plan', input: { plan: [{ step: 'run the migration', status: 'in_progress' }] } },
      { type: 'tool.end', toolCallId: 'c1', status: 'error', error: { message: 'rejected' } },
    )) {
      failed.apply(event);
    }
    expect(failed.getListSnapshot()).toHaveLength(1);
    expect(latestTodos(failed)?.items).toHaveLength(1);
  });
});
