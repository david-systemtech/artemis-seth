/**
 * How full a *served* conversation is.
 *
 * This is the half that was missing. Every provider a server can route to
 * reports the reading — claude off its result message, codex off `tokenUsage`,
 * a local server by being asked — and the relay dropped all of it: the server's
 * `toOpenAiUsage` kept two token counts and discarded the rest, so a served run
 * could say what it had spent and never how close it was to the end of its
 * window. The desktop's own `contextReporting` capability was `false` in
 * consequence, and the gauge said so.
 *
 * These pin the client half: the chunk reader, the accumulation across chunks,
 * and the run events the renderer's context meter is built on.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, UsageSnapshot } from '@rx-artemis/protocol';

import { ARTEMIS_CAPABILITIES, createArtemisAdapter } from '../artemis/adapter.js';
import { readServerChunk } from '../artemis/stream.js';
import type { ResolvedRunInput } from '../types.js';

const ENV = {
  ARTEMIS_LOCAL_BASE_URL: 'http://server.tail:6472',
  ARTEMIS_LOCAL_API_KEY: 'tok-123',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readServerChunk', () => {
  it('reads the context reading off the namespace', () => {
    const delta = readServerChunk({
      choices: [{ delta: {} }],
      artemis: { context: { tokens: 12_300, window: 200_000 }, seq: 4 },
    });
    expect(delta?.artemis?.context).toEqual({ tokens: 12_300, window: 200_000 });
  });

  it('keeps a half-reading, because that is the ordinary case', () => {
    // Claude states occupancy per assistant message and the window only once.
    const delta = readServerChunk({
      choices: [{ delta: {} }],
      artemis: { context: { tokens: 9_000 } },
    });
    expect(delta?.artemis?.context).toEqual({ tokens: 9_000 });
  });

  it('drops a non-positive window rather than dividing by it', () => {
    // Not a smaller scale — a denominator that renders as "100% full" or as
    // nothing, and either reads as a conversation in trouble.
    const delta = readServerChunk({
      choices: [{ delta: {} }],
      artemis: { context: { tokens: 500, window: 0 } },
    });
    expect(delta?.artemis?.context).toEqual({ tokens: 500 });
  });

  it('keeps an occupancy of zero, which is a real answer', () => {
    const delta = readServerChunk({
      choices: [{ delta: {} }],
      artemis: { context: { tokens: 0, window: 32_768 } },
    });
    expect(delta?.artemis?.context).toEqual({ tokens: 0, window: 32_768 });
  });

  it('says nothing when the server sent no reading', () => {
    const delta = readServerChunk({ choices: [{ delta: { content: 'hi' } }] });
    expect(delta?.artemis?.context).toBeUndefined();
  });
});

describe('the capability', () => {
  it('is claimed, so the gauge mounts at all', () => {
    // `contextReporting`, not `usageReporting`: the two are different questions
    // and this adapter used to answer only the second. The meter gates on this
    // one, which is why it showed "does not report context usage" against a
    // conversation that had plainly run.
    expect(ARTEMIS_CAPABILITIES.contextReporting).toBe(true);
  });
});

/** One SSE body, framed the way the server writes it. */
function sseResponse(chunks: readonly unknown[]): Response {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of body) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const RUN_INPUT = {
  runId: 'run-1',
  providerId: 'artemis',
  profileId: 'prof-a',
  cwd: '/w',
  prompt: 'hi',
  model: 'work-max/opus',
  env: ENV,
} as unknown as ResolvedRunInput;

async function collect(chunks: readonly unknown[]): Promise<AgentEvent[]> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => sseResponse(chunks)),
  );
  const run = await createArtemisAdapter().createRun(RUN_INPUT);
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

/** Just the context halves of every usage event, in order. */
function readings(events: readonly AgentEvent[]): { tokens?: number; window?: number }[] {
  return events
    .filter((event): event is AgentEvent & { usage: UsageSnapshot } => event.type === 'usage')
    .map((event) => ({
      ...(event.usage.contextTokens === undefined ? {} : { tokens: event.usage.contextTokens }),
      ...(event.usage.contextWindow === undefined ? {} : { window: event.usage.contextWindow }),
    }));
}

