/**
 * The headless browser beside an Artemis Server, as a {@link PageDriver}.
 * ============================================================================
 *
 * The second implementation of the contract in `protocol/browserDriver.ts`. The
 * first is `apps/desktop/main/embeddedPageDriver.ts`, over Electron's
 * `webContents`; this one is over the Chrome DevTools Protocol, so that a run
 * on a server — which has no window and no `WebContentsView` — can look at the
 * web app it just built instead of saying "done" on the strength of a green
 * suite.
 *
 * Where the behaviour is shared it is the same behaviour: a twenty-second
 * settle, refusals as sentences rather than exceptions, console and network
 * buffers that are bounded and that answer "since the last time you asked".
 * Two things differ, and both are properties of the browser rather than of this
 * file.
 *
 * ## It can afford the deep verbs, because it is signed in to nothing
 *
 * `cookies`, `storage` and `evaluate` are `false` on the embedded driver
 * because its session is the one the *user* signs into inside Artemis: a tool
 * that could read a cookie value there could read their live session on every
 * site they had visited. This browser has no logins at all. Every context is
 * made for one run and thrown away with it, so a cookie here is test data the
 * agent put there, and `evaluate` can run nothing it could not have run by
 * navigating. All five abilities are true.
 *
 * ## It has a navigation policy the desktop never needed
 *
 * And it is not the desktop's. `DEFAULT_BLOCKED_SITES` is a list of banks and
 * password managers, which exists because the *embedded and extension* browsers
 * hold the user's logins — none of that applies to a browser with no sessions,
 * and applying it here would refuse an agent a public help page for no gain.
 * What this browser has instead is a position: it sits inside the operator's
 * network, so it can route to the LAN and to the cloud metadata service. The
 * rule is therefore the inverse — the public internet is open, and anything
 * internal is shut unless an operator named it. See `serverBrowserPolicy.ts`.
 *
 * Where that policy is applied is this file's business, and it is applied in
 * three places because one was not enough:
 *
 *  - **Before navigating**, on the address the agent named *and on what it
 *    resolves to*. A name check alone was a spelling check:
 *    `169.254.169.254.nip.io` is a public name for the metadata service.
 *  - **On every navigation the browser makes**, from `Page.frameNavigated` and
 *    `Page.navigatedWithinDocument`. A page can move itself with a meta refresh
 *    or a timer, with no tool call anywhere near it, and a policy that only ran
 *    inside `navigate` and `click` never saw that. The listener blanks the tab
 *    and leaves its sentence for the next verb.
 *  - **Before every verb acts**, over the address the tab has now and the
 *    machine the main document was actually served from. The second is what
 *    defeats rebinding between the lookup and the fetch.
 *
 * What none of it covers: a loaded page's own sub-requests, which happen below
 * anything CDP lets a client veto cheaply. Only a network-level rule on the
 * container can, and `docs/SERVER-BROWSER.md` says so and says how.
 *
 * ## One tab, and it may go away between calls
 *
 * Targeting is by closure, as the contract requires: no verb takes an id, and a
 * run's driver reaches that run's tab and no other. A tab a page opens by
 * `window.open` is closed by the manager's sweep, because no tool could name it
 * — the browser gives a run one tab.
 *
 * The manager may also close a run's tab between two tool calls, for being idle
 * or for being too large. When it does it leaves a sentence, and this file's
 * job is to hand that sentence to the model on its next call instead of letting
 * a verb fail against a target that is not there. `browser_open` clears it
 * without comment, because opening is exactly what the sentence asked for.
 */

import type {
  ConsoleEntry,
  CookieEntry,
  DriverResult,
  NetworkEntry,
  PageDriver,
  PageDriverAbilities,
  PageImage,
  PageLocation,
  PageText,
  StorageSnapshot,
} from '@rx-artemis/protocol';

import type { CdpPage } from './cdpPage.js';
import {
  addressStanding,
  navigationStanding,
  navigationStandingFor,
  type HostResolver,
  type ServerBrowserAllowList,
} from './serverBrowserPolicy.js';

/**
 * This browser can do everything the contract describes. See the file header
 * on why, and `embeddedPageDriver.ts` on why the dock browser cannot.
 */
const SERVER_ABILITIES: PageDriverAbilities = {
  console: true,
  network: true,
  cookies: true,
  storage: true,
  evaluate: true,
};

/** The sentence a verb answers with when the run has no tab yet. */
const NO_BROWSER = 'No browser is open for this conversation. Use browser_open first.';

