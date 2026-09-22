/**
 * The server browser, against a Chromium that is only a record of what was
 * asked.
 * ============================================================================
 *
 * The driver, the page and the manager are exercised together over a fake CDP
 * endpoint — a transport that answers the protocol rather than a mock of each
 * class — because the interesting behaviour lives between them: a refusal is
 * decided by the driver from a sentence the page threw, and a tab closing for
 * being idle is decided by the manager and reported by the driver on a later
 * call. Testing them apart would test three things and prove none of them.
 *
 * Four things are pinned here.
 *
 *  - **Every verb sends the protocol messages a person's action would send.**
 *    A click is `Input.dispatchMouseEvent` at the element's box, not
 *    `el.click()`; typing replaces what is there and tells the application.
 *  - **A refusal is a sentence.** Nothing throws at the tool surface, and every
 *    no says what to do next.
 *  - **The navigation policy is checked twice**, and the second check is the
 *    one that matters: a public address that redirects to a private one is the
 *    attack the first check cannot see.
 *  - **Every lifecycle rule fires, on an injected clock.** Idle close, the
 *    context cap, the memory watchdog, the sweep, the idle exit and the
 *    reconnect after it. No test here waits for anything.
 *
 * The real Chromium is exercised separately — see `cdpBrowser.integration.test.ts`,
 * which skips itself where there is no browser to drive.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { hostOf, type PageDriver } from '@rx-artemis/protocol';

import type { CdpTransport } from './cdp.js';
import { MAX_ENTRY_CHARS } from './pageTools.js';
import { createServerBrowser, type BrowserTimers, type ServerBrowser } from './serverBrowser.js';
import { isAddressLiteral } from './serverBrowserPolicy.js';

/**
 * The frame every page in this file lives in.
 *
 * A constant because the checks under test all turn on "is this the top
 * frame?", and a test that let the id drift would pass for the wrong reason.
 */
const TOP_FRAME = 'frame-top';

/** What a name resolves to when a test has not said otherwise: a public address. */
const DEFAULT_ADDRESSES: readonly string[] = ['203.0.113.10'];

/**
 * The resolver, as the tests control it.
 *
 * Every name resolves somewhere public unless a test puts it here, and a name
 * mapped to `null` fails to resolve at all. DNS is the whole of the second gate
 * now, so a suite that reached the real resolver would be a suite whose results
 * depended on the machine it ran on.
 */
let dns: Map<string, readonly string[] | null>;

/* -------------------------------------------------------------------------- */
/* A Chromium that is only a record of what was asked                         */
/* -------------------------------------------------------------------------- */

interface FakeElement {
  /** The element's content quad, as CDP reports one. */
  readonly box?: readonly number[];
  /** What `SELECT_ALL_FN` would answer for it. */
  readonly kind?: 'field' | 'editable' | 'other';
  /** Scrolling it into view fails, which is what a hidden element does. */
  readonly hidden?: boolean;
}

class FakeChromium {
  readonly calls: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  readonly contexts = new Set<string>();
  readonly targets = new Map<
    string,
    { contextId: string | null; url: string; title: string; type?: string }
  >();
  readonly sessions = new Map<string, string>();

  /** What the page answers with. */
  text = 'Orders\nNothing here yet.';
  title = 'Orders';
  heapBytes = 4 * 1024 * 1024;
  domBytes = 1024 * 1024;
  cookies: Record<string, unknown>[] = [];
  storage = { origin: 'https://example.com', local: { token: 'abc' }, session: {} };
  elements = new Map<string, FakeElement>();
  /** Where a navigation actually ends up, when it is not where it was aimed. */
  redirects = new Map<string, string>();
  /** A navigation that fails outright, as `Page.navigate`'s `errorText`. */
  navigationFailures = new Map<string, string>();
  /** A `Page.navigate` the browser rejects rather than answers. See the case below. */
  navigationErrors = new Map<string, string>();
  /** Methods this browser accepts and never replies to. See {@link #handle}. */
  neverAnswers = new Set<string>();
  evaluated: (expression: string) => Record<string, unknown> = () => ({
    result: { type: 'string', value: 'ok' },
  });

  browserClosed = false;
  purged = 0;
  /** Set to refuse the next dial, so a reconnect can be watched. */
  refuseDials = 0;
  /**
   * Called as each message is answered, before the reply is sent.
   *
   * The seam for testing a race: whatever this does happens while the caller is
   * still waiting, which is the only way to put a maintenance pass inside a
   * half-finished `openFor`.
   */
  onCall: ((method: string, params: Record<string, unknown>) => void) | null = null;

  #nextId = 1;
  #onMessage: ((message: string) => void) | null = null;
  #onClose: (() => void) | null = null;
  #live = true;

  /** A target this server does not own, as a crashed predecessor would leave. */
  addStrayTarget(contextId: string | null = 'ctx-stray'): string {
    const id = `target-stray-${String(this.#nextId++)}`;
    this.targets.set(id, { contextId, url: 'https://left-behind.example/', title: 'Left behind' });
    if (contextId !== null) this.contexts.add(contextId);
    return id;
  }

  /**
   * A frame that is its own target, as site isolation makes of a cross-site
   * iframe.
   *
   * It shares the `browserContextId` of the page that holds it — measured on
   * Chromium 141 — which is the fact the sweep's ownership rule turns on.
   */
  addFrameTarget(contextId: string | null): string {
    const id = `target-frame-${String(this.#nextId++)}`;
    this.targets.set(id, {
      contextId,
      url: 'https://widget.example/embed',
      title: '',
      type: 'iframe',
    });
    if (contextId !== null) this.contexts.add(contextId);
    return id;
  }

  dial(): CdpTransport {
    if (this.refuseDials > 0) {
      this.refuseDials -= 1;
      throw new Error('Could not connect to the browser.');
    }
    this.#live = true;
    this.browserClosed = false;
    return {
      send: (message) => {
        this.#handle(JSON.parse(message) as Record<string, unknown>);
      },
      close: () => {
        this.#live = false;
      },
      onMessage: (listener) => {
        this.#onMessage = listener;
      },
      onClose: (listener) => {
        this.#onClose = listener;
      },
    };
  }

  /** The socket dies under whoever is holding it. */
  drop(): void {
    this.#live = false;
    this.#onClose?.();
  }

  emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.#send({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });
  }

  /** Every session open on this browser, in the order they were attached. */
  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  called(method: string): Record<string, unknown>[] {
    return this.calls.filter((one) => one.method === method).map((one) => one.params);
  }

  #send(message: Record<string, unknown>): void {
    if (!this.#live) return;
    this.#onMessage?.(JSON.stringify(message));
  }

  #handle(message: Record<string, unknown>): void {
    const method = String(message['method']);
    const params = (message['params'] ?? {}) as Record<string, unknown>;
    const sessionId = message['sessionId'] as string | undefined;
    this.calls.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });

    /*
     * A call the browser never answers at all.
     *
     * Measured on Chromium 141: `Runtime.evaluate` with `awaitPromise` on a
     * promise that never settles is exactly this — `timeout` bounds execution
     * and not the wait, so nothing ever comes back. This is how that is stood
     * in for, and the reply is withheld rather than delayed because a delay is
     * a race and this is not.
     */
    if (this.neverAnswers.has(method)) return;

    let result: Record<string, unknown> | Error;
    try {
      result = this.#answer(method, params, sessionId);
    } catch (error) {
      result = error instanceof Error ? error : new Error(String(error));
    }
    this.onCall?.(method, params);
    // Asynchronously, as a socket would, so a caller that did not await is not
    // quietly serialised by the fake.
    queueMicrotask(() => {
      if (result instanceof Error) {
        this.#send({ id: message['id'], error: { message: result.message } });
      } else {
        this.#send({ id: message['id'], result });
      }
      this.#after(method, params, sessionId);
    });
  }

  /**
   * What a real browser does a beat after answering.
   *
   * Two cases, and the second is the one that used to be missed: a navigation
   * the *page* started. A click handler calling `location.assign` navigates
   * after the mouse events have been acknowledged, so a verb that asked "is
   * anything loading?" the instant the last `Input.*` call returned was told
   * no.
   */
  #after(method: string, params: Record<string, unknown>, sessionId: string | undefined): void {
    if (sessionId === undefined) return;

    if (method === 'Page.navigate') {
      const url = String(params['url']);
      if (this.navigationFailures.has(url) || this.navigationErrors.has(url)) return;
      const sameDocument = this.sameDocumentOn.get(url);
      if (sameDocument !== undefined) {
        queueMicrotask(() => {
          this.arriveWithinDocumentAt(url, sameDocument, sessionId);
        });
        return;
      }
      queueMicrotask(() => {
        this.arriveAt(this.redirects.get(url) ?? url, sessionId);
      });
      return;
    }

    if (
      method === 'Input.dispatchMouseEvent' &&
      params['type'] === 'mouseReleased' &&
      this.navigatesOnClick !== null
    ) {
      const to = this.navigatesOnClick;
      this.navigatesOnClick = null;
      queueMicrotask(() => {
        this.arriveAt(to, sessionId);
      });
    }
  }

  /** Where the page goes next, and the events Chromium sends on the way. */
  navigatesOnClick: string | null = null;

  /**
   * Addresses a `Page.navigate` reaches without loading anything: url → frame.
   *
   * A fragment on the page already open. See {@link arriveWithinDocumentAt} for
   * what Chromium was measured to send for one, and for the event this fake
   * deliberately leaves out.
   */
  sameDocumentOn = new Map<string, string>();

  /**
   * A same-document arrival, as Chromium 141 sends one — minus one event.
   *
   * Measured: `frameStartedNavigating`, `frameStartedLoading`,
   * `navigatedWithinDocument`, `frameStoppedLoading`, and never a
   * `loadEventFired` or a `frameNavigated`. `frameStoppedLoading` is withheld
   * here on purpose: on that build it would end the wait by itself, which would
   * make a test that used it pass for a reason that is a property of one
   * browser rather than of this driver.
   */
  arriveWithinDocumentAt(url: string, frameId: string, sessionId: string): void {
    const target = this.sessions.get(sessionId);
    if (target !== undefined) {
      this.targets.set(target, {
        contextId: this.targets.get(target)?.contextId ?? null,
        url,
        title: this.title,
      });
    }
    this.emit('Page.frameStartedLoading', { frameId }, sessionId);
    this.emit('Page.navigatedWithinDocument', { frameId, url }, sessionId);
  }

  /**
   * The events one arrival produces, in Chromium's own order.
   *
   * The order is load-bearing: the main document's response carries the address
   * it came from, and it has to be recorded before `frameNavigated` asks
   * whether the page may be where it is.
   */
  arriveAt(url: string, sessionId: string): void {
    const target = this.sessions.get(sessionId);
    if (target !== undefined) {
      this.targets.set(target, {
        contextId: this.targets.get(target)?.contextId ?? null,
        url,
        title: url === 'about:blank' ? '' : this.title,
      });
    }
    this.emit('Page.frameStartedLoading', { frameId: TOP_FRAME }, sessionId);
    if (url !== 'about:blank') {
      this.emit(
        'Network.responseReceived',
        {
          requestId: `doc-${String(this.#nextId++)}`,
          type: 'Document',
          frameId: TOP_FRAME,
          response: { status: 200, remoteIPAddress: this.servedFrom(url) },
        },
        sessionId,
      );
    }
    this.emit('Page.frameNavigated', { frame: { id: TOP_FRAME, url } }, sessionId);
    this.emit('Page.loadEventFired', { timestamp: 1 }, sessionId);
    // After the load event, as Chromium sends it: measured on 141, the top
    // frame's `frameStoppedLoading` follows `loadEventFired` by a millisecond,
    // which is what makes it safe as a second way to clear the wait.
    this.emit('Page.frameStoppedLoading', { frameId: TOP_FRAME }, sessionId);
  }

  /**
   * A frame *inside* the page arriving somewhere, in the same order.
   *
   * The response first, because it carries the address that frame's document
   * was served from and the policy reads it when `frameNavigated` asks. The
   * frame keeps its own `frameStartedLoading` and `frameStoppedLoading`, which
   * is the pair the page's own load must not be confused by.
   */
  frameArrivesAt(
    url: string,
    sessionId: string,
    options?: { readonly frameId?: string; readonly servedFrom?: string },
  ): void {
    const frameId = options?.frameId ?? 'frame-inside';
    this.emit('Page.frameStartedLoading', { frameId }, sessionId);
    this.emit(
      'Network.responseReceived',
      {
        requestId: `sub-${String(this.#nextId++)}`,
        type: 'Document',
        frameId,
        response: { status: 200, remoteIPAddress: options?.servedFrom ?? this.servedFrom(url) },
      },
      sessionId,
    );
    this.emit('Page.frameNavigated', { frame: { id: frameId, parentId: TOP_FRAME, url } }, sessionId);
    this.emit('Page.frameStoppedLoading', { frameId }, sessionId);
  }

  /**
   * The address a page was actually served from.
   *
   * Defaults to the address its name resolves to, which is what a browser
   * without an attacker in it would report. A test that wants the two to
   * disagree — which is what DNS rebinding *is* — sets {@link servedFromOverride}.
   */
  servedFrom(url: string): string {
    const override = this.servedFromOverride.get(url);
    if (override !== undefined) return override;
    const host = hostOf(url)?.host ?? '';
    if (isAddressLiteral(host)) return host;
    return (dns.get(host) ?? DEFAULT_ADDRESSES)[0] ?? '';
  }

  /** url → the address Chromium says it really talked to. See {@link servedFrom}. */
  servedFromOverride = new Map<string, string>();

  #answer(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): Record<string, unknown> {
    switch (method) {
      case 'Target.createBrowserContext': {
        const id = `ctx-${String(this.#nextId++)}`;
        this.contexts.add(id);
        return { browserContextId: id };
      }
      case 'Target.createTarget': {
        const id = `target-${String(this.#nextId++)}`;
        this.targets.set(id, {
          contextId: (params['browserContextId'] as string | undefined) ?? null,
          url: 'about:blank',
          title: '',
        });
        return { targetId: id };
      }
      case 'Target.attachToTarget': {
        const id = `session-${String(this.#nextId++)}`;
        this.sessions.set(id, String(params['targetId']));
        return { sessionId: id };
      }
      case 'Target.getTargetInfo': {
        const target = this.targets.get(String(params['targetId']));
        return { targetInfo: { url: target?.url ?? '', title: target?.title ?? '' } };
      }
      case 'Target.getTargets':
        return {
          targetInfos: [...this.targets].map(([targetId, target]) => ({
            targetId,
            type: target.type ?? 'page',
            url: target.url,
            ...(target.contextId === null ? {} : { browserContextId: target.contextId }),
          })),
        };
      case 'Target.closeTarget':
        this.targets.delete(String(params['targetId']));
        return { success: true };
      case 'Target.disposeBrowserContext':
        this.contexts.delete(String(params['browserContextId']));
        return {};

      case 'Page.enable':
      case 'Runtime.enable':
      case 'Log.enable':
      case 'Network.enable':
      case 'Target.setAutoAttach':
      case 'Emulation.setDeviceMetricsOverride':
      case 'DOM.focus':
      case 'Input.dispatchMouseEvent':
      case 'Input.insertText':
      case 'Input.dispatchKeyEvent':
      case 'Runtime.releaseObject':
        return {};

      case 'Page.navigate': {
        const asked = String(params['url']);
        const refused = this.navigationErrors.get(asked);
        // A CDP-level rejection rather than an `errorText`: the socket died, or
        // the target went away. Different from a page that would not load.
        if (refused !== undefined) throw new Error(refused);
        const failure = this.navigationFailures.get(asked);
        if (failure !== undefined) return { errorText: failure };
        const targetId = sessionId === undefined ? undefined : this.sessions.get(sessionId);
        const landed = this.redirects.get(asked) ?? asked;
        if (targetId !== undefined) {
          this.targets.set(targetId, {
            contextId: this.targets.get(targetId)?.contextId ?? null,
            url: landed,
            title: landed === 'about:blank' ? '' : this.title,
          });
        }
        return { frameId: 'frame-1' };
      }
      case 'Page.captureScreenshot':
        return { data: 'aGVsbG8=' };

      case 'Runtime.evaluate': {
        const expression = String(params['expression']);
        if (expression.includes('body.innerText')) {
          return { result: { type: 'string', value: this.text } };
        }
        if (expression.includes('localStorage')) {
          return { result: { type: 'object', value: this.storage } };
        }
        return this.evaluated(expression);
      }
      case 'Runtime.getHeapUsage':
        return { usedSize: this.heapBytes, embedderHeapUsedSize: this.domBytes };
      case 'Runtime.callFunctionOn': {
        const declaration = String(params['functionDeclaration']);
        if (declaration.includes('isContentEditable')) {
          const element = this.elements.get(this.#lastSelector);
          return { result: { type: 'string', value: element?.kind ?? 'field' } };
        }
        return { result: { type: 'boolean', value: true } };
      }

      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: TOP_FRAME, url: 'about:blank' } } };

      case 'DOM.getDocument':
        return { root: { nodeId: 1 } };
      case 'DOM.querySelector': {
        const selector = String(params['selector']);
        this.#lastSelector = selector;
        if (selector.startsWith('!')) throw new Error('DOM Error while querying');
        return { nodeId: this.elements.has(selector) ? 2 : 0 };
      }
      case 'DOM.scrollIntoViewIfNeeded': {
        if (this.elements.get(this.#lastSelector)?.hidden === true) {
          throw new Error('Node does not have a layout object');
        }
        return {};
      }
      case 'DOM.getBoxModel': {
        const box = this.elements.get(this.#lastSelector)?.box;
        if (box === undefined) throw new Error('Could not compute box model.');
        return { model: { content: [...box] } };
      }
      case 'DOM.resolveNode':
        return { object: { objectId: 'object-1' } };

      case 'Network.getCookies':
        return { cookies: this.cookies };

      case 'Browser.close':
        this.browserClosed = true;
        this.targets.clear();
        this.contexts.clear();
        return {};
      case 'Memory.forciblyPurgeJavaScriptMemory':
        this.purged += 1;
        return {};

      default:
        throw new Error(`'${method}' wasn't found`);
    }
  }

  #lastSelector = '';
}

