/**
 * The dock browser's driver: what it listens to, and what it declines.
 *
 * No Electron. A `webContents` here is an object that records which events were
 * subscribed to and lets a test fire them, and a session is an object holding
 * three `webRequest` slots. What is under test is the bookkeeping — which is
 * where the bugs in this kind of code live:
 *
 *  - **Buffers are since-last-call.** A second `console()` must not repeat what
 *    the first already reported, or an agent watching a page would see every
 *    error once per check and conclude it was still happening.
 *  - **`webRequest` has one slot per session.** Two drivers on the dock's
 *    shared session must not each register their own `onCompleted`, because the
 *    second would silently replace the first and leave one of them blind.
 *  - **A tab nobody is watching costs nothing**, and a tab that is let go of
 *    stops costing anything.
 *  - **Cookies, storage and evaluate are refused in words.** They are declined
 *    deliberately, and the sentence has to say why rather than reading as a
 *    fault the model should route around.
 *  - **Waiting for a load always ends.** A tab the user closes mid-load must
 *    not hold a verb, and detaching from a `webContents` that has been
 *    destroyed throws — which used to leave the promise unsettled for ever.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrowserId, BrowserState, RunId } from '@rx-artemis/protocol';

import { embeddedPageDriver, recorderFor, type BrowserToolContext } from './embeddedPageDriver';

const RUN = 'run-1' as RunId;
const ID = 'browser-1' as BrowserId;

type Listener = (...args: never[]) => void;

/** A `webRequest` whose three observer slots can be read back and fired. */
function fakeWebRequest(): {
  webRequest: Record<string, (listener: Listener) => void>;
  installed: Record<string, Listener[]>;
  fire: (slot: string, details: unknown) => void;
} {
  const installed: Record<string, Listener[]> = {
    onSendHeaders: [],
    onCompleted: [],
    onErrorOccurred: [],
  };
  const webRequest: Record<string, (listener: Listener) => void> = {};
  for (const slot of Object.keys(installed)) {
    webRequest[slot] = (listener) => void (installed[slot] as Listener[]).push(listener);
  }
  return {
    webRequest,
    installed,
    fire: (slot, details) => {
      for (const listener of installed[slot] ?? []) listener(details as never);
    },
  };
}

/** A page that records its subscriptions and answers the four driving calls. */
function fakePage(session: unknown, webContentsId = 7): {
  contents: Record<string, unknown>;
  emit: (event: string, ...args: unknown[]) => void;
  listening: () => string[];
} {
  const listeners = new Map<string, Set<Listener>>();
  const contents: Record<string, unknown> = {
    id: webContentsId,
    session,
    isLoading: () => false,
    executeJavaScript: async () => 'the page text',
    capturePage: async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
    once: () => undefined,
    on: (event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
    },
    off: (event: string, listener: Listener) => void listeners.get(event)?.delete(listener),
  };
  return {
    contents,
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...(args as never[]));
    },
    listening: () =>
      [...listeners.entries()].filter(([, set]) => set.size > 0).map(([event]) => event),
  };
}

function stateWith(over: Partial<BrowserState> = {}): BrowserState {
  return {
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...over,
  };
}

function contextFor(contents: Record<string, unknown>, current: BrowserId | null = ID): BrowserToolContext {
  return {
    ensure: async () => ID,
    current: () => current,
    host: {
      contentsFor: () => contents as never,
      stateFor: () => stateWith(),
      navigate: (_id, url) => url,
    },
  };
}

/** A console-message event as Electron 43 delivers it. */
function consoleMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { level: 'error', message: 'boom', lineNumber: 14, sourceId: 'app.js', ...over };
}