/**
 * How long an action waits to see whether it started a navigation.
 *
 * A click whose handler calls `location.assign` has not navigated by the time
 * the mouse events are acknowledged, so a verb that asked "is anything loading?"
 * at that moment was told no and reported the address the page had *before* the
 * click. Half a second is long enough for a handler to run and short enough
 * that a click which really does nothing does not read as a hang.
 */
const NAVIGATION_GRACE_MS = 500;

/**
 * One run's claim on the server's browser.
 *
 * The seam between this file and `serverBrowser.ts`, which owns the connection,
 * the caps and the clocks. An interface rather than the manager itself so the
 * decisions here — the policy gate, the redirect re-check, the refusal wording
 * — can be asserted against a fake tab, without a socket and without a
 * Chromium.
 */
export interface PageLease {
  /** This run's tab, or `null` when it has none. */
  current(): CdpPage | null;
  /** This run's tab, made if there is none. Throws a sentence when it cannot be. */
  open(): Promise<CdpPage>;
  /** Note that the run used its tab just now, for the idle clock. */
  touch(): void;
  /** Why the tab went away since the last call, once. `null` when nothing happened. */
  takeNotice(): string | null;
  /** The run has finished: close the tab and dispose its context. */
  release(): Promise<void>;
  readonly allowList: ServerBrowserAllowList;
  /**
   * Hostname → addresses, for the half of the policy a name cannot answer.
   *
   * On the lease rather than built here so a test never touches DNS, and so an
   * operator's resolver — the container's, which is what Chromium will use —
   * is the one the gate consults.
   */
  readonly resolveHost: HostResolver;
}

function ok<T>(value: T): DriverResult<T> {
  return { ok: true, value };
}

function no<T>(reason: string): DriverResult<T> {
  return { ok: false, reason };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The browser tool failed.';
}

/**
 * One run's hands on the headless browser beside the server.
 *
 * Built per run by the composition root, closing over that run's lease: a tool
 * therefore acts on the tab belonging to its own conversation, and the model
 * has no way to name a different one because no verb takes an id.
 */
export function cdpPageDriver(lease: PageLease): PageDriver {
  return new CdpPageDriver(lease);
}

class CdpPageDriver implements PageDriver {
  readonly kind = 'server' as const;
  readonly abilities = SERVER_ABILITIES;

  readonly #lease: PageLease;
  /**
   * A refusal the navigation listener recorded, waiting for the next verb.
   *
   * A page can arrive somewhere it may not be with no tool call in flight — a
   * `<meta http-equiv="refresh">`, a `location =` on a timer. The listener
   * cannot answer anybody, so it blanks the tab and leaves the sentence here.
   */
  #blocked: string | null = null;
  /** The tab this driver has hooked the navigation listener onto. */
  #watching: CdpPage | null = null;

  constructor(lease: PageLease) {
    this.#lease = lease;
  }

  async open(url?: string): Promise<DriverResult<PageLocation>> {
    /*
     * The tab may have been closed for being idle since the last call. Opening
     * is what that notice told the model to do, so it is taken and dropped
     * rather than reported: a refusal here would refuse the remedy.
     */
    this.#lease.takeNotice();

    /*
     * The address is checked before anything is created — the name, and then
     * what the name resolves to. An agent asking for `file:///etc/passwd`, for
     * the metadata service, or for a public name that points at it gets the
     * refusal without a context being made, so a denied `open` costs the server
     * nothing and does not spend one of its two context slots.
     */
    if (url !== undefined) {
      const standing = await this.#mayOpen(url);
      if (!standing.allowed) return no(standing.reason);
    }

    try {
      const page = await this.#lease.open();
      this.#watch(page);
      if (url === undefined) return ok(await page.location());
      return await this.#go(page, url);
    } catch (error) {
      return no(messageOf(error));
    }
  }

  async navigate(url: string): Promise<DriverResult<PageLocation>> {
    const page = this.#page();
    if (typeof page === 'string') return no(page);
    const standing = await this.#mayOpen(url);
    if (!standing.allowed) return no(standing.reason);
    try {
      return await this.#go(page, url);
    } catch (error) {
      return no(messageOf(error));
    }
  }

