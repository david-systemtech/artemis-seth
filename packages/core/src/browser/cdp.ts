/**
 * One WebSocket to a Chromium, and the bookkeeping that makes it a protocol.
 * ============================================================================
 *
 * The Chrome DevTools Protocol is JSON objects over a socket: `{id, method,
 * params}` out, `{id, result}` or `{id, error}` back, and unsolicited
 * `{method, params}` events in between. Everything here is that, plus the three
 * things a caller would otherwise write four times: matching answers to
 * questions, routing by session, and not waiting for ever.
 *
 * ## One socket, flattened sessions
 *
 * The browser-level endpoint (`/devtools/browser/<uuid>`) is the only socket
 * this opens. Pages are reached by attaching to their targets with
 * `Target.attachToTarget {flatten: true}`, which makes every later message
 * carry a `sessionId` on the same connection rather than needing a second
 * socket per tab. Rejected: a socket per target, which is what a naive client
 * does. It costs a file descriptor and a handshake per tab, and it loses the
 * ordering guarantee that matters here — a `Target.targetDestroyed` event and
 * the failure of the call that was in flight when the tab died arrive on one
 * connection in the order they happened.
 *
 * ## Node's own WebSocket, not `ws`
 *
 * Node 22 has a global `WebSocket` (the WHATWG one, undici's implementation),
 * and it is sufficient here, so nothing is added to `package.json`. `ws` is in
 * the lockfile as a transitive dependency of the MCP SDK; depending on a
 * package that arrived under something else is how a workspace ends up with a
 * version it never chose.
 *
 * The one thing the WHATWG API cannot do is set request headers, which is why
 * {@link resolveCdpEndpoint} exists — see its comment on what Chromium checks.
 * Measured on Chromium 141 (`chromium_headless_shell`, 2026-09-21): the global
 * `WebSocket` connects to the DevTools endpoint with no extra arguments, and
 * sends no `Origin`, so `--remote-allow-origins` is not needed.
 *
 * ## A dead socket is an answer, not a hang
 *
 * Every call has a deadline and every in-flight call is rejected when the
 * socket closes. A browser that goes away mid-verb must produce a sentence the
 * agent can read; a promise that never settles would park the turn until the
 * run's own deadline hours later.
 *
 * That rule covers the discovery `GET` as well, and it has to: an endpoint that
 * accepts a TCP connection and never answers `/json/version` is met *before*
 * any of the above exists — see {@link defaultFetchJson}.
 */

import { lookup } from 'node:dns/promises';

// One predicate, from the module whose job is classifying hosts. It was
// duplicated here, and two copies of a rule a gate depends on is how the two
// stop agreeing.
import { isAddressLiteral } from './serverBrowserPolicy.js';

/**
 * The socket, as the rest of this package needs it.
 *
 * An interface rather than a `WebSocket` so a test can drive the protocol
 * without a port: the interesting behaviour is the correlation and the
 * lifecycle, and standing up a real Chromium to assert them would be testing
 * Chromium. {@link webSocketDialer} is the only implementation that opens
 * anything.
 */
export interface CdpTransport {
  send(message: string): void;
  close(): void;
  /** Called for every frame the far end sends. Registered once, before use. */
  onMessage(listener: (message: string) => void): void;
  /** Called once, whenever the socket ends — cleanly or otherwise. */
  onClose(listener: () => void): void;
}

/** How a connection is opened. Injected by tests; {@link webSocketDialer} live. */
export type CdpDialer = (wsUrl: string) => Promise<CdpTransport>;

/** How long one CDP call may take before it is treated as lost. */
const CALL_TIMEOUT_MS = 30_000;

/** How long the socket handshake may take. */
const DIAL_TIMEOUT_MS = 10_000;

/** What a CDP answer looks like once it is parsed. */
interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly sessionId?: string;
  readonly result?: unknown;
  readonly params?: unknown;
  readonly error?: { readonly message?: string; readonly data?: string };
}