/** A `webRequest` details object, as the three observers receive it. */
function details(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    url: 'https://example.com/api/orders',
    method: 'GET',
    webContentsId: 7,
    resourceType: 'xhr',
    timestamp: 1_000,
    statusCode: 200,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* The console buffer                                                         */
/* -------------------------------------------------------------------------- */

describe('the console buffer holds what happened since the last check', () => {
  it('reports a message logged after the first verb, and reports it once', async () => {
    const wr = fakeWebRequest();
    const page = fakePage(wr);
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));

    await driver.open('https://example.com');
    page.emit('console-message', consoleMessage());

    const first = await driver.console();
    const second = await driver.console();

    expect(first).toEqual({
      ok: true,
      value: [
        expect.objectContaining({ level: 'error', text: 'boom', source: 'app.js:14' }),
      ],
    });
    // Reading drains. An agent checking twice must not see the same error
    // twice and conclude it is still happening.
    expect(second).toEqual({ ok: true, value: [] });
  });

  it('translates Chromium’s four severities into the contract’s words', async () => {
    const page = fakePage(fakeWebRequest());
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));
    await driver.open();

    for (const level of ['info', 'warning', 'error', 'debug']) {
      page.emit('console-message', consoleMessage({ level, message: level }));
    }
    const result = await driver.console();

    expect(result.ok && result.value.map((one) => one.level)).toEqual([
      'info',
      'warn',
      'error',
      'debug',
    ]);
  });

  it('omits the source when the page did not say where the message came from', async () => {
    const page = fakePage(fakeWebRequest());
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));
    await driver.open();

    page.emit('console-message', consoleMessage({ sourceId: '' }));
    const result = await driver.console();

    expect(result.ok && result.value[0]?.source).toBeUndefined();
  });

  it('drops the oldest messages rather than growing without limit', async () => {
    const page = fakePage(fakeWebRequest());
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));
    await driver.open();

    // A page with a logging loop would otherwise grow this in a process the
    // user cannot restart without losing their work.
    for (let index = 0; index < 250; index += 1) {
      page.emit('console-message', consoleMessage({ message: `line ${String(index)}` }));
    }
    const result = await driver.console();

    expect(result.ok && result.value).toHaveLength(200);
    expect(result.ok && result.value[0]?.text).toBe('line 50');
  });

  it('refuses rather than buffering when the conversation has no page yet', async () => {
    const page = fakePage(fakeWebRequest());
    const driver = embeddedPageDriver(RUN, contextFor(page.contents, null));

    expect(await driver.console()).toEqual({
      ok: false,
      reason: 'No browser is open for this conversation. Use browser_open first.',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The network buffer                                                         */
/* -------------------------------------------------------------------------- */

describe('the request log is one observer per session, fanned out by tab', () => {
  it('installs one set of observers however many drivers are watching', async () => {
    // `webRequest`'s slots hold one listener each: a second registration
    // replaces the first, so two drivers each installing their own would leave
    // one of them permanently blind with no error anywhere.
    const wr = fakeWebRequest();
    const first = fakePage(wr, 7);
    const second = fakePage(wr, 8);

    await embeddedPageDriver(RUN, contextFor(first.contents)).open();
    await embeddedPageDriver('run-2' as RunId, contextFor(second.contents)).open();

    expect(wr.installed['onSendHeaders']).toHaveLength(1);
    expect(wr.installed['onCompleted']).toHaveLength(1);
    expect(wr.installed['onErrorOccurred']).toHaveLength(1);
  });

  it('records a completed request against its own tab and dates it from its start', async () => {
    const wr = fakeWebRequest();
    const page = fakePage(wr, 7);
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));
    await driver.open();

    wr.fire('onSendHeaders', details({ timestamp: 1_000 }));
    wr.fire('onCompleted', details({ timestamp: 1_118, statusCode: 200 }));

    expect(await driver.network()).toEqual({
      ok: true,
      value: [
        {
          method: 'GET',
          url: 'https://example.com/api/orders',
          status: 200,
          resourceType: 'xhr',
          durationMs: 118,
          at: 1_118,
        },
      ],
    });
  });

  it('gives a request no duration rather than a wrong one when its start was missed', async () => {
    const wr = fakeWebRequest();
    const page = fakePage(wr, 7);
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));
    await driver.open();

    wr.fire('onCompleted', details({ timestamp: 1_118 }));
    const result = await driver.network();

    expect(result.ok && result.value[0]?.durationMs).toBeUndefined();
  });

  it('keeps one tab’s requests out of another tab’s log', async () => {
    const wr = fakeWebRequest();
    const mine = fakePage(wr, 7);
    const theirs = fakePage(wr, 8);
    const driver = embeddedPageDriver(RUN, contextFor(mine.contents));
    await driver.open();
    await embeddedPageDriver('run-2' as RunId, contextFor(theirs.contents)).open();

    wr.fire('onCompleted', details({ webContentsId: 8, url: 'https://other.test/' }));

    expect(await driver.network()).toEqual({ ok: true, value: [] });
  });

  it('records nothing at all for a tab no driver is watching', async () => {
    const wr = fakeWebRequest();
    const page = fakePage(wr, 7);
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));
    await driver.open();

    // The user's own tabs share this session. Buffering their requests would
    // cost memory for pages no agent will ever ask about.
    wr.fire('onCompleted', details({ webContentsId: 99 }));
    wr.fire('onSendHeaders', details({ webContentsId: 99 }));

    expect(await driver.network()).toEqual({ ok: true, value: [] });
  });

  it('reports a request that failed outright with the error and no status', async () => {
    const wr = fakeWebRequest();
    const page = fakePage(wr, 7);
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));
    await driver.open();

    wr.fire('onErrorOccurred', details({ error: 'net::ERR_CONNECTION_REFUSED', timestamp: 2_000 }));
    const result = await driver.network();

    expect(result.ok && result.value[0]).toEqual({
      method: 'GET',
      url: 'https://example.com/api/orders',
      resourceType: 'xhr',
      failure: 'net::ERR_CONNECTION_REFUSED',
      at: 2_000,
    });
  });

  it('drains the log whole and filters afterwards, so failedOnly loses nothing', async () => {
    const wr = fakeWebRequest();
    const page = fakePage(wr, 7);
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));
    await driver.open();

    wr.fire('onCompleted', details({ id: 1, statusCode: 200, url: 'https://example.com/a' }));
    wr.fire('onCompleted', details({ id: 2, statusCode: 500, url: 'https://example.com/b' }));
    wr.fire('onErrorOccurred', details({ id: 3, error: 'net::ERR_ABORTED', url: 'https://example.com/c' }));

    const failed = await driver.network({ failedOnly: true });

    // A 500 is a failure to the person debugging even though the request
    // itself succeeded, and an aborted request is one too.
    expect(failed.ok && failed.value.map((one) => one.url)).toEqual([
      'https://example.com/b',
      'https://example.com/c',
    ]);
    // And the drain took everything: the successful request is gone, not
    // waiting to be reported later as if it had just happened.
    expect(await driver.network()).toEqual({ ok: true, value: [] });
  });

  it('records a main-frame load failure the request layer never saw', async () => {
    const wr = fakeWebRequest();
    const page = fakePage(wr, 7);
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));
    await driver.open();

    page.emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://bad.test/', true);
    const result = await driver.network();

    expect(result.ok && result.value[0]).toMatchObject({
      url: 'https://bad.test/',
      resourceType: 'mainFrame',
      failure: 'ERR_CERT_AUTHORITY_INVALID',
    });
  });

  it('ignores a subframe failure and a navigation the user replaced', async () => {
    const wr = fakeWebRequest();
    const page = fakePage(wr, 7);
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));
    await driver.open();

    // Subframe failures are the ad blocker's business. `-3` is ABORTED, which
    // is what a navigation replaced by another one reports.
    page.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://ads.test/', false);
    page.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com/', true);

    expect(await driver.network()).toEqual({ ok: true, value: [] });
  });

  it('does not say the same failure twice when both sources report it', async () => {
    const wr = fakeWebRequest();
    const page = fakePage(wr, 7);
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));
    await driver.open();

    wr.fire(
      'onErrorOccurred',
      details({ url: 'https://gone.test/', error: 'net::ERR_NAME_NOT_RESOLVED', timestamp: Date.now() }),
    );
    page.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://gone.test/', true);

    const result = await driver.network();
    expect(result.ok && result.value).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Letting go                                                                 */
