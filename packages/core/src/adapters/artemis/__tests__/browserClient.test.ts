/**
 * The client's half of the relay: what it performs, and what it leaves alone.
 *
 * A served run's browser is on the machine the conversation was started from,
 * and this is the code that does the driving. Two properties are worth more
 * than all the rest:
 *
 *  - **Exactly one client performs a call.** Every client holding that
 *    connection's token sees it — two windows of one Artemis, two machines
 *    sharing a token — so seeing is not permission. A `click` performed twice
 *    is a form submitted twice, and there is no undoing that from here.
 *  - **Every call is answered, including the ones that failed.** The agent is
 *    on the other side of a deadline. A refusal posted as an answer is a
 *    sentence it can read out; silence is a timeout it can only guess at.
 *
 * Against a fake `fetch` and a fake driver: the socket has its own suite
 * (`extensionBridge.test.ts`), the route has its own
 * (`browserRelayRoute.test.ts`), and what is left here is the decisions.
 */

import { describe, expect, it, vi } from 'vitest';

import type { DriverResult, PageDriver, ServerBrowserCall } from '@rx-artemis/protocol';

import { createBrowserCallClient, performBrowserCall } from '../browserClient.js';

const ROOT = 'http://server.test:6472';

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** A driver that records what it was asked and answers whatever it was told. */
function fakeDriver(answer: DriverResult<unknown> = { ok: true, value: 'done' }) {
  const asked: string[] = [];
  const note =
    <T,>(verb: string) =>
    async (): Promise<DriverResult<T>> => {
      asked.push(verb);
      return answer as DriverResult<T>;
    };
  const driver = {
    kind: 'extension' as const,
    abilities: { console: true, network: true, cookies: true, storage: true, evaluate: true },
    open: note('open'),
    navigate: note('navigate'),
    read: note('read'),
    screenshot: note('screenshot'),
    click: note('click'),
    type: note('type'),
    console: note('console'),
    network: note('network'),
    cookies: note('cookies'),
    storage: note('storage'),
    evaluate: note('evaluate'),
    close: async (): Promise<void> => {
      asked.push('close');
    },
  } as unknown as PageDriver;
  return { driver, asked };
}

function call(over: Partial<ServerBrowserCall> = {}): ServerBrowserCall {
  return {
    object: 'artemis.browser.call',
    callId: 'c1',
    runId: 'run-1',
    runKey: 'run-1',
    verb: 'read',
    ...over,
  } as ServerBrowserCall;
}

/**
 * A `fetch` that serves one controllable event stream and records the answers.
 *
 * The stream is a real `ReadableStream`, fed a frame at a time, because the
 * client reads it with a real `createSseDecoder` — a fake that handed over
 * parsed events would skip the one part of this that touches bytes.
 */
function fakeServer() {
  const answers: { callId: string; result: DriverResult<unknown> }[] = [];
  const headersSeen: Record<string, string>[] = [];
  /*
   * One pusher per open stream, not one in total: the feed fans an event out
   * to every connection that may see it, and the two-clients case below is
   * meaningless unless both of them actually receive the call.
   */
  const pushers = new Set<(frame: string) => void>();
  let streams = 0;
  let closed = 0;

  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).slice(ROOT.length);
    if (path.startsWith('/api/v0/events')) {
      streams += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const push = (frame: string): void => {
            controller.enqueue(encoder.encode(frame));
          };
          pushers.add(push);
          init?.signal?.addEventListener('abort', () => {
            closed += 1;
            pushers.delete(push);
            try {
              controller.close();
            } catch {
              // Already closed by the reader letting go.
            }
          });
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === '/api/v0/browser/answer') {
      headersSeen.push((init?.headers ?? {}) as Record<string, string>);
      answers.push(JSON.parse(String(init?.body)) as never);
      return new Response(JSON.stringify({ object: 'artemis.browser.answer' }), { status: 200 });
    }
    return new Response('no', { status: 404 });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    answers,
    headersSeen,
    get streams() {
      return streams;
    },
    get closed() {
      return closed;
    },
    /** Put one browser call on the stream, as the server would. */
    async send(one: ServerBrowserCall): Promise<void> {
      await settle();
      const frame = `event: artemis:push:browser-call\ndata: ${JSON.stringify(one)}\n\n`;
      for (const push of pushers) push(frame);
      await settle();
    },
    /** Put something else on it, which the client must ignore. */
    async sendOther(): Promise<void> {
      await settle();
      const frame = `event: artemis:push:agent-event\ndata: ${JSON.stringify({ type: 'text.delta' })}\n\n`;
      for (const push of pushers) push(frame);
      await settle();
    },
  };
}

