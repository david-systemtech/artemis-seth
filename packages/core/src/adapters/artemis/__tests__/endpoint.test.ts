/**
 * One Artemis driving another, over a real socket.
 * ============================================================================
 *
 * Same discipline as the local adapter's endpoint tests: the adapter is driven
 * through a real `node:http` server rather than a stubbed `fetch`, because the
 * thing under test is what goes out on the wire — the path, the bearer token,
 * the request body — and what is made of the SSE that comes back.
 *
 * The behaviours pinned here that the local suite has no equivalent of:
 *
 *  - **The session id is never guessed.** `session.started` carries an id the
 *    server owns or is not emitted at all, and `run.end` never carries one the
 *    server did not confirm. The local adapter's placeholder trick would, with
 *    `resumeSession: true`, poison the pane's resume target on any stream that
 *    died early — see the adapter's class comment.
 *  - **Tool calls become rows as they happen**, and the activity report
 *    becomes settled rows after the text for whatever the stream did not
 *    already show.
 *  - **A vanished stream is an error, not a completion.**
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentEvent, RunId } from '@rx-artemis/protocol';
import { LOCAL_API_KEY_ENV, LOCAL_BASE_URL_ENV } from '@rx-artemis/protocol';

import type { ResolvedRunInput } from '../../types.js';
import { createArtemisAdapter } from '../adapter.js';
import { guardRemoteDecision } from '../permissions.js';

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** Every request a test server received, in order. */
interface Recorded {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A server whose every route is scripted by the test. */
async function serve(
  handler: (request: IncomingMessage, response: ServerResponse, body: unknown) => void,
): Promise<{ origin: string; seen: Recorded[] }> {
  const seen: Recorded[] = [];
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      seen.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      });
      handler(request, response, body);
    });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, seen };
}

/** Frame chunks the way the serving Artemis does. */
function sse(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'work/opus',
    choices: [{ index: 0, delta, finish_reason: (extra['finish_reason'] as string) ?? null }],
    ...extra,
  };
}

/** Start a run against `origin` and collect its whole event stream. */
async function drive(
  origin: string,
  input: Partial<ResolvedRunInput> = {},
  options: Parameters<typeof createArtemisAdapter>[0] = {},
): Promise<readonly AgentEvent[]> {
  const adapter = createArtemisAdapter(options);
  const run = await adapter.createRun({
    runId: 'run-1' as RunId,
    providerId: 'artemis',
    profileId: 'profile-1',
    cwd: process.cwd(),
    prompt: 'hello over the wire',
    model: 'work/opus',
    env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok_123' },
    ...input,
  } as ResolvedRunInput);

  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

/** The default happy stream: an early session chunk, text, a final report. */
function happyStream(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  response.write(sse(chunk({ role: 'assistant' })));
  response.write(sse(chunk({}, { artemis: { sessionId: 'sess-abc' } })));
  response.write(sse(chunk({ content: 'Hel' })));
  response.write(sse(chunk({ content: 'lo.' })));
  response.write(
    sse(
      chunk(
        {},
        {
          finish_reason: 'stop',
          usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
          artemis: {
            sessionId: 'sess-abc',
            activity: [
              { tool: 'read', summary: 'src/index.ts', at: 1, ok: true },
              { tool: 'bash', summary: 'pnpm test', at: 2, ok: false },
            ],
            endReason: 'completed',
          },
        },
      ),
    ),
  );
  response.write(sse('[DONE]'));
  response.end();
}

describe('a fresh turn', () => {
  it('streams the reply and never guesses a session id', async () => {
    const { origin, seen } = await serve((request, response) => {
      expect(request.url).toBe('/v1/chat/completions');
      happyStream(response);
    });

    const events = await drive(origin);
    const types = events.map((event) => event.type);

    // The id arrived on an early chunk, so `session.started` leads — with the
    // server's id, not a placeholder.
    expect(types[0]).toBe('session.started');
    expect(events[0]).toMatchObject({ sessionId: 'sess-abc', providerId: 'artemis' });

    // The answer closes before the report of how it was reached lands.
    expect(types).toEqual([
      'session.started',
      'text.delta',
      'text.delta',
      'text.complete',
      'tool.start',
      'tool.end',
      'tool.start',
      'tool.end',
      'run.end',
    ]);

    // The completion names the block its deltas built. Without the index, a
    // transcript that had already settled the block under the tool rows could
    // not find it, opened a second one, and drew the whole answer twice.
    const deltas = events.filter((event) => event.type === 'text.delta');
    expect(deltas).toMatchObject([
      { messageId: 'run-1-0', blockIndex: 0, text: 'Hel' },
      { messageId: 'run-1-0', blockIndex: 0, text: 'lo.' },
    ]);
    expect(events.find((event) => event.type === 'text.complete')).toMatchObject({
      messageId: 'run-1-0',
      blockIndex: 0,
      role: 'assistant',
      text: 'Hello.',
    });

    const end = events.at(-1);
    expect(end).toMatchObject({
      type: 'run.end',
      reason: 'completed',
      sessionId: 'sess-abc',
      usage: { scope: 'final', tokens: { inputTokens: 11, outputTokens: 5 } },
    });

    // The request body is the wire contract: the route as `model`, one user
    // message, streaming on, and the remote opt-in every turn now carries — so a
    // disconnect detaches the run and a prompt comes back here to be answered.
    const body = seen[0]?.body as Record<string, unknown>;
    expect(body['model']).toBe('work/opus');
    expect(body['messages']).toEqual([{ role: 'user', content: 'hello over the wire' }]);
    expect(body['stream']).toBe(true);
    expect(body['artemis']).toEqual({ remote: { detach: true, permissions: true } });
    expect(seen[0]?.authorization).toBe('Bearer tok_123');
  });

  it('renders the activity report as settled tool rows', async () => {
    const { origin } = await serve((_request, response) => happyStream(response));

    const events = await drive(origin);
    const toolEnds = events.filter((event) => event.type === 'tool.end');

    expect(events.filter((event) => event.type === 'tool.start')).toMatchObject([
      { name: 'read', title: 'src/index.ts' },
      { name: 'bash', title: 'pnpm test' },
    ]);
    // `ok: false` is a row that failed; absent/true settle as ok.
    expect(toolEnds).toMatchObject([
      { name: 'read', status: 'ok' },
      { name: 'bash', status: 'error' },
    ]);
  });

  it('accepts the id arriving only on the final chunk, as older servers send it', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' })));
      response.write(sse(chunk({ content: 'Hi.' })));
      response.write(
        sse(
          chunk(
            {},
            {
              finish_reason: 'stop',
              artemis: { sessionId: 'sess-late', endReason: 'completed' },
            },
          ),
        ),
      );
      response.write(sse('[DONE]'));
      response.end();
    });

    const events = await drive(origin);
    const types = events.map((event) => event.type);

    // Late is tolerated — the text streams first, the announcement lands when
    // the server finally says. What is not tolerated is a made-up id.
    expect(types).toEqual(['text.delta', 'session.started', 'text.complete', 'run.end']);
    expect(events.at(-1)).toMatchObject({ sessionId: 'sess-late' });
  });

  it('draws reasoning as thinking rows, in the order it arrived', async () => {
    // The wire carries reasoning on `reasoning_content` — a flat stream beside
    // the answer's. Each stretch becomes a block of its own, numbered in
    // arrival order, so reasoning the model did *after* its first sentence
    // lands after that sentence rather than being glued onto the fold above.
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' })));
      response.write(sse(chunk({ reasoning_content: 'First, ' })));
      response.write(sse(chunk({ reasoning_content: 'look.' })));
      response.write(sse(chunk({ content: 'Found it. ' })));
      response.write(sse(chunk({ reasoning_content: 'Now the other file.' })));
      response.write(sse(chunk({ content: 'Both fixed.' })));
      response.write(
        sse(chunk({}, { finish_reason: 'stop', artemis: { sessionId: 'sess-abc', endReason: 'completed' } })),
      );
      response.write(sse('[DONE]'));
      response.end();
    });

    const events = await drive(origin);
    const blocks = events
      .filter((event) => event.type !== 'session.started' && event.type !== 'run.end')
      .map((event) => {
        const { type, blockIndex, text } = event as { type: string; blockIndex: number; text: string };
        return { type, blockIndex, text };
      });

    expect(blocks).toEqual([
      { type: 'thinking.delta', blockIndex: 0, text: 'First, ' },
      { type: 'thinking.delta', blockIndex: 0, text: 'look.' },
      { type: 'text.delta', blockIndex: 1, text: 'Found it. ' },
      // The answer block closes the moment the model goes back to thinking,
      // whole, under the index its delta carried.
      { type: 'text.complete', blockIndex: 1, text: 'Found it. ' },
      { type: 'thinking.delta', blockIndex: 2, text: 'Now the other file.' },
      { type: 'text.delta', blockIndex: 3, text: 'Both fixed.' },
      { type: 'text.complete', blockIndex: 3, text: 'Both fixed.' },
    ]);
    // Every block belongs to the one message the turn is.
    expect(new Set(events.map((event) => (event as { messageId?: string }).messageId).filter(Boolean)))
      .toEqual(new Set(['run-1-0']));
  });

  it('reads reasoning under the other name it travels by', async () => {
    // `reasoning` is the second spelling in the wild; the local reader takes
    // both, and so does this one.
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' })));
      response.write(sse(chunk({ reasoning: 'hmm' })));
      response.write(sse(chunk({ content: 'ok' })));
      response.write(sse(chunk({}, { finish_reason: 'stop', artemis: { endReason: 'completed' } })));
      response.write(sse('[DONE]'));
      response.end();
    });

    const events = await drive(origin);
    expect(events.find((event) => event.type === 'thinking.delta')).toMatchObject({
      blockIndex: 0,
      text: 'hmm',
    });
  });

  it('reports a stream that died mid-turn as an error with no session at all', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' })));
      response.write(sse(chunk({ content: 'Hal' })));
      // The socket dies before any final chunk. No id was ever confirmed.
      response.destroy();
    });

    const events = await drive(origin);
    const end = events.at(-1);

    expect(end?.type).toBe('run.end');
    expect(end).toMatchObject({ reason: 'error' });
    // The load-bearing assertion: nothing here for the store to promote into
    // a resume target the server has never heard of.
    expect((end as { sessionId?: string }).sessionId).toBeUndefined();
    expect(events.some((event) => event.type === 'session.started')).toBe(false);
  });
});

