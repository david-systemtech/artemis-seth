/**
 * One conversation's hands on one tab.
 * ============================================================================
 *
 * The far end of {@link PageDriver}. Artemis sends a `call` naming a verb and a
 * `runKey`; this runs it on the tab belonging to that key and answers with a
 * `result`. Every verb is CDP over `chrome.debugger`, attached to Artemis's own
 * tabs and nothing else.
 *
 * ## The order of every verb is the same, and it is the security model
 *
 *  1. Find this run's tab. There is no other way to name a tab — see
 *     `tabBook.ts`.
 *  2. Make sure the debugger is attached to it and the four domains are on.
 *  3. **Read the address the tab actually has**, from the debugger session.
 *  4. Decide, here, against the policy Artemis last sent.
 *  5. Do the thing, then read the address again if the thing could have moved
 *     the page.
 *
 * Step 3 is the one that is easy to skip and expensive to have skipped. A page
 * can leave the site it was opened on without being asked: a 302, a meta
 * refresh, a link the agent clicked, `window.location` set by a script on a
 * page the agent is reading — which is the prompt-injection route issue #436
 * names. Checking the address that was *requested* would catch none of those.
 * A tab found somewhere blocked is sent to `about:blank` before the refusal is
 * written, so the next verb does not find it there either.
 *
 * ## Refusals are sentences, never exceptions
 *
 * Every method answers with a {@link DriverResult}, and a refusal says what the
 * user could change. The reason `browserTools.ts` gives holds here too: a
 * thrown error reaches the agent as a stack trace and tells it nothing it can
 * act on. A refusal that names "Artemis settings → dev sites" reaches a person
 * reading the transcript, who can.
 */

import type {
  BridgeCall,
  ConsoleEntry,
  CookieEntry,
  DriverResult,
  PageImage,
  PageLocation,
  PagePolicy,
  PageText,
  StorageSnapshot,
} from '@rx-artemis/protocol';

import { BoundedLog, droppedNotice, type BufferSnapshot } from './buffer.js';
import { consoleEntryFor, NetworkLedger } from './events.js';
import type { PageEvent, PageHost } from './host.js';
import {
  BLANK_PAGE,
  blankPageRefusal,
  deepVerbRefusal,
  redactCookies,
  redactionNotice,
  standingOfPage,
  type PageStanding,
  type RawCookie,
} from './policy.js';
import { domClickScript, locateScript, READ_SCRIPT, STORAGE_SCRIPT, typeScript } from './scripts.js';
import { TabBook, type TabBookSnapshot } from './tabBook.js';

/** How long a navigation is waited for before the answer is given anyway. */
export const LOAD_TIMEOUT_MS = 20_000;

/**
 * How long a click is watched for a navigation it might have started.
 *
 * A click that goes somewhere fires `Page.frameStartedLoading` almost at once;
 * one that only changes the page does not fire it at all. Half a second
 * distinguishes them without making every click on a form feel slow.
 */
const NAVIGATION_GRACE_MS = 500;

/** How long an `evaluate` may run. A page can be asked for an infinite loop. */
const EVALUATE_TIMEOUT_MS = 10_000;

/** Most readable text handed back from one page, matching the desktop's tools. */
export const MAX_TEXT = 40_000;

/** The CDP domains every Artemis tab has on, and what each one is for. */
const DOMAINS = [
  'Page.enable', // navigation and load events
  'Runtime.enable', // console output, uncaught errors, evaluate
  'Log.enable', // the browser's own messages about the page
  'Network.enable', // the network panel, and cookies for the page
] as const;

/** What survives a service-worker restart. */
export interface DriverSnapshot {
  readonly book: TabBookSnapshot;
  /** tab id → the console buffer for that tab. */
  readonly console: Readonly<Record<string, BufferSnapshot<ConsoleEntry>>>;
}

/** One tab's in-memory state. */
interface TabState {
  readonly console: BoundedLog<ConsoleEntry>;
  readonly network: NetworkLedger;
  attached: boolean;
}

/** A waiter on a CDP event for one tab. */
interface Waiter {
  readonly tabId: number;
  readonly match: (event: PageEvent) => boolean;
  readonly resolve: () => void;
}