/** Let the client's reads, drives and posts run to their end. */
async function settle(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise((done) => setTimeout(done, 1));
}

/* -------------------------------------------------------------------------- */
/* Turning a call back into a verb                                            */
/* -------------------------------------------------------------------------- */

describe('one relayed call becomes one method on the driver', () => {
  it('maps every verb the contract carries', async () => {
    const { driver, asked } = fakeDriver();

    for (const verb of [
      { verb: 'open' },
      { verb: 'navigate', url: 'https://example.com' },
      { verb: 'read' },
      { verb: 'screenshot' },
      { verb: 'click', selector: '#a' },
      { verb: 'type', selector: '#a', text: 'x' },
      { verb: 'console' },
      { verb: 'network' },
      { verb: 'cookies' },
      { verb: 'storage' },
      { verb: 'evaluate', expression: '1' },
      { verb: 'close' },
    ] as const) {
      await performBrowserCall(() => driver, call(verb as never));
    }

    expect(asked).toEqual([
      'open',
      'navigate',
      'read',
      'screenshot',
      'click',
      'type',
      'console',
      'network',
      'cookies',
      'storage',
      'evaluate',
      'close',
    ]);
  });

  it('answers a close with an ok, because the server is waiting on something', async () => {
    // The contract's `close` returns `void` — a local caller has nobody to
    // report to. Across a wire there is a deadline, so "it is done" is sent.
    const { driver } = fakeDriver();

    expect(await performBrowserCall(() => driver, call({ verb: 'close' } as never))).toEqual({
      ok: true,
      value: null,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Performing and answering                                                   */
/* -------------------------------------------------------------------------- */

describe('a call for a run this client owns', () => {
  it('is performed and its answer is posted', async () => {
    const server = fakeServer();
    const { driver, asked } = fakeDriver({ ok: true, value: { text: 'hello' } });
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({ authorization: 'Bearer the-token' }),
      driverFor: () => driver,
      fetch: server.fetch,
    });
    client.own('run-1');

    await server.send(call({ callId: 'c7', verb: 'read' } as never));

    expect(asked).toEqual(['read']);
    expect(server.answers).toEqual([{ callId: 'c7', result: { ok: true, value: { text: 'hello' } } }]);
    client.stop();
  });

  it('posts with the same connection token the stream was opened on', async () => {
    // The route checks that the answering connection is the one the call was
    // addressed to, so an answer sent without the token is an answer refused.
    const server = fakeServer();
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({ authorization: 'Bearer the-token' }),
      driverFor: () => fakeDriver().driver,
      fetch: server.fetch,
    });
    client.own('run-1');

    await server.send(call());

    expect(server.headersSeen[0]).toMatchObject({ authorization: 'Bearer the-token' });
    client.stop();
  });

  it('carries a notice back, so a partial answer says it is partial', async () => {
    const server = fakeServer();
    const { driver } = fakeDriver({ ok: true, value: [], notice: 'older console entries were dropped' });
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: () => driver,
      fetch: server.fetch,
    });
    client.own('run-1');

    await server.send(call({ verb: 'console' } as never));

    expect(server.answers[0]?.result).toEqual({
      ok: true,
      value: [],
      notice: 'older console entries were dropped',
    });
    client.stop();
  });

  it('posts the driver’s refusal, so a served run reads the local sentence', async () => {
    // No paired browser, or Chrome closed. The words are written once, in
    // `extensionPageDriver.ts`, and reach the agent on the server unchanged.
    const reason = 'The Artemis extension is not connected. Ask the user to open Chrome…';
    const server = fakeServer();
    const { driver } = fakeDriver({ ok: false, reason });
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: () => driver,
      fetch: server.fetch,
    });
    client.own('run-1');

    await server.send(call());

    expect(server.answers).toEqual([{ callId: 'c1', result: { ok: false, reason } }]);
    client.stop();
  });

  it('answers even when the driver throws, rather than leaving a deadline to expire', async () => {
    const server = fakeServer();
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: () => {
        throw new Error('the bridge is gone');
      },
      fetch: server.fetch,
    });
    client.own('run-1');

    await server.send(call());

    expect(server.answers).toHaveLength(1);
    expect(server.answers[0]?.result).toMatchObject({ ok: false });
    client.stop();
  });

  it('gives the driver the run key the server sent, so one served run is one tab', async () => {
    const server = fakeServer();
    const keys: string[] = [];
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: (runKey) => {
        keys.push(runKey);
        return fakeDriver().driver;
      },
      fetch: server.fetch,
    });
    client.own('run-a');
    client.own('run-b');

    await server.send(call({ runKey: 'run-a', callId: 'c1' } as never));
    await server.send(call({ runKey: 'run-b', callId: 'c2' } as never));

    expect(keys).toEqual(['run-a', 'run-b']);
    client.stop();
  });
});