describe('a resumed turn', () => {
  it('announces the known session first and asks the server to continue it', async () => {
    const { origin, seen } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' })));
      response.write(sse(chunk({ content: 'Continuing.' })));
      response.write(
        sse(chunk({}, { finish_reason: 'stop', artemis: { sessionId: 'sess-abc', endReason: 'completed' } })),
      );
      response.write(sse('[DONE]'));
      response.end();
    });

    const events = await drive(origin, { resumeSessionId: 'sess-abc' });

    expect(events[0]).toMatchObject({
      type: 'session.started',
      sessionId: 'sess-abc',
      resumedFrom: 'sess-abc',
    });

    const body = seen[0]?.body as { artemis?: { sessionId?: string } };
    expect(body.artemis?.sessionId).toBe('sess-abc');
  });

  it('carries thinking, fast mode and ultracode through as extensions', async () => {
    const { origin, seen } = await serve((_request, response) => happyStream(response));

    await drive(origin, { fastMode: true, ultracode: false, effort: 'high' });

    // `effort` rides as `artemis.thinking`; the remote opt-in rides alongside it.
    const body = seen[0]?.body as { artemis?: Record<string, unknown> };
    expect(body.artemis).toEqual({
      thinking: 'high',
      fastMode: true,
      ultracode: false,
      remote: { detach: true, permissions: true },
    });
  });
});

describe('refusals and losses', () => {
  it('reports a 401 as a token problem, not an absent server', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'No connection matches this token.', type: 'auth' } }),
      );
    });

    const events = await drive(origin);
    const end = events.at(-1) as { type: string; reason?: string; error?: { code?: string; message?: string } };

    expect(end.type).toBe('run.end');
    expect(end.reason).toBe('error');
    expect(end.error?.code).toBe('auth');
    expect(end.error?.message).toContain('connection token');
  });

  it('surfaces the server’s own message for an unknown route', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'No model route “gone/away”.', type: 'invalid_request_error' } }),
      );
    });

    const events = await drive(origin);
    const end = events.at(-1) as { error?: { code?: string; message?: string } };

    expect(end.error?.code).toBe('model_unavailable');
    expect(end.error?.message).toContain('gone/away');
  });

  it('shows the reason a failed run gave, rather than a sentence about it', async () => {
    /*
     * The whole point of `artemis.error`. Before it, this arrived as
     * `endReason: 'error'` on an empty delta and the adapter answered with a
     * fixed line claiming the detail was in the reply text — which it never
     * was, because a run that fails before generating has no text. A signed-out
     * account on the server read, on the desktop, as "the remote run failed".
     */
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' })));
      response.write(
        sse(
          chunk(
            {},
            {
              finish_reason: 'stop',
              artemis: {
                endReason: 'error',
                error: 'unexpected status 401 Unauthorized: Missing bearer authentication',
              },
            },
          ),
        ),
      );
      response.write(sse('[DONE]'));
      response.end();
    });

    const events = await drive(origin);
    const end = events.at(-1) as Extract<AgentEvent, { type: 'run.end' }>;

    expect(end.type).toBe('run.end');
    expect(end.reason).toBe('error');
    expect(end.error?.message).toBe(
      'unexpected status 401 Unauthorized: Missing bearer authentication',
    );
  });

  it('says so plainly when an older server sends no reason', async () => {
    // Every server up to 2.4.6. The fallback must not repeat the old claim that
    // the detail is in the text: it says where the reason actually is instead.
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' })));
      response.write(sse(chunk({}, { finish_reason: 'stop', artemis: { endReason: 'error' } })));
      response.write(sse('[DONE]'));
      response.end();
    });

    const events = await drive(origin);
    const end = events.at(-1) as Extract<AgentEvent, { type: 'run.end' }>;

    expect(end.reason).toBe('error');
    expect(end.error?.message).toContain('did not say why');
    expect(end.error?.message).not.toContain('reply text');
  });

  it('ends interrupted when asked to stop mid-stream', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' })));
      response.write(sse(chunk({ content: 'thinking…' })));
      // …and then nothing, forever. The client's interrupt is the only exit.
    });

    const adapter = createArtemisAdapter();
    const run = await adapter.createRun({
      runId: 'run-2' as RunId,
      providerId: 'artemis',
      profileId: 'profile-1',
      cwd: process.cwd(),
      prompt: 'hang please',
      model: 'work/opus',
      env: { [LOCAL_BASE_URL_ENV]: origin },
    } as ResolvedRunInput);

    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'text.delta') void run.interrupt();
    }

    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'interrupted' });
  });
});

describe('the request body it sends', () => {
  it('carries appended standing instructions as artemis.systemPrompt', async () => {
    let sent: unknown;
    const { origin } = await serve((_request, response, body) => {
      sent = body;
      happyStream(response);
    });
    await drive(origin, { systemPrompt: { kind: 'append', text: 'Follow the house style.' } });
    expect((sent as { artemis?: { systemPrompt?: string } }).artemis?.systemPrompt).toBe(
      'Follow the house style.',
    );
  });

  it('carries the always-on skills as names, for the server to read its own copies of', async () => {
    let sent: unknown;
    const { origin } = await serve((_request, response, body) => {
      sent = body;
      happyStream(response);
    });
    await drive(origin, { alwaysOnSkills: ['unslop', 'tdd'] });
    expect((sent as { artemis?: { alwaysOnSkills?: string[] } }).artemis?.alwaysOnSkills).toEqual(['unslop', 'tdd']);
  });

  it('sends no alwaysOnSkills for a run that has none, empty list included', async () => {
    const bodies: unknown[] = [];
    const { origin } = await serve((_request, response, body) => {
      bodies.push(body);
      happyStream(response);
    });
    await drive(origin, {});
    await drive(origin, { alwaysOnSkills: [] });
    for (const body of bodies) {
      expect((body as { artemis?: Record<string, unknown> }).artemis ?? {}).not.toHaveProperty('alwaysOnSkills');
    }
  });

  it('sends no systemPrompt when the run carries a default one', async () => {
    let sent: unknown;
    const { origin } = await serve((_request, response, body) => {
      sent = body;
      happyStream(response);
    });
    await drive(origin, { systemPrompt: { kind: 'default' } });
    expect((sent as { artemis?: Record<string, unknown> }).artemis ?? {}).not.toHaveProperty(
      'systemPrompt',
    );
  });
});