  async read(): Promise<DriverResult<PageText>> {
    return this.#on(async (page) => {
      await page.settle();
      return ok(await page.read());
    });
  }

  async screenshot(): Promise<DriverResult<PageImage>> {
    return this.#on(async (page) => {
      await page.settle();
      return ok(await page.screenshot());
    });
  }

  async click(selector: string): Promise<DriverResult<PageLocation>> {
    return this.#on(async (page) => {
      await page.click(selector);
      /*
       * A click very often navigates, so the verb that follows should not have
       * to guess whether it is looking at the old page — and a link to a denied
       * address is a navigation the first gate never saw. The grace is because
       * a handler that navigates has not navigated yet when the mouse events
       * are acknowledged: see {@link NAVIGATION_GRACE_MS}.
       */
      await page.settle({ graceMs: NAVIGATION_GRACE_MS });
      return this.#whereNow(page, 'That click went to');
    });
  }

  async type(selector: string, text: string): Promise<DriverResult<PageLocation>> {
    return this.#on(async (page) => {
      await page.type(selector, text);
      // Typing can submit: a framework listening for `change` may navigate on
      // the value it just received, and reporting the address the field was on
      // would be reporting the page that is already gone.
      await page.settle({ graceMs: NAVIGATION_GRACE_MS });
      return this.#whereNow(page, 'Typing that took the page to');
    });
  }

  async console(): Promise<DriverResult<readonly ConsoleEntry[]>> {
    return this.#on(async (page) => ok(page.drainConsole()));
  }

  async network(options?: { readonly failedOnly?: boolean }): Promise<DriverResult<readonly NetworkEntry[]>> {
    return this.#on(async (page) => {
      /*
       * Drained whole and filtered afterwards, never filtered at the source: a
       * `failedOnly` call must not quietly throw away the successful requests a
       * later call without the flag was going to report. Failed means the same
       * thing it means on the embedded driver — a transport failure, or a
       * status of 400 and up.
       */
      const entries = page.drainNetwork();
      return ok(
        options?.failedOnly === true
          ? entries.filter((entry) => entry.failure !== undefined || (entry.status ?? 0) >= 400)
          : entries,
      );
    });
  }

  async cookies(): Promise<DriverResult<readonly CookieEntry[]>> {
    return this.#on(async (page) => ok(await page.cookies()));
  }

  async storage(): Promise<DriverResult<StorageSnapshot>> {
    return this.#on(async (page) => ok(await page.storage()));
  }

  async evaluate(expression: string): Promise<DriverResult<unknown>> {
    return this.#on(async (page) => ok(await page.evaluate(expression)));
  }

  /**
   * The run has finished with the browser.
   *
   * A real close, unlike the embedded driver's, which only lets go: that tab
   * belongs to the user's dock and has a tab in their strip, and this one
   * belongs to nobody. The context goes with it, which is what throws away the
   * cookies and the storage — see `serverBrowser.ts`.
   */
  async close(): Promise<void> {
    await this.#lease.release();
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * This run's tab, or the sentence to refuse with.
   *
   * A notice the manager left comes first: "the tab was closed after ten
   * minutes idle" is a better answer than "no browser is open", because it says
   * what happened as well as what to do.
   */
  #page(): CdpPage | string {
    const notice = this.#lease.takeNotice();
    if (notice !== null) return notice;
    const page = this.#lease.current();
    if (page === null) return NO_BROWSER;
    this.#lease.touch();
    return page;
  }

  /**
   * Run a verb on this run's tab, once the page has been checked.
   *
   * The check is here rather than in each verb because "where is this tab
   * *now*" is a question every verb has to ask and none of them is about. A
   * page that moved itself between two tool calls — a meta refresh, a timer
   * calling `location.assign` — is a page `browser_read` must not read, and the
   * verb that would have read it is the only thing with anybody to tell.
   */
  async #on<T>(work: (page: CdpPage) => Promise<DriverResult<T>>): Promise<DriverResult<T>> {
    const page = this.#page();
    if (typeof page === 'string') return no(page);
    try {
      const refusal = await this.#guard(page);
      if (refusal !== null) return no(refusal);
      return await work(page);
    } catch (error) {
      return no(messageOf(error));
    }
  }

  /** Go somewhere, then check where the browser actually ended up. */
  async #go(page: CdpPage, url: string): Promise<DriverResult<PageLocation>> {
    // A deliberate navigation clears whatever the last page did on its way out:
    // the agent is being told where it is going now, not where it was stopped.
    this.#blocked = null;
    await page.navigate(url);
    return this.#whereNow(page, 'That address went to');
  }

  /**
   * May this browser open this address? The name, then what it resolves to.
   *
   * Both halves before anything is created. The resolver is the container's
   * own, which is the one Chromium will use a moment later — see
   * `serverBrowserPolicy.ts` on why a name check alone was a spelling check.
   */
  async #mayOpen(url: string): Promise<{ allowed: boolean; reason: string }> {
    const standing = await navigationStandingFor(url, this.#lease.allowList, this.#lease.resolveHost);
    return standing.allowed ? { allowed: true, reason: '' } : { allowed: false, reason: standing.reason };
  }

  /**
   * Watch where this tab goes, for the navigations no verb asked for.
   *
   * Set once per tab. The listener cannot answer anybody — nothing is waiting
   * on it — so it does the two things it can: blank the tab, and leave the
   * sentence for whichever verb comes next.
   */
  #watch(page: CdpPage): void {
    if (this.#watching === page) return;
    this.#watching = page;
    page.onNavigated((url) => {
      const refusal = this.#verdictOn(page, url);
      if (refusal === null) return;
      /*
       * Neutral about *how* it got there, because the listener cannot tell: a
       * server redirect, a `<meta http-equiv="refresh">` and a timer calling
       * `location.assign` all arrive as the same event. Saying "the page moved
       * itself" would be a guess, and on a plain 302 a wrong one.
       */
      this.#blocked = `The page went to ${url}, which this browser may not open. ${refusal} The tab is now blank.`;
      void page.navigate('about:blank').catch(() => undefined);
    });
  }

  /**
   * Why this tab may not be where it is, or `null`.
   *
   * Two checks over one address: the name, and the machine the main document
   * was actually served from. The second is the one that catches a name which
   * resolved publicly when the driver looked and privately when Chromium
   * fetched — and it is free, because the page recorded it from
   * `Network.responseReceived` on the way in.
   *
   * No resolver here, deliberately. This runs on every verb and inside an event
   * handler; a DNS lookup in both would be a lookup per tool call for a weaker
   * answer than the remote address already gives.
   */
  #verdictOn(page: CdpPage, url: string): string | null {
    // A tab that has not been anywhere sits on about:blank, which is not an
    // http address and would fail the gate for the wrong reason.
    if (url.length === 0 || url === 'about:blank') return null;

    const named = navigationStanding(url, this.#lease.allowList);
    if (!named.allowed) return named.reason;

    const address = page.mainDocumentAddress();
    // `null` is "nothing to check" and not "fine": a data: page, or one whose
    // document had no remote address. See `serverBrowserPolicy.ts` on how
    // narrow that gap is for this browser.
    if (address === null) return null;

    const byAddress = addressStanding(named.host, [address], this.#lease.allowList);
    return byAddress.allowed ? null : byAddress.reason;
  }

  /**
   * The sentence a verb must refuse with before it acts, or `null`.
   *
   * Takes whatever the navigation listener left, and then checks for itself —
   * because the listener fires on `Page.frameNavigated`, and a page can be
   * somewhere new before Chromium has said so.
   */
  async #guard(page: CdpPage): Promise<string | null> {
    const recorded = this.#blocked;
    this.#blocked = null;
    if (recorded !== null) return recorded;

    const at = await page.location();
    const refusal = this.#verdictOn(page, at.url);
    if (refusal === null) return null;
    await page.navigate('about:blank').catch(() => undefined);
    return `This tab is on ${at.url}, which this browser may not open. ${refusal} The tab is now blank.`;
  }

  /**
   * Where the page is now, refused if that is somewhere it may not be.
   *
   * The half of the navigation policy that matters. The first gate reads the
   * address the agent named and what it resolved to; a redirect chain ends
   * somewhere else, and `http://a-public-shortener.example/x` →
   * `http://169.254.169.254/` is one HTTP response away from being the attack
   * this whole policy exists for. So the address the browser *has*, and the
   * machine it actually talked to, are checked too — and a page that got
   * somewhere it should not be is left on `about:blank` rather than sitting
   * loaded with the agent merely told not to read it.
   */
  async #whereNow(page: CdpPage, lead: string): Promise<DriverResult<PageLocation>> {
    // Something moved the page mid-navigation and the listener already acted.
    // Its sentence is more specific than anything this could compose.
    const recorded = this.#blocked;
    this.#blocked = null;
    if (recorded !== null) return no(recorded);

    const at = await page.location();
    const refusal = this.#verdictOn(page, at.url);
    if (refusal === null) return ok(at);

    await page.navigate('about:blank').catch(() => undefined);
    return no(`${lead} ${at.url}, which this browser may not open. ${refusal} The tab is now blank.`);
  }
}