describe('a call for a run this client does not own', () => {
  it('is left alone, so the client that started the run answers it', async () => {
    const server = fakeServer();
    const { driver, asked } = fakeDriver();
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: () => driver,
      fetch: server.fetch,
    });
    client.own('mine');

    await server.send(call({ runKey: 'somebody-elses', callId: 'c9' } as never));

    expect(asked).toEqual([]);
    expect(server.answers).toEqual([]);
    client.stop();
  });

  it('is never performed, even after a long wait', async () => {
    // Held calls are held, not queued for execution. A client that never
    // claims the run has clicked nothing.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const server = fakeServer();
      const { driver, asked } = fakeDriver();
      const client = createBrowserCallClient({
        root: ROOT,
        headers: () => ({}),
        driverFor: () => driver,
        fetch: server.fetch,
      });
      client.own('mine');

      await server.send(call({ runKey: 'not-mine' } as never));
      await vi.advanceTimersByTimeAsync(10_000);

      expect(asked).toEqual([]);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is performed once the run is claimed, covering the gap before its id is known', async () => {
    // A run's id is the server's and arrives on the turn's own stream, so a
    // verb can in principle land a beat before this side can name the run.
    // Dropping it would make the agent wait out a deadline to be told the
    // client is not there, which would be false.
    const server = fakeServer();
    const { driver, asked } = fakeDriver();
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: () => driver,
      fetch: server.fetch,
    });
    // Something else keeps the stream open while the run is still nameless.
    client.own('another-run');

    await server.send(call({ runKey: 'late-run', callId: 'c5' } as never));
    expect(asked).toEqual([]);

    client.own('late-run');
    await settle();

    expect(asked).toEqual(['read']);
    expect(server.answers).toEqual([{ callId: 'c5', result: { ok: true, value: 'done' } }]);
    client.stop();
  });
});

describe('two clients on one connection', () => {
  it('perform a click once, and it is the one that started the run', async () => {
    /*
     * The feed scopes by connection, so both of these see the call — two
     * windows of one Artemis, or two machines sharing a token. Only the one
     * holding the run may act, because a click performed twice is a form
     * submitted twice and there is no undoing that from here.
     */
    const server = fakeServer();
    const owner = fakeDriver();
    const bystander = fakeDriver();

    const owning = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: () => owner.driver,
      fetch: server.fetch,
    });
    const watching = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: () => bystander.driver,
      fetch: server.fetch,
    });
    owning.own('run-1');
    watching.own('a-different-run');

    // One publish, delivered to both streams, as the feed does.
    await server.send(call({ verb: 'click', selector: '#pay', callId: 'c3' } as never));

    expect(owner.asked).toEqual(['click']);
    expect(bystander.asked).toEqual([]);
    expect(server.answers).toHaveLength(1);

    owning.stop();
    watching.stop();
  });
});

