/**
 * A served run's browser, on the caller's machine: what is published, and who
 * may answer it.
 *
 * The relay is a small object with one dangerous property — it asks a client
 * to act in a browser full of somebody's live sessions — so the cases worth
 * pinning are the ones about *addressing*:
 *
 *  - **A verb goes to one connection.** Not to everyone allowed the account,
 *    which is how the feed's other two scope axes work: those ask what a
 *    connection may see, and this one names the connection, because a question
 *    a second client can see is a question a second client can answer.
 *  - **An answer from anyone else is refused.** The call id is sixteen random
 *    bytes and the connection is checked again, so an id that leaks into a log
 *    still buys nothing.
 *  - **Silence becomes a sentence.** A client that is gone, or slow, produces
 *    a refusal the agent can read out to the user — not a hung turn.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ServerBrowserCall } from '@rx-artemis/protocol';

import { createBrowserRelay, RELAY_REFUSALS } from '../browserRelay.js';

/** A relay that records what it published instead of putting it on a feed. */
function relayWatching(options: { readonly connected?: boolean } = {}) {
  const published: { connectionId: string; call: ServerBrowserCall }[] = [];
  const relay = createBrowserRelay({
    publish: (connectionId, call) => {
      published.push({ connectionId, call });
    },
    ...(options.connected === undefined ? {} : { isConnected: () => options.connected === true }),
  });
  return { relay, published };
}

/** The id of the call that has just been published. */
function lastCallId(published: { call: ServerBrowserCall }[]): string {
  const call = published.at(-1)?.call;
  if (call === undefined) throw new Error('Nothing was published.');
  return call.callId;
}

