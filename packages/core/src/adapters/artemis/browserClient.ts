/**
 * The client's half of the browser relay: performing what a server asks.
 * ============================================================================
 *
 * `server/browserRelay.ts` is the other end. A run executing on an Artemis
 * Server asks for a page; the server publishes that verb to the connection the
 * run came in on; and this is what is listening there. It runs the verb
 * against the browser paired with *this* machine and posts the answer back.
 *
 * David's decision of 2026-09-21 (issue #436): the agent stays where it is and
 * sends actions, and the client passes them on. Nothing about the extension
 * knows a server exists — it talks to the Artemis on its own machine, and this
 * file is the part of that Artemis that happens to be listening to a server.
 *
 * ## It listens only while a run needs it
 *
 * Opening an event stream per served conversation would be an idle socket per
 * server for every conversation that never touches a browser. So the stream is
 * opened when the first run on that server claims ownership and closed when
 * the last one lets go. A server nobody asked a browser of is a server this
 * file never dials.
 *
 * ## Exactly one client performs each call
 *
 * The feed's `connectionId` scope means every client holding that connection's
 * token sees the call — two windows of one Artemis, or two machines sharing a
 * token. So *seeing* a call is not permission to perform it. Ownership is:
 * this process started that run, and therefore holds its `runKey`. A call for
 * a run this client did not start is left alone, and the client that did start
 * it answers. One execution, whatever else is watching.
 *
 * A call that arrives before its run's id is known is held rather than
 * dropped — see {@link HOLD_MS}. The alternative is a verb nobody answers and
 * an agent that waits out the server's deadline to be told the client is not
 * there, which would be false.
 *
 * ## Nothing here knows what a verb means
 *
 * {@link performBrowserCall} turns a {@link ServerBrowserCall} back into a
 * method on a {@link PageDriver}, and the driver is injected. On the desktop
 * that is `ExtensionPageDriver`, so a served run and a local run get the same
 * browser, the same policy and — when there is no browser to be had — the same
 * refusal sentences, written once.
 */

import {
  createSseDecoder,
  REMOTE_BROWSER_ANSWER_PATH,
  REMOTE_EVENTS_PATH,
  type DriverResult,
  type PageDriver,
  type RemoteBrowserAnswerBody,
  type ServerBrowserCall,
} from '@rx-artemis/protocol';

/**
 * How long a call for an unknown run is held before it is let go.
 *
 * A run's id is the *server's*, announced on the stream once the turn starts,
 * so there is a short window in which a verb could arrive for a run this
 * client has started but cannot yet name. Two seconds covers it with room to
 * spare and is far inside the server's own deadline, so a held call that is
 * claimed still answers in time.
 *
 * Holding is not performing. A client that never claims the run drops what it
 * held and has executed nothing, which is what keeps two windows from both
 * clicking the same button.
 */
const HOLD_MS = 2_000;

/** Most calls held at once, so a stream of verbs for unknown runs is bounded. */
const MAX_HELD = 32;

/* -------------------------------------------------------------------------- */
/* Performing one call                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Run one relayed verb against a driver.
 *
 * The inverse of the mapping in `extensionPageDriver.ts`, and deliberately a
 * plain exhaustive switch: the compiler is what keeps it in step with
 * `BridgeVerb`, so a verb added to the contract fails the build here rather
 * than becoming a silent refusal in somebody's browser.
 *
 * `close` answers `ok` with nothing. The contract's `close` returns `void`
 * because a local caller has nobody to report to; across a wire the server is
 * waiting on *something*, and "it is done" is the honest thing to send.
 */
export async function performBrowserCall(
  driver: PageDriver,
  call: ServerBrowserCall,
): Promise<DriverResult<unknown>> {
  switch (call.verb) {
    case 'open':
      return driver.open(call.url);
    case 'navigate':
      return driver.navigate(call.url);
    case 'read':
      return driver.read();
    case 'screenshot':
      return driver.screenshot();
    case 'click':
      return driver.click(call.selector);
    case 'type':
      return driver.type(call.selector, call.text);
    case 'console':
      return driver.console();
    case 'network':
      return driver.network({ failedOnly: call.failedOnly === true });
    case 'cookies':
      return driver.cookies();
    case 'storage':
      return driver.storage();
    case 'evaluate':
      return driver.evaluate(call.expression);
    case 'close':
      await driver.close();
      return { ok: true, value: null };
  }
}

