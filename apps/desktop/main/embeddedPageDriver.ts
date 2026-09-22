/**
 * The dock browser, as a {@link PageDriver}.
 * ============================================================================
 *
 * `browser.ts` draws a page for a person and `browserTools.ts` used to drive it
 * for an agent, with the tool handlers written straight against Electron's
 * `webContents`. This file is what is left of that after the handlers moved to
 * `@rx-artemis/core`: the Electron half, behind the one interface every browser
 * Artemis can drive implements. The emphasis stays on **same page** — a tool
 * call navigates the view sitting in the dock, so the user sees each step
 * happen, which is what separates this from wiring up a Playwright MCP server
 * and handing the agent a browser nobody can see.
 *
 * ## The abilities this driver claims, and the three it declines
 *
 * `console` and `network` are here, because the whole point of them is turning
 * "the page is blank" into "`/api/orders` returned 500", and Electron can
 * answer both without asking the page anything.
 *
 * `cookies`, `storage` and `evaluate` are `false`, and that is a decision
 * rather than an omission. The verbs now exist on the contract — the server
 * browser is signed in to nothing and can afford all three, and the extension
 * applies a per-site policy inside Chrome — but this browser can afford none of
 * them:
 *
 * **No `browser_evaluate`.** Handing the model an arbitrary-JavaScript tool
 * would make every other rule here decorative — `browser_click` could be
 * spelled as a `fetch`, and the scheme gate in `browserUrlFor` could be stepped
 * around with `location.href`. The tools this driver offers are verbs a person
 * could perform on a page, which is the level it belongs at. Note that the
 * driver runs JavaScript in the page *itself*, for reading and clicking: the
 * difference is that the expressions are this file's and not the model's.
 *
 * **No cookie, storage or header access.** `browser.ts`'s `BROWSER_PARTITION`
 * is one persistent session shared by every tab in the dock, so it holds
 * whatever the *user* has signed into inside Artemis. A tool that could read a
 * cookie value here would be a tool that could read their live session on any
 * site they had visited, and a page steered by a prompt injection could ask for
 * exactly that. The contract's per-site policy is what makes those verbs safe
 * elsewhere, and this browser has no per-site anything: one session, one set of
 * cookies, all of them the user's. `browser_network` is bounded by the same
 * rule and is why it reports no headers and no bodies: a request line says
 * *that* a call was made and how it went, an `Authorization` header or a
 * response body hands over what was in it.
 *
 * Rejected: giving this driver `cookies` with values suppressed. Names and
 * attributes alone would be honest, but they answer almost none of the
 * questions the verb exists for, and a half-working tool the model keeps
 * reaching for is worse than a tool it was never offered.
 *
 * ## Where the console and network entries come from
 *
 * Console lines are `webContents`'s own `console-message` event. Requests are
 * the *session*'s `webRequest` observers — `onSendHeaders`, `onCompleted`,
 * `onErrorOccurred`, all three of which are the non-blocking kind that cannot
 * delay, cancel or alter anything. Rejected: `webContents.debugger`, which is
 * the more capable route and the wrong one here. Attaching it puts Chromium
 * into a debugged state, fights with a DevTools window the user opens, and
 * `Network.enable` changes how the page caches — a browser the user is watching
 * must not behave differently because an agent is watching too.
 *
 * `webRequest` handlers are **per session and single-slot**: registering a
 * second `onCompleted` replaces the first. Every tab in the dock shares one
 * session, so this file installs exactly one observer per session and fans out
 * by `webContentsId` — see {@link SessionRecorder}. Nothing is recorded for a
 * tab no driver is watching.
 */

import type { Session } from 'electron';

import {
  browserUrlFor,
  type BrowserId,
  type ConsoleEntry,
  type CookieEntry,
  type DriverResult,
  type NetworkEntry,
  type PageDriver,
  type PageDriverAbilities,
  type PageImage,
  type PageLocation,
  type PageText,
  type RunId,
  type StorageSnapshot,
} from '@rx-artemis/protocol';

import type { BrowserHost } from './browser.js';
import { createLogger } from './log.js';

const log = createLogger('browser-driver');

/** How long a verb waits for a navigation to settle before reporting anyway. */
const LOAD_TIMEOUT_MS = 20_000;

/**
 * How many console lines and requests one tab keeps between calls.
 *
 * Bounded because a page with a logging loop would otherwise grow this without
 * limit in a process the user cannot restart without losing their work. The
 * oldest go first: what an agent asks about is nearly always what just
 * happened. Console keeps fewer because one entry can be a whole stack trace.
 */