/* -------------------------------------------------------------------------- */
/* A clock the test owns                                                      */
/* -------------------------------------------------------------------------- */

class FakeTimers implements BrowserTimers {
  #now = 1_700_000_000_000;
  readonly ticks: (() => void)[] = [];
  /** How long the code under test asked to wait for, in order, in ms. */
  readonly waits: number[] = [];

  now(): number {
    return this.#now;
  }

  every(_ms: number, fn: () => void): () => void {
    this.ticks.push(fn);
    return () => {
      const at = this.ticks.indexOf(fn);
      if (at >= 0) this.ticks.splice(at, 1);
    };
  }

  /**
   * Wait, in the only sense a test has of the word: one turn of the macrotask
   * queue.
   *
   * Not instant, deliberately. The navigation grace in `settle` is a race
   * between this and an event the fake browser emits in a microtask, and a
   * grace that resolved immediately would win that race every time — which
   * would pin the bug rather than the fix.
   */
  async after(ms: number): Promise<void> {
    this.waits.push(ms);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  advanceMinutes(minutes: number): void {
    this.#now += minutes * 60_000;
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let chromium: FakeChromium;
let timers: FakeTimers;
/** What the server would have written to its stderr. */
let logged: string[];

function build(limits?: Parameters<typeof createServerBrowser>[0]['limits']): ServerBrowser {
  return createServerBrowser({
    endpoint: 'ws://browser:9222/devtools/browser/fake',
    dial: async () => chromium.dial(),
    endpointDeps: { lookup: async () => '172.20.0.3' },
    log: (line) => logged.push(line),
    resolveHost: async (host) => {
      const answer = dns.get(host);
      if (answer === null) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
      return answer ?? DEFAULT_ADDRESSES;
    },
    timers,
    ...(limits === undefined ? {} : { limits }),
  });
}

/** A driver on a fresh browser, with one element the tests can click. */
async function openAt(url = 'https://example.com/orders'): Promise<{
  browser: ServerBrowser;
  driver: PageDriver;
}> {
  const browser = build();
  const driver = browser.driver();
  const opened = await driver.open(url);
  expect(opened.ok).toBe(true);
  return { browser, driver };
}

function reasonOf(result: { ok: boolean; reason?: string }): string {
  if (result.ok) throw new Error('expected a refusal');
  return result.reason ?? '';
}

beforeEach(() => {
  chromium = new FakeChromium();
  timers = new FakeTimers();
  logged = [];
  dns = new Map();
  chromium.elements.set('button[type="submit"]', { box: [10, 20, 110, 20, 110, 60, 10, 60] });
  chromium.elements.set('#email', { box: [0, 0, 200, 0, 200, 30, 0, 30], kind: 'field' });
});

/* -------------------------------------------------------------------------- */
/* Opening and going places                                                   */
/* -------------------------------------------------------------------------- */

describe('opening this conversation’s tab', () => {
  it('makes a context of its own, so two runs never share a login', async () => {
    const browser = build();
    await browser.driver().open('https://example.com/a');
    await browser.driver().open('https://example.com/b');
    const contexts = chromium.called('Target.createTarget').map((one) => one['browserContextId']);
    expect(new Set(contexts).size).toBe(2);
  });

  it('opens at about:blank when no address is given', async () => {
    const browser = build();
    const opened = await browser.driver().open();
    expect(opened).toEqual({ ok: true, value: { url: 'about:blank', title: '' } });
  });

  it('reuses the tab it already has rather than making a second', async () => {
    const { driver } = await openAt();
    await driver.open('https://example.com/other');
    expect(chromium.called('Target.createTarget')).toHaveLength(1);
  });

  it('renders every page at 1280×800, so a screenshot is the desktop layout', async () => {
    await openAt();
    expect(chromium.called('Emulation.setDeviceMetricsOverride')[0]).toMatchObject({
      width: 1280,
      height: 800,
    });
  });

  it('refuses a private address without creating anything at all', async () => {
    const browser = build();
    const refused = await browser.driver().open('http://192.168.1.10/admin');
    expect(reasonOf(refused)).toContain('inside the operator’s own network');
    // A denied open must not spend one of the server's two context slots.
    expect(chromium.called('Target.createBrowserContext')).toHaveLength(0);
  });

  it('says what the browser said when a page will not load', async () => {
    chromium.navigationFailures.set('https://gone.example/', 'net::ERR_NAME_NOT_RESOLVED');
    const browser = build();
    const refused = await browser.driver().open('https://gone.example/');
    expect(reasonOf(refused)).toContain('net::ERR_NAME_NOT_RESOLVED');
  });
});

describe('going somewhere else', () => {
  it('needs a browser first, and says which tool opens one', async () => {
    const browser = build();
    const refused = await browser.driver().navigate('https://example.com/');
    expect(reasonOf(refused)).toBe('No browser is open for this conversation. Use browser_open first.');
  });

  it('reports where the page ended up', async () => {
    const { driver } = await openAt();
    const went = await driver.navigate('https://example.com/orders/1');
    expect(went).toEqual({ ok: true, value: { url: 'https://example.com/orders/1', title: 'Orders' } });
  });

  it('refuses a cloud metadata address, and says the rule has no switch', async () => {
    const { driver } = await openAt();
    expect(reasonOf(await driver.navigate('http://169.254.169.254/latest/'))).toContain(
      'whatever ARTEMIS_BROWSER_ALLOW_HOSTS says',
    );
  });

  it('catches a redirect into the private network and leaves the tab blank', async () => {
    // The check the first gate cannot make: the address the agent named was
    // public, and one HTTP response later the browser is on the metadata
    // service.
    chromium.redirects.set('https://shortener.example/x', 'http://169.254.169.254/latest/meta-data/');
    const { driver } = await openAt();
    const refused = await driver.navigate('https://shortener.example/x');
    expect(reasonOf(refused)).toContain('went to http://169.254.169.254/latest/meta-data/');
    expect(reasonOf(refused)).toContain('The tab is now blank.');
    // And it is actually blank, rather than loaded with the agent merely told
    // not to look.
    expect(chromium.called('Page.navigate').at(-1)).toEqual({ url: 'about:blank' });
  });

  it('catches a redirect on the first open too', async () => {
    chromium.redirects.set('https://shortener.example/x', 'http://10.0.0.5/admin');
    const browser = build();
    const refused = await browser.driver().open('https://shortener.example/x');
    expect(reasonOf(refused)).toContain('went to http://10.0.0.5/admin');
  });

  it('catches a link that navigated somewhere denied after a click', async () => {
    const { driver } = await openAt('https://example.com/start');
    chromium.elements.set('a.next', { box: [0, 0, 10, 0, 10, 10, 0, 10] });
    // The click is what moves the page, the way a real one would: the address
    // changes while the mouse events are still being acknowledged.
    chromium.navigatesOnClick = 'http://10.0.0.5/admin';
    const refused = await driver.click('a.next');
    expect(reasonOf(refused)).toContain('http://10.0.0.5/admin');
    expect(reasonOf(refused)).toContain('The tab is now blank.');
  });
});

/* -------------------------------------------------------------------------- */
/* Looking and acting                                                         */
/* -------------------------------------------------------------------------- */

describe('reading and looking', () => {
  it('reads the page’s text, not its markup', async () => {
    const { driver } = await openAt();
    const read = await driver.read();
    expect(read).toEqual({
      ok: true,
      value: {
        url: 'https://example.com/orders',
        title: 'Orders',
        text: 'Orders\nNothing here yet.',
        truncated: false,
      },
    });
    // The expression is this package's own fixed string, never anything a model
    // wrote.
    expect(String(chromium.called('Runtime.evaluate')[0]?.['expression'])).toContain('body.innerText');
  });

  it('takes a JPEG at quality 70, because a screenshot is a bill', async () => {
    const { driver } = await openAt();
    const shot = await driver.screenshot();
    expect(shot).toEqual({ ok: true, value: { mimeType: 'image/jpeg', data: 'aGVsbG8=' } });
    expect(chromium.called('Page.captureScreenshot')[0]).toEqual({ format: 'jpeg', quality: 70 });
  });
});

describe('clicking', () => {
  it('presses and releases at the centre of the element’s box', async () => {
    const { driver } = await openAt();
    const clicked = await driver.click('button[type="submit"]');
    expect(clicked.ok).toBe(true);
    const mouse = chromium.called('Input.dispatchMouseEvent');
    expect(mouse.map((one) => one['type'])).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    // The quad above is 10..110 by 20..60.
    expect(mouse[1]).toMatchObject({ x: 60, y: 40, button: 'left', clickCount: 1 });
  });

  it('scrolls the element into view before aiming at it', async () => {
    const { driver } = await openAt();
    await driver.click('button[type="submit"]');
    const order = chromium.calls.map((one) => one.method);
    expect(order.indexOf('DOM.scrollIntoViewIfNeeded')).toBeLessThan(
      order.indexOf('Input.dispatchMouseEvent'),
    );
  });

  it('says nothing matched, rather than clicking nothing', async () => {
    const { driver } = await openAt();
    expect(reasonOf(await driver.click('.absent'))).toBe('Nothing matches .absent on this page.');
  });

  it('says an element is there but not visible, which is a different next move', async () => {
    chromium.elements.set('.collapsed', { hidden: true });
    const { driver } = await openAt();
    expect(reasonOf(await driver.click('.collapsed'))).toContain('not visible on the page');
  });

  it('says an element has no box, which is the other way to be invisible', async () => {
    chromium.elements.set('.zero', {});
    const { driver } = await openAt();
    expect(reasonOf(await driver.click('.zero'))).toContain('no box on the page');
  });

  it('hands back the browser’s own complaint about a broken selector', async () => {
    const { driver } = await openAt();
    expect(reasonOf(await driver.click('!not a selector'))).toContain('not a usable CSS selector');
  });
});

describe('typing', () => {
  it('replaces what is there and tells the application', async () => {
    const { driver } = await openAt();
    const typed = await driver.type('#email', 'someone@example.com');
    expect(typed.ok).toBe(true);
    // Select first, so the insert replaces rather than appends.
    const functions = chromium.called('Runtime.callFunctionOn').map((one) => String(one['functionDeclaration']));
    expect(functions[0]).toContain('isContentEditable');
    expect(chromium.called('Input.insertText')).toEqual([{ text: 'someone@example.com' }]);
    // `input` comes from the real edit; `change` is the one a browser only
    // fires on blur, which nothing here does.
    expect(functions[1]).toContain("new Event('change'");
  });

  it('clears a field with a real Delete, because an empty insert is a no-op', async () => {
    const { driver } = await openAt();
    await driver.type('#email', '');
    expect(chromium.called('Input.insertText')).toHaveLength(0);
    expect(chromium.called('Input.dispatchKeyEvent').map((one) => one['type'])).toEqual([
      'keyDown',
      'keyUp',
    ]);
  });

  it('refuses an element that is not something you can type into', async () => {
    chromium.elements.set('div.card', { box: [0, 0, 10, 0, 10, 10, 0, 10], kind: 'other' });
    const { driver } = await openAt();
    expect(reasonOf(await driver.type('div.card', 'hello'))).toContain(
      'not an input, a textarea or a contenteditable',
    );
  });

  it('lets go of the element handle even when the typing failed', async () => {
    chromium.elements.set('div.card', { box: [0, 0, 10, 0, 10, 10, 0, 10], kind: 'other' });
    const { driver } = await openAt();
    await driver.type('div.card', 'hello');
    expect(chromium.called('Runtime.releaseObject')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* What a developer opens DevTools for                                        */
/* -------------------------------------------------------------------------- */

describe('the console', () => {
  it('reports console lines, uncaught errors and the browser’s own log', async () => {
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.emit(
      'Runtime.consoleAPICalled',
      {
        type: 'warning',
        timestamp: 1_700_000_000_500,
        args: [{ type: 'string', value: 'slow render' }, { type: 'number', value: 42 }],
        stackTrace: { callFrames: [{ url: 'https://example.com/app.js', lineNumber: 11 }] },
      },
      session,
    );
    chromium.emit(
      'Runtime.exceptionThrown',
      {
        timestamp: 1_700_000_000_600,
        exceptionDetails: { exception: { description: 'TypeError: x is not a function' } },
      },
      session,
    );
    chromium.emit(
      'Log.entryAdded',
      {
        entry: {
          source: 'network',
          level: 'error',
          text: 'Failed to load resource: 500',
          timestamp: 1_700_000_000_700,
          url: 'https://example.com/api/orders',
          lineNumber: 0,
        },
      },
      session,
    );

    const said = await driver.console();
    expect(said.ok && said.value).toEqual([
      {
        level: 'warn',
        text: 'slow render 42',
        source: 'https://example.com/app.js:12',
        at: 1_700_000_000_500,
      },
      // The contract has a level for an uncaught error and Electron cannot
      // produce one. CDP reports it separately, so this driver can.
      { level: 'exception', text: 'TypeError: x is not a function', at: 1_700_000_000_600 },
      {
        level: 'error',
        text: '[network] Failed to load resource: 500',
        source: 'https://example.com/api/orders:1',
        at: 1_700_000_000_700,
      },
    ]);
  });

  it('answers what is new, so a second call after nothing is empty', async () => {
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'one' }] }, session);
    expect((await driver.console()).ok && ((await driver.console()) as never)).toBeTruthy();
    const second = await driver.console();
    expect(second.ok && second.value).toEqual([]);
  });

  it('keeps the last two hundred, so a logging loop cannot eat the process', async () => {
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    for (let i = 0; i < 260; i += 1) {
      chromium.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: `line ${String(i)}` }] }, session);
    }
    const said = await driver.console();
    expect(said.ok && said.value).toHaveLength(200);
    // The oldest go first: what an agent asks about is what just happened.
    expect(said.ok && said.value[0]?.text).toBe('line 60');
  });

  it('clips one enormous line rather than keeping all of it', async () => {
    /*
     * Two hundred entries is not two hundred lines' worth of memory. One
     * `console.log` of a serialised application state is routinely a hundred
     * kilobytes, so a full buffer of them is twenty megabytes held for a
     * listing that would have shown the first two thousand characters of each
     * anyway. The bound is entries × chars, and this is the second half.
     */
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.emit(
      'Runtime.consoleAPICalled',
      { type: 'log', args: [{ value: 'x'.repeat(100_000) }] },
      session,
    );
    chromium.emit(
      'Runtime.exceptionThrown',
      { exceptionDetails: { exception: { description: 'y'.repeat(100_000) } } },
      session,
    );
    chromium.emit('Log.entryAdded', { entry: { level: 'error', text: 'z'.repeat(100_000) } }, session);

    const said = await driver.console();
    const texts = said.ok ? said.value.map((one) => one.text) : [];
    expect(texts).toHaveLength(3);
    for (const text of texts) {
      expect(text).toHaveLength(MAX_ENTRY_CHARS + 1);
      expect(text.endsWith('…')).toBe(true);
    }
  });
});