describe('what the server set aside', () => {
  it('says once, in the transcript, that the serving provider took no standing instructions', async () => {
    /*
     * The first chunk names what the server dropped. The pane on this side
     * still lists the prompt as active, so the run says so itself — in the
     * synthetic voice a dropped link speaks in, not as something the model
     * said — and only once, however many chunks repeat the list.
     */
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' }, { artemis: { ignored: ['artemis.systemPrompt'] } })));
      response.write(sse(chunk({ content: 'Hello.' }, { artemis: { ignored: ['artemis.systemPrompt'] } })));
      response.write(sse(chunk({}, { finish_reason: 'stop', artemis: { endReason: 'completed' } })));
      response.write(sse('[DONE]'));
      response.end();
    });
    const events = await drive(origin, { systemPrompt: { kind: 'append', text: 'Follow the house style.' } });
    const notices = events.filter(
      (event) => event.type === 'text.complete' && (event as { synthetic?: boolean }).synthetic === true,
    );
    expect(notices).toHaveLength(1);
    expect((notices[0] as { text: string }).text).toMatch(/cannot take standing instructions/);
    // The reply itself is untouched.
    expect(events.some((event) => event.type === 'text.delta' && (event as { text: string }).text === 'Hello.')).toBe(true);
  });

  it('names the always-on skills when they are what the run went without, and both when both', async () => {
    const dropped = async (ignored: readonly string[]): Promise<string> => {
      const { origin } = await serve((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({ role: 'assistant' }, { artemis: { ignored } })));
        response.write(sse(chunk({}, { finish_reason: 'stop', artemis: { endReason: 'completed' } })));
        response.write(sse('[DONE]'));
        response.end();
      });
      const events = await drive(origin, { alwaysOnSkills: ['unslop'] });
      const notices = events.filter(
        (event) => event.type === 'text.complete' && (event as { synthetic?: boolean }).synthetic === true,
      );
      expect(notices).toHaveLength(1);
      return (notices[0] as { text: string }).text;
    };

    expect(await dropped(['artemis.alwaysOnSkills'])).toMatch(/started without your always-on skills\./);
    expect(await dropped(['artemis.systemPrompt', 'artemis.alwaysOnSkills'])).toMatch(
      /without your prompt library or your always-on skills\./,
    );
  });

  it('says nothing when nothing was set aside', async () => {
    const { origin } = await serve((_request, response) => happyStream(response));
    const events = await drive(origin, { systemPrompt: { kind: 'append', text: 'Follow the house style.' } });
    expect(
      events.some((event) => event.type === 'text.complete' && (event as { synthetic?: boolean }).synthetic === true),
    ).toBe(false);
  });
});

describe('what a run refuses up front', () => {
  const adapter = createArtemisAdapter();
  const base = {
    runId: 'run-3' as RunId,
    providerId: 'artemis',
    profileId: 'profile-1',
    cwd: process.cwd(),
    prompt: 'x',
    model: 'work/opus',
    env: {},
  };

  it('a run with no model route', async () => {
    await expect(
      adapter.createRun({ ...base, model: undefined } as unknown as ResolvedRunInput),
    ).rejects.toMatchObject({ agentError: { code: 'invalid_request' } });
  });

  it('no longer refuses a permission mode: the wire carries it now', async () => {
    // The refusal existed while the completions route took no mode from an
    // HTTP caller; both ends speak it today, and an older server drops the
    // field — degradation, not silent difference. The run must accept it.
    const run = await adapter.createRun({
      ...base,
      permissionMode: 'acceptEdits',
    } as unknown as ResolvedRunInput);
    expect(run).toBeDefined();
  });

  it('no longer refuses a fork or a rewind: the wire carries both now', async () => {
    // Both ride the completions request as `artemis.forkSession` and
    // `artemis.rewindToMessageId`; a server whose account cannot honour one
    // refuses the request outright, which is the honest failure. The run
    // must accept them here.
    const run = await adapter.createRun({
      ...base,
      resumeSessionId: 'sess-abc',
      forkSession: true,
      rewindToMessageId: 'msg-7',
    } as unknown as ResolvedRunInput);
    expect(run).toBeDefined();
  });

  it('a replacing system prompt, which would displace the serving preset', async () => {
    await expect(
      adapter.createRun({
        ...base,
        systemPrompt: { kind: 'replace', text: 'You are a pirate.' },
      } as unknown as ResolvedRunInput),
    ).rejects.toMatchObject({ agentError: { code: 'invalid_request' } });
  });

});