const MAX_CONSOLE = 200;
const MAX_NETWORK = 400;

/** In-flight requests remembered so a completion can be given a duration. */
const MAX_IN_FLIGHT = 500;

/** What this browser will and will not do. See the file header for the three `false`s. */
const EMBEDDED_ABILITIES: PageDriverAbilities = {
  console: true,
  network: true,
  cookies: false,
  storage: false,
  evaluate: false,
};

/** The sentence a verb answers with when the run has no page yet. */
const NO_BROWSER = 'No browser is open for this conversation. Use browser_open first.';

/**
 * What the driver needs from the app.
 *
 * An interface rather than the concrete host so this file can be exercised
 * against a fake — the decisions are the interesting part, and standing up a
 * `WebContentsView` to test them would test Electron instead.
 */
export interface BrowserToolContext {
  /** Open a page for this run, returning its id. Reuses one when it exists. */
  ensure(runId: RunId, url: string | undefined): Promise<BrowserId>;
  /** The browser this run is driving, or `null` when it has none yet. */
  current(runId: RunId): BrowserId | null;
  readonly host: Pick<BrowserHost, 'contentsFor' | 'stateFor' | 'navigate'>;
}

/* -------------------------------------------------------------------------- */
/* Page access                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The page's readable text, the way a reader would meet it.
 *
 * `innerText` rather than `innerHTML`, and that is the load-bearing choice.
 * Markup is mostly attributes, class names and framework noise — a page whose
 * prose is two kilobytes is routinely four hundred kilobytes of HTML — and the
 * agent is nearly always asking "what does this page say", not "how is it
 * built". `innerText` also honours `display: none`, so it omits what the reader
 * cannot see, which is the same answer a screenshot would give.
 */
const READ_SCRIPT = `(() => {
  const body = document.body;
  if (!body) return '';
  return body.innerText;
})()`;

/**
 * A CSS selector or a piece of typed text, as JavaScript source.
 *
 * `JSON.stringify` rather than quotes-and-hope: a selector is model output, it
 * routinely contains quotes (`[data-id="save"]`), and concatenating one into a
 * script is the injection this file would otherwise be full of. This is the
 * only way model output reaches a page anywhere below.
 */
function asLiteral(value: string): string {
  return JSON.stringify(value);
}

function ok<T>(value: T): DriverResult<T> {
  return { ok: true, value };
}

function no<T>(reason: string): DriverResult<T> {
  return { ok: false, reason };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  log.debug('A browser verb failed with a non-Error', error);
  return 'The browser tool failed.';
}

/* -------------------------------------------------------------------------- */
/* Watching one tab's console and requests                                    */
/* -------------------------------------------------------------------------- */

/** A bounded buffer that drops the oldest when it is full. */
function push<T>(buffer: T[], entry: T, max: number): void {
  buffer.push(entry);
  if (buffer.length > max) buffer.splice(0, buffer.length - max);
}

/**
 * One session's request observer, shared by every tab on that session.
 *
 * Exists because `webRequest`'s listeners are per session and single-slot: a
 * second `onCompleted` silently replaces the first, so two drivers each
 * registering their own would leave one of them permanently blind with no
 * error anywhere. One observer per session, installed on the first tab anyone
 * watches, fanning out by `webContentsId`.
 *
 * A tab nobody is watching is not recorded at all — {@link watch} is what
 * creates a buffer, and every callback returns immediately for an id with none.
 * That keeps the cost of this proportional to the agents actually using it
 * rather than to the tabs the user has open.
 */
export class SessionRecorder {
  readonly #session: Session;
  readonly #buffers = new Map<number, NetworkEntry[]>();
  /** Request id → what was known when it went out, so a finish can be dated. */
  readonly #inFlight = new Map<number, { readonly at: number; readonly kind: string }>();
  #installed = false;

  constructor(session: Session) {
    this.#session = session;
  }