describe('the network log', () => {
  /** One request through the events CDP actually sends for it. */
  function request(
    session: string,
    options: { id: string; url: string; status?: number; failure?: string },
  ): void {
    chromium.emit(
      'Network.requestWillBeSent',
      {
        requestId: options.id,
        request: { method: 'GET', url: options.url },
        type: 'XHR',
        timestamp: 100,
        wallTime: 1_700_000_000,
      },
      session,
    );
    if (options.failure === undefined) {
      chromium.emit(
        'Network.responseReceived',
        { requestId: options.id, response: { status: options.status ?? 200 }, type: 'XHR' },
        session,
      );
      chromium.emit('Network.loadingFinished', { requestId: options.id, timestamp: 100.25 }, session);
    } else {
      chromium.emit(
        'Network.loadingFailed',
        { requestId: options.id, errorText: options.failure, timestamp: 100.1 },
        session,
      );
    }
  }

  it('reports method, status, kind and how long each took', async () => {
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    request(session, { id: 'r1', url: 'https://example.com/api/orders' });
    const said = await driver.network();
    expect(said.ok && said.value).toEqual([
      {
        method: 'GET',
        url: 'https://example.com/api/orders',
        status: 200,
        resourceType: 'XHR',
        // The duration is a difference of monotonic seconds; the timestamp is
        // wall time. Mixing them produces requests that happened in 1970.
        durationMs: 250,
        at: 1_700_000_000_000,
      },
    ]);
  });

  it('counts a transport failure and a 4xx as failures, exactly as the dock browser does', async () => {
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    request(session, { id: 'r1', url: 'https://example.com/ok' });
    request(session, { id: 'r2', url: 'https://example.com/missing', status: 404 });
    request(session, { id: 'r3', url: 'https://example.com/dns', failure: 'net::ERR_NAME_NOT_RESOLVED' });
    const said = await driver.network({ failedOnly: true });
    expect(said.ok && said.value.map((one) => one.url)).toEqual([
      'https://example.com/missing',
      'https://example.com/dns',
    ]);
  });

  it('drops a navigation the agent replaced rather than calling it a failure', async () => {
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.emit(
      'Network.requestWillBeSent',
      { requestId: 'r1', request: { method: 'GET', url: 'https://example.com/slow' }, timestamp: 1, wallTime: 1_700_000_000 },
      session,
    );
    chromium.emit(
      'Network.loadingFailed',
      { requestId: 'r1', errorText: 'net::ERR_ABORTED', canceled: true, timestamp: 2 },
      session,
    );
    const said = await driver.network();
    expect(said.ok && said.value).toEqual([]);
  });

  it('drains whole and filters afterwards, so failedOnly loses nothing', async () => {
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    request(session, { id: 'r1', url: 'https://example.com/ok' });
    await driver.network({ failedOnly: true });
    // The successful request was reported to nobody and is gone, which is the
    // cost of "since the last time you asked" — but it was drained once, not
    // filtered at the source, so no later call is missing anything it held.
    const after = await driver.network();
    expect(after.ok && after.value).toEqual([]);
  });
});