/* -------------------------------------------------------------------------- */

describe('letting go of a tab', () => {
  it('detaches the listeners and stops recording, without closing the user’s tab', async () => {
    const wr = fakeWebRequest();
    const page = fakePage(wr, 7);
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));
    await driver.open();
    expect(page.listening().sort()).toEqual(['console-message', 'did-fail-load']);

    await driver.close();

    // Nothing here destroys the page: the tab belongs to the user's dock and
    // has a tab in their strip. What is released is what the driver added.
    expect(page.listening()).toEqual([]);
    wr.fire('onCompleted', details());
    page.emit('console-message', consoleMessage());
    expect(await driver.network()).toEqual({ ok: true, value: [] });
    expect(await driver.console()).toEqual({ ok: true, value: [] });
  });

  it('moves its listeners to the new tab when the user closed the old one', async () => {
    // `agentBrowserFor` answers null for a tab the user shut, and the next
    // `browser_open` makes another with a new id rather than resurrecting the
    // old one. The buffers have to follow the page the agent is now driving.
    const wr = fakeWebRequest();
    const pages = new Map([
      [ID, fakePage(wr, 7)],
      ['browser-2' as BrowserId, fakePage(wr, 8)],
    ]);
    let live = ID;

    const context: BrowserToolContext = {
      ensure: async () => live,
      current: () => live,
      host: {
        contentsFor: (id) => (pages.get(id)?.contents ?? null) as never,
        stateFor: () => stateWith(),
        navigate: (_id, url) => url,
      },
    };
    const driver = embeddedPageDriver(RUN, context);
    await driver.open();

    live = 'browser-2' as BrowserId;
    await driver.open();

    expect(pages.get(ID)?.listening()).toEqual([]);
    expect(pages.get(live)?.listening().sort()).toEqual(['console-message', 'did-fail-load']);

    // And a message logged by the new tab reaches the agent.
    pages.get(live)?.emit('console-message', consoleMessage({ message: 'from the new tab' }));
    const result = await driver.console();
    expect(result.ok && result.value[0]?.text).toBe('from the new tab');
  });
});