describe('a live run: steering, interrupting and answering', () => {
  const base = {
    runId: 'run-live' as RunId,
    providerId: 'artemis' as const,
    profileId: 'profile-1',
    cwd: process.cwd(),
    prompt: 'do the thing',
    model: 'work/opus',
  };

  it('steers a message onto the run route and reports delivery honestly', async () => {
    const { origin, seen } = await serve((request, response) => {
      if (request.url === '/v1/chat/completions') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({ role: 'assistant' })));
        // The server's own run id, announced early, is what the steer addresses.
        response.write(sse(chunk({}, { artemis: { runId: 'srv-1' } })));
        response.write(sse(chunk({ content: 'working…' })));
        return; // holds; the test steers, then interrupts to end it
      }
      if (request.url === '/api/v0/runs/srv-1/messages') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ runId: 'srv-1', deliveredImmediately: true }));
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const adapter = createArtemisAdapter();
    const run = await adapter.createRun({
      ...base,
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok' },
    } as ResolvedRunInput);

    let delivered: boolean | undefined;
    for await (const event of run.events) {
      if (event.type === 'text.delta' && delivered === undefined) {
        delivered = (await run.send('also do this')).deliveredImmediately;
        void run.interrupt();
      }
      if (event.type === 'run.end') break;
    }

    expect(delivered).toBe(true);
    const steer = seen.find((row) => row.url === '/api/v0/runs/srv-1/messages');
    expect(steer?.body).toEqual({ text: 'also do this' });
    expect(steer?.authorization).toBe('Bearer tok');
  });

  it('interrupts on the run route and ends on the ending the server sends', async () => {
    let held: ServerResponse | undefined;
    const { origin, seen } = await serve((request, response) => {
      if (request.url === '/v1/chat/completions') {
        held = response;
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({ role: 'assistant' })));
        response.write(sse(chunk({}, { artemis: { runId: 'srv-2' } })));
        response.write(sse(chunk({ content: 'thinking…' })));
        return; // holds; the server ends it once it has taken the interrupt
      }
      if (request.url === '/api/v0/runs/srv-2/interrupt') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ runId: 'srv-2' }));
        // The provider over there winds the turn down and the server says so,
        // with the turn's accounting, on the stream it already has.
        held?.write(
          sse(
            chunk(
              {},
              {
                finish_reason: 'stop',
                usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 },
                artemis: { endReason: 'interrupted' },
              },
            ),
          ),
        );
        held?.write(sse('[DONE]'));
        held?.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const adapter = createArtemisAdapter();
    const run = await adapter.createRun({
      ...base,
      runId: 'run-int' as RunId,
      env: { [LOCAL_BASE_URL_ENV]: origin },
    } as ResolvedRunInput);

    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'text.delta') void run.interrupt();
    }

    // The explicit interrupt reached the server — a detached run needs it, since
    // the abort that ends the local stream now reads as "detach", not "stop".
    expect(seen.some((row) => row.url === '/api/v0/runs/srv-2/interrupt')).toBe(true);
    // And the ending is the server's, accounting and all — not a card this side
    // drew for itself the moment the route answered.
    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      reason: 'interrupted',
      usage: { tokens: { inputTokens: 40, outputTokens: 3 } },
    });
  });

  it('still carries the last usage reading when it has to end the run itself', async () => {
    // A server too old for the run routes never announces a run id, so the
    // stop is the local abort alone — and the tokens counted by then were
    // spent all the same.
    const { origin } = await serve((request, response) => {
      if (request.url === '/v1/chat/completions') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({ role: 'assistant' })));
        response.write(
          sse(
            chunk(
              { content: 'thinking…' },
              { usage: { prompt_tokens: 21, completion_tokens: 2, total_tokens: 23 } },
            ),
          ),
        );
        return; // holds forever; the local abort is the only exit
      }
      response.writeHead(404);
      response.end();
    });

    const adapter = createArtemisAdapter();
    const run = await adapter.createRun({
      ...base,
      runId: 'run-old' as RunId,
      env: { [LOCAL_BASE_URL_ENV]: origin },
    } as ResolvedRunInput);

    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'text.delta') void run.interrupt();
    }

    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      reason: 'interrupted',
      usage: { tokens: { inputTokens: 21, outputTokens: 2 } },
    });
  });

  it('draws a card from a permission chunk and answers it on the run route', async () => {
    let completion: ServerResponse | undefined;
    const { origin, seen } = await serve((request, response) => {
      if (request.url === '/v1/chat/completions') {
        completion = response;
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({ role: 'assistant' })));
        response.write(sse(chunk({}, { artemis: { runId: 'srv-3' } })));
        response.write(
          sse(
            chunk(
              {},
              {
                artemis: {
                  permission: {
                    status: 'requested',
                    request: {
                      id: 'perm-1',
                      runId: 'srv-3',
                      toolName: 'Bash',
                      input: { command: 'rm -rf build' },
                      requestedAt: 1,
                    },
                  },
                },
              },
            ),
          ),
        );
        return; // parks; the answer arrives on a different request, below
      }
      if (request.url === '/api/v0/runs/srv-3/permission') {
        // The answer landed. Clear the card and finish the turn on the open stream.
        completion?.write(
          sse(
            chunk(
              {},
              { artemis: { permission: { status: 'resolved', requestId: 'perm-1', outcome: 'allowed' } } },
            ),
          ),
        );
        completion?.write(sse(chunk({ content: 'Removed it.' })));
        completion?.write(
          sse(chunk({}, { finish_reason: 'stop', artemis: { sessionId: 'sess-p', endReason: 'completed' } })),
        );
        completion?.write(sse('[DONE]'));
        completion?.end();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ requestId: 'perm-1' }));
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const adapter = createArtemisAdapter();
    const run = await adapter.createRun({
      ...base,
      runId: 'run-perm' as RunId,
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok' },
    } as ResolvedRunInput);

    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'permission.request') {
        void run.respondToPermission(event.requestId, { behavior: 'allow', scope: 'once' });
      }
    }

    const request = events.find((event) => event.type === 'permission.request');
    // The request rides through verbatim, but its run id is re-stamped to the
    // local run so the transcript agrees on one; the server's `request.id` stays
    // the answer key.
    expect(request).toMatchObject({
      type: 'permission.request',
      requestId: 'perm-1',
      request: { toolName: 'Bash', runId: 'run-perm', input: { command: 'rm -rf build' } },
    });
    expect(
      events.some(
        (event) =>
          event.type === 'permission.resolved' &&
          event.requestId === 'perm-1' &&
          event.outcome === 'allowed',
      ),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });

    // The decision went back to the run route, with the token and the id.
    const answer = seen.find((row) => row.url === '/api/v0/runs/srv-3/permission');
    expect(answer?.authorization).toBe('Bearer tok');
    expect(answer?.body).toEqual({ requestId: 'perm-1', decision: { behavior: 'allow', scope: 'once' } });
  });
  it('keeps a parked ask where it was asked: the reasoning after it is a new block', async () => {
    // The agent thinks, stops to ask, and thinks again once the answer lands.
    // On the wire that is reasoning, a permission chunk, reasoning — the same
    // kind either side of the park, which used to mean the same block index:
    // the transcript writes a later delta of a block back into the row it
    // opened, so everything the agent thought *after* the question was
    // appended to the fold above the card, and the card read as the end of
    // the reasoning it was asked in the middle of. A park closes the block.
    let completion: ServerResponse | undefined;
    const { origin } = await serve((request, response) => {
      if (request.url === '/v1/chat/completions') {
        completion = response;
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({ role: 'assistant' }, { artemis: { runId: 'srv-4' } })));
        response.write(sse(chunk({ reasoning_content: 'Two libraries would do. ' })));
        response.write(sse(chunk({ reasoning_content: 'Better ask.' })));
        response.write(
          sse(
            chunk(
              {},
              {
                artemis: {
                  permission: {
                    status: 'requested',
                    request: {
                      id: 'ask-1',
                      runId: 'srv-4',
                      toolName: 'AskUserQuestion',
                      input: {},
                      requestedAt: 1,
                      question: {
                        questions: [
                          {
                            question: 'Which library?',
                            header: 'Library',
                            multiSelect: false,
                            options: [
                              { label: 'date-fns', description: 'one' },
                              { label: 'Luxon', description: 'two' },
                            ],
                          },
                        ],
                      },
                    },
                  },
                },
              },
            ),
          ),
        );
        return; // parks; the answer arrives on the run route, below
      }
      if (request.url === '/api/v0/runs/srv-4/permission') {
        completion?.write(
          sse(
            chunk(
              {},
              {
                artemis: {
                  permission: {
                    status: 'resolved',
                    requestId: 'ask-1',
                    outcome: 'allowed',
                  },
                },
              },
            ),
          ),
        );
        // The serving side sets the provider's next reasoning block apart
        // with a paragraph break, as it does between any two blocks.
        completion?.write(sse(chunk({ reasoning_content: '\n\nLuxon it is.' })));
        completion?.write(sse(chunk({ content: 'Using Luxon.' })));
        completion?.write(
          sse(chunk({}, { finish_reason: 'stop', artemis: { sessionId: 'sess-q', endReason: 'completed' } })),
        );
        completion?.write(sse('[DONE]'));
        completion?.end();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ requestId: 'ask-1' }));
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const adapter = createArtemisAdapter();
    const run = await adapter.createRun({
      ...base,
      runId: 'run-ask' as RunId,
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok' },
    } as ResolvedRunInput);

    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'permission.request') {
        void run.respondToPermission(event.requestId, {
          behavior: 'allow',
          scope: 'once',
          answers: [{ question: 'Which library?', options: ['Luxon'] }],
        });
      }
    }

    const story = events
      .filter((event) => event.type !== 'session.started' && event.type !== 'run.end')
      .map((event) => {
        const { type, blockIndex, text } = event as { type: string; blockIndex?: number; text?: string };
        return blockIndex === undefined ? { type } : { type, blockIndex, text };
      });

    expect(story).toEqual([
      { type: 'thinking.delta', blockIndex: 0, text: 'Two libraries would do. ' },
      { type: 'thinking.delta', blockIndex: 0, text: 'Better ask.' },
      { type: 'permission.request' },
      { type: 'permission.resolved' },
      // A fresh block, so the transcript opens a fresh row under the card —
      // and the server's break between the two blocks is not carried to the
      // head of it, where it would separate nothing.
      { type: 'thinking.delta', blockIndex: 1, text: 'Luxon it is.' },
      { type: 'text.delta', blockIndex: 2, text: 'Using Luxon.' },
      { type: 'text.complete', blockIndex: 2, text: 'Using Luxon.' },
    ]);
  });

  it('closes an answer in progress when the agent stops to ask, and finalises it', async () => {
    // The same boundary on the answer's side: what the agent said before the
    // question is one block, finalised with its `text.complete`, and what it
    // says after is the next — not more of the same paragraph above the card.
    let completion: ServerResponse | undefined;
    const { origin } = await serve((request, response) => {
      if (request.url === '/v1/chat/completions') {
        completion = response;
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({ role: 'assistant' }, { artemis: { runId: 'srv-5' } })));
        response.write(sse(chunk({ content: 'One thing first.' })));
        response.write(
          sse(
            chunk(
              {},
              {
                artemis: {
                  permission: {
                    status: 'requested',
                    request: { id: 'perm-5', runId: 'srv-5', toolName: 'Bash', input: { command: 'ls' }, requestedAt: 1 },
                  },
                },
              },
            ),
          ),
        );
        return;
      }
      if (request.url === '/api/v0/runs/srv-5/permission') {
        completion?.write(
          sse(chunk({}, { artemis: { permission: { status: 'resolved', requestId: 'perm-5', outcome: 'allowed' } } })),
        );
        completion?.write(sse(chunk({ content: 'Done.' })));
        completion?.write(sse(chunk({}, { finish_reason: 'stop', artemis: { sessionId: 'sess-5', endReason: 'completed' } })));
        completion?.write(sse('[DONE]'));
        completion?.end();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ requestId: 'perm-5' }));
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const adapter = createArtemisAdapter();
    const run = await adapter.createRun({
      ...base,
      runId: 'run-5' as RunId,
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok' },
    } as ResolvedRunInput);

    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'permission.request') {
        void run.respondToPermission(event.requestId, { behavior: 'allow', scope: 'once' });
      }
    }

    const story = events
      .filter((event) => event.type !== 'session.started' && event.type !== 'run.end')
      .map((event) => {
        const { type, blockIndex, text } = event as { type: string; blockIndex?: number; text?: string };
        return blockIndex === undefined ? { type } : { type, blockIndex, text };
      });

    expect(story).toEqual([
      { type: 'text.delta', blockIndex: 0, text: 'One thing first.' },
      { type: 'text.complete', blockIndex: 0, text: 'One thing first.' },
      { type: 'permission.request' },
      { type: 'permission.resolved' },
      { type: 'text.delta', blockIndex: 1, text: 'Done.' },
      { type: 'text.complete', blockIndex: 1, text: 'Done.' },
    ]);
  });
});

describe('the remote decision guard', () => {
  it('refuses what the server would refuse with a 400', () => {
    // A durable scope writes to the serving machine's own settings.
    expect(() => guardRemoteDecision({ behavior: 'allow', scope: 'project' })).toThrow(/durable scope/i);
    // A mode switch — bypassPermissions above all — is not a client's to make.
    expect(() =>
      guardRemoteDecision({
        behavior: 'allow',
        updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', scope: 'session' }],
      }),
    ).toThrow(/permission mode/i);
    // A directory grant widens the connection's pinned workspace.
    expect(() =>
      guardRemoteDecision({
        behavior: 'allow',
        updatedPermissions: [{ type: 'addDirectories', directories: ['/etc'], scope: 'session' }],
      }),
    ).toThrow(/directories/i);
  });

  it('lets a once/session decision through', () => {
    expect(() => guardRemoteDecision({ behavior: 'allow', scope: 'once' })).not.toThrow();
    expect(() =>
      guardRemoteDecision({
        behavior: 'allow',
        scope: 'session',
        updatedPermissions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash' }], scope: 'session' }],
      }),
    ).not.toThrow();
    expect(() => guardRemoteDecision({ behavior: 'deny', message: 'no' })).not.toThrow();
  });
});