  /** Begin recording for a tab. Idempotent: watching twice keeps one buffer. */
  watch(webContentsId: number): void {
    if (!this.#buffers.has(webContentsId)) this.#buffers.set(webContentsId, []);
    this.#install();
  }

  /** Stop recording for a tab and let go of what it held. */
  forget(webContentsId: number): void {
    this.#buffers.delete(webContentsId);
  }

  /** Everything since the last call. Reading empties the buffer. */
  drain(webContentsId: number): readonly NetworkEntry[] {
    const buffer = this.#buffers.get(webContentsId);
    if (buffer === undefined) return [];
    return buffer.splice(0, buffer.length);
  }

  /**
   * A main-frame load failure, from the tab's own `did-fail-load`.
   *
   * `webRequest` reports most of these already, so this is the belt to that
   * brace: it catches what never reaches the request layer, notably a
   * certificate Chromium rejected before connecting, and it is attributable to
   * one tab where a `webContentsId` is sometimes absent. Recorded only when the
   * request layer has not just said the same thing about the same address,
   * because one failure reported twice reads as two failures.
   */
  noteLoadFailure(webContentsId: number, entry: NetworkEntry): void {
    const buffer = this.#buffers.get(webContentsId);
    if (buffer === undefined) return;
    const alreadySaid = buffer
      .slice(-8)
      .some(
        (one) =>
          one.url === entry.url && one.failure !== undefined && Math.abs(one.at - entry.at) < 5_000,
      );
    if (!alreadySaid) push(buffer, entry, MAX_NETWORK);
  }

  #install(): void {
    if (this.#installed) return;
    this.#installed = true;
    const requests = this.#session.webRequest;

    /*
     * All three are the observing kind: they cannot delay, cancel or rewrite
     * anything, and none of them takes a callback the stack is waiting on. A
     * page behaves the same whether or not an agent is looking, which is the
     * property that made this preferable to attaching the debugger — see the
     * file header.
     */
    requests.onSendHeaders((details) => {
      const tab = details.webContentsId;
      if (tab === undefined || !this.#buffers.has(tab)) return;
      this.#inFlight.set(details.id, { at: details.timestamp, kind: details.resourceType });
      /*
       * A request that never finishes would otherwise be remembered for the
       * life of the app. The oldest is the one least likely still to be in
       * flight, and losing it costs a duration on one line of a listing.
       */
      if (this.#inFlight.size > MAX_IN_FLIGHT) {
        const oldest = this.#inFlight.keys().next();
        if (oldest.done !== true) this.#inFlight.delete(oldest.value);
      }
    });

    requests.onCompleted((details) => {
      this.#finish(details.webContentsId, details.id, {
        method: details.method,
        url: details.url,
        status: details.statusCode,
        resourceType: details.resourceType,
        at: details.timestamp,
      });
    });

    requests.onErrorOccurred((details) => {
      this.#finish(details.webContentsId, details.id, {
        method: details.method,
        url: details.url,
        resourceType: details.resourceType,
        failure: details.error,
        at: details.timestamp,
      });
    });
  }

  /** Record a finished request against its tab, dated from its start if seen. */
  #finish(tab: number | undefined, requestId: number, entry: NetworkEntry): void {
    const started = this.#inFlight.get(requestId);
    this.#inFlight.delete(requestId);
    if (tab === undefined) return;
    const buffer = this.#buffers.get(tab);
    if (buffer === undefined) return;
    push(
      buffer,
      started === undefined
        ? entry
        : { ...entry, durationMs: Math.max(0, Math.round(entry.at - started.at)) },
      MAX_NETWORK,
    );
  }
}

/**
 * One recorder per session, because one set of observers per session is all
 * `webRequest` has room for.
 */
const recorders = new WeakMap<Session, SessionRecorder>();

/** The recorder for a session, created on first use. */
export function recorderFor(session: Session): SessionRecorder {
  const existing = recorders.get(session);
  if (existing !== undefined) return existing;
  const created = new SessionRecorder(session);
  recorders.set(session, created);
  return created;
}

/* -------------------------------------------------------------------------- */
/* The driver                                                                 */
/* -------------------------------------------------------------------------- */

/** What one driver has hooked up to one tab, and how to let go of it again. */
interface Watch {
  readonly id: BrowserId;
  /** Console lines since the last `console()` call. Drained by reading. */
  readonly console: ConsoleEntry[];
  readonly release: () => void;
}

/**
 * Chromium's four console severities, in the vocabulary the contract uses.
 *
 * `console.log` arrives as `info` and there is no separate signal for an
 * uncaught exception — Chromium logs one as an ordinary `error` line whose text
 * begins "Uncaught". So `log` and `exception` are levels this driver never
 * produces, which is a gap in what Electron reports rather than one worth
 * inventing a heuristic over: a model reading "error / Uncaught TypeError …"
 * has everything the distinction would have told it.
 */