describe('a verb is addressed to one connection', () => {
  it('publishes the verb to the connection that started the run', async () => {
    const { relay, published } = relayWatching();
    const driver = relay.driverFor('conn-a', 'run-1');

    const answering = driver.navigate('https://example.com');
    expect(published).toHaveLength(1);
    expect(published[0]?.connectionId).toBe('conn-a');
    expect(published[0]?.call).toMatchObject({
      object: 'artemis.browser.call',
      runKey: 'run-1',
      verb: 'navigate',
      url: 'https://example.com',
    });

    relay.answer('conn-a', lastCallId(published), { ok: true, value: { url: '', title: '' } });
    expect((await answering).ok).toBe(true);
  });

  it('gives every call an id that cannot be guessed from the last one', async () => {
    const { relay, published } = relayWatching();
    const driver = relay.driverFor('conn-a', 'run-1');

    void driver.read();
    void driver.read();

    const [first, second] = published.map((one) => one.call.callId);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('keeps two runs’ calls apart even on the same connection', async () => {
    const { relay, published } = relayWatching();
    const one = relay.driverFor('conn-a', 'run-1');
    const two = relay.driverFor('conn-a', 'run-2');

    void one.read();
    void two.read();

    expect(published.map((entry) => entry.call.runKey)).toEqual(['run-1', 'run-2']);
  });
});

describe('who may answer', () => {
  it('refuses an answer from a connection the call was not addressed to', async () => {
    // The second lock on the same door: the id is unguessable, and an id that
    // leaked into a log still cannot be spent by the connection that read it.
    const { relay, published } = relayWatching();
    void relay.driverFor('conn-a', 'run-1').read();

    const outcome = relay.answer('conn-b', lastCallId(published), { ok: true, value: 'stolen' });

    expect(outcome).toBe('wrong-connection');
    expect(relay.pendingCount()).toBe(1);
  });

  it('refuses an id nobody is waiting on', () => {
    const { relay } = relayWatching();

    expect(relay.answer('conn-a', 'made-up', { ok: true, value: null })).toBe('unknown-call');
  });

  it('refuses a second answer to the same call', async () => {
    // Which is also what a replayed answer looks like. Settling clears the
    // entry, so the second finds nothing waiting — the same "no" as an id
    // that never existed, deliberately.
    const { relay, published } = relayWatching();
    const answering = relay.driverFor('conn-a', 'run-1').read();
    const callId = lastCallId(published);

    expect(relay.answer('conn-a', callId, { ok: true, value: { text: 'first' } })).toBeNull();
    await answering;
    expect(relay.answer('conn-a', callId, { ok: true, value: { text: 'second' } })).toBe(
      'unknown-call',
    );
  });
});

describe('what the browser said is what the model reads', () => {
  it('passes a value through untouched', async () => {
    const { relay, published } = relayWatching();
    const answering = relay.driverFor('conn-a', 'run-1').read();

    relay.answer('conn-a', lastCallId(published), {
      ok: true,
      value: { url: 'https://example.com', title: 'Example', text: 'hello', truncated: false },
    });

    expect(await answering).toEqual({
      ok: true,
      value: { url: 'https://example.com', title: 'Example', text: 'hello', truncated: false },
    });
  });

  it('carries a notice from the client’s browser all the way to the served run', async () => {
    const { relay, published } = relayWatching();
    const answering = relay.driverFor('conn-a', 'run-1').console();

    relay.answer('conn-a', lastCallId(published), {
      ok: true,
      value: [],
      notice: 'older console entries were dropped',
    });

    expect(await answering).toEqual({
      ok: true,
      value: [],
      notice: 'older console entries were dropped',
    });
  });

  it('passes the client’s own refusal through, so a served run reads the local sentence', async () => {
    // A client with no paired browser answers with its own driver's refusal,
    // which is written once in `extensionPageDriver.ts`. Rewriting it here
    // would give a served run different words for the same situation.
    const reason = 'The Artemis extension is not connected. Ask the user to open Chrome…';
    const { relay, published } = relayWatching();
    const answering = relay.driverFor('conn-a', 'run-1').read();

    relay.answer('conn-a', lastCallId(published), { ok: false, reason });

    expect(await answering).toEqual({ ok: false, reason });
  });
});

describe('when no answer comes', () => {
  it('turns a silent client into a sentence rather than a hung turn', async () => {
    vi.useFakeTimers();
    try {
      const { relay } = relayWatching();
      const answering = relay.driverFor('conn-a', 'run-1').read();

      await vi.advanceTimersByTimeAsync(13_000);
      const result = await answering;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('did not answer within');
      expect(result.reason).toContain('Try once more');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a load twenty seconds and a question twelve', async () => {
    vi.useFakeTimers();
    try {
      const { relay } = relayWatching();
      const driver = relay.driverFor('conn-a', 'run-1');
      const loading = driver.navigate('https://example.com');
      const asking = driver.cookies();

      await vi.advanceTimersByTimeAsync(13_000);
      expect((await asking).ok).toBe(false);
      expect(relay.pendingCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(8_000);
      expect((await loading).ok).toBe(false);
      expect(relay.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the client is not connected without waiting out the deadline', async () => {
    // A connection with no live stream will never hear the question, and
    // waiting twenty seconds to say so spends the turn to learn nothing.
    const { relay, published } = relayWatching({ connected: false });

    const result = await relay.driverFor('conn-a', 'run-1').read();

    expect(published).toEqual([]);
    expect(result).toEqual({ ok: false, reason: RELAY_REFUSALS.NO_CLIENT });
  });

  it('names the machine the browser is on, so the agent can ask the right person', async () => {
    expect(RELAY_REFUSALS.NO_CLIENT).toContain('the machine the user started it from');
    expect(RELAY_REFUSALS.NO_CLIENT).toContain('do not describe pages you have not seen');
  });
});

describe('what this driver claims it can do', () => {
  it('is the extension kind, because it is the extension’s browser', async () => {
    // Not a fourth `BrowserDriverKind`: the wording the tools give the model —
    // "their real browser, with their logins" — is true of this one in exactly
    // the same way, and a fourth kind would be a fourth copy of it.
    const { relay } = relayWatching();

    const driver = relay.driverFor('conn-a', 'run-1');

    expect(driver.kind).toBe('extension');
    expect(driver.abilities).toEqual({
      console: true,
      network: true,
      cookies: true,
      storage: true,
      evaluate: true,
    });
  });
});