describe('the probe and the catalogue', () => {
  it('probes the connection endpoint at the profile’s address, with the token', async () => {
    const { origin, seen } = await serve((request, response) => {
      expect(request.url).toBe('/api/v0/connection');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'conn-1',
          label: 'laptop',
          workspace: { kind: 'directory', path: '/srv/work' },
          canRunTurns: true,
        }),
      );
    });

    const adapter = createArtemisAdapter();
    const availability = await adapter.checkAvailability?.({
      env: { [LOCAL_BASE_URL_ENV]: `${origin}/`, [LOCAL_API_KEY_ENV]: 'tok_123' },
    });

    expect(availability?.available).toBe(true);
    expect(seen[0]?.url).toBe('/api/v0/connection');
    expect(seen[0]?.authorization).toBe('Bearer tok_123');
  });

  it('reports a refusal as a token problem and an absence as an address one', async () => {
    const refused = await serve((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'no', type: 'auth' } }));
    });

    const adapter = createArtemisAdapter();

    const refusal = await adapter.checkAvailability?.({
      env: { [LOCAL_BASE_URL_ENV]: refused.origin },
    });
    expect(refusal?.available).toBe(false);
    expect(refusal?.unavailableReason).toContain('connection token');

    const absence = await adapter.checkAvailability?.({
      env: { [LOCAL_BASE_URL_ENV]: 'http://127.0.0.1:9' },
    });
    expect(absence?.available).toBe(false);
    expect(absence?.unavailableReason).toContain('http://127.0.0.1:9');
  });

  it('lists the routes the connection may run, live', async () => {
    const { origin, seen } = await serve((request, response) => {
      expect(request.url).toBe('/api/v0/models');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'artemis.models',
          models: [
            {
              route: 'work/opus',
              id: 'opus',
              label: 'Opus 5',
              note: 'The safe default.',
              profileId: 'p1',
              profileSlug: 'work',
              profileLabel: 'Work',
              providerId: 'claude',
              thinkingLevels: [],
              adaptiveThinking: true,
              fastMode: true,
              ultracode: false,
              tier: 2,
            },
          ],
        }),
      );
    });

    const adapter = createArtemisAdapter();
    const catalogue = await adapter.listModels?.({
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok_123' },
      cwd: process.cwd(),
    });

    expect(catalogue?.live).toBe(true);
    expect(catalogue?.models[0]).toMatchObject({
      id: 'work/opus',
      label: 'Opus 5',
      note: 'Work — The safe default.',
      tier: 2,
      supportsFastMode: true,
      supportsUltracode: false,
      adaptiveThinking: true,
    });
    expect(seen[0]?.authorization).toBe('Bearer tok_123');
  });

  it('answers not-confirmed rather than throwing when the server is away', async () => {
    const adapter = createArtemisAdapter();
    const catalogue = await adapter.listModels?.({
      env: { [LOCAL_BASE_URL_ENV]: 'http://127.0.0.1:9' },
      cwd: process.cwd(),
    });
    expect(catalogue).toEqual({ models: [], live: false });
  });

  it('fills the slash-command menu from the server, with the token', async () => {
    const { origin, seen } = await serve((request, response) => {
      expect(request.url).toBe('/api/v0/commands');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'artemis.commands',
          commands: ['compact', 'artemis-skills:unslop', 'compact', 7],
          accounts: [],
        }),
      );
    });

    const adapter = createArtemisAdapter();
    const commands = await adapter.listCommands?.({
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok_123' },
      cwd: process.cwd(),
    });

    // The serving machine's names as it spells them, folded and read leniently
    // — and nothing about this machine's directory on the wire.
    expect(commands).toEqual(['compact', 'artemis-skills:unslop']);
    expect(seen[0]?.url).toBe('/api/v0/commands');
    expect(seen[0]?.authorization).toBe('Bearer tok_123');
  });

  it('offers no commands against a server too old for the route, or one that is away', async () => {
    const older = await serve((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'no such route', type: 'invalid_request_error' } }));
    });
    const adapter = createArtemisAdapter();
    expect(
      await adapter.listCommands?.({ env: { [LOCAL_BASE_URL_ENV]: older.origin }, cwd: process.cwd() }),
    ).toEqual([]);
    expect(
      await adapter.listCommands?.({ env: { [LOCAL_BASE_URL_ENV]: 'http://127.0.0.1:9' }, cwd: process.cwd() }),
    ).toEqual([]);
  });
});

/**
 * A stream that dies, and the run that does not.
 *
 * The socket is destroyed mid-turn on purpose, exactly as a laptop lid or a
 * dropped tunnel would do it, and the same test server then answers the
 * resume route. What is pinned: the adapter reconnects from the last cursor
 * it rendered, draws each piece once, and ends on the run's real end — or on
 * the server saying the run is gone, or on the user's own stop.
 */