/**
 * A subscription to one event, with no clock of its own.
 *
 * The timeout is the caller's because the moment a wait should *begin* is not
 * the moment the subscription has to exist. A click has to be subscribed before
 * the mouse event is sent, or the navigation it starts could be missed — but
 * the patience for it should only start running once the click has actually
 * been delivered, which can be seconds later. See {@link PageRunner.click}.
 */
interface Watch {
  readonly seen: Promise<void>;
  readonly cancel: () => void;
}

/** The CDP events that mean a document has finished arriving. */
function isLoadFinished(event: PageEvent): boolean {
  return event.method === 'Page.loadEventFired' || event.method === 'Page.frameStoppedLoading';
}

/** The CDP events that mean the tab has begun going somewhere else. */
function isNavigationStarted(event: PageEvent): boolean {
  return event.method === 'Page.frameStartedLoading' || event.method === 'Page.frameNavigated';
}

/** `true` if it happened in time, `false` if the patience ran out. */
async function within(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
  });
  try {
    return await Promise.race([promise.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the driver needs from the world besides the browser. */
export interface DriverOptions {
  readonly host: PageHost;
  /** Milliseconds since the epoch. A parameter so tests are not about clocks. */
  readonly now?: () => number;
  /** Called whenever state worth surviving a worker restart has changed. */
  readonly onStateChanged?: () => void;
}

export class PageRunner {
  readonly #host: PageHost;
  readonly #now: () => number;
  readonly #changed: () => void;
  readonly #tabs = new Map<number, TabState>();
  readonly #waiters = new Set<Waiter>();

  #book = new TabBook();
  #policy: PagePolicy | null = null;

  constructor(options: DriverOptions) {
    this.#host = options.host;
    this.#now = options.now ?? (() => Date.now());
    this.#changed = options.onStateChanged ?? ((): void => {});

    this.#host.onEvent((event) => {
      this.#observe(event);
    });
    this.#host.onDetached((tabId) => {
      const state = this.#tabs.get(tabId);
      if (state !== undefined) state.attached = false;
    });
    this.#host.onTabClosed((tabId) => {
      if (this.#book.forgetTab(tabId) !== null) {
        this.#tabs.delete(tabId);
        this.#changed();
      }
    });
  }

  /** The policy Artemis last sent. No verb runs before one has arrived. */
  set policy(policy: PagePolicy | null) {
    this.#policy = policy;
  }

  get book(): TabBook {
    return this.#book;
  }

  /** Everything that must outlive a stopped service worker. */
  snapshot(): DriverSnapshot {
    const console: Record<string, BufferSnapshot<ConsoleEntry>> = {};
    for (const [tabId, state] of this.#tabs) console[String(tabId)] = state.console.toSnapshot();
    return { book: this.#book.toSnapshot(), console };
  }

  /**
   * Take up where a stopped worker left off.
   *
   * The network ledger is deliberately *not* restored. Half of it is a map of
   * requests still in flight keyed by a CDP `requestId` that a new debugger
   * session will not reuse, so restoring it would produce entries that can
   * never be completed and a duration that is nonsense. Console lines are
   * whole the moment they arrive and restore cleanly.
   */
  restore(snapshot: DriverSnapshot | undefined): void {
    this.#book = TabBook.fromSnapshot(snapshot?.book);
    this.#tabs.clear();
    for (const [tabId, buffer] of Object.entries(snapshot?.console ?? {})) {
      this.#tabs.set(Number(tabId), {
        console: BoundedLog.fromSnapshot<ConsoleEntry>(buffer),
        network: new NetworkLedger(),
        attached: false,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* The verbs                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Run one call and answer it.
   *
   * The single entry point, so that the audit log, the policy check and the
   * refusal wording have one place each rather than twelve.
   */
  async run(call: BridgeCall): Promise<DriverResult<unknown>> {
    const policy = this.#policy;
    if (policy === null) {
      return { ok: false, reason: 'Artemis has not sent this browser a policy yet, so nothing may be run in it.' };
    }

    if (call.verb === 'close') return this.#close(call.runKey);
    if (call.verb === 'open') return this.#open(call.runKey, call.url, policy);

    const tabId = this.#book.tabFor(call.runKey);
    if (tabId === null) {
      if (call.verb === 'navigate') return this.#open(call.runKey, call.url, policy);
      return { ok: false, reason: blankPageRefusal(call.verb) };
    }

    const ready = await this.#ensureAttached(tabId);
    if (ready !== null) return ready;

    const where = await this.#standing(tabId, policy);
    if (where.kind === 'blocked') return this.#sendHomeAndRefuse(tabId, where.reason);
    if (where.kind === 'blank' && call.verb !== 'navigate' && call.verb !== 'console' && call.verb !== 'network') {
      return { ok: false, reason: blankPageRefusal(call.verb) };
    }

    switch (call.verb) {
      case 'navigate':
        return this.#navigate(tabId, call.url, policy);
      case 'read':
        return this.#read(tabId);
      case 'screenshot':
        return this.#screenshot(tabId);
      case 'click':
        return this.#click(tabId, call.selector, policy);
      case 'type':
        return this.#type(tabId, call.selector, call.text, policy);
      case 'console':
        return this.#console(tabId);
      case 'network':
        return this.#network(tabId, call.failedOnly === true);
      case 'cookies':
        return this.#cookies(tabId, where);
      case 'storage':
        return this.#storage(tabId, where);
      case 'evaluate':
        return this.#evaluate(tabId, call.expression, where);
    }
  }

  /** Open this run's page, making the tab and the group if there are none. */
  async #open(runKey: string, url: string | undefined, policy: PagePolicy): Promise<DriverResult<PageLocation>> {
    if (url !== undefined) {
      const wanted = standingOfPage(url, policy);
      if (wanted.kind === 'blocked') return { ok: false, reason: wanted.reason };
    }

    const existing = this.#book.tabFor(runKey);
    if (existing !== null) {
      const ready = await this.#ensureAttached(existing);
      if (ready !== null) return ready;
      if (url === undefined) return this.#locate(existing, policy);
      return this.#navigate(existing, url, policy);
    }

    let tabId: number;
    try {
      // Always blank, even when an address was asked for, and then navigated
      // like any other navigation. Creating the tab *at* the address looks
      // like it saves a step and does not: the load is then already under way
      // before the debugger is attached, so there is no reliable moment to
      // subscribe to its completion — `document.readyState` answers `complete`
      // about the empty document the tab starts with, and the verb returns
      // against a page that has not arrived. One loading path, subscribed
      // before it starts, is worth the extra navigation.
      tabId = await this.#host.openTab(BLANK_PAGE);
    } catch (error) {
      return { ok: false, reason: `This browser would not open a tab: ${describe(error)}` };
    }
    this.#book.remember(runKey, tabId);
    this.#tabs.set(tabId, { console: new BoundedLog<ConsoleEntry>(), network: new NetworkLedger(), attached: false });
    this.#changed();

    // The group is the visible mark, but a browser that will not make one is
    // not a reason to refuse the verb: the tab is still Artemis's, still
    // debugger-marked, and still in the popup's list.
    try {
      this.#book.groupId = await this.#host.groupTab(tabId, this.#book.groupId);
      this.#changed();
    } catch {
      this.#book.groupId = null;
    }

    const ready = await this.#ensureAttached(tabId);
    if (ready !== null) return ready;

    if (url !== undefined) return this.#navigate(tabId, url, policy);
    return this.#locate(tabId, policy);
  }

  async #navigate(tabId: number, url: string, policy: PagePolicy): Promise<DriverResult<PageLocation>> {
    const wanted = standingOfPage(url, policy);
    if (wanted.kind === 'blocked') return { ok: false, reason: wanted.reason };

    // Subscribed before the navigation is asked for, so that a page which
    // finishes before `Page.navigate` even returns cannot be missed.
    const loaded = this.#watch(tabId, isLoadFinished);
    let navigation: unknown;
    try {
      navigation = await this.#host.send(tabId, 'Page.navigate', { url });
    } catch (error) {
      loaded.cancel();
      return { ok: false, reason: `Could not go to ${url}: ${describe(error)}` };
    }
    const failure = isRecord(navigation) && typeof navigation['errorText'] === 'string' ? navigation['errorText'] : null;
    // No `loaderId` means the browser did not fetch anything — a fragment
    // change, or an address it was already at. There is no load to wait for and
    // waiting would cost the full timeout.
    if (isRecord(navigation) && navigation['loaderId'] !== undefined) await within(loaded.seen, LOAD_TIMEOUT_MS);
    loaded.cancel();

    // The address is read again here rather than trusted, because between the
    // request and now the server may have redirected and the page may have
    // moved itself. This is the check the header is about.
    const where = await this.#standing(tabId, policy);
    if (where.kind === 'blocked') return this.#sendHomeAndRefuse(tabId, where.reason);
    if (failure !== null && where.kind === 'blank') return { ok: false, reason: `Could not go to ${url}: ${failure}` };
    return this.#locate(tabId, policy);
  }

  async #read(tabId: number): Promise<DriverResult<PageText>> {
    const read = await this.#evaluateInPage<{ title: string; text: string }>(tabId, READ_SCRIPT);
    if (!read.ok) return read;
    const location = await this.#targetInfo(tabId);
    const whole = read.value.text ?? '';
    const truncated = whole.length > MAX_TEXT;
    return {
      ok: true,
      value: {
        url: location.url,
        title: read.value.title ?? location.title,
        text: truncated ? whole.slice(0, MAX_TEXT) : whole,
        truncated,
      },
    };
  }

  async #screenshot(tabId: number): Promise<DriverResult<PageImage>> {
    try {
      const shot = await this.#host.send(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const data = isRecord(shot) && typeof shot['data'] === 'string' ? shot['data'] : '';
      if (data.length === 0) return { ok: false, reason: 'The browser returned an empty screenshot.' };
      return { ok: true, value: { mimeType: 'image/png', data } };
    } catch (error) {
      return { ok: false, reason: `Could not take a screenshot: ${describe(error)}` };
    }
  }

  async #click(tabId: number, selector: string, policy: PagePolicy): Promise<DriverResult<PageLocation>> {
    const found = await this.#evaluateInPage<{ found: boolean; x?: number; y?: number; inView?: boolean }>(tabId, locateScript(selector));
    if (!found.ok) return found;
    if (!found.value.found) return { ok: false, reason: `Nothing on this page matches the selector ${selector}.` };

    const navigated = this.#watchNavigation(tabId);
    if (found.value.inView === true && typeof found.value.x === 'number' && typeof found.value.y === 'number') {
      const where = { x: Math.round(found.value.x), y: Math.round(found.value.y), button: 'left', clickCount: 1 };
      try {
        // A real click: move, press, release, at the element's centre. Every
        // handler a person's click would run, runs.
        //
        // The first of these on a given tab can take about five seconds to be
        // acknowledged, and it is worth knowing why rather than being surprised
        // by it. These tabs are opened in the background and a background tab
        // has no compositor frame, so Chrome cannot hit-test the coordinates
        // until it makes one; the wait is Chrome producing that first frame.
        // Every later click on the same tab returns immediately. Bringing the
        // tab to the front would avoid it and is the wrong trade: the agent
        // would take the user's focus on every click.
        await this.#host.send(tabId, 'Input.dispatchMouseEvent', { ...where, type: 'mouseMoved', button: 'none', clickCount: 0 });
        await this.#host.send(tabId, 'Input.dispatchMouseEvent', { ...where, type: 'mousePressed' });
        await this.#host.send(tabId, 'Input.dispatchMouseEvent', { ...where, type: 'mouseReleased' });
      } catch (error) {
        navigated.cancel();
        return { ok: false, reason: `Could not click ${selector}: ${describe(error)}` };
      }
    } else {
      // No rectangle to aim at — a zero-size element, or one scrolled nowhere.
      // A DOM click is not something a person could do, but it is what the
      // agent meant, and refusing would leave hidden-but-clickable controls
      // (a label's input, a custom menu item) permanently unreachable.
      const clicked = await this.#evaluateInPage<{ found: boolean }>(tabId, domClickScript(selector));
      if (!clicked.ok) {
        navigated.cancel();
        return clicked;
      }
      if (!clicked.value.found) {
        navigated.cancel();
        return { ok: false, reason: `Nothing on this page matches the selector ${selector}.` };
      }
    }
    await navigated.settled();

    const where = await this.#standing(tabId, policy);
    if (where.kind === 'blocked') return this.#sendHomeAndRefuse(tabId, where.reason);
    return this.#locate(tabId, policy);
  }

  async #type(tabId: number, selector: string, text: string, policy: PagePolicy): Promise<DriverResult<PageLocation>> {
    const typed = await this.#evaluateInPage<{ found: boolean; kind?: string; tag?: string }>(tabId, typeScript(selector, text));
    if (!typed.ok) return typed;
    if (!typed.value.found) return { ok: false, reason: `Nothing on this page matches the selector ${selector}.` };
    if (typed.value.kind === 'not-a-field') {
      return { ok: false, reason: `${selector} matched a <${String(typed.value.tag).toLowerCase()}>, which is not something text can be typed into.` };
    }
    const where = await this.#standing(tabId, policy);
    if (where.kind === 'blocked') return this.#sendHomeAndRefuse(tabId, where.reason);
    return this.#locate(tabId, policy);
  }

  #console(tabId: number): DriverResult<readonly ConsoleEntry[]> {
    const { entries, dropped } = this.#stateFor(tabId).console.drain();
    const notice = droppedNotice(dropped, 'console');
    return notice === undefined ? { ok: true, value: entries } : { ok: true, value: entries, notice };
  }

  #network(tabId: number, failedOnly: boolean): DriverResult<unknown> {
    const { entries, dropped } = this.#stateFor(tabId).network.drain(failedOnly);
    const notice = droppedNotice(dropped, 'network');
    return notice === undefined ? { ok: true, value: entries } : { ok: true, value: entries, notice };
  }

  async #cookies(tabId: number, where: PageStanding): Promise<DriverResult<readonly CookieEntry[]>> {
    if (where.kind !== 'open') return { ok: false, reason: blankPageRefusal('read cookies from') };
    try {
      const answer = await this.#host.send(tabId, 'Network.getCookies', { urls: [where.url] });
      const raw = isRecord(answer) && Array.isArray(answer['cookies']) ? (answer['cookies'] as RawCookie[]) : [];
      const value = redactCookies(raw, where.standing.deepRead);
      return where.standing.deepRead ? { ok: true, value } : { ok: true, value, notice: redactionNotice(where.url) };
    } catch (error) {
      return { ok: false, reason: `Could not read this page's cookies: ${describe(error)}` };
    }
  }

  async #storage(tabId: number, where: PageStanding): Promise<DriverResult<StorageSnapshot>> {
    if (where.kind !== 'open') return { ok: false, reason: blankPageRefusal('read storage from') };
    const refusal = deepVerbRefusal('storage', where.url, where.standing);
    if (refusal !== null) return { ok: false, reason: refusal };
    return this.#evaluateInPage<StorageSnapshot>(tabId, STORAGE_SCRIPT);
  }

  async #evaluate(tabId: number, expression: string, where: PageStanding): Promise<DriverResult<unknown>> {
    if (where.kind !== 'open') return { ok: false, reason: blankPageRefusal('evaluate on') };
    const refusal = deepVerbRefusal('evaluate', where.url, where.standing);
    if (refusal !== null) return { ok: false, reason: refusal };
    return this.#evaluateInPage<unknown>(tabId, expression, EVALUATE_TIMEOUT_MS);
  }

  /** Close this run's tab and let go of everything that was its. */
  async #close(runKey: string): Promise<DriverResult<unknown>> {
    const tabId = this.#book.forgetRun(runKey);
    if (tabId === null) return { ok: true, value: null };
    this.#tabs.delete(tabId);
    // Detach before closing: a tab removed while a debugger session is open
    // leaves Chrome reporting the session until it notices, and the next
    // attach to a reused id then fails.
    await this.#letGo(tabId);
    this.#changed();
    return { ok: true, value: null };
  }

  /**
   * Close every Artemis tab and detach from all of them.
   *
   * The "Stop Artemis" button. Not a refusal and not an error: the user has
   * said stop, so this succeeds even where a tab has already gone.
   */
  async stopEverything(): Promise<void> {
    for (const tabId of this.#book.clear()) {
      this.#tabs.delete(tabId);
      await this.#letGo(tabId);
    }
    this.#changed();
  }

  /* ---------------------------------------------------------------------- */
  /* Plumbing                                                               */
  /* ---------------------------------------------------------------------- */

  async #letGo(tabId: number): Promise<void> {
    try {
      await this.#host.detach(tabId);
    } catch {
      // Already gone, which is the outcome wanted.
    }
    try {
      await this.#host.closeTab(tabId);
    } catch {
      // The user closed it first.
    }
  }

  #stateFor(tabId: number): TabState {
    const existing = this.#tabs.get(tabId);
    if (existing !== undefined) return existing;
    const fresh: TabState = { console: new BoundedLog<ConsoleEntry>(), network: new NetworkLedger(), attached: false };
    this.#tabs.set(tabId, fresh);
    return fresh;
  }

  /**
   * Attach, and turn the four domains on. `null` when the tab is usable.
   *
   * The attach is allowed to fail, and the command that follows is what
   * actually decides. After a service-worker restart the extension's own
   * session may still be open, in which case `attach` reports that a debugger
   * is already attached — the same sentence Chrome uses when the *user* has
   * DevTools open on the tab, which is a completely different situation. A
   * command that succeeds means the session is ours; one that fails means it is
   * somebody else's, and the refusal says so.
   */
  async #ensureAttached(tabId: number): Promise<DriverResult<never> | null> {
    const state = this.#stateFor(tabId);
    if (state.attached) return null;
    try {
      await this.#host.attach(tabId);
    } catch {
      // Possibly ours from before the worker was stopped. The commands decide.
    }
    try {
      for (const domain of DOMAINS) await this.#host.send(tabId, domain);
    } catch (error) {
      return {
        ok: false,
        reason:
          `Artemis cannot drive this conversation's tab: ${describe(error)} ` +
          'That usually means DevTools is open on it — close DevTools, or ask Artemis to open a new page.',
      };
    }
    state.attached = true;
    return null;
  }

  /**
   * The address and title the tab has now, from the debugger, not from a cache.
   *
   * Asked twice when the first answer has no address at all. `Target.getTargetInfo`
   * reports an empty url for the moment between a navigation committing and the
   * new document being installed, and an empty address reads as "blank" to the
   * policy — which would turn a page that is merely mid-commit into a refusal.
   * One retry is enough; a tab that answers twice with nothing really has
   * nothing.
   */
  async #targetInfo(tabId: number): Promise<PageLocation> {
    const ask = async (): Promise<PageLocation> => {
      try {
        const info = await this.#host.send(tabId, 'Target.getTargetInfo');
        const target = isRecord(info) && isRecord(info['targetInfo']) ? info['targetInfo'] : {};
        return { url: String(target['url'] ?? ''), title: String(target['title'] ?? '') };
      } catch {
        return { url: '', title: '' };
      }
    };
    const first = await ask();
    if (first.url.length > 0) return first;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return ask();
  }

  /** What the policy says about where the tab is right now. */
  async #standing(tabId: number, policy: PagePolicy): Promise<PageStanding> {
    const { url } = await this.#targetInfo(tabId);
    return standingOfPage(url, policy);
  }

  async #locate(tabId: number, policy: PagePolicy): Promise<DriverResult<PageLocation>> {
    const location = await this.#targetInfo(tabId);
    const where = standingOfPage(location.url, policy);
    if (where.kind === 'blocked') return this.#sendHomeAndRefuse(tabId, where.reason);
    return { ok: true, value: location };
  }

  /**
   * Take the tab off the page it should not be on, then refuse.
   *
   * The navigation is not decoration. Leaving the tab where it is would mean
   * the next verb finds it there, the group shows the user's bank in an Artemis
   * tab, and any script on that page keeps running with the session it has.
   * `about:blank` is the only address that is certainly nobody's.
   */
  async #sendHomeAndRefuse(tabId: number, reason: string): Promise<DriverResult<never>> {
    try {
      await this.#host.send(tabId, 'Page.navigate', { url: BLANK_PAGE });
    } catch {
      // A tab that will not navigate is a tab that is closing. The refusal stands.
    }
    return { ok: false, reason };
  }

  /**
   * Run one expression in the page and return its value.
   *
   * `awaitPromise` because half of what is worth evaluating is async and an
   * agent handed `[object Promise]` learns nothing. `returnByValue` because the
   * result crosses a socket as JSON; a value that cannot be serialised comes
   * back as a refusal naming what it was, which is more use than `{}`.
   */
  async #evaluateInPage<T>(tabId: number, expression: string, timeout?: number): Promise<DriverResult<T>> {
    let answer: unknown;
    try {
      answer = await this.#host.send(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        ...(timeout === undefined ? {} : { timeout }),
      });
    } catch (error) {
      return { ok: false, reason: `The page could not be read: ${describe(error)}` };
    }
    if (!isRecord(answer)) return { ok: false, reason: 'The browser gave no answer.' };

    const details = answer['exceptionDetails'];
    if (isRecord(details)) {
      const thrown = details['exception'];
      const text = isRecord(thrown) ? String(thrown['description'] ?? thrown['value'] ?? details['text']) : String(details['text'] ?? 'threw');
      return { ok: false, reason: `That threw in the page: ${text}` };
    }

    const result = isRecord(answer['result']) ? answer['result'] : {};
    if ('value' in result) return { ok: true, value: result['value'] as T };
    if (result['type'] === 'undefined') return { ok: true, value: undefined as T };
    return {
      ok: false,
      reason: `That produced a ${String(result['className'] ?? result['type'] ?? 'value')} which cannot be sent as JSON. Return something serialisable.`,
    };
  }

  /**
   * Watch a tab for a load that a click may or may not be about to start.
   *
   * A click that goes somewhere fires `Page.frameStartedLoading` almost at
   * once; one that only changes the page does not fire it at all. The grace
   * period distinguishes them without making every click on a form feel slow.
   *
   * Both waits are registered before the click, not one after the other, and
   * that is deliberate: a local page can deliver "started" and "finished" in
   * the same turn, and a watch for the second that is only registered once the
   * first has resolved can miss it and then sit for the full timeout.
   *
   * Resolving rather than rejecting on timeout, for the reason the desktop's
   * tools give: a page still streaming after twenty seconds is usually a page
   * whose useful content arrived nineteen seconds ago and whose analytics
   * beacon is still open. Reporting what is there beats refusing to report.
   */
  #watchNavigation(tabId: number): { readonly settled: () => Promise<void>; readonly cancel: () => void } {
    const started = this.#watch(tabId, isNavigationStarted);
    const finished = this.#watch(tabId, isLoadFinished);
    return {
      settled: async (): Promise<void> => {
        try {
          // The clock starts here, not where the subscriptions were made: by
          // the time a click has been acknowledged the grace period would
          // already have expired, and the navigation it started would be
          // reported as no navigation at all.
          if (await within(started.seen, NAVIGATION_GRACE_MS)) await within(finished.seen, LOAD_TIMEOUT_MS);
        } finally {
          started.cancel();
          finished.cancel();
        }
      },
      cancel: (): void => {
        started.cancel();
        finished.cancel();
      },
    };
  }

  /** Subscribe to one event on one tab. The caller decides how long to wait. */
  #watch(tabId: number, match: (event: PageEvent) => boolean): Watch {
    let settle: () => void = () => {};
    const seen = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const waiter: Waiter = {
      tabId,
      match,
      resolve: () => {
        this.#waiters.delete(waiter);
        settle();
      },
    };
    this.#waiters.add(waiter);
    return {
      seen,
      cancel: () => {
        this.#waiters.delete(waiter);
      },
    };
  }

  /**
   * One CDP event from one of Artemis's tabs.
   *
   * The `owns` check is the same rule the whole package is built on, asserted
   * once more at the point where data from a page enters: an event for a tab
   * that is not in the book is dropped rather than buffered, so even a bug that
   * attached the debugger somewhere it should not be would produce nothing an
   * agent could read.
   */
  #observe(event: PageEvent): void {
    if (!this.#book.owns(event.tabId)) return;
    const state = this.#stateFor(event.tabId);
    const at = this.#now();

    const line = consoleEntryFor(event.method, event.params, at);
    if (line !== null) {
      state.console.push(line);
      this.#changed();
    } else if (event.method.startsWith('Network.')) {
      state.network.observe(event.method, event.params, at);
    }

    for (const waiter of this.#waiters) if (waiter.tabId === event.tabId && waiter.match(event)) waiter.resolve();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** An unknown thrown thing, as a sentence fragment fit for a refusal. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error['message'] === 'string') return error['message'];
  return String(error);
}