/* -------------------------------------------------------------------------- */
/* The three verbs this browser declines                                      */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Waiting for a load                                                         */
/* -------------------------------------------------------------------------- */

describe('waiting for a page to stop loading always ends', () => {
  /**
   * A page that never finishes loading and that throws when detached from.
   *
   * Both halves are the real thing: a `webContents` the user closed is still
   * the object this file holds, `isLoading` keeps answering whatever it last
   * answered, and `off` on a destroyed one throws — which this file's own
   * `Watch.release` comment has always said.
   */
  function fakeStuckPage(session: unknown): {
    contents: Record<string, unknown>;
    emit: (event: string) => void;
    offCalls: number;
  } {
    const once = new Map<string, Set<Listener>>();
    const counters = { offCalls: 0 };
    const contents: Record<string, unknown> = {
      id: 7,
      session,
      isLoading: () => true,
      executeJavaScript: async () => 'the page text',
      capturePage: async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
      once: (event: string, listener: Listener) => {
        const set = once.get(event) ?? new Set<Listener>();
        set.add(listener);
        once.set(event, set);
      },
      on: () => undefined,
      off: () => {
        counters.offCalls += 1;
        throw new Error('Object has been destroyed');
      },
    };
    return {
      contents,
      emit: (event) => {
        for (const listener of once.get(event) ?? []) listener();
      },
      get offCalls() {
        return counters.offCalls;
      },
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up after the timeout even though detaching throws', async () => {
    /*
     * The bug this pins. `done` ran inside a bare timer callback and called
     * `off` *before* resolving; `off` on a destroyed `webContents` throws, so
     * the exception left the timer with nothing to catch it and the promise
     * unsettled. The verb waited for ever, and the run waited with it.
     */
    vi.useFakeTimers();
    const session = fakeWebRequest();
    const page = fakeStuckPage(session);
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));

    const reading = driver.read();
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(reading).resolves.toMatchObject({ ok: true });
    expect(page.offCalls).toBeGreaterThan(0);
  });

  it('stops waiting when the tab is destroyed, rather than holding the verb', async () => {
    // Without this the user closing a loading tab parks the verb for the full
    // twenty seconds before it reports on a page that no longer exists.
    vi.useFakeTimers();
    const session = fakeWebRequest();
    const page = fakeStuckPage(session);
    const driver = embeddedPageDriver(RUN, contextFor(page.contents));

    const reading = driver.read();
    await Promise.resolve();
    page.emit('destroyed');
    // No time passes: what ends the wait is the event, not the deadline.
    await vi.advanceTimersByTimeAsync(0);

    await expect(reading).resolves.toMatchObject({ ok: true });
  });
});

describe('the dock browser declines the three deep verbs, in words', () => {
  it('claims console and network and nothing else', () => {
    const driver = embeddedPageDriver(RUN, contextFor(fakePage(fakeWebRequest()).contents));
    expect(driver.abilities).toEqual({
      console: true,
      network: true,
      cookies: false,
      storage: false,
      evaluate: false,
    });
    expect(driver.kind).toBe('embedded');
  });

  it('says cookies and stored values are the user’s live sessions, not a fault to route around', async () => {
    const driver = embeddedPageDriver(RUN, contextFor(fakePage(fakeWebRequest()).contents));

    for (const result of [await driver.cookies(), await driver.storage()]) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain('signs into inside Artemis');
    }
  });

  it('says why it will not run the model’s JavaScript, and what to use instead', async () => {
    const driver = embeddedPageDriver(RUN, contextFor(fakePage(fakeWebRequest()).contents));

    const result = await driver.evaluate('document.cookie');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('browser_click');
  });
});

/* -------------------------------------------------------------------------- */
/* The recorder, on its own                                                   */
/* -------------------------------------------------------------------------- */

describe('the session recorder', () => {
  it('hands the same recorder back for the same session', () => {
    const session = fakeWebRequest();
    expect(recorderFor(session as never)).toBe(recorderFor(session as never));
  });

  it('installs nothing until somebody watches a tab', () => {
    const wr = fakeWebRequest();
    recorderFor(wr as never);
    expect(wr.installed['onCompleted']).toHaveLength(0);
  });
});