describe('a served run', () => {
  it('moves the reading while the turn is still running', async () => {
    // The whole point of streaming it. A reading that only lands on the final
    // chunk is a fuel gauge that reports at the end of the journey.
    const events = await collect([
      { choices: [{ delta: {} }], artemis: { context: { tokens: 4_000, window: 200_000 } } },
      { choices: [{ delta: { content: 'working' } }] },
      { choices: [{ delta: {} }], artemis: { context: { tokens: 9_500 } } },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
        artemis: { endReason: 'completed', context: { tokens: 9_500, window: 200_000 } },
      },
    ]);

    // The second reading carried no window; it keeps the one it was given.
    expect(readings(events)).toEqual([
      { tokens: 4_000, window: 200_000 },
      { tokens: 9_500, window: 200_000 },
    ]);
  });

  it('spends no tokens on the events that carry it', async () => {
    /*
     * `delta` scope with zero counts — the identity element. The renderer
     * accumulates deltas, so these move the context readout and leave the token
     * bill exactly as it was. `cumulative`, which is what the OpenCode mapper
     * uses for the same job, would *replace* the counts and zero a bill the
     * final chunk has not restated yet.
     */
    const events = await collect([
      { choices: [{ delta: {} }], artemis: { context: { tokens: 4_000 } } },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
        artemis: { endReason: 'completed' },
      },
    ]);

    const usage = events.find((event) => event.type === 'usage') as { usage: UsageSnapshot };
    expect(usage.usage.scope).toBe('delta');
    expect(usage.usage.tokens).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('still holds the reading once the turn is over', async () => {
    // The renderer *replaces* a run's usage with what `run.end` hands it, so a
    // final snapshot without the reading would blank the gauge at exactly the
    // moment the turn finished — which looks far more like a bug than never
    // having worked at all.
    const events = await collect([
      { choices: [{ delta: {} }], artemis: { context: { tokens: 9_500, window: 200_000 } } },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
        artemis: { endReason: 'completed' },
      },
    ]);

    const end = events.find((event) => event.type === 'run.end') as { usage?: UsageSnapshot };
    expect(end.usage).toMatchObject({
      tokens: { inputTokens: 120, outputTokens: 40 },
      contextTokens: 9_500,
      contextWindow: 200_000,
    });
  });

  it('reports no reading at all against a server too old to send one', async () => {
    // Degrades to the state the gauge already draws for a route that will not
    // state a size — not to a guess, and not to a zero.
    const events = await collect([
      { choices: [{ delta: { content: 'hi' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
        artemis: { endReason: 'completed' },
      },
    ]);

    expect(readings(events)).toEqual([]);
    const end = events.find((event) => event.type === 'run.end') as { usage?: UsageSnapshot };
    expect(end.usage?.contextTokens).toBeUndefined();
    expect(end.usage?.contextWindow).toBeUndefined();
  });
});

/**
 * The bill, which is a different measurement from the reading above.
 *
 * The same function that discarded the context also flattened the prompt: it
 * reported Artemis's *uncached* input as OpenAI's `prompt_tokens`, which is the
 * whole prompt by definition. A served turn with a warm cache therefore came
 * back claiming a prompt of a few tokens. These pin the client's half of the
 * round trip — splitting the whole back into the disjoint triple every other
 * adapter reports, without which the same error happens again in reverse.
 */
describe('the token counts a served run reports', () => {
  it('splits the prompt back into uncached, cached and written', async () => {
    const events = await collect([
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 20_810,
          completion_tokens: 173,
          total_tokens: 20_983,
          prompt_tokens_details: { cached_tokens: 19_000 },
          cache_creation_input_tokens: 1_800,
        },
        artemis: { endReason: 'completed' },
      },
    ]);

    const end = events.find((event) => event.type === 'run.end') as { usage?: UsageSnapshot };
    expect(end.usage?.tokens).toEqual({
      inputTokens: 10,
      outputTokens: 173,
      cacheReadInputTokens: 19_000,
      cacheCreationInputTokens: 1_800,
    });
  });

  it('leaves the prompt whole when the server named no cached part', async () => {
    // A provider with no prompt cache, or a server too old to say. The whole
    // prompt is uncached as far as anyone here knows, which is the truth.
    const events = await collect([
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
        artemis: { endReason: 'completed' },
      },
    ]);

    const end = events.find((event) => event.type === 'run.end') as { usage?: UsageSnapshot };
    expect(end.usage?.tokens).toEqual({ inputTokens: 100, outputTokens: 40 });
  });

  it('never lets the parts make the remainder negative', async () => {
    // A token count below zero on a diagnostic panel, arrived at by arithmetic
    // rather than by anything that happened. The parser clamps; this is the
    // guard that says so.
    const events = await collect([
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          total_tokens: 140,
          prompt_tokens_details: { cached_tokens: 900 },
        },
        artemis: { endReason: 'completed' },
      },
    ]);

    const end = events.find((event) => event.type === 'run.end') as { usage?: UsageSnapshot };
    expect(end.usage?.tokens.inputTokens).toBe(0);
    expect(end.usage?.tokens.cacheReadInputTokens).toBe(100);
  });
});

describe('readServerChunk — the seam beside the run id', () => {
  it('reads the history offset off the announcement', () => {
    const delta = readServerChunk({
      choices: [{ delta: {} }],
      artemis: { runId: 'srv-run', historyOffset: 911 },
    });
    expect(delta?.artemis?.runId).toBe('srv-run');
    expect(delta?.artemis?.historyOffset).toBe(911);
  });

  it('keeps zero, which is a fresh conversation, and drops what is not a count', () => {
    const read = (historyOffset: unknown) =>
      readServerChunk({ choices: [{ delta: {} }], artemis: { historyOffset } })?.artemis
        ?.historyOffset;
    expect(read(0)).toBe(0);
    for (const junk of [-1, 1.5, '12', null, true]) expect(read(junk)).toBeUndefined();
  });
});
