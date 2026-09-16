/**
 * What `--print` puts on stdout, in each of its three formats.
 *
 * The writer is the whole of that decision — `runPrint` around it is the
 * conversation, the refusals and the exit code — so these drive it directly
 * with the events a provider would have produced, and read what came out. No
 * host, no run, no real clock: the time is injected, so a duration is a fact
 * about the input.
 *
 * Events are written the way `exportTranscript.test.ts` writes them, minus the
 * envelope no case here cares about.
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@rx-artemis/protocol';

import { createPrintWriter, printResult, type OutputFormat, type PrintResult } from './print.js';

/** One event of a run, minus the envelope the tests do not care about. */
type Draft = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, 'runId' | 'seq' | 'ts'> : never) : never;

/** When the run happened, as against how long it took. */
const AT = 5_000;

interface Driven {
  readonly writer: ReturnType<typeof createPrintWriter>;
  /** Feed events in order, stamped the way a run would stamp them. */
  feed(...drafts: readonly Draft[]): void;
  advance(ms: number): void;
  out(): string;
  lines(): readonly string[];
  /** Finish, then the last line parsed — the result document. */
  result(): PrintResult;
}

function driven(format: OutputFormat): Driven {
  const stdout: string[] = [];
  let clock = 1_000;
  const writer = createPrintWriter(format, { stdout: (t) => stdout.push(t), stderr: () => undefined }, () => clock);
  const out = (): string => stdout.join('');
  const lines = (): readonly string[] => out().trimEnd().split('\n');
  return {
    writer,
    feed(...drafts) {
      drafts.forEach((draft, index) => {
        writer.event({ ...draft, runId: 'run_1', seq: index, ts: AT + index } as AgentEvent);
      });
    },
    advance(ms) {
      clock += ms;
    },
    out,
    lines,
    result() {
      writer.finish();
      const all = lines();
      return JSON.parse(all[all.length - 1] ?? '') as PrintResult;
    },
  };
}

/** A whole turn: a session, two fragments of an answer, and the bill. */
const HELLO: readonly Draft[] = [
  { type: 'session.started', sessionId: 'sess_7', providerId: 'claude', cwd: '/work/artemis' },
  { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'Hel' },
  { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'lo' },
  {
    type: 'run.end',
    reason: 'completed',
    sessionId: 'sess_7',
    durationMs: 4_200,
    usage: { scope: 'final', tokens: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5 }, costUsd: 0.125 },
  },
];

describe('--output-format text', () => {
  it('streams the assistant as it speaks, and ends the line', () => {
    const run = driven('text');
    run.feed(...HELLO);
    expect(run.out()).toBe('Hello\n');
    // Nothing is appended at the end: the prose *is* the output.
    run.writer.finish();
    expect(run.out()).toBe('Hello\n');
  });

  it('writes a non-streaming provider once and a streaming one once', () => {
    const run = driven('text');
    run.feed(
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'Hello' },
      { type: 'text.complete', role: 'assistant', messageId: 'm1', blockIndex: 0, text: 'Hello' },
      { type: 'text.complete', role: 'assistant', messageId: 'm2', blockIndex: 0, text: ' again' },
    );
    expect(run.out()).toBe('Hello again');
  });

  it('leaves out what is not the assistant answering', () => {
    const run = driven('text');
    run.feed(
      { type: 'text.complete', role: 'user', messageId: 'u1', text: 'the question' },
      { type: 'text.delta', messageId: 'a1', blockIndex: 0, text: 'a subagent', agentId: 'agent_1' },
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'the answer' },
    );
    expect(run.out()).toBe('the answer');
  });
});

describe('--output-format json', () => {
  it('says nothing until the end, then one document', () => {
    const run = driven('json');
    run.feed(...HELLO);
    expect(run.out()).toBe('');
    expect(run.result()).toEqual({
      sessionId: 'sess_7',
      text: 'Hello',
      usage: { tokens: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5 }, costUsd: 0.125 },
      durationMs: 4_200,
      reason: 'completed',
    });
  });

  it('is one line, newline-terminated', () => {
    const run = driven('json');
    run.feed(...HELLO);
    run.writer.finish();
    expect(run.out().endsWith('\n')).toBe(true);
    expect(run.lines()).toHaveLength(1);
  });

  it('writes the document once, however often the caller finishes', () => {
    const run = driven('json');
    run.feed(...HELLO);
    run.writer.finish();
    run.writer.finish();
    expect(run.lines()).toHaveLength(1);
  });

  it('still answers when the run never reached a provider', () => {
    const run = driven('json');
    expect(run.result()).toEqual({
      sessionId: null,
      text: '',
      usage: { tokens: { inputTokens: 0, outputTokens: 0 }, costUsd: null },
      durationMs: 0,
      reason: 'error',
    });
  });

  it('carries the session the turn opened, when the end did not repeat it', () => {
    const run = driven('json');
    run.feed(
      { type: 'session.started', sessionId: 'sess_9', providerId: 'claude', cwd: '/work/artemis' },
      { type: 'run.end', reason: 'interrupted' },
    );
    const result = run.result();
    expect(result.sessionId).toBe('sess_9');
    expect(result.reason).toBe('interrupted');
  });

  it('times the turn itself when the provider reports no duration', () => {
    const run = driven('json');
    run.feed({ type: 'run.end', reason: 'completed' });
    run.advance(2_500);
    expect(run.result().durationMs).toBe(2_500);
  });
});

describe('--output-format stream-json', () => {
  it('writes every event as one line, exactly as the protocol shaped it', () => {
    const run = driven('stream-json');
    run.feed(...HELLO);
    const lines = run.lines();
    expect(lines).toHaveLength(HELLO.length);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ ...HELLO[0], runId: 'run_1', seq: 0, ts: AT });
    expect(JSON.parse(lines[1] ?? '')).toEqual({ ...HELLO[1], runId: 'run_1', seq: 1, ts: AT + 1 });
  });

  it('ends with the same document json ends with', () => {
    const streamed = driven('stream-json');
    streamed.feed(...HELLO);
    const whole = driven('json');
    whole.feed(...HELLO);
    expect(streamed.result()).toEqual(whole.result());
  });

  it('writes a subagent and its tools too, which the prose leaves out', () => {
    const run = driven('stream-json');
    run.feed(
      { type: 'text.delta', messageId: 'a1', blockIndex: 0, text: 'a subagent', agentId: 'agent_1' },
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
    );
    expect(run.lines()).toHaveLength(2);
    expect(run.result().text).toBe('');
  });
});

describe('printResult', () => {
  it('prefers the duration the run reported to the wall clock around it', () => {
    const result = printResult({
      text: 'x',
      elapsedMs: 9_000,
      end: { type: 'run.end', runId: 'run_1', seq: 3, ts: AT, reason: 'completed', durationMs: 4_200 },
    });
    expect(result.durationMs).toBe(4_200);
  });

  it('keeps the shape when the provider priced nothing', () => {
    const result = printResult({
      text: '',
      elapsedMs: 10,
      end: { type: 'run.end', runId: 'run_1', seq: 1, ts: AT, reason: 'max_turns' },
    });
    expect(result.usage).toEqual({ tokens: { inputTokens: 0, outputTokens: 0 }, costUsd: null });
    expect(result.reason).toBe('max_turns');
  });
});
