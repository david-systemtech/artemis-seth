/**
 * `POST /api/v0/browser/answer`, and the connection check on it.
 *
 * The relay's own suite proves it refuses an answer from the wrong connection.
 * This one proves the *route* does — that the check is reached at all, that it
 * is reached after authentication rather than instead of it, and that a build
 * without a relay says 501 rather than pretending to accept.
 *
 * The distinction matters because the two locks are on the same door and a
 * route that forgot to pass the connection id would leave only the first: a
 * call id that leaked into a log would then be spendable by any token on the
 * server. So the assertion is not "the relay said no", it is "a second
 * connection got a 404 and the first one's call is still waiting".
 */

import { describe, expect, it } from 'vitest';

import type { ServerBrowserCall } from '@rx-artemis/protocol';
import { REMOTE_BROWSER_ANSWER_PATH } from '@rx-artemis/protocol';

import { createBrowserRelay, type BrowserRelay } from '../browserRelay.js';
import type { Catalogue } from '../catalogue.js';
import { handleServerRequest, isStreamReply, type ServerContext } from '../http.js';

const TOKEN = 'first-token-abcdefghijklmnopqrstuvwxyz';
const OTHER_TOKEN = 'second-token-abcdefghijklmnopqrstuvw';

const FIRST = {
  id: 'conn-1',
  label: 'The client that started the run',
  workspace: { kind: 'directory' as const, path: '/w' },
  token: TOKEN,
  createdAt: 0,
};

/** A second connection on the same server, with every right the first has. */
const SECOND = {
  id: 'conn-2',
  label: 'Another client',
  workspace: { kind: 'directory' as const, path: '/w' },
  token: OTHER_TOKEN,
  createdAt: 0,
};

const catalogue: Catalogue = { read: async () => [], invalidate: () => undefined };

function answer(
  body: unknown,
  options: { readonly relay?: BrowserRelay; readonly token?: string } = {},
): ReturnType<typeof handleServerRequest> {
  const overrides: Partial<ServerContext> =
    options.relay === undefined ? {} : { browserRelay: options.relay };
  return handleServerRequest(
    {
      method: 'POST',
      url: REMOTE_BROWSER_ANSWER_PATH,
      headers: {
        host: '127.0.0.1:6472',
        authorization: `Bearer ${options.token ?? TOKEN}`,
      },
      body,
    },
    {
      connections: [FIRST, SECOND],
      version: '1.1.1',
      catalogue,
      startedAt: 0,
      ...overrides,
    },
  );
}

/** A relay with one call outstanding, addressed to the first connection. */
function relayWithOneCall(): { relay: BrowserRelay; callId: string; answered: Promise<unknown> } {
  const published: ServerBrowserCall[] = [];
  const relay = createBrowserRelay({
    publish: (_connectionId, call) => {
      published.push(call);
    },
  });
  const answered = relay.driverFor(FIRST.id, 'run-1').read();
  const callId = published[0]?.callId;
  if (callId === undefined) throw new Error('Nothing was published.');
  return { relay, callId, answered };
}

describe('POST /api/v0/browser/answer', () => {
  it('settles the call the client was asked to perform', async () => {
    const { relay, callId, answered } = relayWithOneCall();

    const reply = await answer(
      { callId, result: { ok: true, value: { url: 'https://example.com', title: 'Example' } } },
      { relay },
    );

    expect(reply.status).toBe(200);
    if (isStreamReply(reply)) throw new Error('expected a body');
    expect(reply.body).toMatchObject({ object: 'artemis.browser.answer', callId });
    expect(await answered).toEqual({
      ok: true,
      value: { url: 'https://example.com', title: 'Example' },
    });
  });

  it('carries the client’s refusal through to the waiting run', async () => {
    const { relay, callId, answered } = relayWithOneCall();

    await answer(
      { callId, result: { ok: false, reason: 'The Artemis extension is not connected.' } },
      { relay },
    );

    expect(await answered).toEqual({
      ok: false,
      reason: 'The Artemis extension is not connected.',
    });
  });

  it('refuses an answer from a different connection, and leaves the call waiting', async () => {
    // The lock this route exists to turn. Both tokens are valid and both may
    // start runs; only one of them was asked this question.
    const { relay, callId } = relayWithOneCall();

    const reply = await answer(
      { callId, result: { ok: true, value: 'stolen' } },
      { relay, token: OTHER_TOKEN },
    );

    expect(reply.status).toBe(404);
    expect(relay.pendingCount()).toBe(1);
  });

  it('answers a made-up call id exactly as it answers someone else’s', async () => {
    // Same status, same code, same sentence: a caller that could tell them
    // apart could probe which call ids exist.
    const { relay } = relayWithOneCall();

    const mine = await answer({ callId: 'never-issued', result: { ok: true, value: null } }, { relay });
    const theirs = await answer(
      { callId: 'never-issued', result: { ok: true, value: null } },
      { relay, token: OTHER_TOKEN },
    );

    expect(mine.status).toBe(404);
    expect(theirs.status).toBe(404);
    if (isStreamReply(mine) || isStreamReply(theirs)) throw new Error('expected bodies');
    expect(mine.body).toEqual(theirs.body);
  });

  it('still authenticates, before any of the above', async () => {
    const { relay } = relayWithOneCall();

    const reply = await handleServerRequest(
      {
        method: 'POST',
        url: REMOTE_BROWSER_ANSWER_PATH,
        headers: { host: '127.0.0.1:6472' },
        body: { callId: 'anything', result: { ok: true, value: null } },
      },
      {
        connections: [FIRST, SECOND],
        version: '1.1.1',
        catalogue,
        startedAt: 0,
        browserRelay: relay,
      },
    );

    expect(reply.status).toBe(401);
  });

  it('refuses a body that is not a driver result', async () => {
    const { relay, callId } = relayWithOneCall();

    const reply = await answer({ callId, result: { ok: 'maybe' } }, { relay });

    expect(reply.status).toBe(400);
    expect(relay.pendingCount()).toBe(1);
  });

  it('refuses a body with no call id', async () => {
    const { relay } = relayWithOneCall();

    expect((await answer({ result: { ok: true, value: null } }, { relay })).status).toBe(400);
  });

  it('answers 501 on a build that relays nothing', async () => {
    // The desktop's own server host is such a build today. A 404 would say
    // "no such call"; 501 says the feature is not here at all.
    const reply = await answer({ callId: 'x', result: { ok: true, value: null } });

    expect(reply.status).toBe(501);
  });

  it('is a POST and says so', async () => {
    const { relay } = relayWithOneCall();

    const reply = await handleServerRequest(
      {
        method: 'GET',
        url: REMOTE_BROWSER_ANSWER_PATH,
        headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` },
      },
      {
        connections: [FIRST, SECOND],
        version: '1.1.1',
        catalogue,
        startedAt: 0,
        browserRelay: relay,
      },
    );

    expect(reply.status).toBe(405);
  });
});