describe('a stream that dies under the run', () => {
  const FAST = { reconnect: { backoffMs: [10], watchdogMs: 100 } };

  /** Split a scripted stream between the first socket and the resume. */
  function resumable(script: {
    readonly first: (response: ServerResponse) => void;
    readonly resume: (response: ServerResponse, url: string) => void;
  }) {
    return serve((request, response) => {
      if (request.url === '/v1/chat/completions') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        script.first(response);
        return;
      }
      if (request.url?.startsWith('/api/v0/runs/run-x/stream')) {
        script.resume(response, request.url);
        return;
      }
      response.writeHead(404).end();
    });
  }

  it('picks the run back up from the last chunk it rendered, and draws nothing twice', async () => {
    const { origin, seen } = await resumable({
      first: (response) => {
        response.write(sse(chunk({ role: 'assistant' })));
        response.write(sse(chunk({}, { artemis: { runId: 'run-x' } })));
        response.write(sse(chunk({}, { artemis: { sessionId: 'sess-abc', seq: 0 } })));
        response.write(sse(chunk({ content: 'Hel' }, { artemis: { seq: 1 } })));
        setTimeout(() => response.destroy(), 20);
      },
      resume: (response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({}, { artemis: { runId: 'run-x' } })));
        response.write(sse(chunk({ content: 'lo.' }, { artemis: { seq: 2 } })));
        response.write(
          sse(
            chunk(
              {},
              { finish_reason: 'stop', artemis: { sessionId: 'sess-abc', endReason: 'completed', seq: 3 } },
            ),
          ),
        );
        response.write(sse('[DONE]'));
        response.end();
      },
    });

    const events = await drive(origin, {}, FAST);

    // The resume asked for everything after the last numbered chunk.
    expect(seen.map((request) => request.url)).toEqual([
      '/v1/chat/completions',
      '/api/v0/runs/run-x/stream?after=1',
    ]);
    expect(seen[1]?.authorization).toBe('Bearer tok_123');

    const text = events.filter((event) => event.type === 'text.delta').map((event) => (event as { text: string }).text);
    expect(text).toEqual(['Hel', 'lo.']);
    // The reader is told the link went and came back, in the adapter's own
    // voice, and the answer block that was open is closed under the notice
    // so what follows lands below it.
    const notices = events.filter(
      (event) => event.type === 'text.complete' && (event as { synthetic?: boolean }).synthetic === true,
    );
    expect(notices.map((event) => (event as { text: string }).text)).toEqual([
      expect.stringContaining('dropped'),
      expect.stringContaining('Reconnected'),
    ]);
    const completes = events.filter(
      (event) => event.type === 'text.complete' && (event as { synthetic?: boolean }).synthetic !== true,
    );
    expect(completes).toMatchObject([
      { blockIndex: 0, text: 'Hel' },
      { blockIndex: 1, text: 'lo.' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed', sessionId: 'sess-abc' });
    expect(events.filter((event) => event.type === 'session.started')).toHaveLength(1);
  });

  it('resumes from the beginning when nothing it rendered was numbered', async () => {
    const { origin, seen } = await resumable({
      first: (response) => {
        response.write(sse(chunk({ role: 'assistant' })));
        response.write(sse(chunk({}, { artemis: { runId: 'run-x' } })));
        setTimeout(() => response.destroy(), 20);
      },
      resume: (response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({ content: 'All of it.' }, { artemis: { seq: 0 } })));
        response.write(sse(chunk({}, { finish_reason: 'stop', artemis: { endReason: 'completed', seq: 1 } })));
        response.write(sse('[DONE]'));
        response.end();
      },
    });

    const events = await drive(origin, {}, FAST);
    expect(seen[1]?.url).toBe('/api/v0/runs/run-x/stream');
    expect(events.filter((event) => event.type === 'text.delta')).toMatchObject([{ text: 'All of it.' }]);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('keeps trying through a server that is not back yet', async () => {
    let attempts = 0;
    const { origin } = await resumable({
      first: (response) => {
        response.write(sse(chunk({}, { artemis: { runId: 'run-x' } })));
        setTimeout(() => response.destroy(), 20);
      },
      resume: (response) => {
        attempts += 1;
        if (attempts < 3) {
          // Still coming up: a 503, then a socket that dies before headers.
          if (attempts === 1) response.writeHead(503).end();
          else response.destroy();
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({}, { finish_reason: 'stop', artemis: { endReason: 'completed', seq: 0 } })));
        response.write(sse('[DONE]'));
        response.end();
      },
    });

    const events = await drive(origin, {}, FAST);
    expect(attempts).toBe(3);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('gives up, and says why, when the server no longer has the run', async () => {
    const { origin } = await resumable({
      first: (response) => {
        response.write(sse(chunk({}, { artemis: { runId: 'run-x' } })));
        response.write(sse(chunk({ content: 'Hal' }, { artemis: { seq: 0 } })));
        setTimeout(() => response.destroy(), 20);
      },
      resume: (response) => {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'No such run for this connection.' } }));
      },
    });

    const events = await drive(origin, {}, FAST);
    const end = events.at(-1) as { type: string; reason: string; error?: { message: string } };
    expect(end.type).toBe('run.end');
    expect(end.reason).toBe('error');
    expect(end.error?.message).toContain('no longer has this run');
  });

  it('presumes a silent stream dead once the server has shown it heartbeats', async () => {
    let firstSocket: ServerResponse | undefined;
    const { origin, seen } = await resumable({
      first: (response) => {
        firstSocket = response;
        response.write(sse(chunk({}, { artemis: { runId: 'run-x' } })));
        response.write(':hb\n\n');
        // …and then nothing, for longer than the watchdog allows.
      },
      resume: (response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({ content: 'Back.' }, { artemis: { seq: 0 } })));
        response.write(sse(chunk({}, { finish_reason: 'stop', artemis: { endReason: 'completed', seq: 1 } })));
        response.write(sse('[DONE]'));
        response.end();
      },
    });

    const events = await drive(origin, {}, FAST);
    firstSocket?.destroy();
    expect(seen.map((request) => request.url)).toEqual([
      '/v1/chat/completions',
      '/api/v0/runs/run-x/stream',
    ]);
    expect(events.filter((event) => event.type === 'text.delta')).toMatchObject([{ text: 'Back.' }]);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('waits out silence on a server that has never heartbeated', async () => {
    // An older server sends no comments; its long tool calls are silent and
    // that silence is not evidence. The watchdog stays unarmed.
    const { origin, seen } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({}, { artemis: { runId: 'run-x' } })));
      setTimeout(() => {
        response.write(sse(chunk({ content: 'Late.' })));
        response.write(sse(chunk({}, { finish_reason: 'stop', artemis: { endReason: 'completed' } })));
        response.write(sse('[DONE]'));
        response.end();
      }, 300);
    });

    const events = await drive(origin, {}, FAST);
    expect(seen.map((request) => request.url)).toEqual(['/v1/chat/completions']);
    expect(events.filter((event) => event.type === 'text.delta')).toMatchObject([{ text: 'Late.' }]);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('stops trying the moment the user stops the run', async () => {
    const { origin, seen } = await resumable({
      first: (response) => {
        response.write(sse(chunk({}, { artemis: { runId: 'run-x' } })));
        setTimeout(() => response.destroy(), 20);
      },
      resume: (response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse('[DONE]'));
        response.end();
      },
    });

    const adapter = createArtemisAdapter({ reconnect: { backoffMs: [60_000], watchdogMs: 100 } });
    const run = await adapter.createRun({
      runId: 'run-1' as RunId,
      providerId: 'artemis',
      profileId: 'profile-1',
      cwd: process.cwd(),
      prompt: 'hello',
      model: 'work/opus',
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok_123' },
    } as ResolvedRunInput);

    const events: AgentEvent[] = [];
    const startedAt = Date.now();
    for await (const event of run.events) {
      events.push(event);
      // The link is reported lost; the user stops the run during the wait.
      if (event.type === 'text.complete') void run.interrupt();
    }
    // Ended from inside a sixty-second wait, well inside it.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'interrupted' });
    // The interrupt route was posted, the resume never was.
    expect(seen.map((request) => request.url)).toEqual([
      '/v1/chat/completions',
      '/api/v0/runs/run-x/interrupt',
    ]);
  });
});

/**
 * A served row carries the account that holds it.
 *
 * On this machine the row's `profileId` is the Artemis Server profile — one
 * profile wearing every account the server offers — so the account whose store
 * actually has the transcript has to travel separately, or a resume goes out
 * on whatever route the column was showing and the server's provider cannot
 * find the conversation.
 */
describe('listing served conversations', () => {
  it('carries the serving account, and tolerates a server that sends none', async () => {
    const { origin } = await serve((request, response) => {
      expect(request.url).toBe('/api/v0/sessions');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'artemis.sessions',
          sessions: [
            {
              id: 'sess-1',
              title: 'Held by work',
              updatedAt: 5,
              profileSlug: 'work-max',
              profileId: 'p1',
              providerId: 'claude',
              cwd: '/srv/repo',
            },
            // A 2.4.x server: slug only, no id.
            { id: 'sess-2', title: 'From an older server', updatedAt: 4, profileSlug: 'work-max', cwd: '/srv/repo' },
          ],
        }),
      );
    });

    const adapter = createArtemisAdapter();
    const page = await adapter.listSessions?.({
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok_123' },
      cwd: process.cwd(),
      profileId: 'desk-1' as never,
    });

    expect(page?.sessions[0]).toMatchObject({
      id: 'sess-1',
      profileId: 'desk-1',
      accountSlug: 'work-max',
      accountId: 'p1',
      cwd: '/srv/repo',
    });
    expect(page?.sessions[1]).toMatchObject({ id: 'sess-2', accountSlug: 'work-max' });
    expect(page?.sessions[1]).not.toHaveProperty('accountId');
  });
});

/**
 * Reshaping a served conversation, and reading a queued message now.
 *
 * A fork and a rewind cross the wire as `artemis.forkSession` and
 * `artemis.rewindToMessageId`, beside the session id they act on. What these
 * pin, beyond the body: a fork's session is the *branch* the server announces,
 * never the original it was told to branch from — announcing that first would
 * name the branch after its parent and send every later prompt back to it.
 *
 * "Read it now" is an interrupt with something queued behind the turn. The
 * server keeps the queued message across the interrupt and opens the next
 * turn on it, on the same stream; the adapter used to abort that stream the
 * moment the interrupt was acknowledged, which ended the conversation on this
 * side a second after the click while the server went on answering a message
 * nobody was listening for.
 */