/* -------------------------------------------------------------------------- */
/* The client                                                                 */
/* -------------------------------------------------------------------------- */

export interface BrowserCallClientOptions {
  /** The server's base address, e.g. `http://host:6472`. No trailing slash. */
  readonly root: string;
  /** The connection's auth headers, read per request so a rotation is seen. */
  readonly headers: () => Readonly<Record<string, string>>;
  /**
   * This machine's browser for one served run.
   *
   * Called per call rather than per run, because a driver is cheap and holding
   * one would mean deciding when to let it go. `runKey` is the server's, and
   * is what the extension files the tab under — so one served run is one tab,
   * exactly as one local run is.
   */
  readonly driverFor: (runKey: string) => PageDriver;
  /** Injected by tests. Defaults to the global. */
  readonly fetch?: typeof globalThis.fetch;
  /** Hears anything that went wrong. Defaults to silence. */
  readonly onError?: (error: unknown) => void;
}

export interface BrowserCallClient {
  /**
   * Claim a run, opening the stream if this is the first.
   *
   * Idempotent. Anything held for this run is performed at once, which is what
   * covers the gap between a run starting on the server and its id reaching
   * this side.
   */
  own(runKey: string): void;
  /** Let a run go, closing the stream when it was the last. */
  release(runKey: string): void;
  /** Whether this client would perform a call for that run. */
  owns(runKey: string): boolean;
  /**
   * Resolves once the feed is established, or rejects if it cannot be.
   *
   * A verb published before this client's stream is up reaches nobody: the
   * feed fans out to whoever is listening *now*, and a browser call is
   * deliberately not replayed — a question the server has since abandoned must
   * not be acted on late. In practice the gap does not bite, because the run
   * is claimed the moment the server announces its id and the first browser
   * verb is at least one model round trip after that, while opening this
   * stream is one local request. A call lost in that window is not a hang
   * either: the server's own deadline answers the agent in words.
   *
   * It is exposed for the callers that *can* be faster than a model — the
   * end-to-end suite publishes a verb the instant it claims a run — and for
   * anything that wants to know the connection works before relying on it.
   */
  ready(): Promise<void>;
  /** Stop listening and forget everything. */
  stop(): void;
}

