/**
 * One tab in the server's Chromium, as CDP messages.
 * ============================================================================
 *
 * The mechanical half of the server browser: what a verb *is* on the DevTools
 * protocol. It holds no policy — `cdpPageDriver.ts` decides where the tab may
 * go and what a refusal reads like — and no lifecycle — `serverBrowser.ts`
 * decides when the tab dies. What is here is the translation, and the places
 * where the protocol does not say what you would expect.
 *
 * ## A verb is a person's action, with two exceptions that are this file's
 *
 * Clicking and typing are real `Input.*` events at the element's box, not
 * `el.click()`: a page that listens for `pointerdown`, checks
 * `event.isTrusted`, or opens a menu on hover behaves the way it would for a
 * person. Reading a page and selecting a field's existing contents are
 * JavaScript, because there is no protocol verb for either — but the
 * expressions are **fixed strings in this file**, never composed from model
 * output. The only model text that reaches a page is `Input.insertText`'s
 * argument and `Runtime.evaluate`'s expression, and the second is a verb the
 * agent asked for by name.
 *
 * ## Timestamps come from two clocks and only one of them is a time
 *
 * CDP's `timestamp` is a monotonic number of seconds since an arbitrary origin;
 * `wallTime`, sent once per request, is seconds since the epoch. So durations
 * are differences of the first and the `at` a listing prints is the second,
 * converted. Mixing them produces requests that happened in 1970.
 *
 * ## The buffers are bounded and drained by reading
 *
 * Same rule and the same numbers as the embedded driver: a page with a logging
 * loop must not grow a buffer without limit, and `browser_console` answers
 * "since the last time you asked". The oldest go first.
 */

import type {
  ConsoleEntry,
  CookieEntry,
  NetworkEntry,
  PageImage,
  PageLocation,
  PageText,
  StorageSnapshot,
} from '@rx-artemis/protocol';

import type { CdpConnection } from './cdp.js';

/**
 * How long a verb waits for a navigation to settle before reporting anyway.
 *
 * Twenty seconds, matching `embeddedPageDriver.ts` — a page still streaming
 * after that is usually a page whose useful content arrived nineteen seconds
 * ago and whose analytics beacon is still open. Reporting what is there beats
 * refusing to report anything.
 */
const LOAD_TIMEOUT_MS = 20_000;

/** How long `browser_evaluate` may run before the page is told to stop. */
const EVALUATE_TIMEOUT_MS = 10_000;

/** The same bounds the embedded driver keeps, for the same reasons. */
const MAX_CONSOLE = 200;
const MAX_NETWORK = 400;
const MAX_IN_FLIGHT = 500;

/**
 * How many subframes' served addresses are remembered at once.
 *
 * A real page has a handful of frames; a page written to make this file hold
 * memory has as many as it likes. Two hundred is far past any document anybody
 * meant to write, and dropping the oldest costs at worst one frame judged on
 * its name alone — which is the same answer an out-of-process frame gets
 * anyway.
 */
const MAX_FRAME_ADDRESSES = 200;

/**
 * The window every page is rendered into.
 *
 * A fixed size rather than whatever a headless shell defaults to (800×600),
 * because a screenshot is compared against what the developer sees and a
 * narrower viewport puts a responsive layout into its tablet breakpoint. 1280×800
 * is the desktop breakpoint every framework's default styles assume.
 */
export const VIEWPORT = { width: 1280, height: 800 } as const;

/** JPEG rather than PNG, and not at full quality: see {@link CdpPage.screenshot}. */
const SCREENSHOT_QUALITY = 70;

/**
 * The page's readable text, the way a reader would meet it.
 *
 * `innerText` rather than `innerHTML`, for the reason `embeddedPageDriver.ts`
 * gives: markup is mostly attributes and framework noise, a page whose prose is
 * two kilobytes is routinely four hundred kilobytes of HTML, and `innerText`
 * honours `display: none` so it omits what the reader cannot see.
 */
const READ_SCRIPT = `(() => {
  const body = document.body;
  if (!body) return '';
  return body.innerText;
})()`;

/**
 * Local and session storage for this origin, as one object.
 *
 * Wrapped in a `try` because reading either throws a `SecurityError` on an
 * opaque origin — `about:blank`, a sandboxed frame, a `data:` URL — and an
 * exception here would read to the agent as a browser fault rather than as
 * "this page has no origin to have storage for".
 */
const STORAGE_SCRIPT = `(() => {
  const read = (store) => {
    const out = {};
    try {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key !== null) out[key] = store.getItem(key) ?? '';
      }
    } catch (error) {
      return { __unreadable: String(error && error.message ? error.message : error) };
    }
    return out;
  };
  return { origin: location.origin, local: read(localStorage), session: read(sessionStorage) };
})()`;

/**
 * Select everything already in the field, so the insert that follows replaces
 * it rather than appending to it.
 *
 * Three cases, because "an input" is three different DOM shapes. Returns what
 * it found so the caller can refuse an element that cannot take text at all
 * rather than typing into the void.
 */
const SELECT_ALL_FN = `function () {
  const el = this;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.select();
    return 'field';
  }
  if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    if (selection) { selection.removeAllRanges(); selection.addRange(range); }
    return 'editable';
  }
  return 'other';
}`;

/**
 * Tell the application the field is finished with.
 *
 * `input` is *not* dispatched here: the edit itself was a real one
 * (`Input.insertText` or a Delete key), so Blink has already fired `input` and
 * a second copy would look to a framework like two edits. `change` is the one
 * a browser fires on blur, which nothing here does, and it is the one a plain
 * `onchange` handler is waiting for.
 */