/** A listener for one CDP event, on one session or on the browser itself. */
type EventListener = (params: Record<string, unknown>) => void;

/**
 * What separates a session id from a method name in a listener key.
 *
 * Written as an escape, never as the byte itself: a source file holding a raw
 * control character is one git classifies as binary, which costs every reviewer
 * the diff and every search the file. A unit separator rather than a colon
 * because a session id is opaque and a method name contains a dot, and neither
 * may collide with the joint.
 */
const KEY_SEPARATOR = '\u001f';

/**
 * One live DevTools connection.
 *
 * Holds no opinion about browsers, tabs or policy: it is the place where a
 * `Promise` becomes a message and back again. What it does own is the rule that
 * nothing waits for ever — see the header.
 */
export class CdpConnection {
  readonly #transport: CdpTransport;
  readonly #pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /** `sessionId ?? ''` + {@link KEY_SEPARATOR} + method → listeners. The empty session is the browser. */
  readonly #listeners = new Map<string, Set<EventListener>>();
  #nextId = 0;
  #closed: string | null = null;
  readonly #onClosed = new Set<() => void>();

  constructor(transport: CdpTransport) {
    this.#transport = transport;
    transport.onMessage((text) => {
      this.#receive(text);
    });
    transport.onClose(() => {
      this.#fail('The browser connection closed.');
    });
  }

  /** Whether this connection can still carry a call. */
  get open(): boolean {
    return this.#closed === null;
  }

  /**
   * Ask the browser something and wait for its answer.
   *
   * A CDP `error` object comes back as a rejection carrying the browser's own
   * message, because every caller above this turns a thrown message into the
   * sentence the model reads — see `cdpPageDriver.ts`. `data` is appended when
   * Chromium supplies it: for a bad selector or an unknown node it is the half
   * of the message that says which.
   */
  async call(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.#closed !== null) throw new Error(this.#closed);
    const id = ++this.#nextId;
    const message = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId === undefined ? {} : { sessionId }),
    });

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`The browser did not answer ${method} within 30 seconds.`));
      }, CALL_TIMEOUT_MS);
      // A timer per in-flight call would otherwise hold the process open for
      // half a minute after everything else had finished.
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#transport.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Listen for one CDP event, optionally on one session.
   *
   * Returns the way to stop. Events are fanned out per session because a
   * flattened connection carries every tab's `Runtime.consoleAPICalled` down
   * one socket, and a page's console must not appear in another page's buffer.
   */
  on(method: string, listener: EventListener, sessionId?: string): () => void {
    const key = `${sessionId ?? ''}${KEY_SEPARATOR}${method}`;
    const set = this.#listeners.get(key) ?? new Set<EventListener>();
    set.add(listener);
    this.#listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(key);
    };
  }

  /** Called when the socket ends, for whatever reason. */
  onClosed(listener: () => void): void {
    this.#onClosed.add(listener);
  }

  /** Hang up. In-flight calls reject; later calls reject immediately. */
  close(): void {
    this.#fail('The browser connection was closed.');
    try {
      this.#transport.close();
    } catch {
      // A socket that is already gone is the outcome being asked for.
    }
  }

  #receive(text: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(text) as CdpMessage;
    } catch {
      // A frame that is not JSON is not something this protocol can have sent,
      // and there is no call it could be the answer to. Dropping it is the only
      // move that does not invent a failure for a caller who is still waiting.
      return;
    }

    if (typeof message.id === 'number') {
      const waiting = this.#pending.get(message.id);
      if (waiting === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error !== undefined) {
        const detail = message.error.data === undefined ? '' : `: ${message.error.data}`;
        waiting.reject(new Error(`${message.error.message ?? 'The browser refused the request.'}${detail}`));
        return;
      }
      waiting.resolve((message.result ?? {}) as Record<string, unknown>);
      return;
    }

    if (typeof message.method !== 'string') return;
    const key = `${message.sessionId ?? ''}${KEY_SEPARATOR}${message.method}`;
    const set = this.#listeners.get(key);
    if (set === undefined) return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    // A copy, because a listener may unsubscribe itself while being called and
    // mutating a `Set` under its own iteration drops the listener after it.
    for (const listener of [...set]) listener(params);
  }

  /** End every call in flight and refuse the ones that come after. */
  #fail(reason: string): void {
    if (this.#closed !== null) return;
    this.#closed = reason;
    for (const waiting of this.#pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
    }
    this.#pending.clear();
    this.#listeners.clear();
    for (const listener of this.#onClosed) listener();
    this.#onClosed.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Opening one                                                                */
/* -------------------------------------------------------------------------- */

/** A connection over Node's own `WebSocket`. See the header on why not `ws`. */
export function webSocketDialer(): CdpDialer {
  return async (wsUrl: string) =>
    new Promise<CdpTransport>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* already gone */
        }
        reject(new Error(`The browser at ${wsUrl} did not accept a connection within 10 seconds.`));
      }, DIAL_TIMEOUT_MS);
      timer.unref?.();

      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve({
          send: (message) => {
            socket.send(message);
          },
          close: () => {
            socket.close();
          },
          onMessage: (listener) => {
            socket.addEventListener('message', (event: MessageEvent) => {
              listener(typeof event.data === 'string' ? event.data : String(event.data));
            });
          },
          onClose: (listener) => {
            socket.addEventListener('close', () => {
              listener();
            });
          },
        });
      });

      socket.addEventListener('error', () => {
        clearTimeout(timer);
        // The WHATWG event carries no reason, by design — it is the same event
        // a page gets, and a page is not told why a connection failed. The
        // address is the only thing worth saying, and it is the thing an
        // operator needs.
        reject(new Error(`Could not connect to the browser at ${wsUrl}.`));
      });
    });
}

