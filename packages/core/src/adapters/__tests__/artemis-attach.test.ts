/**
 * Joining a served run in progress, and noticing a stream that has stalled.
 *
 * Two things a served conversation could not do until 2026-09-17, both seen
 * that morning on one session:
 *
 *  - **Attach without a message.** The desktop restarted while the server was
 *    mid-turn. The poll said the conversation was working, the pane showed a
 *    static transcript, and the first thing that put the work on screen was
 *    the user typing "keep going", which the server turned into a steer and
 *    answered with a replay. `attachToLive` asks for the replay alone: the
 *    run the server lists on the session is followed from its retained start,
 *    and the run reports the seam the server measured when it began.
 *
 *  - **Tell a quiet agent from a lost stream.** Later the pane froze
 *    mid-sentence while the server ran on for three minutes and parked on a
 *    question. The socket was up and heartbeats kept coming, so the byte
 *    watchdog saw nothing wrong. The stall probe asks the server where the
 *    run is; a run past this side's cursor means the stream has lost its
 *    place, and the reconnect loop picks it back up from the cursor.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@rx-artemis/protocol';

import { ARTEMIS_CAPABILITIES, createArtemisAdapter } from '../artemis/adapter.js';
import type { ResolvedRunInput } from '../types.js';

const ENV = {
  ARTEMIS_LOCAL_BASE_URL: 'http://server.tail:6472',
  ARTEMIS_LOCAL_API_KEY: 'tok-123',
};

const ATTACH_INPUT = {
  runId: 'run-local',
  providerId: 'artemis',
  profileId: 'prof-a',
  cwd: '/w',
  prompt: '',
  resumeSessionId: 'sess-9',
  attachToLive: true,
  env: ENV,
} as unknown as ResolvedRunInput;

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** One chunk of a served stream, stamped with the run event it came from. */
function chunk(delta: Record<string, unknown>, artemis: Record<string, unknown> = {}): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'work-max/opus',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...(Object.keys(artemis).length === 0 ? {} : { artemis }),
  };
}

const DONE = {
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'work-max/opus',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  artemis: { sessionId: 'sess-9', endReason: 'completed', seq: 9 },
};

/** A stream that sends its chunks, then closes. */
function sseResponse(chunks: readonly unknown[]): Response {
  const body = [...chunks.map((one) => `data: ${JSON.stringify(one)}\n\n`), 'data: [DONE]\n\n'];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of body) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * A stream that sends its chunks and then only heartbeats, until the request
 * is aborted — which is what a real socket does when the attempt is given up.
 */
function stuckResponse(chunks: readonly unknown[], signal: AbortSignal | undefined): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const one of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(one)}\n\n`));
      timer = setInterval(() => controller.enqueue(encoder.encode(':hb\n\n')), 5);
      signal?.addEventListener('abort', () => {
        clearInterval(timer);
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const LIVE = {
  runId: 'srv-run',
  providerId: 'claude',
  profileId: 'prof-a',
  cwd: '/w',
  status: 'running',
  sessionId: 'sess-9',
  historyOffset: 7,
  lastSeq: 1,
};

describe('attaching to a run the server is already serving', () => {
  it('is claimed, so a window has something to ask for', () => {
    expect(ARTEMIS_CAPABILITIES.attachLive).toBe(true);
  });

  it('follows the run from its retained start and reports the seam the server measured', async () => {
    const requests: { method: string; url: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const address = String(url);
        requests.push({ method: init?.method ?? 'GET', url: address });
        if (address.endsWith('/api/v0/runs')) {
          return jsonResponse({ object: 'artemis.runs', runs: [LIVE] });
        }
        if (address.includes('/api/v0/runs/srv-run/stream')) {
          return sseResponse([
            chunk({}, { runId: 'srv-run' }),
            chunk({ content: 'hi' }, { seq: 0 }),
            chunk({ content: ' there' }, { seq: 1 }),
            DONE,
          ]);
        }
        throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${address}`);
      }),
    );

    const run = await createArtemisAdapter().createRun(ATTACH_INPUT);
    expect(run.historyOffset).toBe(7);

    const events = await drain(run.events);
    expect(events[0]).toMatchObject({ type: 'session.started', sessionId: 'sess-9' });
    expect(
      events
        .filter((event): event is AgentEvent & { text: string } => event.type === 'text.delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('hi there');
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });

    // Nothing was sent: no completions request, and the stream was asked for
    // whole rather than from a cursor.
    expect(requests.some((request) => request.url.endsWith('/v1/chat/completions'))).toBe(false);
    const stream = requests.find((request) => request.url.includes('/stream'));
    expect(stream?.url.includes('after=')).toBe(false);
  });

  it('refuses when the server is not working on the conversation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ object: 'artemis.runs', runs: [] })),
    );
    await expect(createArtemisAdapter().createRun(ATTACH_INPUT)).rejects.toMatchObject({
      agentError: { code: 'invalid_request', details: { reason: 'run_ended' } },
    });
  });

  it('refuses without the session it would be joining', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { resumeSessionId: _session, ...bare } = ATTACH_INPUT as unknown as Record<string, unknown>;
    await expect(
      createArtemisAdapter().createRun(bare as unknown as ResolvedRunInput),
    ).rejects.toMatchObject({ agentError: { code: 'invalid_request' } });
  });
});