describe('the stream is open only while a run needs it', () => {
  it('opens on the first claim and closes on the last release', async () => {
    const server = fakeServer();
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: () => fakeDriver().driver,
      fetch: server.fetch,
    });

    expect(server.streams).toBe(0);

    client.own('run-1');
    await settle();
    expect(server.streams).toBe(1);

    client.own('run-2');
    await settle();
    // Still one: a second run on the same server rides the same feed.
    expect(server.streams).toBe(1);

    client.release('run-1');
    await settle();
    expect(server.closed).toBe(0);

    client.release('run-2');
    await settle();
    expect(server.closed).toBe(1);

    client.stop();
  });

  it('says when the feed is established, for a caller faster than a model', async () => {
    // A verb published before the stream is up reaches nobody — the feed fans
    // out to whoever is listening now, and a browser call is deliberately not
    // replayed. A real conversation takes a model round trip to want a
    // browser; a test publishes the instant it claims the run.
    const server = fakeServer();
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: () => fakeDriver().driver,
      fetch: server.fetch,
    });

    await expect(client.ready()).rejects.toThrow(/No run has claimed/u);

    client.own('run-1');
    await client.ready();
    expect(server.streams).toBe(1);

    client.stop();
    await expect(client.ready()).rejects.toThrow(/stopped/u);
  });

  it('reports a feed it cannot open rather than waiting on it for ever', async () => {
    const refusing = (async () => new Response('no', { status: 401 })) as unknown as typeof globalThis.fetch;
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: () => fakeDriver().driver,
      fetch: refusing,
    });
    client.own('run-1');

    await expect(client.ready()).rejects.toThrow(/401/u);
    client.stop();
  });

  it('ignores every other channel on the feed', async () => {
    const server = fakeServer();
    const { driver, asked } = fakeDriver();
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: () => driver,
      fetch: server.fetch,
    });
    client.own('run-1');

    await server.sendOther();

    expect(asked).toEqual([]);
    expect(server.answers).toEqual([]);
    client.stop();
  });

  it('answers nothing at all once it has been stopped', async () => {
    const server = fakeServer();
    const { driver, asked } = fakeDriver();
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: () => driver,
      fetch: server.fetch,
    });
    client.own('run-1');
    await settle();

    client.stop();
    await server.send(call());

    expect(asked).toEqual([]);
    expect(client.owns('run-1')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Which of this machine's browsers a relayed call is for                      */
/* -------------------------------------------------------------------------- */

/*
 * The server holds the choice and restates it on every call, because this side
 * builds a driver per call and keeps nothing between them. What is pinned here
 * is that the choice reaches the *driver* — which is the only thing on this
 * machine that can turn a name into a pairing, and the only thing that can
 * refuse in words when it cannot.
 */
describe('a call that names one of this machine’s browsers', () => {
  it('builds the driver for the browser the server named', async () => {
    const asked: (string | undefined)[] = [];
    const { driver } = fakeDriver();

    await performBrowserCall((_runKey, browserId) => {
      asked.push(browserId);
      return driver;
    }, call({ browserId: 'b-work' }));

    expect(asked).toEqual(['b-work']);
  });

  it('builds it for no browser in particular when the call names none', async () => {
    const asked: (string | undefined)[] = [];
    const { driver } = fakeDriver();

    await performBrowserCall((_runKey, browserId) => {
      asked.push(browserId);
      return driver;
    }, call());

    expect(asked).toEqual([undefined]);
  });

  it('passes a name through unchanged, because only the driver holds the list', async () => {
    // The agent answered "Personal" to a question the driver on this machine
    // asked. The server cannot translate that into an id, having never seen
    // the pairings, so it sends the word back as it was given.
    const asked: (string | undefined)[] = [];
    const { driver } = fakeDriver();

    await performBrowserCall((_runKey, browserId) => {
      asked.push(browserId);
      return driver;
    }, call({ browserId: 'Personal', verb: 'open' } as never));

    expect(asked).toEqual(['Personal']);
  });

  it('names the run as well, so one served run is one tab', async () => {
    const asked: string[] = [];
    const { driver } = fakeDriver();

    await performBrowserCall((runKey) => {
      asked.push(runKey);
      return driver;
    }, call({ runKey: 'run-9' }));

    expect(asked).toEqual(['run-9']);
  });

  it('drops a call whose browser field is not a string, rather than typing one as one', async () => {
    // Off the wire, so it can be anything. Whether a browser answers to a
    // given name is the driver's question and it answers in a sentence; a
    // field of the wrong *type* is not a name at all.
    const performed: string[] = [];
    const { driver } = fakeDriver();
    const server = fakeServer();
    const client = createBrowserCallClient({
      root: ROOT,
      headers: () => ({}),
      driverFor: (runKey) => {
        performed.push(runKey);
        return driver;
      },
      fetch: server.fetch,
    });
    client.own('run-1');

    await server.send({ ...call(), browserId: 7 } as never);

    expect(performed).toEqual([]);
    client.stop();
  });
});