describe('forking, rewinding and reading a queued message now', () => {
  const base = {
    runId: 'run-fr' as RunId,
    providerId: 'artemis' as const,
    profileId: 'profile-1',
    cwd: process.cwd(),
    prompt: 'again, differently',
    model: 'work/opus',
  };

  function branchStream(response: ServerResponse, sessionId: string): void {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(sse(chunk({ role: 'assistant' })));
    response.write(sse(chunk({}, { artemis: { sessionId } })));
    response.write(sse(chunk({ content: 'from here on' })));
    response.write(
      sse(chunk({}, { finish_reason: 'stop', artemis: { sessionId, endReason: 'completed' } })),
    );
    response.write(sse('[DONE]'));
    response.end();
  }

  it('sends the fork beside the session and adopts the branch the server announces', async () => {
    const { origin, seen } = await serve((_request, response) => branchStream(response, 'branch-1'));

    const adapter = createArtemisAdapter();
    const run = await adapter.createRun({
      ...base,
      resumeSessionId: 'orig-1',
      forkSession: true,
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok' },
    } as ResolvedRunInput);
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    const body = seen[0]?.body as { artemis: Record<string, unknown> };
    expect(body.artemis).toMatchObject({ sessionId: 'orig-1', forkSession: true });
    expect(body.artemis).not.toHaveProperty('rewindToMessageId');

    const announced = events.filter((event) => event.type === 'session.started');
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ sessionId: 'branch-1', resumedFrom: 'orig-1' });
    expect(run.sessionId).toBe('branch-1');
    expect(events.at(-1)).toMatchObject({ type: 'run.end', sessionId: 'branch-1' });
  });

  it('sends the rewind anchor and keeps the session it cuts', async () => {
    const { origin, seen } = await serve((_request, response) => branchStream(response, 'orig-1'));

    const adapter = createArtemisAdapter();
    const run = await adapter.createRun({
      ...base,
      resumeSessionId: 'orig-1',
      rewindToMessageId: 'msg-7',
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok' },
    } as ResolvedRunInput);
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    const body = seen[0]?.body as { artemis: Record<string, unknown> };
    expect(body.artemis).toMatchObject({ sessionId: 'orig-1', rewindToMessageId: 'msg-7' });
    expect(body.artemis).not.toHaveProperty('forkSession');
    // A rewind stays in its conversation, so the session is known before the
    // first byte, exactly as for any other resume.
    expect(events[0]).toMatchObject({ type: 'session.started', sessionId: 'orig-1' });
  });

  it('keeps the stream open when the server still holds a queued message', async () => {
    let held: ServerResponse | undefined;
    const { origin } = await serve((request, response) => {
      if (request.url === '/v1/chat/completions') {
        held = response;
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({ role: 'assistant' })));
        response.write(sse(chunk({}, { artemis: { runId: 'srv-q' } })));
        response.write(sse(chunk({ content: 'first turn…' })));
        return; // holds: the test steers, then asks for the message to be read now
      }
      if (request.url === '/api/v0/runs/srv-q/messages') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ runId: 'srv-q', deliveredImmediately: false }));
        return;
      }
      if (request.url === '/api/v0/runs/srv-q/interrupt') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ runId: 'srv-q', stillQueued: ['srv-m1'] }));
        // The provider over there takes the queued message up, and the next
        // turn arrives on the stream it already has.
        held?.write(sse(chunk({ content: ' second turn' })));
        held?.write(sse(chunk({}, { finish_reason: 'stop', artemis: { endReason: 'completed' } })));
        held?.write(sse('[DONE]'));
        held?.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const adapter = createArtemisAdapter();
    const run = await adapter.createRun({
      ...base,
      runId: 'run-q' as RunId,
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok' },
    } as ResolvedRunInput);

    const events: AgentEvent[] = [];
    let outcome: { readonly stillQueued: readonly string[] } | undefined;
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'text.delta' && outcome === undefined) {
        await run.send('read this next', undefined, 'local-m1' as never);
        outcome = await run.interrupt();
      }
    }

    // Named in this side's ids: the one steer that had not been delivered.
    expect(outcome?.stillQueued).toEqual(['local-m1']);
    // The conversation went on rather than ending at the click.
    expect(events.some((event) => event.type === 'text.delta' && event.text === ' second turn')).toBe(
      true,
    );
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('keeps the stream open even when the server names nothing as queued', async () => {
    /*
     * The case seen live on 2026-09-18: a message queued behind the turn, the
     * stop pressed to have it read now, and the server's receipt naming no
     * queued message — a Claude server lists only the ids it can match to a
     * steer of this client's. The message survived and was answered all the
     * same, so an empty list is no reason to end the conversation on this
     * side; the server's own ending is.
     */
    let held: ServerResponse | undefined;
    const { origin, seen } = await serve((request, response) => {
      if (request.url === '/v1/chat/completions') {
        held = response;
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({ role: 'assistant' })));
        response.write(sse(chunk({}, { artemis: { runId: 'srv-s' } })));
        response.write(sse(chunk({ content: 'working…' })));
        return; // holds: the stop is acknowledged, then the next turn arrives
      }
      if (request.url === '/api/v0/runs/srv-s/interrupt') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ runId: 'srv-s', stillQueued: [] }));
        held?.write(sse(chunk({ content: ' read it, carrying on' })));
        held?.write(sse(chunk({}, { finish_reason: 'stop', artemis: { endReason: 'completed' } })));
        held?.write(sse('[DONE]'));
        held?.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const adapter = createArtemisAdapter();
    const run = await adapter.createRun({
      ...base,
      runId: 'run-s' as RunId,
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok' },
    } as ResolvedRunInput);

    const events: AgentEvent[] = [];
    let outcome: { readonly stillQueued: readonly string[] } | undefined;
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'text.delta' && outcome === undefined) outcome = await run.interrupt();
    }

    expect(seen.some((row) => row.url === '/api/v0/runs/srv-s/interrupt')).toBe(true);
    expect(outcome).toEqual({ stillQueued: [] });
    expect(
      events.some((event) => event.type === 'text.delta' && event.text === ' read it, carrying on'),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('stops outright when the server will not take the interrupt', async () => {
    // Nothing over there has been told to stop, so the local abort is the only
    // stop there is — a dead Stop button would be worse than a torn stream.
    const { origin, seen } = await serve((request, response) => {
      if (request.url === '/v1/chat/completions') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(sse(chunk({ role: 'assistant' })));
        response.write(sse(chunk({}, { artemis: { runId: 'srv-r' } })));
        response.write(sse(chunk({ content: 'working…' })));
        return; // holds forever; the local abort is the only exit
      }
      if (request.url === '/api/v0/runs/srv-r/interrupt') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not now' } }));
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const adapter = createArtemisAdapter();
    const run = await adapter.createRun({
      ...base,
      runId: 'run-r' as RunId,
      env: { [LOCAL_BASE_URL_ENV]: origin, [LOCAL_API_KEY_ENV]: 'tok' },
    } as ResolvedRunInput);

    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'text.delta') void run.interrupt();
    }

    expect(seen.some((row) => row.url === '/api/v0/runs/srv-r/interrupt')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'interrupted' });
  });
});

/**
 * The paragraph break the server puts between two answer blocks.
 *
 * On its flat stream the server parts two blocks of answer with a paragraph
 * break, exactly as it parts two reasoning blocks. When a stretch of reasoning
 * sat between them this adapter opens a fresh row for the second block anyway,
 * and the break at its head would stand as blank lines; when nothing sat
 * between them the break is what keeps the two paragraphs apart in one row.
 */
describe('two answer blocks on one stream', () => {
  it('drops the break at the head of a fresh row, keeps it inside a continuing one', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' })));
      response.write(sse(chunk({ content: 'Starting the probe.' })));
      // Reasoning between: the adapter opens a new answer row after it.
      response.write(sse(chunk({ reasoning_content: 'ran it' })));
      response.write(sse(chunk({ content: '\n\n**Probe complete.**' })));
      // No reasoning between: same row, so the break is the paragraph.
      response.write(sse(chunk({ content: '\n\nAnd a footnote.' })));
      response.write(
        sse(chunk({}, { finish_reason: 'stop', artemis: { sessionId: 's-1', endReason: 'completed' } })),
      );
      response.write(sse('[DONE]'));
      response.end();
    });

    const events = await drive(origin);
    const texts = events
      .filter((event) => event.type === 'text.delta')
      .map((event) => ({
        blockIndex: (event as { blockIndex: number }).blockIndex,
        text: (event as { text: string }).text,
      }));
    expect(texts).toEqual([
      { blockIndex: 0, text: 'Starting the probe.' },
      { blockIndex: 2, text: '**Probe complete.**' },
      { blockIndex: 2, text: '\n\nAnd a footnote.' },
    ]);
  });
});

/**
 * Tool calls, drawn while the remote agent makes them.
 *
 * The report on the final chunk used to be the only word of any call, so a
 * served pane sat still through a tool-heavy turn — a probe saw 241 bare
 * cursor chunks and not one row in thirteen minutes — and then drew every
 * call at once under the answer. A server that sends `artemis.tool` puts each
 * of the agent's own calls on the stream as it starts and as it ends; what is
 * pinned here is that each becomes a row at that moment, in the block order a
 * local run would give it, exactly once, and that the report still draws what
 * the stream did not show.
 */
