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
 * internal is shut unless an operator named it. See `serverBrowserPolicy.ts`,
 * and note what it cannot do: a page's own sub-requests are not filtered by it,
 * and only a network-level rule on the container can be.
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
import { navigationStanding, type ServerBrowserAllowList } from './serverBrowserPolicy.js';

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
     * The address is checked before anything is created. An agent asking for
     * `file:///etc/passwd` or for the metadata service gets the refusal without
     * a context being made, so a denied `open` costs the server nothing and
     * does not spend one of its two context slots.
     */
    if (url !== undefined) {
      const standing = navigationStanding(url, this.#lease.allowList);
      if (!standing.allowed) return no(standing.reason);
    }

    try {
      const page = await this.#lease.open();
      if (url === undefined) return ok(await page.location());
      return await this.#go(page, url);
    } catch (error) {
      return no(messageOf(error));
    }
  }

  async navigate(url: string): Promise<DriverResult<PageLocation>> {
    const page = this.#page();
    if (typeof page === 'string') return no(page);
    const standing = navigationStanding(url, this.#lease.allowList);
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
      // A click very often navigates, so the verb that follows should not have
      // to guess whether it is looking at the old page — and a link to a denied
      // address is a navigation the first gate never saw.
      await page.settle();
      return this.#whereNow(page, 'That link went to');
    });
  }

  async type(selector: string, text: string): Promise<DriverResult<PageLocation>> {
    return this.#on(async (page) => {
      await page.type(selector, text);
      return ok(await page.location());
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

  /** Run a verb on this run's tab, turning a throw into the contract's refusal. */
  async #on<T>(work: (page: CdpPage) => Promise<DriverResult<T>>): Promise<DriverResult<T>> {
    const page = this.#page();
    if (typeof page === 'string') return no(page);
    try {
      return await work(page);
    } catch (error) {
      return no(messageOf(error));
    }
  }

  /** Go somewhere, then check where the browser actually ended up. */
  async #go(page: CdpPage, url: string): Promise<DriverResult<PageLocation>> {
    await page.navigate(url);
    return this.#whereNow(page, 'That address redirected to');
  }

  /**
   * Where the page is now, refused if that is somewhere it may not be.
   *
   * The second half of the navigation policy, and the half that matters. The
   * first gate reads the address the agent named; a redirect chain ends
   * somewhere else, and `http://a-public-shortener.example/x` → `http://169.254.169.254/`
   * is one HTTP response away from being the attack this whole policy exists
   * for. So the address the browser *has* is checked too, and a page that got
   * somewhere it should not be is left on `about:blank` rather than sitting
   * loaded with the agent merely told not to read it.
   */
  async #whereNow(page: CdpPage, lead: string): Promise<DriverResult<PageLocation>> {
    const at = await page.location();
    // A page that has not navigated at all sits on about:blank, which is not an
    // http address and would fail the gate for the wrong reason.
    if (at.url.length === 0 || at.url === 'about:blank') return ok(at);

    const standing = navigationStanding(at.url, this.#lease.allowList);
    if (standing.allowed) return ok(at);

    await page.navigate('about:blank').catch(() => undefined);
    return no(`${lead} ${at.url}, which this browser may not open. ${standing.reason} The tab is now blank.`);
  }
}