describe('a stream that heartbeats while the run moves on without it', () => {
  it('is given up and picked back up from the cursor', async () => {
    const streams: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const address = String(url);
        if (address.endsWith('/api/v0/runs')) {
          // The server is already past what this side has heard.
          return jsonResponse({ object: 'artemis.runs', runs: [{ ...LIVE, lastSeq: 3 }] });
        }
        if (address.includes('/api/v0/runs/srv-run/stream')) {
          streams.push(address);
          if (streams.length === 1) {
            // The first stream says one thing and then only keeps alive.
            return stuckResponse(
              [chunk({}, { runId: 'srv-run' }), chunk({ content: 'hi' }, { seq: 1 })],
              init?.signal ?? undefined,
            );
          }
          return sseResponse([chunk({ content: ' there' }, { seq: 3 }), DONE]);
        }
        throw new Error(`unexpected request: ${address}`);
      }),
    );

    const adapter = createArtemisAdapter({
      reconnect: { stallProbeMs: 30, backoffMs: [1], watchdogMs: 60_000 },
    });
    const run = await adapter.createRun(ATTACH_INPUT);
    const events = await drain(run.events);

    expect(streams).toHaveLength(2);
    // Resumed from exactly where this side had got to.
    expect(streams[1]).toContain('after=1');
    expect(
      events
        .filter((event): event is AgentEvent & { text: string } => event.type === 'text.delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('hi there');
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('leaves a quiet stream alone while the server has nothing newer', async () => {
    let asked = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const address = String(url);
        if (address.endsWith('/api/v0/runs')) {
          asked += 1;
          // Exactly what this side has: a long tool call, nothing to relay.
          return jsonResponse({ object: 'artemis.runs', runs: [{ ...LIVE, lastSeq: 1 }] });
        }
        if (address.includes('/api/v0/runs/srv-run/stream')) {
          return stuckResponse(
            [chunk({}, { runId: 'srv-run' }), chunk({ content: 'hi' }, { seq: 1 })],
            init?.signal ?? undefined,
          );
        }
        throw new Error(`unexpected request: ${address}`);
      }),
    );

    const adapter = createArtemisAdapter({
      reconnect: { stallProbeMs: 30, backoffMs: [1], watchdogMs: 60_000 },
    });
    const run = await adapter.createRun(ATTACH_INPUT);
    // Long enough for several probes.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(asked).toBeGreaterThan(1);
    expect(run.status).not.toBe('ended');
    await run.dispose();
  });
});

describe('a run this side started learns the seam its server measured', () => {
  const STARTED_INPUT = {
    runId: 'run-local-2',
    providerId: 'artemis',
    profileId: 'prof-a',
    cwd: '/w',
    prompt: 'keep going',
    model: 'work-max/opus',
    resumeSessionId: 'sess-9',
    env: ENV,
  } as unknown as ResolvedRunInput;

  it('reads it off the run announcement, and the first reading stands', async () => {
    /*
     * The conversation lives on the server, so the registry on this side
     * cannot count it before the run starts — the one moment the count is
     * exact. The server took it then, and says so beside the run id. Without
     * it a window that reloaded mid-turn drew the turn alone.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const address = String(url);
        if (address.endsWith('/v1/chat/completions')) {
          return sseResponse([
            chunk({}, { runId: 'srv-run', historyOffset: 12 }),
            chunk({ content: 'hi' }, { seq: 0 }),
            // A replayed announcement cannot move it: the count is a fact
            // about how the run began.
            chunk({}, { runId: 'srv-run', historyOffset: 99 }),
            DONE,
          ]);
        }
        throw new Error(`unexpected request: ${address}`);
      }),
    );

    const run = await createArtemisAdapter().createRun(STARTED_INPUT);
    const events = await drain(run.events);

    expect(run.historyOffset).toBe(12);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('stays unknown on a server that does not say', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([chunk({}, { runId: 'srv-run' }), DONE])),
    );

    const run = await createArtemisAdapter().createRun(STARTED_INPUT);
    await drain(run.events);

    // Not zero: a reader must not take an old server's silence for "the
    // whole file belongs to this run".
    expect(run.historyOffset).toBeUndefined();
  });
});