const CONSOLE_LEVELS: Readonly<Record<string, ConsoleEntry['level']>> = {
  info: 'info',
  warning: 'warn',
  error: 'error',
  debug: 'debug',
};

/**
 * One run's hands on the browser tab in the dock.
 *
 * Built per run by the composition root, closing over that run's id: a tool
 * therefore acts on the browser belonging to its own conversation, and the
 * model has no way to name a different one because no verb takes an id.
 */
export function embeddedPageDriver(runId: RunId, context: BrowserToolContext): PageDriver {
  return new EmbeddedPageDriver(runId, context);
}

class EmbeddedPageDriver implements PageDriver {
  readonly kind = 'embedded' as const;
  readonly abilities = EMBEDDED_ABILITIES;

  readonly #runId: RunId;
  readonly #context: BrowserToolContext;
  #watch: Watch | null = null;

  constructor(runId: RunId, context: BrowserToolContext) {
    this.#runId = runId;
    this.#context = context;
  }

  async open(url?: string): Promise<DriverResult<PageLocation>> {
    /*
     * The scheme gate, before anything is created. `browserUrlFor` is the rule
     * the address bar obeys and a tool call is not a privileged way around it —
     * an agent asking for `file:///etc/passwd` gets the refusal a person typing
     * it would, and gets it without a view being opened first.
     */
    if (url !== undefined && browserUrlFor(url) === null) {
      return no(`“${url}” is not an http or https address.`);
    }
    try {
      const id = await this.#context.ensure(this.#runId, url);
      this.#listen(id);
      await this.#settle(id);
      return ok(this.#locationOf(id));
    } catch (error) {
      return no(messageOf(error));
    }
  }

  async navigate(url: string): Promise<DriverResult<PageLocation>> {
    const id = this.#context.current(this.#runId);
    if (id === null) return no(NO_BROWSER);
    try {
      // The host applies the same gate again and throws a sentence written for
      // a person when the query is not an address; that sentence is the answer.
      this.#context.host.navigate(id, url);
      this.#listen(id);
      await this.#settle(id);
      const state = this.#context.host.stateFor(id);
      if (state?.failure !== undefined) return no(state.failure);
      return ok(this.#locationOf(id));
    } catch (error) {
      return no(messageOf(error));
    }
  }

  async read(): Promise<DriverResult<PageText>> {
    const id = this.#context.current(this.#runId);
    if (id === null) return no(NO_BROWSER);
    try {
      this.#listen(id);
      await this.#settle(id);
      const text = await this.#inPage(id, READ_SCRIPT);
      /*
       * Nothing is cut here. The tools hold the budget a model reads under, and
       * a driver that clipped as well would leave two places deciding one
       * number. `truncated` is for a driver that has no choice — one reading a
       * page down a socket — which this is not.
       */
      return ok({
        ...this.#locationOf(id),
        text: typeof text === 'string' ? text : '',
        truncated: false,
      });
    } catch (error) {
      return no(messageOf(error));
    }
  }

  async screenshot(): Promise<DriverResult<PageImage>> {
    const id = this.#context.current(this.#runId);
    if (id === null) return no(NO_BROWSER);
    try {
      this.#listen(id);
      await this.#settle(id);
      const contents = this.#context.host.contentsFor(id);
      if (contents === null) return no('That browser is no longer open.');
      const image = await contents.capturePage();
      if (image.isEmpty()) {
        // A detached view has no surface to capture from, which is what a
        // hidden tab is — say so rather than returning a blank image the model
        // would go on to describe as a blank page.
        return no(
          'Could not capture the page. The browser tab may be hidden — ask the user to bring it forward.',
        );
      }
      return ok({ mimeType: 'image/png', data: image.toPNG().toString('base64') });
    } catch (error) {
      return no(messageOf(error));
    }
  }

  async click(selector: string): Promise<DriverResult<PageLocation>> {
    const id = this.#context.current(this.#runId);
    if (id === null) return no(NO_BROWSER);
    try {
      this.#listen(id);
      const clicked = await this.#inPage(
        id,
        `(() => {
                 const el = document.querySelector(${asLiteral(selector)});
                 if (!el) return false;
                 el.scrollIntoView({ block: 'center' });
                 el.click();
                 return true;
               })()`,
      );
      if (clicked !== true) return no(`Nothing matches ${selector} on this page.`);
      // A click very often navigates, so the verb that follows should not have
      // to guess whether it is looking at the old page.
      await this.#settle(id);
      return ok(this.#locationOf(id));
    } catch (error) {
      return no(messageOf(error));
    }
  }

  async type(selector: string, text: string): Promise<DriverResult<PageLocation>> {
    const id = this.#context.current(this.#runId);
    if (id === null) return no(NO_BROWSER);
    try {
      this.#listen(id);
      /*
       * The events matter as much as the value. React, Vue and every other
       * framework listen for `input`; setting `.value` alone updates the DOM
       * and leaves the application's state untouched, so the field looks right
       * and submits empty.
       */
      const typed = await this.#inPage(
        id,
        `(() => {
                 const el = document.querySelector(${asLiteral(selector)});
                 if (!el) return false;
                 el.focus();
                 if (el.isContentEditable) el.textContent = ${asLiteral(text)};
                 else el.value = ${asLiteral(text)};
                 el.dispatchEvent(new Event('input', { bubbles: true }));
                 el.dispatchEvent(new Event('change', { bubbles: true }));
                 return true;
               })()`,
      );
      if (typed !== true) return no(`Nothing matches ${selector} on this page.`);
      return ok(this.#locationOf(id));
    } catch (error) {
      return no(messageOf(error));
    }
  }

  async console(): Promise<DriverResult<readonly ConsoleEntry[]>> {
    const id = this.#context.current(this.#runId);
    if (id === null) return no(NO_BROWSER);
    const watch = this.#listen(id);
    if (watch === null) return no('That browser is no longer open.');
    return ok(watch.console.splice(0, watch.console.length));
  }

  async network(options?: { readonly failedOnly?: boolean }): Promise<DriverResult<readonly NetworkEntry[]>> {
    const id = this.#context.current(this.#runId);
    if (id === null) return no(NO_BROWSER);
    this.#listen(id);
    const contents = this.#context.host.contentsFor(id);
    if (contents === null) return no('That browser is no longer open.');
    /*
     * Drained whole and filtered afterwards, never filtered at the source: a
     * `failedOnly` call must not quietly throw away the successful requests a
     * later call without the flag was going to report.
     */
    const entries = recorderFor(contents.session).drain(contents.id);
    return ok(
      options?.failedOnly === true
        ? entries.filter((entry) => entry.failure !== undefined || (entry.status ?? 0) >= 400)
        : entries,
    );
  }

  async cookies(): Promise<DriverResult<readonly CookieEntry[]>> {
    return no(EMBEDDED_DECLINES_DEEP_READ);
  }

  async storage(): Promise<DriverResult<StorageSnapshot>> {
    return no(EMBEDDED_DECLINES_DEEP_READ);
  }

  async evaluate(_expression: string): Promise<DriverResult<unknown>> {
    return no(
      'The embedded dock browser does not run JavaScript an agent wrote. Every ' +
        'other rule it has would be optional if it did — a click could be ' +
        'spelled as a fetch, and the http/https gate stepped around with ' +
        'location.href. Use browser_click, browser_type and browser_read.',
    );
  }

  /**
   * Let go of the tab without ending it.
   *
   * Deliberately not a close. The tab belongs to the user's dock and has a tab
   * in their strip; `BrowserHost.close` is the only thing that ends a page, and
   * a conversation finishing is not a reason to take a page out from under
   * someone who is reading it. What this releases is what the driver added:
   * the console listener and the tab's slot in the session's recorder.
   */
  async close(): Promise<void> {
    this.#watch?.release();
    this.#watch = null;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Start recording this tab's console and requests, if we are not already.
   *
   * Called from every verb rather than once at construction because a tab does
   * not exist until `open`, and the run gets a *new* one when the user closes
   * the old — `agentBrowserFor` answers `null` for a tab that is gone and the
   * next `browser_open` makes another. Re-listening on a changed id is what
   * keeps the buffers pointed at the page the agent is actually driving.
   */
  #listen(id: BrowserId): Watch | null {
    if (this.#watch?.id === id) return this.#watch;
    this.#watch?.release();
    this.#watch = null;

    const contents = this.#context.host.contentsFor(id);
    if (contents === null) return null;

    const recorder = recorderFor(contents.session);
    const buffer: ConsoleEntry[] = [];
    const onConsole = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
      push(
        buffer,
        {
          level: CONSOLE_LEVELS[details.level] ?? 'log',
          text: details.message,
          ...(details.sourceId === ''
            ? {}
            : { source: `${details.sourceId}:${String(details.lineNumber)}` }),
          at: Date.now(),
        },
        MAX_CONSOLE,
      );
    };

    const onFailedLoad = (
      _event: unknown,
      code: number,
      description: string,
      url: string,
      isMainFrame: boolean,
    ): void => {
      // Subframe failures are the ad blocker's business. `-3` is ABORTED, which
      // is what a navigation the user replaced reports, and is not a failure.
      if (!isMainFrame || code === -3) return;
      recorder.noteLoadFailure(contents.id, {
        method: 'GET',
        url,
        resourceType: 'mainFrame',
        failure: description.length > 0 ? description : `net error ${String(code)}`,
        at: Date.now(),
      });
    };

    contents.on('console-message', onConsole);
    contents.on('did-fail-load', onFailedLoad);
    recorder.watch(contents.id);

    const watch: Watch = {
      id,
      console: buffer,
      release: () => {
        try {
          contents.off('console-message', onConsole);
          contents.off('did-fail-load', onFailedLoad);
          recorder.forget(contents.id);
        } catch (error) {
          // A `webContents` that has been destroyed throws on `off`. There is
          // nothing left to detach from in that case, which is the outcome
          // being asked for.
          log.debug('Could not detach from a browser tab', error);
        }
      },
    };
    this.#watch = watch;
    return watch;
  }

  /**
   * Wait for the page to stop loading.
   *
   * Bounded, and resolving rather than rejecting on timeout: a page that is
   * still streaming after twenty seconds is usually a page whose useful content
   * arrived nineteen seconds ago and whose analytics beacon is still open.
   * Reporting what is there beats refusing to report anything.
   *
   * Three ways out, and the last two were missing. The timeout used to detach
   * its listener *before* resolving, from inside a bare timer callback — and
   * `off` on a destroyed `webContents` throws, which this file's own
   * {@link Watch} comment says. A tab the user closed while a page was loading
   * therefore threw out of a timer with nothing to catch it, and the promise
   * never settled: the verb waited for ever and the run went with it. So the
   * detach is guarded and the resolve happens whatever it does.
   *
   * `destroyed` is the third way out, and it is the one that makes the common
   * case quick. Without it, closing a loading tab parks the verb for the full
   * twenty seconds before it reports on a page that no longer exists.
   */
  async #settle(id: BrowserId): Promise<void> {
    const contents = this.#context.host.contentsFor(id);
    if (contents === null || !contents.isLoading()) return;

    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        try {
          contents.off('did-stop-loading', done);
          contents.off('destroyed', done);
        } catch (error) {
          // A `webContents` that has been destroyed throws on `off`. There is
          // nothing left to detach from, which is the outcome being asked for —
          // and resolving anyway is the whole point of catching it here.
          log.debug('Could not detach from a settling browser tab', error);
        }
        resolve();
      };
      const timer = setTimeout(done, LOAD_TIMEOUT_MS);
      contents.once('did-stop-loading', done);
      contents.once('destroyed', done);
    });
  }

  /**
   * Run one expression in the page and return its value.
   *
   * The single place this file talks to a page's world, kept private so that
   * the set of things a *model* can ask a page to do stays the verbs above —
   * see the header on why `evaluate` is declined.
   *
   * `userGesture` is false: these are not clicks by a person, and a page that
   * gates `window.open` or fullscreen on a real gesture should keep gating them.
   */
  async #inPage(id: BrowserId, expression: string): Promise<unknown> {
    const contents = this.#context.host.contentsFor(id);
    if (contents === null) throw new Error('That browser is no longer open.');
    return contents.executeJavaScript(expression, false);
  }

  /** Where the page is, as the contract states a location. */
  #locationOf(id: BrowserId): PageLocation {
    const state = this.#context.host.stateFor(id);
    // An id whose record has gone answers as a page with no address, which the
    // tools render as "an unknown page" — the honest thing to say about a tab
    // that was closed between the action and the report.
    return { url: state?.url ?? '', title: state?.title ?? '' };
  }
}

/**
 * Why this browser will not read cookies or storage.
 *
 * One sentence for both verbs because it is one reason, and it is the reason
 * the abilities are `false` — the tools are never registered, so this is the
 * answer only for a caller holding the driver directly. See the file header.
 */
const EMBEDDED_DECLINES_DEEP_READ =
  'The embedded dock browser does not hand over cookies or stored values. Its ' +
  'session is the one the user signs into inside Artemis, so reading them here ' +
  'would read their live sessions on every site they have visited in it.';