/** What {@link resolveCdpEndpoint} needs from the outside world. */
export interface EndpointDeps {
  /** Hostname → address. Node's resolver live; a map in tests. */
  readonly lookup?: (hostname: string) => Promise<string>;
  /** `GET` a JSON document. `fetch` live. */
  readonly fetchJson?: (url: string) => Promise<unknown>;
}

/**
 * The configured address, turned into a WebSocket endpoint this can dial.
 * ============================================================================
 *
 * `ARTEMIS_BROWSER_CDP_URL` is written by an operator against a compose file,
 * so it arrives in whichever of three shapes reads best to them:
 *
 *  - `http://browser:9222` — resolved through `/json/version`.
 *  - `ws://browser:9222` — the same, because the browser endpoint's path
 *    carries a UUID that only `/json/version` knows.
 *  - `ws://browser:9222/devtools/browser/<uuid>` — used as it stands.
 *
 * ## Why the name is resolved to an address first
 *
 * Chromium refuses an HTTP request to its DevTools port whose `Host` header is
 * neither an IP literal nor `localhost`: the reply is `500 Host header is
 * specified and is not an IP address or localhost`. It is rebinding protection
 * — a page cannot make a browser send a chosen `Host` — and it means
 * `http://browser:9222/json/version`, the obvious thing to write in a compose
 * file, does not work. So the hostname is resolved here and the discovery
 * request is made to the address. Chromium echoes the `Host` it was given back
 * into `webSocketDebuggerUrl`, so the endpoint that comes back already names
 * the address (measured 2026-09-21, Chromium 141, through a TCP relay standing
 * in for the compose service).
 *
 * Measured at the same time, and the reason the third shape needs no
 * resolution: the **WebSocket upgrade** is *not* Host-checked on that build.
 * Only the plain `/json/*` documents are. Resolving anyway costs one DNS
 * lookup and removes a dependency on that staying true.
 */