describe('cookies, storage and an expression', () => {
  it('reports cookies with their attributes, in the contract’s units', async () => {
    chromium.cookies = [
      {
        name: 'session',
        value: 'abc',
        domain: 'example.com',
        path: '/',
        expires: 1_700_000_100,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
      { name: 'ephemeral', value: '1', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false },
    ];
    const { driver } = await openAt();
    const said = await driver.cookies();
    expect(said.ok && said.value[0]).toEqual({
      name: 'session',
      value: 'abc',
      domain: 'example.com',
      path: '/',
      // CDP dates a cookie in seconds; the contract wants milliseconds.
      expires: 1_700_000_100_000,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
    // A session cookie has no expiry, rather than one in 1969.
    expect(said.ok && said.value[1]).not.toHaveProperty('expires');
  });

  it('reads local and session storage for the page’s origin', async () => {
    const { driver } = await openAt();
    const said = await driver.storage();
    expect(said).toEqual({
      ok: true,
      value: { origin: 'https://example.com', local: { token: 'abc' }, session: {} },
    });
  });

  it('runs an expression and returns its value', async () => {
    chromium.evaluated = () => ({ result: { type: 'object', value: { total: 3 } } });
    const { driver } = await openAt();
    expect(await driver.evaluate('window.store.total')).toEqual({ ok: true, value: { total: 3 } });
    expect(chromium.called('Runtime.evaluate').at(-1)).toMatchObject({
      expression: 'window.store.total',
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    });
  });

  it('reports what the page threw, rather than an empty answer', async () => {
    chromium.evaluated = () => ({
      exceptionDetails: { exception: { description: 'ReferenceError: store is not defined' } },
    });
    const { driver } = await openAt();
    expect(reasonOf(await driver.evaluate('store.total'))).toContain('ReferenceError');
  });

  it('says so when a value cannot cross the protocol', async () => {
    chromium.evaluated = () => ({ result: { type: 'object', subtype: 'node' } });
    const { driver } = await openAt();
    expect(reasonOf(await driver.evaluate('document.body'))).toContain('cannot be returned as data');
  });

  it('gives up on an expression the browser never answers for', async () => {
    /*
     * The half of the bound CDP does not supply. Measured on Chromium 141:
     * `Runtime.evaluate`'s `timeout` terminates a runaway *synchronous*
     * expression but does not bound the wait for a promise, so
     * `new Promise(() => {})` under `awaitPromise` produces no answer at all.
     * Without a deadline of this file's own the agent would wait out
     * `CdpConnection`'s thirty seconds and be told the browser had not
     * answered, which is a different and wrong thing to say.
     */
    const { driver } = await openAt();
    chromium.neverAnswers.add('Runtime.evaluate');

    const said = reasonOf(await driver.evaluate('new Promise(() => {})'));

    expect(said).toContain('did not finish within 10 seconds');
    // And it says the page survived it, because an agent told otherwise opens
    // a new one for no reason.
    expect(said).toContain('The page itself is unharmed');
    // The deadline was this file's, on the injected clock, and bounded.
    expect(timers.waits).toContain(10_000);
  });

  it('says an expression ran too long, rather than passing on “Internal error”', async () => {
    /*
     * What Chromium answers when its own `timeout` stops a runaway loop,
     * measured on 141: `{"code": -32603, "message": "Internal error"}` after
     * the timeout elapses. Handing that to a model teaches it nothing.
     */
    chromium.evaluated = () => {
      throw new Error('Internal error');
    };
    const { driver } = await openAt();

    const said = reasonOf(await driver.evaluate('while (true) {}'));

    expect(said).toContain('did not finish within 10 seconds');
    expect(said).not.toContain('Internal error');
  });

  it('offers all five deep verbs, because it is signed in to nothing', async () => {
    const browser = build();
    expect(browser.driver().abilities).toEqual({
      console: true,
      network: true,
      cookies: true,
      storage: true,
      evaluate: true,
    });
    expect(browser.driver().kind).toBe('server');
  });
});

/* -------------------------------------------------------------------------- */
/* Nothing outlives its use                                                   */
/* -------------------------------------------------------------------------- */

describe('a tab nobody is using closes', () => {
  it('closes after the idle minutes and disposes its context', async () => {
    const browser = build({ idleMinutes: 10 });
    const driver = browser.driver();
    await driver.open('https://example.com/orders');
    expect(chromium.targets.size).toBe(1);

    timers.advanceMinutes(11);
    await browser.maintain();
    expect(chromium.targets.size).toBe(0);
    // The context goes with the tab: that is what throws away the cookies.
    expect(chromium.contexts.size).toBe(0);
  });

  it('keeps a tab a conversation is still using', async () => {
    const browser = build({ idleMinutes: 10 });
    const driver = browser.driver();
    await driver.open('https://example.com/orders');
    timers.advanceMinutes(8);
    await driver.read();
    timers.advanceMinutes(8);
    await browser.maintain();
    expect(chromium.targets.size).toBe(1);
  });

  it('tells the run on its next call what happened and what to do', async () => {
    const browser = build({ idleMinutes: 10 });
    const driver = browser.driver();
    await driver.open('https://example.com/orders');
    timers.advanceMinutes(11);
    await browser.maintain();

    const refused = await driver.read();
    expect(reasonOf(refused)).toContain('closed after 10 minutes');
    expect(reasonOf(refused)).toContain('browser_open starts a new one');
  });

  it('says it once, and then says the ordinary thing', async () => {
    const browser = build({ idleMinutes: 10 });
    const driver = browser.driver();
    await driver.open('https://example.com/orders');
    timers.advanceMinutes(11);
    await browser.maintain();
    await driver.read();
    expect(reasonOf(await driver.read())).toBe(
      'No browser is open for this conversation. Use browser_open first.',
    );
  });

  it('lets browser_open do what the notice asked, without repeating it', async () => {
    const browser = build({ idleMinutes: 10 });
    const driver = browser.driver();
    await driver.open('https://example.com/orders');
    timers.advanceMinutes(11);
    await browser.maintain();
    const reopened = await driver.open('https://example.com/orders');
    expect(reopened).toEqual({
      ok: true,
      value: { url: 'https://example.com/orders', title: 'Orders' },
    });
  });
});

describe('the cap on live contexts', () => {
  it('refuses the third conversation with something it can act on', async () => {
    const browser = build({ maxContexts: 2 });
    await browser.driver().open('https://example.com/a');
    await browser.driver().open('https://example.com/b');
    const refused = await browser.driver().open('https://example.com/c');
    expect(reasonOf(refused)).toContain('already open for 2 other conversations');
    expect(reasonOf(refused)).toContain('ARTEMIS_BROWSER_MAX_CONTEXTS');
    expect(reasonOf(refused)).toContain('not a fault in what you asked for');
  });

  it('counts contexts rather than conversations, so an unused driver costs nothing', async () => {
    const browser = build({ maxContexts: 1 });
    browser.driver();
    browser.driver();
    expect((await browser.driver().open('https://example.com/a')).ok).toBe(true);
  });

  it('gives the slot back when a run closes its browser', async () => {
    const browser = build({ maxContexts: 1 });
    const first = browser.driver();
    await first.open('https://example.com/a');
    expect((await browser.driver().open('https://example.com/b')).ok).toBe(false);
    await first.close();
    expect((await browser.driver().open('https://example.com/b')).ok).toBe(true);
  });

  it('gives the slot back when the idle rule closes a tab', async () => {
    const browser = build({ maxContexts: 1, idleMinutes: 10 });
    await browser.driver().open('https://example.com/a');
    timers.advanceMinutes(11);
    await browser.maintain();
    expect((await browser.driver().open('https://example.com/b')).ok).toBe(true);
  });
});

describe('the memory watchdog', () => {
  it('closes a tab past the ceiling and says how much it was holding', async () => {
    const browser = build({ tabMemoryMb: 100 });
    const driver = browser.driver();
    await driver.open('https://example.com/heavy');
    chromium.heapBytes = 150 * 1024 * 1024;
    chromium.domBytes = 10 * 1024 * 1024;

    await browser.maintain();
    expect(chromium.targets.size).toBe(0);
    const refused = await driver.read();
    expect(reasonOf(refused)).toContain('holding 160 MB');
    expect(reasonOf(refused)).toContain('past the 100 MB');
  });

  it('leaves a tab under the ceiling alone', async () => {
    const browser = build({ tabMemoryMb: 100 });
    await browser.driver().open('https://example.com/light');
    await browser.maintain();
    expect(chromium.targets.size).toBe(1);
  });

  it('takes the least recently used first', async () => {
    const browser = build({ tabMemoryMb: 100, maxContexts: 3 });
    const older = browser.driver();
    await older.open('https://example.com/a');
    timers.advanceMinutes(1);
    const newer = browser.driver();
    await newer.open('https://example.com/b');
    chromium.heapBytes = 200 * 1024 * 1024;

    await browser.maintain();
    const closed = chromium.called('Target.closeTarget').map((one) => one['targetId']);
    // Two targets, two closes, and the one nobody had touched for a minute
    // goes first.
    expect(closed).toHaveLength(2);
    expect(closed[0]).toBe('target-2');
  });
});

/* -------------------------------------------------------------------------- */
/* A name is not an address                                                   */
/* -------------------------------------------------------------------------- */

describe('the address behind a name', () => {
  it('refuses a public name that resolves to the metadata service', async () => {
    /*
     * The hole the first version of this had. Every rule was applied to the
     * spelling of the host, so `169.254.169.254.nip.io` — a real public name
     * that resolves to the metadata service, and one of a family anybody can
     * mint — passed both gates and the claim that metadata "can never be
     * reached" was false.
     */
    dns.set('169.254.169.254.nip.io', ['169.254.169.254']);
    const browser = build();
    const refused = await browser.driver().open('http://169.254.169.254.nip.io/latest/meta-data/');
    expect(reasonOf(refused)).toContain('resolves to 169.254.169.254');
    expect(reasonOf(refused)).toContain('cloud metadata address');
    // And nothing was built for it: the gate runs before a context is made.
    expect(chromium.called('Target.createBrowserContext')).toHaveLength(0);
  });

  it('refuses a public name that resolves into the private network', async () => {
    dns.set('admin.example', ['192.168.1.10']);
    const browser = build();
    expect(reasonOf(await browser.driver().open('https://admin.example/'))).toContain(
      'resolves to 192.168.1.10',
    );
  });

  it('refuses a name where only one of its addresses is bad', async () => {
    // Which record Chromium picks is not ours to choose, so any of them
    // deciding it is the only safe reading.
    dns.set('mixed.example', ['203.0.113.7', '10.0.0.9']);
    const browser = build();
    expect(reasonOf(await browser.driver().open('https://mixed.example/'))).toContain(
      'resolves to 10.0.0.9',
    );
  });

  it('opens an allow-listed name that resolves into the private network', async () => {
    // The reason the allow-list is consulted by name. `artemis-server` is a
    // compose service and resolves to a private address by design; a rule that
    // refused every private address would refuse the dev servers this browser
    // exists to test.
    dns.set('artemis-server', ['172.20.0.4']);
    const browser = build();
    expect((await browser.driver().open('http://artemis-server:3000/orders')).ok).toBe(true);
  });

  it('refuses an allow-listed name that resolves to metadata, because that rule has no switch', async () => {
    dns.set('staging.internal', ['169.254.169.254']);
    const browser = build({ allowHosts: ['staging.internal'] });
    expect(reasonOf(await browser.driver().open('https://staging.internal/'))).toContain(
      'cloud metadata address',
    );
  });

  it('refuses a name it cannot resolve, in the resolver’s own words', async () => {
    dns.set('nowhere.example', null);
    const browser = build();
    const refused = await browser.driver().open('https://nowhere.example/');
    expect(reasonOf(refused)).toContain('getaddrinfo ENOTFOUND nowhere.example');
    expect(reasonOf(refused)).toContain('does not open a name it cannot look up');
  });

  it('asks no resolver about an address literal', async () => {
    let asked = 0;
    const browser = createServerBrowser({
      endpoint: 'ws://browser:9222/devtools/browser/fake',
      dial: async () => chromium.dial(),
      endpointDeps: { lookup: async () => '172.20.0.3' },
      resolveHost: async () => {
        asked += 1;
        return DEFAULT_ADDRESSES;
      },
      timers,
      limits: { allowHosts: ['127.0.0.1'] },
    });
    expect((await browser.driver().open('http://127.0.0.1:5173/')).ok).toBe(true);
    // The name gate already judged it as the address it is. Asking a resolver
    // about `127.0.0.1` would be asking it to agree with itself.
    expect(asked).toBe(0);
  });

  it('refuses when the address served does not match the address looked up', async () => {
    /*
     * Rebinding, which is what the third gate is for. The name resolved
     * publicly when the driver asked, and by the time Chromium fetched it the
     * answer had changed — so only `remoteIPAddress`, the machine the browser
     * really talked to, can catch it.
     */
    dns.set('rebind.example', ['203.0.113.7']);
    chromium.servedFromOverride.set('https://rebind.example/', '169.254.169.254');
    const browser = build();
    const refused = await browser.driver().open('https://rebind.example/');
    expect(reasonOf(refused)).toContain('cloud metadata address');
    expect(reasonOf(refused)).toContain('The tab is now blank.');
  });

  it('checks the last main-document address on every verb, not only on arrival', async () => {
    /*
     * The address is recorded by the page and read by the driver, so a verb
     * running long after the load still judges the machine the document came
     * from. Pinned by moving the record under a page that is already open: a
     * soft reload, or a document response that arrives after the navigation
     * the driver watched.
     */
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.emit(
      'Network.responseReceived',
      {
        requestId: 'doc-late',
        type: 'Document',
        frameId: TOP_FRAME,
        response: { status: 200, remoteIPAddress: '10.0.0.5' },
      },
      session,
    );
    const refused = await driver.read();
    expect(reasonOf(refused)).toContain('resolves to 10.0.0.5');
    expect(reasonOf(refused)).toContain('The tab is now blank.');
  });

  it('does not take a frame’s address for the page’s own', async () => {
    // A response for a frame says where *that frame* came from. Letting it
    // overwrite the page's would check the page's name against a machine that
    // never served it, which refuses pages at random and misses real ones.
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.emit(
      'Network.responseReceived',
      {
        requestId: 'sub-1',
        type: 'Document',
        frameId: 'frame-advert',
        response: { status: 200, remoteIPAddress: '169.254.169.254' },
      },
      session,
    );
    expect((await driver.read()).ok).toBe(true);
  });

  it('treats a page with no remote address as nothing to check, not as a pass', async () => {
    // A `data:` page or one with no document response. The name gate still
    // holds it; there is simply no second opinion to be had.
    const { driver } = await openAt();
    chromium.servedFromOverride.set('https://example.com/other', '');
    expect((await driver.navigate('https://example.com/other')).ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The policy runs on every load, not only the ones a verb asked for          */
/* -------------------------------------------------------------------------- */

describe('a page that moves itself', () => {
  it('is blanked at once and reported on the next verb', async () => {
    // A `<meta http-equiv="refresh">`, or a timer calling `location.assign`.
    // No tool call is in flight, so the listener is the only thing that can
    // act — and the verb that comes next is the only thing with anybody to
    // tell.
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.arriveAt('http://10.0.0.5/admin', session);
    await Promise.resolve();

    const refused = await driver.read();
    expect(reasonOf(refused)).toContain('The page went to http://10.0.0.5/admin');
    expect(reasonOf(refused)).toContain('The tab is now blank.');
    expect(chromium.called('Page.navigate').at(-1)).toEqual({ url: 'about:blank' });
  });

  it('says it once, and the verb after that is ordinary', async () => {
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.arriveAt('http://10.0.0.5/admin', session);
    await Promise.resolve();
    await driver.read();
    // The tab is blank now, so there is nothing to refuse and nothing to read.
    expect((await driver.read()).ok).toBe(true);
  });

  it('is caught on a same-document navigation as well as a real one', async () => {
    /*
     * `history.pushState` and a fragment change fire
     * `Page.navigatedWithinDocument` and nothing else, so a listener watching
     * only `frameNavigated` would never see a single-page application move.
     * The address here could not be reached that way in a real browser — a
     * pushState cannot change origin — but what is under test is that the
     * event is wired to the policy at all.
     */
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.emit(
      'Page.navigatedWithinDocument',
      { frameId: TOP_FRAME, url: 'http://10.0.0.5/admin' },
      session,
    );
    await Promise.resolve();
    expect(reasonOf(await driver.read())).toContain('http://10.0.0.5/admin');
  });

  it('lets browser_navigate be the remedy rather than refusing it', async () => {
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.arriveAt('http://10.0.0.5/admin', session);
    await Promise.resolve();
    // Going somewhere allowed is what the agent should do next, so it works —
    // and it is not made to read a stale refusal first.
    expect((await driver.navigate('https://example.com/orders')).ok).toBe(true);
  });

  it('is checked by every verb, not only the ones that navigate', async () => {
    /*
     * The listener fires on `Page.frameNavigated`, and a page can be somewhere
     * new before Chromium has said so. Every verb therefore looks for itself,
     * which is what this pins: the tab's address changes with no event at all.
     */
    const target = [...chromium.targets.keys()];
    const { driver } = await openAt();
    const mine = [...chromium.targets.keys()].find((id) => !target.includes(id)) as string;
    const moved = (): void => {
      chromium.targets.set(mine, { contextId: null, url: 'http://10.0.0.5/admin', title: 'Admin' });
    };

    for (const verb of [
      () => driver.read(),
      () => driver.screenshot(),
      () => driver.console(),
      () => driver.network(),
      () => driver.cookies(),
      () => driver.storage(),
      () => driver.evaluate('1'),
      () => driver.click('button[type="submit"]'),
      () => driver.type('#email', 'x'),
    ]) {
      moved();
      expect(reasonOf(await verb())).toContain('may not open');
      // Blanked, so the next round starts from a page that is allowed.
      await driver.navigate('https://example.com/orders');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* A frame inside the page is judged exactly as the page is                    */
/* -------------------------------------------------------------------------- */

describe('a frame inside the page', () => {
  it('refuses the whole page when it loads a cloud metadata address', async () => {
    /*
     * The one the agent can write itself. `browser_evaluate` appending an
     * `<iframe src="http://169.254.169.254/…">` used to be invisible to every
     * gate, while `browser_screenshot` rendered it and `browser_click` — which
     * aims at viewport coordinates — could drive it.
     */
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.frameArrivesAt('http://169.254.169.254/latest/meta-data/', session);
    await Promise.resolve();

    const refused = await driver.read();
    expect(reasonOf(refused)).toContain(
      'A frame inside the page loaded http://169.254.169.254/latest/meta-data/',
    );
    expect(reasonOf(refused)).toContain('cloud metadata address');
    expect(reasonOf(refused)).toContain('The tab is now blank.');
    expect(chromium.called('Page.navigate').at(-1)).toEqual({ url: 'about:blank' });
    // And the operator hears about it, because nothing else in the transcript
    // reaches them and this is what a prompt injection going for the metadata
    // service looks like from outside.
    expect(logged.some((line) => line.includes('169.254.169.254'))).toBe(true);
  });

  it('is judged on the machine that served it, not only on its name', async () => {
    /*
     * A frame is checked against its *own* remote address, which is the only
     * thing that can see a public name in an `<iframe src>` that Chromium
     * actually fetched from inside the operator's network.
     */
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.frameArrivesAt('https://widget.example/embed', session, { servedFrom: '10.0.0.5' });
    await Promise.resolve();

    const refused = await driver.read();
    expect(reasonOf(refused)).toContain('resolves to 10.0.0.5');
    expect(reasonOf(refused)).toContain('A frame inside the page loaded https://widget.example/embed');
  });

  it('is judged through the target it becomes when it is out of process', async () => {
    /*
     * Measured on Chromium 141: under site isolation — which the full browser
     * in `docker/browser.Dockerfile` has on — a cross-site iframe is its own
     * target and reports nothing on the page's `Page` domain. It arrives as an
     * attach carrying no url, and the url follows on a `targetInfoChanged`.
     */
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    const targetInfo = { targetId: 'target-frame', type: 'iframe', url: '' };
    chromium.emit(
      'Target.attachedToTarget',
      { sessionId: 'session-frame', targetInfo },
      session,
    );
    chromium.emit(
      'Target.targetInfoChanged',
      { targetInfo: { ...targetInfo, url: 'http://metadata.google.internal/computeMetadata/v1/' } },
      session,
    );
    await Promise.resolve();

    const refused = await driver.read();
    expect(reasonOf(refused)).toContain('http://metadata.google.internal/computeMetadata/v1/');
    expect(reasonOf(refused)).toContain('cloud metadata address');
  });

  it('is left alone when it is somewhere this browser may go', async () => {
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.frameArrivesAt('https://widget.example/embed', session);
    await Promise.resolve();
    expect((await driver.read()).ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Waiting for a load, and stopping waiting                                    */
/* -------------------------------------------------------------------------- */

describe('waiting for a page to settle', () => {
  it('is not held up by a frame that starts loading after the page has loaded', async () => {
    /*
     * The twenty-second stall. A lazy embed, an advert, a frame some analytics
     * script injects — anything that starts loading after `loadEventFired` —
     * used to set the page's own loading flag, and nothing cleared it: the load
     * event had already been and gone, and `Page.frameStoppedLoading` was never
     * subscribed. Every verb after that waited out the full settle timeout.
     *
     * This test fails by timing out rather than by asserting, which is the
     * honest shape for it: the bug is that the verb never comes back.
     */
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.emit('Page.frameStartedLoading', { frameId: 'frame-advert' }, session);

    expect((await driver.read()).ok).toBe(true);
  });

  it('stops waiting when the top frame stops loading without a load event', async () => {
    // A document that commits and then ends without firing `load` — one the
    // page replaced, or one that failed part-way — produces
    // `frameStoppedLoading` and no `loadEventFired`.
    const { driver } = await openAt();
    const session = chromium.sessionIds()[0] as string;
    chromium.emit('Page.frameStartedLoading', { frameId: TOP_FRAME }, session);
    chromium.emit('Page.frameStoppedLoading', { frameId: TOP_FRAME }, session);

    expect((await driver.read()).ok).toBe(true);
  });

  it('ends a navigation that only changed the fragment, which loads no document', async () => {
    /*
     * The hash-routed single-page application: `browser_navigate` from
     * `https://example.com/orders` to `https://example.com/orders#/settings` is
     * a *same-document* navigation, and Chromium commits nothing for it.
     *
     * Measured on Chromium 141: such a navigation produces
     * `frameStartedNavigating`, `frameStartedLoading`,
     * `navigatedWithinDocument` and `frameStoppedLoading` — and never a
     * `loadEventFired`. The fake deliberately withholds `frameStoppedLoading`
     * here, because that event is a property of one browser build and this
     * verb's answer must not be: what ends the wait is the event that says the
     * address arrived.
     *
     * A verb that never came back would fail this by timing out, which is the
     * honest shape for it.
     */
    const { driver } = await openAt('https://example.com/orders');
    const session = chromium.sessionIds()[0] as string;
    const fragment = 'https://example.com/orders#/settings';
    chromium.sameDocumentOn.set(fragment, TOP_FRAME);

    const at = await driver.navigate(fragment);

    expect(at).toEqual({ ok: true, value: { url: fragment, title: 'Orders' } });
    // No document was loaded, so nothing waited on the real clock either.
    expect(chromium.called('Page.navigate').at(-1)).toEqual({ url: fragment });
  });

  it('does not let a page’s own pushState cut short a load somebody asked for', async () => {
    /*
     * The other side of the same rule. A navigation to a real document is under
     * way; the page it is leaving calls `history.pushState` on a timer. That is
     * not the answer to what `navigate` asked, and ending the wait on it would
     * report the old page as though the new one had arrived.
     */
    const { driver } = await openAt('https://example.com/orders');
    const session = chromium.sessionIds()[0] as string;

    // Nothing is navigating: the wait below is `settle`'s, not `navigate`'s.
    chromium.emit('Page.frameStartedLoading', { frameId: TOP_FRAME }, session);
    chromium.emit(
      'Page.navigatedWithinDocument',
      { frameId: TOP_FRAME, url: 'https://example.com/orders#/late' },
      session,
    );
    const reading = driver.read();
    // Only a real end to the load lets the verb through.
    await Promise.resolve();
    chromium.emit('Page.loadEventFired', { timestamp: 1 }, session);

    expect((await reading).ok).toBe(true);
  });

  it('does not leave the next verb waiting when the browser refuses the navigation', async () => {
    // The wait is armed before `Page.navigate` is sent, deliberately — so a
    // call that is rejected rather than answered has to release it. The socket
    // dying mid-navigation is the case: the next verb must not pay for it.
    const { driver } = await openAt();
    chromium.navigationErrors.set('https://example.com/gone', 'Target closed.');

    const refused = await driver.navigate('https://example.com/gone');
    expect(reasonOf(refused)).toContain('Target closed.');
    expect((await driver.read()).ok).toBe(true);
  });
});

describe('a click whose navigation starts late', () => {
  it('waits a moment for it rather than reporting the page it left', async () => {
    /*
     * A handler calling `location.assign` has not navigated by the time the
     * mouse events are acknowledged. `settle` used to ask "is anything
     * loading?" at exactly that instant, be told no, and report the old
     * address — which, once the policy started reading that address, meant
     * checking the page the click had just left.
     */
    const { driver } = await openAt('https://example.com/start');
    chromium.elements.set('a.next', { box: [0, 0, 10, 0, 10, 10, 0, 10] });
    chromium.navigatesOnClick = 'https://example.com/next';

    const clicked = await driver.click('a.next');
    expect(clicked).toEqual({
      ok: true,
      value: { url: 'https://example.com/next', title: 'Orders' },
    });
    // The grace was asked for, and bounded.
    expect(timers.waits).toContain(500);
  });

  it('does not hang on a click that navigates nowhere', async () => {
    const { driver } = await openAt('https://example.com/start');
    const clicked = await driver.click('button[type="submit"]');
    expect(clicked).toEqual({
      ok: true,
      value: { url: 'https://example.com/start', title: 'Orders' },
    });
  });
});

describe('the sweep on connecting', () => {
  it('closes every target and context this server does not own', async () => {
    const stray = chromium.addStrayTarget();
    const browser = build();
    await browser.driver().open('https://example.com/a');
    expect(chromium.targets.has(stray)).toBe(false);
    expect(chromium.contexts.has('ctx-stray')).toBe(false);
  });

  it('leaves this server’s own tabs alone on a later pass', async () => {
    const browser = build();
    await browser.driver().open('https://example.com/a');
    const mine = [...chromium.targets.keys()];
    await browser.maintain();
    expect([...chromium.targets.keys()]).toEqual(mine);
  });

  it('does not close a tab that is still being set up', async () => {
    /*
     * The race the ownership rule is for. `lease.page` is assigned at the end
     * of `openFor`, three round trips after the target exists, and the
     * maintenance timer does not wait for that — so a sweep landing in the
     * window used to find a target belonging to no lease and close it, taking
     * the tab out from under the run that was still attaching to it.
     *
     * Ownership is by *context* now, claimed the instant Chromium names one.
     */
    const browser = build();
    let swept: Promise<void> | null = null;
    chromium.onCall = (method) => {
      if (method === 'Target.createTarget' && swept === null) swept = browser.maintain();
    };

    const opened = await browser.driver().open('https://example.com/a');
    await swept;
    expect(opened.ok).toBe(true);
    expect(chromium.targets.size).toBe(1);
    expect(chromium.called('Target.closeTarget')).toHaveLength(0);
  });

  it('closes a window a page opened, which no tool could have driven', async () => {
    const browser = build();
    await browser.driver().open('https://example.com/a');
    const popup = chromium.addStrayTarget('ctx-1');
    await browser.maintain();
    expect(chromium.targets.has(popup)).toBe(false);
    // And the context it shares with this run's tab survives, because the run
    // is still using it.
    expect(chromium.targets.size).toBe(1);
  });

  it('leaves a frame of its own page alone, however out of process it is', async () => {
    /*
     * A cross-site iframe under site isolation is its own target, with its own
     * target id and the *same* browser context as the page holding it. The rule
     * used to be "any document target that is not a lease's page", which made
     * every such frame a stranger: an agent looking at a page with an embedded
     * map, a payment form or a video had it closed from under them on the next
     * maintenance pass.
     */
    const browser = build();
    await browser.driver().open('https://example.com/a');
    const frame = chromium.addFrameTarget('ctx-1');

    await browser.maintain();

    expect(chromium.targets.has(frame)).toBe(true);
    expect(chromium.contexts.has('ctx-1')).toBe(true);
  });

  it('closes a frame target in a context it does not own', async () => {
    // The other side of the same rule. A frame belonging to a predecessor's
    // page is as much a leftover as the page was.
    const browser = build();
    await browser.driver().open('https://example.com/a');
    const stray = chromium.addFrameTarget('ctx-stray');

    await browser.maintain();

    expect(chromium.targets.has(stray)).toBe(false);
    expect(chromium.contexts.has('ctx-stray')).toBe(false);
  });
});

describe('the browser is not kept when nothing is open', () => {
  it('asks Chromium to exit after the idle minutes with no context', async () => {
    const browser = build({ idleMinutes: 1, idleExit: true });
    const driver = browser.driver();
    await driver.open('https://example.com/a');
    await driver.close();

    timers.advanceMinutes(6);
    await browser.maintain();
    expect(chromium.browserClosed).toBe(true);
  });

  it('does not exit while a conversation still has a tab', async () => {
    const browser = build();
    await browser.driver().open('https://example.com/a');
    timers.advanceMinutes(60);
    await browser.maintain();
    expect(chromium.browserClosed).toBe(false);
  });

  it('starts a new browser on the next open, retrying while the container comes back', async () => {
    const browser = build({ idleExit: true });
    const first = browser.driver();
    await first.open('https://example.com/a');
    await first.close();
    timers.advanceMinutes(6);
    await browser.maintain();
    expect(chromium.browserClosed).toBe(true);

    // The container is restarting: the first two dials find nothing listening.
    chromium.refuseDials = 2;
    const opened = await browser.driver().open('https://example.com/b');
    expect(opened.ok).toBe(true);
    expect(timers.waits).toEqual([1_000, 1_000]);
  });

  it('says why when the browser never comes back', async () => {
    chromium.refuseDials = 99;
    const browser = build();
    const refused = await browser.driver().open('https://example.com/a');
    expect(reasonOf(refused)).toContain('Could not reach the browser at ws://browser:9222');
    expect(reasonOf(refused)).toContain('It may be starting; try again in a moment.');
  });

  it('frees what a running Chromium can free when the operator turned the exit off', async () => {
    // Strictly worse, and the variable exists so the default can be the good
    // one without breaking a deployment that will not restart the container.
    const browser = build({ idleExit: false });
    const driver = browser.driver();
    await driver.open('https://example.com/a');
    await driver.close();
    timers.advanceMinutes(6);
    await browser.maintain();
    expect(chromium.browserClosed).toBe(false);
    expect(chromium.purged).toBe(1);
    // The pages are still gone: turning the exit off keeps the process, not
    // the tabs.
    expect(chromium.targets.size).toBe(0);
  });
});

describe('when the browser goes away underneath a run', () => {
  it('tells the run on its next call, rather than failing against a dead target', async () => {
    const browser = build();
    const driver = browser.driver();
    await driver.open('https://example.com/a');
    chromium.drop();
    const refused = await driver.read();
    expect(reasonOf(refused)).toContain('The browser this conversation was using went away');
    expect(reasonOf(refused)).toContain('browser_open starts a new one');
  });

  it('lets the next open build a fresh one', async () => {
    const browser = build();
    const driver = browser.driver();
    await driver.open('https://example.com/a');
    chromium.drop();
    await driver.read();
    expect((await driver.open('https://example.com/a')).ok).toBe(true);
  });
});

describe('shutting the server down', () => {
  it('closes every tab and lets go of the socket, without ending a browser it does not own', async () => {
    const browser = build();
    await browser.driver().open('https://example.com/a');
    await browser.dispose();
    expect(chromium.targets.size).toBe(0);
    expect(chromium.contexts.size).toBe(0);
    // A server shutting down is not a reason to end a browser another
    // deployment may be sharing; the container's own lifecycle governs that.
    expect(chromium.browserClosed).toBe(false);
  });

  it('refuses a run that asks for a browser on the way down', async () => {
    const browser = build();
    await browser.dispose();
    expect(reasonOf(await browser.driver().open('https://example.com/a'))).toContain(
      'shutting down',
    );
  });

  it('stops the maintenance timer', async () => {
    const browser = build();
    expect(timers.ticks).toHaveLength(1);
    await browser.dispose();
    expect(timers.ticks).toHaveLength(0);
  });
});