export function createBrowserCallClient(options: BrowserCallClientOptions): BrowserCallClient {
  const request = options.fetch ?? globalThis.fetch;
  const owned = new Set<string>();
  /** Calls seen before their run was claimed, oldest first. */
  const held: { readonly call: ServerBrowserCall; readonly at: number }[] = [];
  let abort: AbortController | null = null;
  let stopped = false;
  /** Settled when the current stream's response headers have arrived. */
  let established: { promise: Promise<void>; settle: (error?: unknown) => void } | null = null;

  function openings(): { promise: Promise<void>; settle: (error?: unknown) => void } {
    if (established !== null) return established;
    let settle: (error?: unknown) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      settle = (error) => {
        if (error === undefined) resolve();
        else reject(error instanceof Error ? error : new Error(String(error)));
      };
    });
    // Nobody may be waiting on it, and an unhandled rejection would take the
    // process down for a stream this client is about to retry anyway.
    promise.catch(() => undefined);
    established = { promise, settle };
    return established;
  }

  function report(error: unknown): void {
    try {
      options.onError?.(error);
    } catch {
      // A reporter that throws is not worth a second exception.
    }
  }

  async function answer(call: ServerBrowserCall, result: DriverResult<unknown>): Promise<void> {
    try {
      const response = await request(`${options.root}${REMOTE_BROWSER_ANSWER_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers() },
        body: JSON.stringify({ callId: call.callId, result } satisfies {
          callId: string;
          result: DriverResult<unknown>;
        }),
      });
      if (!response.ok) {
        // A 404 is the ordinary case for an answer that arrived after the
        // server gave up, and there is nothing to do about it: the agent has
        // already been told the client did not answer.
        report(new Error(`The server refused a browser answer: ${String(response.status)}`));
      }
    } catch (error) {
      report(error);
    }
  }

  /** Perform a call and post what happened. Never throws. */
  async function handle(call: ServerBrowserCall): Promise<void> {
    let result: DriverResult<unknown>;
    try {
      result = await performBrowserCall(options.driverFor(call.runKey), call);
    } catch (error) {
      /*
       * A driver is contracted to answer rather than throw, and this is the
       * belt to that brace. The server is waiting, and a sentence it can hand
       * the model beats a deadline nobody can explain.
       */
      report(error);
      result = {
        ok: false,
        reason: `The browser on the user's machine could not do that: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    await answer(call, result);
  }

  /** Drop anything held past its welcome. Performed calls are already gone. */
  function expire(): void {
    const deadline = Date.now() - HOLD_MS;
    while (held.length > 0 && (held[0] as { at: number }).at < deadline) held.shift();
  }

  function receive(call: ServerBrowserCall): void {
    if (owned.has(call.runKey)) {
      void handle(call);
      return;
    }
    // Not ours yet, and possibly never. Held rather than dropped; see HOLD_MS.
    expire();
    held.push({ call, at: Date.now() });
    if (held.length > MAX_HELD) held.shift();
  }

  /**
   * Follow the server's push feed until told to stop.
   *
   * Reconnects on its own with a flat delay rather than a backoff: this stream
   * is opened only while a run is waiting on a browser, so a gap in it costs
   * that run a verb, and a client that waited thirty seconds to retry would be
   * a client the server had already given up on. `Last-Event-ID` is not sent —
   * a browser call is a question, and replaying a question the server has
   * since answered or abandoned would have this machine act on a stale one.
   */
  function listen(): void {
    if (abort !== null || stopped) return;
    const controller = new AbortController();
    abort = controller;

    void (async () => {
      while (!stopped && abort === controller) {
        try {
          const response = await request(`${options.root}${REMOTE_EVENTS_PATH}`, {
            headers: { accept: 'text/event-stream', ...options.headers() },
            signal: controller.signal,
          });
          if (!response.ok || response.body === null) {
            throw new Error(`The event stream answered ${String(response.status)}.`);
          }
          openings().settle();
          const decoder = createSseDecoder();
          const reader = response.body.getReader();
          const text = new TextDecoder();
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done === true) break;
            for (const message of decoder.feed(text.decode(chunk.value, { stream: true }))) {
              if (message.event !== 'artemis:push:browser-call') continue;
              const call = readCall(message.data);
              if (call !== null) receive(call);
            }
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          report(error);
          // A caller waiting on the first attempt hears about it rather than
          // waiting for a retry that may be a second away.
          openings().settle(error);
          established = null;
        }
        if (stopped || abort !== controller) return;
        await new Promise((done) => setTimeout(done, 1_000));
      }
    })();
  }

  function stopListening(): void {
    abort?.abort();
    abort = null;
    established = null;
  }

  return {
    own(runKey) {
      if (stopped || owned.has(runKey)) return;
      owned.add(runKey);
      listen();
      expire();
      // Held calls for this run were waiting for exactly this.
      for (const entry of held.splice(0, held.length)) {
        if (entry.call.runKey === runKey) void handle(entry.call);
        else held.push(entry);
      }
    },

    release(runKey) {
      owned.delete(runKey);
      if (owned.size === 0) stopListening();
    },

    owns: (runKey) => owned.has(runKey),

    ready: async () => {
      if (stopped) throw new Error('This browser relay client has been stopped.');
      if (abort === null) throw new Error('No run has claimed this browser relay client yet.');
      await openings().promise;
    },

    stop() {
      stopped = true;
      owned.clear();
      held.length = 0;
      stopListening();
    },
  };
}

/**
 * One call off the wire, or `null` for anything that is not plainly one.
 *
 * The three fields this file acts on are proved: an event with no `callId` is
 * one nothing can answer, and one with no `runKey` is one ownership cannot be
 * decided for. `verb` is left to {@link performBrowserCall}'s switch, which
 * refuses what it does not recognise by returning nothing — so an unknown verb
 * from a newer server fails the build here rather than silently doing the
 * wrong thing in somebody's browser.
 */
function readCall(data: string | undefined): ServerBrowserCall | null {
  if (data === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw['object'] !== 'artemis.browser.call') return null;
  if (typeof raw['callId'] !== 'string' || raw['callId'].length === 0) return null;
  if (typeof raw['runKey'] !== 'string' || raw['runKey'].length === 0) return null;
  if (typeof raw['verb'] !== 'string') return null;
  return parsed as ServerBrowserCall;
}

/** The answer body's shape, named so a test can assert on it. */
export type { RemoteBrowserAnswerBody };