export async function resolveCdpEndpoint(configured: string, deps: EndpointDeps = {}): Promise<string> {
  const trimmed = configured.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `ARTEMIS_BROWSER_CDP_URL is not a URL: "${configured}". Expected something like ws://browser:9222.`,
    );
  }

  const scheme = parsed.protocol.replace(/:$/u, '');
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws' && scheme !== 'wss') {
    throw new Error(
      `ARTEMIS_BROWSER_CDP_URL must be http, https, ws or wss, not ${scheme}: (got "${configured}").`,
    );
  }

  const address = await resolveAddress(parsed.hostname, deps);
  // A WebSocket URL that already names a target is the endpoint. Anything else
  // — including a bare `ws://host:port` — has to ask the browser for its UUID.
  if ((scheme === 'ws' || scheme === 'wss') && parsed.pathname.startsWith('/devtools/')) {
    const dialled = new URL(trimmed);
    // Bracketed, exactly as the discovery branch below does it, and for a
    // reason that is invisible without it: `ws:` is a *special* scheme, so the
    // WHATWG host parser refuses a bare IPv6 literal — and the `hostname`
    // setter fails **silently**. It does not throw; it leaves the old host in
    // place, so `ws://browser:9222/devtools/browser/<uuid>` behind an IPv6
    // address would be dialled by the name the resolution was meant to remove.
    dialled.hostname = bracketed(address);
    return dialled.toString();
  }

  const httpScheme = scheme === 'wss' || scheme === 'https' ? 'https' : 'http';
  const port = parsed.port.length > 0 ? `:${parsed.port}` : '';
  const discovery = `${httpScheme}://${bracketed(address)}${port}/json/version`;
  const body = await (deps.fetchJson ?? defaultFetchJson)(discovery);
  const endpoint = (body as { webSocketDebuggerUrl?: unknown } | null)?.webSocketDebuggerUrl;
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new Error(
      `${discovery} did not name a webSocketDebuggerUrl. Is a Chromium listening there with --remote-debugging-port?`,
    );
  }
  return endpoint;
}

/** An IPv6 address needs brackets inside a URL; a name and an IPv4 must not have them. */
function bracketed(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

async function resolveAddress(host: string, deps: EndpointDeps): Promise<string> {
  if (host.length === 0) throw new Error('ARTEMIS_BROWSER_CDP_URL names no host.');
  if (isAddressLiteral(host)) return host.replace(/^\[|\]$/gu, '');
  const resolver = deps.lookup ?? (async (name: string) => (await lookup(name)).address);
  try {
    return await resolver(host);
  } catch (error) {
    throw new Error(
      `Could not resolve "${host}" from ARTEMIS_BROWSER_CDP_URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * `GET` the discovery document, on a deadline.
 *
 * The deadline is the point. {@link resolveCdpEndpoint} is awaited on the
 * connect path, *before* a {@link CdpConnection} exists, so it is outside
 * everything the header's "a dead socket is an answer, not a hang" rule covers:
 * an endpoint that accepts the TCP connection and then says nothing — a
 * half-started container, a proxy holding the request open, a browser wedged
 * before its HTTP server answers — would hang the run's first `browser_open`
 * for as long as the run lives. The same ten seconds the socket handshake gets,
 * because it is the same question asked one layer down.
 *
 * An `AbortController` and a timer rather than `AbortSignal.timeout`, which
 * says this in one line. Two reasons, and the second is the one that decided
 * it: this file already owns the idiom twice ({@link webSocketDialer} and
 * `CdpConnection.call`), and `AbortSignal.timeout` schedules on Node's internal
 * timers rather than the global `setTimeout`, so no test can reach it without
 * spending the ten seconds for real.
 *
 * The timer is cleared only after the body has been read, so a response whose
 * body never ends is bounded too — that is the shape a wedged proxy actually
 * has, and a deadline on the headers alone would not catch it.
 */
async function defaultFetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, DIAL_TIMEOUT_MS);
  // A pending discovery must not be the reason a server cannot exit.
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${url} answered ${String(response.status)}.`);
    }
    return await response.json();
  } catch (error) {
    // Said in the words the dialler uses for the same failure one layer up: an
    // operator reading this has a browser that is reachable and not answering,
    // which is a different fault from one that is not there at all.
    if (controller.signal.aborted) {
      throw new Error(`The browser at ${url} did not answer within 10 seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