describe('tool calls drawn as they happen', () => {
  const READ = { id: 'call-1', tool: 'read', summary: 'src/a.ts', at: 5 };
  const BASH = { id: 'call-2', tool: 'bash', summary: 'pnpm test', at: 6 };

  /** What a transcript draws from each event, without the run's bookends. */
  const story = (events: readonly AgentEvent[]) =>
    events
      .filter((event) => event.type !== 'session.started' && event.type !== 'run.end')
      .map((event) => {
        const fields = event as unknown as Record<string, unknown>;
        return Object.fromEntries(
          ['type', 'blockIndex', 'text', 'toolCallId', 'name', 'title', 'status', 'resultText']
            .filter((field) => fields[field] !== undefined)
            .map((field) => [field, fields[field]]),
        );
      });
  /** The tool rows alone. */
  const rows = (events: readonly AgentEvent[]) =>
    story(events.filter((event) => event.type === 'tool.start' || event.type === 'tool.end'));

  it('draws each call as it starts and as it ends, closing the answer in progress first', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' }, { artemis: { runId: 'srv-t', sessionId: 'sess-t' } })));
      response.write(sse(chunk({ content: 'Reading the file.' }, { artemis: { seq: 1 } })));
      response.write(sse(chunk({}, { artemis: { tool: READ, seq: 2 } })));
      response.write(sse(chunk({}, { artemis: { tool: { ...READ, ok: true }, seq: 3 } })));
      // The server parts the answer blocks either side of the call with a
      // paragraph break, which separates nothing at the head of a fresh row.
      response.write(sse(chunk({ content: '\n\nIt is fine.' }, { artemis: { seq: 4 } })));
      response.write(
        sse(
          chunk(
            {},
            {
              finish_reason: 'stop',
              artemis: { sessionId: 'sess-t', activity: [{ ...READ, ok: true }], endReason: 'completed', seq: 5 },
            },
          ),
        ),
      );
      response.write(sse('[DONE]'));
      response.end();
    });

    const events = await drive(origin);
    // The answer before the call is closed and finalised before the row
    // lands, so the answer after it opens a block of its own below the row
    // instead of being written back into the one above it. And the report
    // draws nothing: its one call is already on screen.
    expect(story(events)).toEqual([
      { type: 'text.delta', blockIndex: 0, text: 'Reading the file.' },
      { type: 'text.complete', blockIndex: 0, text: 'Reading the file.' },
      { type: 'tool.start', toolCallId: 'run-1-tool-call-1', name: 'read', title: 'src/a.ts' },
      { type: 'tool.end', toolCallId: 'run-1-tool-call-1', name: 'read', status: 'ok', resultText: 'src/a.ts' },
      { type: 'text.delta', blockIndex: 1, text: 'It is fine.' },
      { type: 'text.complete', blockIndex: 1, text: 'It is fine.' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed', sessionId: 'sess-t' });
  });

  it('draws from the report only what the stream did not show, and ends a row left running', async () => {
    // A subagent's calls never cross live, so the report is their only
    // account. A row whose ending never crossed takes its outcome from the
    // report, rather than spinning under an ended run.
    const GREP = { id: 'sub-1', tool: 'grep', summary: 'TODO', at: 7 };
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(sse(chunk({ role: 'assistant' }, { artemis: { runId: 'srv-t' } })));
      response.write(sse(chunk({}, { artemis: { tool: READ, seq: 1 } })));
      response.write(sse(chunk({}, { artemis: { tool: BASH, seq: 2 } })));
      response.write(sse(chunk({}, { artemis: { tool: { ...READ, ok: true }, seq: 3 } })));
      response.write(
        sse(
          chunk(
            {},
            {
              finish_reason: 'stop',
              artemis: {
                activity: [
                  { ...READ, ok: true },
                  { ...GREP, ok: true },
                  { ...BASH, ok: false },
                ],
                endReason: 'completed',
                seq: 9,
              },
            },
          ),
        ),
      );
      response.write(sse('[DONE]'));
      response.end();
    });

    const events = await drive(origin);
    expect(story(events)).toEqual([
      { type: 'tool.start', toolCallId: 'run-1-tool-call-1', name: 'read', title: 'src/a.ts' },
      { type: 'tool.start', toolCallId: 'run-1-tool-call-2', name: 'bash', title: 'pnpm test' },
      { type: 'tool.end', toolCallId: 'run-1-tool-call-1', name: 'read', status: 'ok', resultText: 'src/a.ts' },
      // The run is over: the row still running takes the report's outcome.
      { type: 'tool.end', toolCallId: 'run-1-tool-call-2', name: 'bash', status: 'error', resultText: 'pnpm test' },
      // The subagent's call, settled, under the id its place in the report gives it.
      { type: 'tool.start', toolCallId: 'run-1-act-1', name: 'grep', title: 'TODO' },
      { type: 'tool.end', toolCallId: 'run-1-act-1', name: 'grep', status: 'ok', resultText: 'TODO' },
    ]);
  });

  it('draws an older server’s report exactly as it always has', async () => {
    // No rows on the stream and no ids in the report: every entry is drawn,
    // settled, after the answer, under the ids a report's rows always took.
    const { origin } = await serve((_request, response) => happyStream(response));

    const events = await drive(origin);
    expect(story(events)).toEqual([
      { type: 'text.delta', blockIndex: 0, text: 'Hel' },
      { type: 'text.delta', blockIndex: 0, text: 'lo.' },
      { type: 'text.complete', blockIndex: 0, text: 'Hello.' },
      { type: 'tool.start', toolCallId: 'run-1-act-0', name: 'read', title: 'src/index.ts' },
      { type: 'tool.end', toolCallId: 'run-1-act-0', name: 'read', status: 'ok', resultText: 'src/index.ts' },
      { type: 'tool.start', toolCallId: 'run-1-act-1', name: 'bash', title: 'pnpm test' },
      { type: 'tool.end', toolCallId: 'run-1-act-1', name: 'bash', status: 'error', resultText: 'pnpm test' },
    ]);
  });

  describe('across a stream that dies', () => {
    const FAST = { reconnect: { backoffMs: [10], watchdogMs: 100 } };

    function resumable(script: {
      readonly first: (response: ServerResponse) => void;
      readonly resume: (response: ServerResponse) => void;
    }) {
      return serve((request, response) => {
        if (request.url === '/v1/chat/completions') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          script.first(response);
          return;
        }
        if (request.url?.startsWith('/api/v0/runs/run-x/stream')) {
          script.resume(response);
          return;
        }
        response.writeHead(404).end();
      });
    }

    it('never draws a row twice when a replay carries it again', async () => {
      const { origin, seen } = await resumable({
        first: (response) => {
          response.write(sse(chunk({}, { artemis: { runId: 'run-x', sessionId: 'sess-x', seq: 0 } })));
          response.write(sse(chunk({}, { artemis: { tool: READ, seq: 1 } })));
          setTimeout(() => response.destroy(), 20);
        },
        resume: (response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          response.write(sse(chunk({}, { artemis: { runId: 'run-x' } })));
          // The call's start again, and its ending twice: one row, one ending.
          response.write(sse(chunk({}, { artemis: { tool: READ, seq: 1 } })));
          response.write(sse(chunk({}, { artemis: { tool: { ...READ, ok: true }, seq: 2 } })));
          response.write(sse(chunk({}, { artemis: { tool: { ...READ, ok: true }, seq: 2 } })));
          // An ending whose start this run never saw still gets its row.
          response.write(sse(chunk({}, { artemis: { tool: { ...BASH, ok: true }, seq: 4 } })));
          response.write(
            sse(
              chunk(
                {},
                {
                  finish_reason: 'stop',
                  artemis: {
                    sessionId: 'sess-x',
                    activity: [
                      { ...READ, ok: true },
                      { ...BASH, ok: true },
                    ],
                    endReason: 'completed',
                    seq: 5,
                  },
                },
              ),
            ),
          );
          response.write(sse('[DONE]'));
          response.end();
        },
      });

      const events = await drive(origin, {}, FAST);
      expect(seen.map((request) => request.url)).toEqual([
        '/v1/chat/completions',
        '/api/v0/runs/run-x/stream?after=1',
      ]);
      expect(rows(events)).toEqual([
        { type: 'tool.start', toolCallId: 'run-1-tool-call-1', name: 'read', title: 'src/a.ts' },
        { type: 'tool.end', toolCallId: 'run-1-tool-call-1', name: 'read', status: 'ok', resultText: 'src/a.ts' },
        { type: 'tool.start', toolCallId: 'run-1-tool-call-2', name: 'bash', title: 'pnpm test' },
        { type: 'tool.end', toolCallId: 'run-1-tool-call-2', name: 'bash', status: 'ok', resultText: 'pnpm test' },
      ]);
      expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
    });

    it('ends a row still running as cancelled when the run cannot be picked back up', async () => {
      // The event contract: every start gets an ending, a run that stops
      // early included. This side can no longer hear how the call came out.
      const { origin } = await resumable({
        first: (response) => {
          response.write(sse(chunk({}, { artemis: { runId: 'run-x', seq: 0 } })));
          response.write(sse(chunk({}, { artemis: { tool: BASH, seq: 1 } })));
          setTimeout(() => response.destroy(), 20);
        },
        resume: (response) => {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'No such run for this connection.' } }));
        },
      });

      const events = await drive(origin, {}, FAST);
      expect(rows(events)).toEqual([
        { type: 'tool.start', toolCallId: 'run-1-tool-call-2', name: 'bash', title: 'pnpm test' },
        {
          type: 'tool.end',
          toolCallId: 'run-1-tool-call-2',
          name: 'bash',
          status: 'cancelled',
          resultText: 'pnpm test',
        },
      ]);
      expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'error' });
      // The ending lands before the run's own.
      expect(events.at(-2)).toMatchObject({ type: 'tool.end', status: 'cancelled' });
    });
  });
});