const FIRE_CHANGE_FN = `function () {
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

/** A bounded buffer that drops the oldest when it is full. */
function push<T>(buffer: T[], entry: T, max: number): void {
  buffer.push(entry);
  if (buffer.length > max) buffer.splice(0, buffer.length - max);
}

/**
 * Why a selector did not work, said so the model can fix it.
 *
 * Its own type because the two cases want different next moves: nothing
 * matched means look at the page again, and matched-but-invisible means the
 * element is behind a tab, a collapsed section or a `display: none`, and
 * clicking something else first is what opens it.
 */
export class SelectorProblem extends Error {}

/**
 * Somewhere a frame of this tab has arrived, for the navigation policy to judge.
 *
 * Every frame, not only the top one — see {@link CdpPage.onNavigated}. The
 * address is carried with the url because only this class knows which
 * `Network.responseReceived` belongs to which frame, and the gate above needs
 * both halves to say anything about rebinding.
 */
export interface FrameArrival {
  /** Where the frame now is. */
  readonly url: string;
  /**
   * The machine that frame's document was really served from, or `null` when
   * there is nothing to check.
   *
   * `null` is not a pass. It is a `data:` or `about:` document, a frame whose
   * response this page never saw because the frame is its own target, or a
   * frame whose address has been forgotten to the bound above.
   */
  readonly address: string | null;
  /** Whether this is the page's own frame rather than something inside it. */
  readonly top: boolean;
}

/** What CDP calls a console message, in the vocabulary the contract uses. */
const CONSOLE_LEVELS: Readonly<Record<string, ConsoleEntry['level']>> = {
  log: 'log',
  debug: 'debug',
  info: 'info',
  error: 'error',
  warning: 'warn',
  trace: 'log',
  dir: 'log',
  table: 'log',
  assert: 'error',
  verbose: 'debug',
};

/**
 * One attached page target.
 *
 * Created by the manager once a context exists, disposed by it. Every method
 * either answers or throws an `Error` whose message is a sentence — the driver
 * above turns the throw into the contract's refusal, so nothing here has to
 * know what a `DriverResult` is.
 */
export class CdpPage {
  readonly targetId: string;
  readonly browserContextId: string;
  readonly #cdp: CdpConnection;
  readonly #session: string;
  readonly #console: ConsoleEntry[] = [];
  readonly #network: NetworkEntry[] = [];
  /** CDP request id → what was known when it went out, so a finish can be dated. */
  readonly #inFlight = new Map<string, { readonly at: number; readonly started: number; readonly entry: NetworkEntry }>();
  readonly #unsubscribe: (() => void)[] = [];
  /** Resolvers waiting for the next `Page.loadEventFired`. */
  #loadWaiters: (() => void)[] = [];
  /** Resolvers waiting for a navigation to *begin*. See {@link settle}. */
  #startWaiters: (() => void)[] = [];
  #loading = false;
  /** How long to wait, and how. Injected so no test waits in real time. */
  readonly #sleep: (ms: number) => Promise<void>;
  /**
   * The frame with no parent. Captured at {@link start} and kept in step with
   * `Page.frameNavigated`.
   *
   * What it separates is the *page's* load and address from a frame inside it.
   * It is no longer what decides whether the navigation policy runs — every
   * frame is judged now — but a subframe's load is not the page's load and a
   * subframe's remote address is not the page's, and both of those are read off
   * this.
   */
  #topFrameId: string | null = null;
  /**
   * Subframe id → the address that frame's document was served from.
   *
   * The per-frame half of what {@link #mainDocumentAddress} is for the page. A
   * frame is judged on the machine its own document came from, not on the
   * page's: checking a frame's host against the *page's* remote address would
   * be comparing two unrelated things and would refuse pages at random.
   *
   * Bounded by {@link MAX_FRAME_ADDRESSES}, oldest out.
   */
  readonly #frameAddresses = new Map<string, string>();
  /**
   * The address the main document was actually served from, per
   * `Network.responseReceived`.
   *
   * The only thing here that can catch a name which resolved publicly a moment
   * ago and privately by the time Chromium fetched it. `null` when there is
   * nothing to check — a `data:` or `about:` page, or a document with no
   * remote address — and the driver treats `null` as "unknown", not as "fine":
   * see `serverBrowserPolicy.ts` on why that gap is narrow here.
   */
  #mainDocumentAddress: string | null = null;
  /** Told whenever any frame of this tab arrives somewhere new. */
  #onNavigated: ((arrival: FrameArrival) => void) | null = null;

  constructor(options: {
    readonly cdp: CdpConnection;
    readonly sessionId: string;
    readonly targetId: string;
    readonly browserContextId: string;
    /** How to wait. Defaults to a real timer; a test injects its own. */
    readonly sleep?: (ms: number) => Promise<void>;
  }) {
    this.#cdp = options.cdp;
    this.#session = options.sessionId;
    this.targetId = options.targetId;
    this.browserContextId = options.browserContextId;
    this.#sleep =
      options.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }));
  }

  /**
   * Turn on the domains this page reports through, and start listening.
   *
   * Every domain enabled here is one the tools have a verb for. `Network` is
   * the one worth stating: enabling it disables the disk cache for this target,
   * so a page measured through this browser is a cold-cache page. That is the
   * right trade for a browser whose whole purpose is testing what was just
   * built — a warm cache is how a developer fails to notice a broken asset —
   * and it is also why the embedded driver, which the *user* is watching, goes
   * out of its way not to attach a debugger.
   */
  async start(): Promise<void> {
    await this.#call('Page.enable');
    await this.#call('Runtime.enable');
    await this.#call('Log.enable');
    await this.#call('Network.enable');
    /*
     * Out-of-process frames, so the navigation policy can see them.
     * ------------------------------------------------------------------
     *
     * Measured on Chromium 141 (2026-09-22), because the answer decides
     * whether the gate below is a gate at all:
     *
     *  - With site isolation **off** — which is what the headless shell does
     *    by default — a cross-origin iframe stays in the page's own frame
     *    tree and reports `Page.frameNavigated` on this session, carrying a
     *    `parentId`. Nothing else is needed.
     *  - With site isolation **on** — `--site-per-process`, and what the full
     *    Chromium in `docker/browser.Dockerfile` does by default — a
     *    cross-*site* iframe becomes its own target. It reports **no**
     *    `Page.frameNavigated` here and does not appear in
     *    `Page.getFrameTree`. Without this call the policy simply never sees
     *    it, which is a gate that opens itself on the very deployment this
     *    feature ships as.
     *
     * With auto-attach on, that frame arrives as `Target.attachedToTarget`
     * with `type: "iframe"` — measured to carry an empty url at creation and
     * then a `Target.targetInfoChanged` with the real one — and every later
     * navigation of it arrives as a further `targetInfoChanged`. Both are
     * listened for below.
     *
     * `waitForDebuggerOnStart: false`: nothing here debugs a frame, and a
     * frame paused waiting for a client that will never speak to it is a page
     * that never finishes loading. `flatten: true` to stay on one socket, as
     * everywhere else — see `cdp.ts`.
     *
     * Not wrapped in a `try`. A build that cannot do this is a build where a
     * cross-site frame is invisible to the policy, and failing `browser_open`
     * with the browser's own words is the honest outcome — a gate that
     * silently stopped applying is the failure mode this whole file is written
     * against.
     */
    await this.#call('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await this.#call('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    this.#listen();
    // Which frame is the top one, so every later check knows what to ignore.
    // Asked once and then maintained from `Page.frameNavigated`; a failure here
    // leaves it null, and a null top frame makes the checks treat every
    // navigation as the page's own, which is the cautious way round.
    try {
      const tree = (await this.#call('Page.getFrameTree'))['frameTree'] as
        | { frame?: { id?: unknown } }
        | undefined;
      if (typeof tree?.frame?.id === 'string') this.#topFrameId = tree.frame.id;
    } catch {
      /* The checks below cope with not knowing. */
    }
  }

  /**
   * Be told whenever any frame of this tab arrives somewhere new.
   *
   * The seam the navigation policy hangs off. A page can reach an address
   * without any verb being called — a `<meta http-equiv="refresh">`, a
   * `location =` on a timer, a form that posts itself — and a policy that only
   * ran inside `navigate` and `click` would never see it. Registered once by
   * the driver, before the page is sent anywhere.
   *
   * **Every frame, and that is a correction.** This used to return early on a
   * `parentId`, on the reasoning that an advert in an iframe reaching a private
   * address was the network's business. It is not, because the agent can write
   * the iframe: `browser_evaluate` appending
   * `<iframe src="http://169.254.169.254/…">` put a refused address inside the
   * tab where no gate could see it, and `browser_screenshot` renders it and
   * `browser_click` — which aims at viewport coordinates — drives it. See
   * `cdpPageDriver.ts` on what happens to a page one of its frames is refused
   * for, and why refusing it whole is the honest answer here.
   */
  onNavigated(listener: (arrival: FrameArrival) => void): void {
    this.#onNavigated = listener;
  }

  /**
   * The address the main document was served from, or `null` when unknown.
   *
   * See the field's comment: `null` means there is nothing to check, not that
   * the check passed.
   */
  mainDocumentAddress(): string | null {
    return this.#mainDocumentAddress;
  }

  /* ---------------------------------------------------------------- */
  /* Going places                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Go to an address and wait for the load to settle.
   *
   * The wait is armed *before* `Page.navigate` is sent, because a `data:` URL
   * or a cached document can fire `Page.loadEventFired` between the call and
   * the subscription. Arming first turns a race that hangs for twenty seconds
   * into no race at all.
   */
  async navigate(url: string): Promise<void> {
    const settled = this.#awaitLoad();
    let result: Record<string, unknown>;
    try {
      result = await this.#call('Page.navigate', { url });
    } catch (error) {
      /*
       * The call itself failed — the socket died, or the target went away
       * under it. The wait armed a line above is now waiting for a load that
       * cannot happen, and leaving it to its twenty-second timer would make
       * the *next* verb pay for this one's failure. Released before the throw,
       * so `#loading` is false by the time the driver turns this into a
       * sentence.
       */
      this.#releaseLoad();
      throw error;
    }
    const failure = result['errorText'];
    if (typeof failure === 'string' && failure.length > 0) {
      this.#releaseLoad();
      throw new Error(`The browser could not load ${url}: ${failure}.`);
    }
    await settled;
  }

  /**
   * Wait for a load — one already under way, or one about to start.
   *
   * `graceMs` is the fix for a bug this had: a click whose handler navigates
   * does not navigate *synchronously*, so by the time the last `Input.*` call
   * was acknowledged `#loading` was still false and `settle` returned at once.
   * The verb then reported the old address, and — worse, once the policy became
   * event-driven — the check ran against the page the click had just left. So
   * when nothing is loading yet, wait a bounded moment for
   * `Page.frameStartedLoading` before concluding that nothing is going to.
   *
   * Bounded and small: half a second is long enough for a handler to run and
   * short enough that a click which really does nothing does not feel like a
   * hang. The wait itself is injected, so no test spends it.
   */
  async settle(options?: { readonly graceMs?: number }): Promise<void> {
    if (!this.#loading) {
      const grace = options?.graceMs ?? 0;
      if (grace <= 0) return;
      const started = this.#awaitLoadStart();
      await Promise.race([started.begun, this.#sleep(grace)]);
      started.cancel();
      if (!this.#loading) return;
    }
    await this.#awaitLoad();
  }

  /** Where the page is, as the contract states a location. */
  async location(): Promise<PageLocation> {
    const info = (await this.#cdp.call('Target.getTargetInfo', { targetId: this.targetId }))[
      'targetInfo'
    ] as { url?: string; title?: string } | undefined;
    return { url: info?.url ?? '', title: info?.title ?? '' };
  }

  /* ---------------------------------------------------------------- */
  /* Looking                                                           */
  /* ---------------------------------------------------------------- */

  async read(): Promise<PageText> {
    const at = await this.location();
    const text = await this.#evaluateFixed(READ_SCRIPT);
    return { ...at, text: typeof text === 'string' ? text : '', truncated: false };
  }

  /**
   * What the page looks like now.
   *
   * JPEG at quality 70 rather than PNG, and that is a cost decision made once
   * here rather than by each caller. A screenshot is an image in the
   * transcript: the same 1280-wide page is about 45 kB as a JPEG and several
   * hundred as a PNG, and the difference is invisible for the question these
   * are taken to answer (did the layout break, is the button where it should
   * be). `captureBeyondViewport` is left off, so what comes back is the fold —
   * which is what a person would have seen.
   */
  async screenshot(): Promise<PageImage> {
    const result = await this.#call('Page.captureScreenshot', {
      format: 'jpeg',
      quality: SCREENSHOT_QUALITY,
    });
    const data = result['data'];
    if (typeof data !== 'string' || data.length === 0) {
      throw new Error('The browser returned an empty screenshot.');
    }
    return { mimeType: 'image/jpeg', data };
  }

  /* ---------------------------------------------------------------- */
  /* Acting                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Click the first element matching a selector, where a person would click it.
   *
   * The centre of the element's *content box* after scrolling it into view, and
   * a real press and release rather than `el.click()`. A page that checks
   * `isTrusted`, that opens on `pointerdown`, or that has an overlay in the way
   * behaves here the way it behaves for a user — including failing, which is
   * information the agent needs and `el.click()` would have hidden.
   */
  async click(selector: string): Promise<void> {
    const nodeId = await this.#nodeFor(selector);
    await this.#scrollIntoView(nodeId, selector);
    const { x, y } = await this.#centreOf(nodeId, selector);
    const common = { x, y, button: 'left' as const, clickCount: 1, buttons: 1 };
    // Moved to first, because a page whose button reveals itself on hover has
    // nothing under the cursor until the pointer arrives.
    await this.#call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await this.#call('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
    await this.#call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
  }

  /**
   * Replace what is in a field, the way typing into it would.
   *
   * Select the existing contents, then insert — so the field's value is the
   * text and not the text appended to what was there. `Input.insertText` is the
   * IME path: Blink commits it through the editing pipeline, so `beforeinput`
   * and `input` fire exactly once and React, Vue and everything else see the
   * change. Setting `.value` would not, which is the bug the embedded driver's
   * comment describes: the field looks right and the form submits empty.
   *
   * Clearing a field is the Delete key rather than an empty insert, because an
   * empty `insertText` is a no-op and a field that could not be cleared is
   * worse than one that refused to be.
   */
  async type(selector: string, text: string): Promise<void> {
    const nodeId = await this.#nodeFor(selector);
    await this.#scrollIntoView(nodeId, selector);
    try {
      await this.#call('DOM.focus', { nodeId });
    } catch {
      throw new SelectorProblem(
        `${selector} matched an element that cannot take keyboard focus. Click it first, or name the input inside it.`,
      );
    }

    const objectId = await this.#objectFor(nodeId);
    try {
      const kind = await this.#callFunctionOn(objectId, SELECT_ALL_FN);
      if (kind === 'other') {
        throw new SelectorProblem(
          `${selector} is not an input, a textarea or a contenteditable, so there is nothing to type into.`,
        );
      }
      if (text.length > 0) {
        await this.#call('Input.insertText', { text });
      } else {
        await this.#call('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Delete',
          code: 'Delete',
          windowsVirtualKeyCode: 46,
          nativeVirtualKeyCode: 46,
        });
        await this.#call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete' });
      }
      await this.#callFunctionOn(objectId, FIRE_CHANGE_FN);
    } finally {
      // The handle keeps the node alive in the renderer's heap for as long as
      // it exists, which on a page being typed into repeatedly is a leak the
      // memory watchdog would eventually have to clean up.
      await this.#cdp
        .call('Runtime.releaseObject', { objectId }, this.#session)
        .catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------------- */
  /* What a developer opens DevTools for                               */
  /* ---------------------------------------------------------------- */

  /** Console lines and uncaught errors since the last call. Reading empties it. */
  drainConsole(): readonly ConsoleEntry[] {
    return this.#console.splice(0, this.#console.length);
  }

  /**
   * Requests since the last call. Reading empties the buffer.
   *
   * Drained whole and filtered by the caller, never filtered at the source: a
   * `failedOnly` call must not quietly throw away the successful requests a
   * later call without the flag was going to report. Same rule as the embedded
   * driver, and the same definition of failed — a transport failure, or a
   * status of 400 and up.
   */
  drainNetwork(): readonly NetworkEntry[] {
    return this.#network.splice(0, this.#network.length);
  }

  /**
   * The cookies the current page would send.
   *
   * `Network.getCookies` with no `urls` answers for the frames of *this* target
   * only, which is the scoping the verb needs: a browser context may hold
   * another run's cookies and no tool here may reach them. Values are included
   * — this browser is signed in to nothing, so a cookie value is test data.
   */
  async cookies(): Promise<readonly CookieEntry[]> {
    const raw = (await this.#call('Network.getCookies'))['cookies'];
    if (!Array.isArray(raw)) return [];
    return raw.map((one) => {
      const cookie = one as Record<string, unknown>;
      const expires = typeof cookie['expires'] === 'number' ? cookie['expires'] : -1;
      const sameSite = cookie['sameSite'];
      return {
        name: String(cookie['name'] ?? ''),
        value: String(cookie['value'] ?? ''),
        domain: String(cookie['domain'] ?? ''),
        path: String(cookie['path'] ?? '/'),
        // CDP dates a cookie in seconds and uses -1 for a session cookie; the
        // contract wants milliseconds and an absent field.
        ...(expires > 0 ? { expires: Math.round(expires * 1000) } : {}),
        httpOnly: cookie['httpOnly'] === true,
        secure: cookie['secure'] === true,
        ...(sameSite === 'Strict' || sameSite === 'Lax' || sameSite === 'None' ? { sameSite } : {}),
      } satisfies CookieEntry;
    });
  }

  /** Local and session storage for the page's origin. */
  async storage(): Promise<StorageSnapshot> {
    const value = await this.#evaluateFixed(STORAGE_SCRIPT);
    const shape = (value ?? {}) as {
      origin?: unknown;
      local?: Record<string, string>;
      session?: Record<string, string>;
    };
    return {
      origin: typeof shape.origin === 'string' ? shape.origin : '',
      local: shape.local ?? {},
      session: shape.session ?? {},
    };
  }

  /**
   * Run the agent's own expression and return its value.
   *
   * `awaitPromise` so an `async` expression is waited for rather than answered
   * with `{}`, `returnByValue` so what comes back is data and not a handle the
   * agent has no way to dereference, and a timeout because an expression the
   * model wrote may not terminate. An expression whose result cannot be turned
   * into JSON — a DOM node, a function, a circular object — is a refusal
   * naming the shape rather than a silent `undefined`.
   */
  async evaluate(expression: string): Promise<unknown> {
    const result = await this.#call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      timeout: EVALUATE_TIMEOUT_MS,
      // The expression is the agent's, not a user's gesture: a page that gates
      // `window.open` or fullscreen on a real click should keep gating them.
      userGesture: false,
    });
    return readEvaluated(result, 'The expression');
  }

  /* ---------------------------------------------------------------- */
  /* What the watchdog reads                                           */
  /* ---------------------------------------------------------------- */

  /**
   * How much memory this tab is holding, as well as CDP can say.
   *
   * `Runtime.getHeapUsage` is the metric, and the sum of `usedSize` (V8) and
   * `embedderHeapUsedSize` (Blink's Oilpan heap: the DOM, and what hangs off
   * it) is the number the ceiling is compared against. Measured 2026-09-21
   * against Chromium 141:
   *
   *  - `Performance.getMetrics` reports the same V8 figure as `JSHeapUsedSize`,
   *    and requires `Performance.enable` to be on. No extra information for a
   *    domain more to keep enabled.
   *  - `SystemInfo.getProcessInfo` answers, but with **`cpuTime` only** — no
   *    memory figures at all on this build. It is also per *process*, and a
   *    renderer process is shared between same-site targets, so it could not
   *    attribute anything to a tab even if it carried the number.
   *  - `Memory.getDOMCounters` counts nodes, not bytes.
   *
   * So this is a floor, not the tab's resident size: it counts neither the
   * renderer's own overhead nor decoded images nor compositing surfaces, which
   * on a heavy page are most of it. That is why this is the *second* line of
   * defence and the container's memory limit is the first — see
   * `serverBrowser.ts` and the compose file.
   */
  async memoryBytes(): Promise<number> {
    const usage = await this.#call('Runtime.getHeapUsage');
    const js = typeof usage['usedSize'] === 'number' ? usage['usedSize'] : 0;
    const dom = typeof usage['embedderHeapUsedSize'] === 'number' ? usage['embedderHeapUsedSize'] : 0;
    return js + dom;
  }

  /**
   * Is this the page's own frame, rather than something inside it?
   *
   * A frame id this page has never heard of counts as the top one. Not
   * carelessness: `Page.getFrameTree` can fail at startup, and a check that
   * silently stopped applying because the id was unknown would be a gate that
   * opened itself. Erring towards "this is the page" costs at worst a refusal
   * the agent can read.
   */
  #isTopFrame(frameId: unknown): boolean {
    if (this.#topFrameId === null) return true;
    return typeof frameId !== 'string' || frameId === this.#topFrameId;
  }

  /** Stop listening. The target itself is the manager's to close. */
  detach(): void {
    for (const off of this.#unsubscribe.splice(0, this.#unsubscribe.length)) off();
    this.#releaseLoad();
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  async #call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.#cdp.call(method, params, this.#session);
  }

  /** Run one of this file's own scripts and return its value. */
  async #evaluateFixed(expression: string): Promise<unknown> {
    const result = await this.#call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    return readEvaluated(result, 'The page');
  }

  /**
   * The first element matching a selector, or a sentence saying it is not there.
   *
   * `DOM.getDocument` before every query rather than once: a navigation
   * invalidates every node id the protocol has handed out, and a cached root
   * from before a click that navigated produces "Could not find node with given
   * id" — an error about the protocol where the agent needed one about the page.
   */
  async #nodeFor(selector: string): Promise<number> {
    const root = (await this.#call('DOM.getDocument', { depth: 0 }))['root'] as
      | { nodeId?: number }
      | undefined;
    const rootId = root?.nodeId;
    if (typeof rootId !== 'number') throw new Error('The page has no document to search.');

    let nodeId: unknown;
    try {
      nodeId = (await this.#call('DOM.querySelector', { nodeId: rootId, selector }))['nodeId'];
    } catch (error) {
      // An invalid selector is the model's typo, and Chromium's own message
      // names the character it stopped at — more useful than anything written
      // here would be.
      throw new SelectorProblem(
        `${selector} is not a usable CSS selector: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof nodeId !== 'number' || nodeId === 0) {
      throw new SelectorProblem(`Nothing matches ${selector} on this page.`);
    }
    return nodeId;
  }

  async #scrollIntoView(nodeId: number, selector: string): Promise<void> {
    try {
      await this.#call('DOM.scrollIntoViewIfNeeded', { nodeId });
    } catch (error) {
      // Chromium answers "Node is detached from document" or "Node does not
      // have a layout object" here, both of which mean the same thing to the
      // agent: it is in the markup and it is not on the screen.
      throw new SelectorProblem(
        `${selector} matches an element that is not visible on the page (${
          error instanceof Error ? error.message : String(error)
        }). Something may need to be opened or expanded first.`,
      );
    }
  }

  /** The centre of an element's content box, in viewport coordinates. */
  async #centreOf(nodeId: number, selector: string): Promise<{ x: number; y: number }> {
    let box: { content?: number[] } | undefined;
    try {
      box = (await this.#call('DOM.getBoxModel', { nodeId }))['model'] as { content?: number[] };
    } catch {
      throw new SelectorProblem(
        `${selector} matches an element with no box on the page — it is hidden, or has no size. Something may need to be opened or expanded first.`,
      );
    }
    const quad = box?.content;
    if (!Array.isArray(quad) || quad.length < 8) {
      throw new SelectorProblem(`${selector} matches an element with no box on the page.`);
    }
    const xs = [quad[0], quad[2], quad[4], quad[6]].map((n) => Number(n));
    const ys = [quad[1], quad[3], quad[5], quad[7]].map((n) => Number(n));
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    if (width <= 0 || height <= 0) {
      throw new SelectorProblem(
        `${selector} matches an element with no size on the page, so there is nowhere to click.`,
      );
    }
    return {
      x: xs.reduce((sum, n) => sum + n, 0) / 4,
      y: ys.reduce((sum, n) => sum + n, 0) / 4,
    };
  }

  async #objectFor(nodeId: number): Promise<string> {
    const object = (await this.#call('DOM.resolveNode', { nodeId }))['object'] as
      | { objectId?: string }
      | undefined;
    const objectId = object?.objectId;
    if (typeof objectId !== 'string') throw new Error('The browser could not reach that element.');
    return objectId;
  }

  async #callFunctionOn(objectId: string, declaration: string): Promise<unknown> {
    const result = await this.#call('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: declaration,
      returnByValue: true,
    });
    return readEvaluated(result, 'The page');
  }

  /* ---------------------------------------------------------------- */
  /* Waiting for a load                                                */
  /* ---------------------------------------------------------------- */

  #awaitLoad(): Promise<void> {
    this.#loading = true;
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#loadWaiters = this.#loadWaiters.filter((one) => one !== done);
        this.#loading = false;
        resolve();
      };
      const timer = setTimeout(done, LOAD_TIMEOUT_MS);
      timer.unref?.();
      this.#loadWaiters.push(done);
    });
  }

  /**
   * A promise that settles when a navigation *begins*, and a way to stop
   * waiting for one.
   *
   * Separate from {@link #awaitLoad} because the two answer different
   * questions — "has anything started?" against "has it finished?" — and
   * {@link settle} needs the first before it may ask the second.
   */
  #awaitLoadStart(): { readonly begun: Promise<void>; readonly cancel: () => void } {
    let done = (): void => undefined;
    const begun = new Promise<void>((resolve) => {
      done = resolve;
      this.#startWaiters.push(resolve);
    });
    return {
      begun,
      cancel: () => {
        this.#startWaiters = this.#startWaiters.filter((one) => one !== done);
      },
    };
  }

  #releaseLoad(): void {
    this.#loading = false;
    for (const waiter of this.#loadWaiters.splice(0, this.#loadWaiters.length)) waiter();
  }

  /* ---------------------------------------------------------------- */
  /* Recording                                                         */
  /* ---------------------------------------------------------------- */

  #listen(): void {
    const on = (method: string, listener: (params: Record<string, unknown>) => void): void => {
      this.#unsubscribe.push(this.#cdp.on(method, listener, this.#session));
    };

    on('Page.loadEventFired', () => {
      this.#releaseLoad();
    });

    /*
     * Loading is a property of the *top* frame, and reading it off any frame
     * was a bug with a twenty-second price.
     *
     * `Page.frameStartedLoading` arrives for every frame on the page; the two
     * things that clear the flag do not. `Page.loadEventFired` is the page's
     * own load and carries no frame id, and the timer inside {@link #awaitLoad}
     * is twenty seconds long. So an iframe that started loading *after* the
     * main document had finished — a lazy embed, an advert, a frame some
     * analytics script injects — left `#loading` true with nothing on the way
     * to clear it, and every later verb's {@link settle} waited out the full
     * twenty seconds before reporting. The grace path made it worse rather
     * than better: `#startWaiters` fired for that frame too, so a click on
     * such a page resolved its grace and then stalled anyway.
     *
     * `Page.frameStoppedLoading` is subscribed as a second way out, for the
     * top frame only and for the same reason. It is not redundant with
     * `loadEventFired`: a navigation that commits and then stops without ever
     * firing `load` — one the page replaces, or a document that ends in an
     * error — produces the second and not the first.
     */
    on('Page.frameStartedLoading', (params) => {
      const frameId = params['frameId'];
      if (!this.#isTopFrame(frameId)) {
        // The same reasoning as the top frame's, one frame down: where a frame
        // was served from last time is not an answer about where it is going.
        if (typeof frameId === 'string') this.#frameAddresses.delete(frameId);
        return;
      }
      // A click that navigates: `settle` has something to wait for without the
      // verb having to know a navigation happened.
      this.#loading = true;
      for (const waiter of this.#startWaiters.splice(0, this.#startWaiters.length)) waiter();
      /*
       * The last page's remote address stops being an answer about this one.
       * Cleared here rather than on arrival because a navigation that never
       * produces a document — one that fails, or is cancelled — would otherwise
       * leave the previous page's address to be checked against the new page's
       * name, and refuse a page for where a different one was served from.
       */
      this.#mainDocumentAddress = null;
      // A new document in the top frame means every frame that was inside the
      // old one is gone, and so is anything known about where they came from.
      this.#frameAddresses.clear();
    });
    on('Page.frameStoppedLoading', (params) => {
      if (!this.#isTopFrame(params['frameId'])) return;
      this.#releaseLoad();
    });

    /*
     * Where a frame of this tab has arrived, whoever sent it there.
     *
     * Both events, because they are two different ways to change the address
     * and only one of them loads a document: `frameNavigated` is a real
     * navigation, `navigatedWithinDocument` is `history.pushState` and a
     * fragment change. A single-page application moving from `/orders` to
     * `/admin` fires only the second, and a policy that watched only the first
     * would never see it.
     *
     * Subframes included. They carry a `parentId`, which is how the top frame
     * is still told apart — what it is told apart *for* is which load and which
     * remote address belong to the page, not for deciding whether the policy
     * runs. See {@link onNavigated} on why the earlier early-return was wrong.
     */
    on('Page.frameNavigated', (params) => {
      const frame = (params['frame'] ?? {}) as { id?: unknown; parentId?: unknown; url?: unknown };
      const inside = typeof frame.parentId === 'string' && frame.parentId.length > 0;
      if (!inside && typeof frame.id === 'string') this.#topFrameId = frame.id;
      if (typeof frame.url !== 'string' || frame.url.length === 0) return;
      this.#onNavigated?.({
        url: frame.url,
        address: inside
          ? (typeof frame.id === 'string' ? this.#frameAddresses.get(frame.id) ?? null : null)
          : this.#mainDocumentAddress,
        top: !inside,
      });
    });

    on('Page.navigatedWithinDocument', (params) => {
      const top = this.#isTopFrame(params['frameId']);
      if (typeof params['url'] !== 'string' || params['url'].length === 0) return;
      const frameId = params['frameId'];
      this.#onNavigated?.({
        url: params['url'],
        address: top
          ? this.#mainDocumentAddress
          : (typeof frameId === 'string' ? this.#frameAddresses.get(frameId) ?? null : null),
        top,
      });
    });

    /*
     * The frames that are their own target.
     *
     * Under site isolation a cross-site iframe is an out-of-process frame and
     * says nothing on this session's `Page` domain — see {@link start} for the
     * measurement. What it does produce, once auto-attach is on, is these two:
     * an attach carrying the target's url (empty at creation) and a change
     * carrying it afterwards and on every later navigation of that frame.
     *
     * No address to go with it. Chromium reports `remoteIPAddress` on the
     * session the document loaded in, which for one of these is the frame's
     * own, and `Network.enable` is not on there. So an out-of-process frame is
     * judged on its name and on the metadata list — which is the half that has
     * no switch, and the half the agent-written `<iframe>` runs into.
     */
    const outOfProcessFrame = (params: Record<string, unknown>): void => {
      const info = params['targetInfo'] as { type?: unknown; url?: unknown } | undefined;
      if (info?.type !== 'iframe') return;
      if (typeof info.url !== 'string' || info.url.length === 0) return;
      this.#onNavigated?.({ url: info.url, address: null, top: false });
    };
    on('Target.attachedToTarget', outOfProcessFrame);
    on('Target.targetInfoChanged', outOfProcessFrame);

    on('Runtime.consoleAPICalled', (params) => {
      const args = Array.isArray(params['args']) ? (params['args'] as Record<string, unknown>[]) : [];
      const text = args.map((arg) => describeRemote(arg)).join(' ');
      const source = frameOf(params['stackTrace']);
      push(
        this.#console,
        {
          level: CONSOLE_LEVELS[String(params['type'])] ?? 'log',
          text,
          ...(source === null ? {} : { source }),
          at: msOf(params['timestamp']),
        },
        MAX_CONSOLE,
      );
    });

    on('Runtime.exceptionThrown', (params) => {
      const details = (params['exceptionDetails'] ?? {}) as Record<string, unknown>;
      const thrown = details['exception'] as Record<string, unknown> | undefined;
      const text =
        (typeof thrown?.['description'] === 'string' ? thrown['description'] : undefined) ??
        (typeof details['text'] === 'string' ? details['text'] : 'An uncaught error.');
      const source = frameOf(details['stackTrace']) ?? urlOf(details);
      push(
        this.#console,
        {
          // The contract has a level for this and Electron cannot produce one —
          // see `embeddedPageDriver.ts`'s note. CDP reports the exception
          // separately from the console, so the server browser can.
          level: 'exception',
          text,
          ...(source === null ? {} : { source }),
          at: msOf(params['timestamp']),
        },
        MAX_CONSOLE,
      );
    });

    on('Log.entryAdded', (params) => {
      const entry = (params['entry'] ?? {}) as Record<string, unknown>;
      // The browser's own log: a blocked mixed-content load, a CSP violation, a
      // 404 on a subresource. None of it reaches `console.*`, and all of it is
      // the answer to "why is the page blank".
      const level = String(entry['level']);
      push(
        this.#console,
        {
          level: level === 'warning' ? 'warn' : level === 'error' ? 'error' : level === 'verbose' ? 'debug' : 'info',
          text: `[${String(entry['source'] ?? 'browser')}] ${String(entry['text'] ?? '')}`,
          // One-based, as `frameOf` renders a stack frame and as an editor
          // counts: CDP's line numbers are zero-based everywhere.
          ...(typeof entry['url'] === 'string' && entry['url'].length > 0
            ? { source: `${entry['url']}:${String(Number(entry['lineNumber'] ?? 0) + 1)}` }
            : {}),
          at: msOf(entry['timestamp']),
        },
        MAX_CONSOLE,
      );
    });

    on('Network.requestWillBeSent', (params) => {
      const request = (params['request'] ?? {}) as Record<string, unknown>;
      const id = String(params['requestId']);
      this.#inFlight.set(id, {
        at: msOf(params['wallTime'], 's'),
        started: Number(params['timestamp'] ?? 0),
        entry: {
          method: String(request['method'] ?? 'GET'),
          url: String(request['url'] ?? ''),
          ...(typeof params['type'] === 'string' ? { resourceType: params['type'] } : {}),
          at: msOf(params['wallTime'], 's'),
        },
      });
      // A request that never finishes would otherwise be remembered for the
      // life of the tab. The oldest is the one least likely still to be in
      // flight, and losing it costs a duration on one line of a listing.
      if (this.#inFlight.size > MAX_IN_FLIGHT) {
        const oldest = this.#inFlight.keys().next();
        if (oldest.done !== true) this.#inFlight.delete(oldest.value);
      }
    });

    on('Network.responseReceived', (params) => {
      const response = (params['response'] ?? {}) as Record<string, unknown>;

      /*
       * The address the main document really came from.
       *
       * Recorded here and nowhere else, because this is the one place Chromium
       * says which machine it actually talked to. A name resolves before the
       * fetch and can resolve differently during it, so the lookup the driver
       * did is a statement about the past; this is a statement about what
       * happened. On a redirect chain only the final response arrives as a
       * `responseReceived`, which is the one that matters.
       *
       * An empty address — a `data:` page, or one served from a cache that
       * `Network.enable` has already disabled for this tab — records `null`,
       * which the driver reads as "nothing to check" rather than as a pass.
       */
      if (params['type'] === 'Document') {
        const raw = response['remoteIPAddress'];
        const remote =
          typeof raw === 'string' && raw.length > 0 ? raw.replace(/^\[|\]$/gu, '') : null;
        const frameId = params['frameId'];
        if (this.#isTopFrame(frameId)) {
          this.#mainDocumentAddress = remote;
        } else if (typeof frameId === 'string') {
          /*
           * A frame's own address, kept so that a frame is judged on the
           * machine *it* talked to. This is what closes rebinding one frame
           * down: a public name in an `<iframe src>` that resolves into private
           * space by the time Chromium fetches it is refused here for the same
           * reason the page would be.
           */
          if (remote === null) this.#frameAddresses.delete(frameId);
          else this.#frameAddresses.set(frameId, remote);
          if (this.#frameAddresses.size > MAX_FRAME_ADDRESSES) {
            const oldest = this.#frameAddresses.keys().next();
            if (oldest.done !== true) this.#frameAddresses.delete(oldest.value);
          }
        }
      }

      const held = this.#inFlight.get(String(params['requestId']));
      if (held === undefined) return;
      this.#inFlight.set(String(params['requestId']), {
        ...held,
        entry: {
          ...held.entry,
          ...(typeof response['status'] === 'number' ? { status: response['status'] } : {}),
          ...(typeof params['type'] === 'string' ? { resourceType: params['type'] } : {}),
        },
      });
    });

    on('Network.loadingFinished', (params) => {
      this.#finish(String(params['requestId']), Number(params['timestamp'] ?? 0), undefined);
    });

    on('Network.loadingFailed', (params) => {
      const cancelled = params['canceled'] === true;
      const reason = String(params['errorText'] ?? 'the request failed');
      // A cancelled request is what a navigation the agent replaced looks like,
      // and the embedded driver drops the same case for the same reason: it is
      // not a failure and reporting it teaches the agent to chase nothing.
      if (cancelled && reason === 'net::ERR_ABORTED') {
        this.#inFlight.delete(String(params['requestId']));
        return;
      }
      this.#finish(String(params['requestId']), Number(params['timestamp'] ?? 0), reason);
    });
  }

  #finish(requestId: string, at: number, failure: string | undefined): void {
    const held = this.#inFlight.get(requestId);
    this.#inFlight.delete(requestId);
    if (held === undefined) return;
    push(
      this.#network,
      {
        ...held.entry,
        ...(failure === undefined ? {} : { failure }),
        // Both ends of this subtraction are CDP's monotonic seconds; the `at`
        // the entry carries is wall time. See the file header.
        ...(at > 0 && held.started > 0
          ? { durationMs: Math.max(0, Math.round((at - held.started) * 1000)) }
          : {}),
      },
      MAX_NETWORK,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Reading what the page answered                                             */
/* -------------------------------------------------------------------------- */

/**
 * The value of a `Runtime.evaluate` or `Runtime.callFunctionOn`, or a sentence.
 *
 * Three ways one can go wrong and they read differently to an agent: the page
 * threw, the value cannot cross the protocol, or the call itself failed. Only
 * the first two are here; the third is the rejection of the CDP call.
 */
function readEvaluated(result: Record<string, unknown>, subject: string): unknown {
  const details = result['exceptionDetails'] as Record<string, unknown> | undefined;
  if (details !== undefined) {
    const thrown = details['exception'] as Record<string, unknown> | undefined;
    const message =
      (typeof thrown?.['description'] === 'string' ? thrown['description'] : undefined) ??
      (typeof details['text'] === 'string' ? details['text'] : 'threw an error');
    throw new Error(`${subject} threw: ${message}`);
  }
  const remote = (result['result'] ?? {}) as Record<string, unknown>;
  if (remote['type'] === 'undefined') return undefined;
  /*
   * What Chromium actually does with a value that will not serialise, measured
   * against 141, because it is not what the protocol documentation suggests:
   *
   *  - a circular object and a `Symbol` come back as CDP **errors** ("Object
   *    reference chain is too long", "Object couldn't be returned by value"),
   *    so they are rejections of the call and never reach here;
   *  - a DOM node comes back as `{type: 'object', value: {}}` — with no
   *    `subtype` at all under `returnByValue`, so it is indistinguishable from
   *    an empty object and `{}` is the honest answer to give for it;
   *  - a function comes back with an `objectId` and no `value`, which is this
   *    branch.
   */
  if (!('value' in remote)) {
    const kind = typeof remote['subtype'] === 'string' ? remote['subtype'] : String(remote['type'] ?? 'value');
    throw new Error(
      `${subject} produced a ${kind}, which cannot be returned as data. Return something JSON can hold — a string, a number, or a plain object.`,
    );
  }
  return remote['value'];
}

/** A console argument as text, without asking the page for anything more. */
function describeRemote(arg: Record<string, unknown>): string {
  if ('value' in arg) {
    const value = arg['value'];
    return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  }
  if (typeof arg['description'] === 'string') return arg['description'];
  if (arg['type'] === 'undefined') return 'undefined';
  const preview = arg['preview'] as { description?: unknown } | undefined;
  if (typeof preview?.description === 'string') return preview.description;
  return String(arg['type'] ?? '');
}

/** Script and line of the top frame of a CDP stack trace, when there is one. */
function frameOf(stack: unknown): string | null {
  const frames = (stack as { callFrames?: unknown } | undefined)?.callFrames;
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const top = frames[0] as { url?: unknown; lineNumber?: unknown };
  if (typeof top.url !== 'string' || top.url.length === 0) return null;
  return `${top.url}:${String(Number(top.lineNumber ?? 0) + 1)}`;
}

function urlOf(details: Record<string, unknown>): string | null {
  if (typeof details['url'] !== 'string' || details['url'].length === 0) return null;
  return `${details['url']}:${String(Number(details['lineNumber'] ?? 0) + 1)}`;
}

/**
 * A CDP timestamp as milliseconds since the epoch.
 *
 * CDP is not consistent about this and the inconsistency is worth naming.
 * `Runtime`'s timestamps are already epoch **milliseconds**; `Log.entryAdded`'s
 * is the same; `Network`'s `wallTime` is epoch **seconds**; `Network`'s
 * `timestamp` is monotonic seconds and is never a date. Anything that does not
 * look like a plausible date falls back to now, because a listing sorted by a
 * timestamp from 1970 is a listing the agent cannot read.
 */
function msOf(value: unknown, unit: 'ms' | 's' = 'ms'): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return Date.now();
  const ms = unit === 's' ? raw * 1000 : raw;
  // Anything before 2001 is not a wall clock; it is a monotonic counter.
  return ms > 978_307_200_000 ? Math.round(ms) : Date.now();
}
