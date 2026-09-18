/**
 * Stopping delegated work on a served conversation.
 *
 * The server has answered `POST /api/v0/runs/{id}/stop-task` for as long as
 * delegated-work rows have crossed the wire, and every one of those rows drew
 * a stop button in the pane. The served run never implemented `stopTask`, so
 * every press ended in the registry's "Provider "artemis" cannot stop
 * delegated tasks" — seen 2026-09-18 on a session waiting on a task that had
 * already finished, with a button that could not reach it. These pin that the
 * run posts the stop to the server's route, and that a refusal is reported as
 * the server's sentence rather than swallowed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createArtemisAdapter } from '../artemis/adapter.js';
import type { ResolvedRunInput } from '../types.js';

const ENV = {
  ARTEMIS_LOCAL_BASE_URL: 'http://server.tail:6472',
  ARTEMIS_LOCAL_API_KEY: 'tok-123',
};

const INPUT = {
  runId: 'run-local',
  providerId: 'artemis',
  profileId: 'prof-a',
  cwd: '/w',
  prompt: 'delegate something',
  model: 'work-max/opus',
  env: ENV,
} as unknown as ResolvedRunInput;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A completions stream that announces the server's run id, then ends. */
function sseResponse(): Response {
  const chunks = [
    {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'work-max/opus',
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      artemis: { runId: 'srv-run' },
    },
    {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'work-max/opus',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      artemis: { sessionId: 'sess-9', endReason: 'completed', seq: 1 },
    },
  ];
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

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

function stubServer(stopStatus = 200): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const address = String(url);
      sent.push({
        method: init?.method ?? 'GET',
        url: address,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (address.endsWith('/v1/chat/completions')) return sseResponse();
      if (address.endsWith('/api/v0/runs/srv-run/stop-task')) {
        return stopStatus === 200
          ? jsonResponse({ object: 'artemis.run.action', runId: 'srv-run' })
          : jsonResponse(
              { error: { message: 'Unknown task "t-gone"', type: 'invalid_request_error' } },
              stopStatus,
            );
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${address}`);
    }),
  );
  return sent;
}

async function drain(run: { events: AsyncIterable<unknown> }): Promise<void> {
  for await (const _event of run.events) {
    // consumed for its side effects: the run id is learned off the stream
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stopping delegated work on a served run', () => {
  it('is offered, and posts the task to the server run route', async () => {
    const sent = stubServer();
    const run = await createArtemisAdapter().createRun(INPUT);
    await drain(run);

    expect(run.stopTask).toBeDefined();
    // After the turn, on purpose: the task worth stopping is the one that
    // outlived the turn that launched it.
    await run.stopTask?.('t-1');

    const stop = sent.find((one) => one.url.endsWith('/stop-task'));
    expect(stop).toMatchObject({
      method: 'POST',
      url: 'http://server.tail:6472/api/v0/runs/srv-run/stop-task',
      body: { taskId: 't-1' },
    });
  });

  it("reports the server's refusal as its own sentence", async () => {
    stubServer(400);
    const run = await createArtemisAdapter().createRun(INPUT);
    await drain(run);

    await expect(run.stopTask?.('t-gone')).rejects.toThrow(/Unknown task "t-gone"/);
  });

  it('refuses before the server has announced the run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Promise<Response>(() => undefined)));
    const run = await createArtemisAdapter().createRun(INPUT);

    await expect(run.stopTask?.('t-1')).rejects.toThrow(/not announced this run yet/);
    await run.dispose();
  });
});
