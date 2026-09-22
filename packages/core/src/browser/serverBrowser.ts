/**
 * Nothing outlives its use: the server browser's lifecycle.
 * ============================================================================
 *
 * The failure this file exists to prevent is a browser holding memory for pages
 * nobody is looking at. It is not hypothetical — a Firefox container on the
 * same host was found holding 2.4 GB for a single tab (David, 2026-09-21) — and
 * the rules below are the answer to it. **None of them can be switched off.**
 * Each is a number an operator may change; none is a boolean an operator may
 * clear, with the single exception noted under "exit when idle", which is a
 * choice between two ways of giving memory back rather than a way of keeping
 * it.
 *
 * Five rules, from the tab outward:
 *
 *  1. **A tab idle for ten minutes is closed.** The clock is tool calls, not
 *     page activity: a page with a `setInterval` is not a conversation that is
 *     using it. The run is told on its next call — see {@link PageLease.takeNotice} —
 *     rather than finding out from a verb that fails for no stated reason.
 *  2. **One tab per run, so a context holds one tab.** The design proposed
 *     three with an LRU rule; the contract that arrived has no tab id on any
 *     verb (`PageDriver` targets by closure), so a second tab would be a tab no
 *     tool could name. A window a *page* opens is closed by the sweep for the
 *     same reason. The "at most three tabs" rule is therefore dropped, not
 *     implemented and disabled — there is nothing for it to bound.
 *  3. **At most two live contexts on the server.** A third run asking is
 *     refused with a sentence it can act on — wait, or close a browser it has
 *     finished with — rather than queued behind a lock it cannot see.
 *  4. **The browser process is not kept when nothing is open.** Five minutes
 *     with no live context and this asks Chromium to exit. See below.
 *  5. **A watchdog, for the case the clocks miss.** Per-tab memory on an
 *     interval; a tab past the ceiling is closed, least recently used first.
 *
 * And a sweep on connect: a server that crashed may have left tabs behind in a
 * browser that outlived it, so on connecting this closes every target and
 * disposes every context it does not own.
 *
 * ## Why `Browser.close` is the right way to exit, here
 *
 * The connection mode is `ARTEMIS_BROWSER_CDP_URL`: a browser in a *separate*
 * container that this process did not start and cannot start. So "exit when
 * idle" is only safe where something else will bring it back, and the
 * recommended compose service is written with `restart: unless-stopped`
 * precisely so that something does. Under that policy `Browser.close` returns
 * the browser's memory to zero — a process that has exited holds nothing — and
 * Docker starts a fresh one, which the next `browser_open` reconnects to with
 * retries.
 *
 * An operator who runs the browser under a policy that will *not* restart it
 * sets `ARTEMIS_BROWSER_IDLE_EXIT=0`. They do not thereby keep the pages: the
 * degraded form closes every target and every context and asks Chromium to
 * free what it can, which is what can be done without ending the process. It
 * is strictly worse — Chromium does not hand memory back to the system readily,
 * which is the whole reason the exit is preferred — and the variable exists so
 * that the default can be the good one without breaking a deployment that
 * cannot take it.
 */

import type { PageDriver } from '@rx-artemis/protocol';

import { CdpConnection, resolveCdpEndpoint, webSocketDialer, type CdpDialer, type EndpointDeps } from './cdp.js';
import { CdpPage, VIEWPORT } from './cdpPage.js';
import { cdpPageDriver, type PageLease } from './cdpPageDriver.js';
import {
  allowListFrom,
  systemHostResolver,
  type HostResolver,
  type ServerBrowserAllowList,
} from './serverBrowserPolicy.js';

/** The numbers an operator may change. None of them may be set to "never". */
export interface ServerBrowserLimits {
  /** Live browser contexts, i.e. runs with a browser open at once. */
  readonly maxContexts: number;
  /** Minutes without a tool call before a run's tab is closed. */
  readonly idleMinutes: number;
  /** Megabytes of heap one tab may hold before it is closed. */
  readonly tabMemoryMb: number;
  /** Minutes with no live context before the browser is asked to exit. */
  readonly idleExitMinutes: number;
  /** Whether the idle exit ends the process. See the file header. */
  readonly idleExit: boolean;
  /** Internal hosts the agent may open. See `serverBrowserPolicy.ts`. */
  readonly allowHosts: readonly string[];
}

/**
 * The defaults, which are the design doc's numbers.
 *
 * Ten minutes is long enough that an agent reading a page, thinking, and coming
 * back keeps its tab, and short enough that a conversation abandoned over lunch
 * is not holding a renderer. Two contexts is deliberately mean: seven agents
 * each with a browser is 2.5 GB, which is the arithmetic that made these rules
 * part of the design rather than tuning.
 */
export const DEFAULT_LIMITS: ServerBrowserLimits = {
  maxContexts: 2,
  idleMinutes: 10,
  tabMemoryMb: 500,
  idleExitMinutes: 5,
  idleExit: true,
  allowHosts: allowListFrom(undefined).allowHosts,
};

/**
 * How often the rules above are checked.
 *
 * Every tab's memory is one CDP round trip, and there are at most two tabs, so
 * this is cheap. Half a minute means a tab that blows past the ceiling is
 * closed within half a minute of doing so, which is inside the time a container
 * with a 1 GB limit survives a leak.
 */
const MAINTENANCE_MS = 30_000;

/** How many times a lazy reconnect is tried, and how long between tries. */
const RECONNECT_TRIES = 12;
const RECONNECT_GAP_MS = 1_000;

/**
 * The clocks and timers, injectable so tests never wait.
 *
 * Every rule in this file is "after N minutes", which is a test that either
 * takes N minutes or controls the clock. `maintain` is public for the same
 * reason: a test advances `now` and calls it, rather than hoping an interval
 * fires.
 */
export interface BrowserTimers {
  now(): number;
  /** Start a repeating timer. Returns the way to stop it. */
  every(ms: number, fn: () => void): () => void;
  /** Wait. Used only between reconnection attempts. */
  after(ms: number): Promise<void>;
}

const REAL_TIMERS: BrowserTimers = {
  now: () => Date.now(),
  every: (ms, fn) => {
    const timer = setInterval(fn, ms);
    // The maintenance timer must not be the reason a server cannot exit.
    timer.unref?.();
    return () => {
      clearInterval(timer);
    };
  },
  after: (ms) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
};

export interface ServerBrowserOptions {
  /** `ARTEMIS_BROWSER_CDP_URL`, in any of the shapes {@link resolveCdpEndpoint} takes. */
  readonly endpoint: string;
  readonly limits?: Partial<ServerBrowserLimits>;
  /** How a socket is opened. Injected by tests. */
  readonly dial?: CdpDialer;
  /** How the endpoint is discovered. Injected by tests. */
  readonly endpointDeps?: EndpointDeps;
  /**
   * Hostname → addresses, for the half of the navigation policy a name cannot
   * answer. The container's own resolver live, a map in tests.
   */
  readonly resolveHost?: HostResolver;
  readonly timers?: BrowserTimers;
  /** Where operational news goes. The server writes it to stderr. */
  readonly log?: (line: string) => void;
}

/** What a host holds: one connection, and the leases it hands to runs. */
export interface ServerBrowser {
  /** A driver for one run. Creates nothing until the run calls `browser_open`. */
  driver(): PageDriver;
  /** Apply the lifecycle rules once. Called on a timer; called directly by tests. */
  maintain(): Promise<void>;
  /** Close everything and let go of the socket. */
  dispose(): Promise<void>;
  readonly limits: ServerBrowserLimits;
}

/** One run's slot: its context, its tab, when it last used them, and what it is owed. */
class Lease implements PageLease {
  page: CdpPage | null = null;
  contextId: string | null = null;
  lastUsedAt: number;
  notice: string | null = null;
  released = false;

  constructor(
    private readonly browser: ServerBrowserImpl,
    now: number,
  ) {
    this.lastUsedAt = now;
  }

  get allowList(): ServerBrowserAllowList {
    return this.browser.allowList;
  }

  get resolveHost(): HostResolver {
    return this.browser.resolveHost;
  }

  current(): CdpPage | null {
    return this.page;
  }

  async open(): Promise<CdpPage> {
    return this.browser.openFor(this);
  }

  touch(): void {
    this.lastUsedAt = this.browser.timers.now();
  }

  takeNotice(): string | null {
    const notice = this.notice;
    this.notice = null;
    return notice;
  }

  async release(): Promise<void> {
    await this.browser.releaseLease(this);
  }
}

class ServerBrowserImpl implements ServerBrowser {
  readonly limits: ServerBrowserLimits;
  readonly allowList: ServerBrowserAllowList;
  readonly timers: BrowserTimers;
  readonly resolveHost: HostResolver;

  readonly #endpoint: string;
  readonly #dial: CdpDialer;
  readonly #endpointDeps: EndpointDeps;
  readonly #log: (line: string) => void;
  readonly #leases = new Set<Lease>();
  /**
   * Every browser context this server made, from the instant Chromium named it.
   *
   * What {@link #sweep} owns things by. A lease records its context too, but a
   * lease is only a lease once `openFor` has finished walking three round
   * trips, and the sweep runs on a timer that does not wait for that.
   */
  readonly #ourContexts = new Set<string>();
  readonly #stopTimer: () => void;

  #cdp: CdpConnection | null = null;
  #connecting: Promise<CdpConnection> | null = null;
  /** When the last context went away, for the idle exit. Null while one is live. */
  #emptySince: number | null;
  #disposed = false;

  constructor(options: ServerBrowserOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.allowList = { allowHosts: this.limits.allowHosts };
    this.timers = options.timers ?? REAL_TIMERS;
    this.resolveHost = options.resolveHost ?? systemHostResolver();
    this.#endpoint = options.endpoint;
    this.#dial = options.dial ?? webSocketDialer();
    this.#endpointDeps = options.endpointDeps ?? {};
    this.#log = options.log ?? (() => undefined);
    this.#emptySince = this.timers.now();
    this.#stopTimer = this.timers.every(MAINTENANCE_MS, () => {
      void this.maintain().catch((error: unknown) => {
        this.#log(`browser maintenance failed: ${messageOf(error)}`);
      });
    });
  }

  driver(): PageDriver {
    const lease = new Lease(this, this.timers.now());
    this.#leases.add(lease);
    return cdpPageDriver(lease);
  }

  /* ---------------------------------------------------------------- */
  /* Opening                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * This run's tab, made if it has none.
   *
   * The cap is counted over *contexts*, not leases: a run that has a driver but
   * has never called `browser_open` costs nothing and is not one of the two.
   */
  async openFor(lease: Lease): Promise<CdpPage> {
    if (this.#disposed) throw new Error('This server is shutting down and cannot open a browser.');
    if (lease.released) throw new Error('This conversation has finished with the browser.');
    if (lease.page !== null) {
      lease.touch();
      return lease.page;
    }

    const live = [...this.#leases].filter((one) => one.contextId !== null).length;
    if (live >= this.limits.maxContexts) {
      throw new Error(
        `The server browser is already open for ${String(live)} other ${
          live === 1 ? 'conversation' : 'conversations'
        }, which is its limit. Wait for one of them to finish, or ask the user to raise ` +
          'ARTEMIS_BROWSER_MAX_CONTEXTS. This is a limit on the server, not a fault in what you asked for.',
      );
    }

    const cdp = await this.#connection();
    const contextId = String(
      (await cdp.call('Target.createBrowserContext', { disposeOnDetach: false }))['browserContextId'],
    );
    /*
     * Claimed the instant the browser names it, and before any `await`.
     *
     * The sweep decides what is ours by *context*, and this is the set it
     * reads. Recording it on the lease alone would leave a window — between
     * `Target.createTarget` answering and `lease.page` being assigned three
     * awaits later — in which a maintenance pass would have seen a target
     * belonging to no lease and closed the tab out from under the run that was
     * still setting it up.
     */
    this.#ourContexts.add(contextId);
    lease.contextId = contextId;
    this.#emptySince = null;

    try {
      const targetId = String(
        (
          await cdp.call('Target.createTarget', {
            url: 'about:blank',
            browserContextId: contextId,
            width: VIEWPORT.width,
            height: VIEWPORT.height,
          })
        )['targetId'],
      );
      const sessionId = String(
        (await cdp.call('Target.attachToTarget', { targetId, flatten: true }))['sessionId'],
      );
      const page = new CdpPage({
        cdp,
        sessionId,
        targetId,
        browserContextId: contextId,
        // The same clock every other deadline here uses, so a test that owns
        // time owns the navigation grace too.
        sleep: (ms) => this.timers.after(ms),
      });
      await page.start();
      lease.page = page;
      lease.touch();
      return page;
    } catch (error) {
      // A context with no tab in it is a context nothing will ever close, and
      // it counts against the cap for the life of the process.
      await cdp.call('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => undefined);
      this.#ourContexts.delete(contextId);
      lease.contextId = null;
      this.#noteEmpty();
      throw error;
    }
  }

  /** A run has finished with its browser. */
  async releaseLease(lease: Lease): Promise<void> {
    lease.released = true;
    this.#leases.delete(lease);
    await this.#closeLease(lease, null);
  }

  /* ---------------------------------------------------------------- */
  /* The rules                                                         */
  /* ---------------------------------------------------------------- */

  async maintain(): Promise<void> {
    if (this.#disposed) return;
    const now = this.timers.now();

    // 1. Tabs nobody has used.
    const idleAfter = this.limits.idleMinutes * 60_000;
    for (const lease of [...this.#leases]) {
      if (lease.page === null) continue;
      if (now - lease.lastUsedAt < idleAfter) continue;
      await this.#closeLease(
        lease,
        `The browser tab for this conversation was closed after ${String(this.limits.idleMinutes)} minutes ` +
          'without a browser tool call, so the server could have its memory back. Nothing is wrong: ' +
          'browser_open starts a new one, at the address you were on if you give it.',
      );
    }

    // 2. Tabs that grew. Least recently used first, so that when a page and its
    //    neighbour are both over the ceiling the one somebody is still reading
    //    is the one told last.
    if (this.#cdp !== null) {
      const ceiling = this.limits.tabMemoryMb * 1024 * 1024;
      const live = [...this.#leases]
        .filter((one) => one.page !== null)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      for (const lease of live) {
        const page = lease.page;
        if (page === null) continue;
        let held: number;
        try {
          held = await page.memoryBytes();
        } catch (error) {
          // A tab that cannot be asked is a tab that is already gone, or a
          // connection that has dropped. Either way the next verb will say so.
          this.#log(`browser watchdog could not read a tab's memory: ${messageOf(error)}`);
          continue;
        }
        if (held <= ceiling) continue;
        await this.#closeLease(
          lease,
          `The browser tab for this conversation was holding ${String(Math.round(held / 1024 / 1024))} MB, ` +
            `past the ${String(this.limits.tabMemoryMb)} MB a tab on this server may hold, and was closed. ` +
            'browser_open starts a new one. If the page really is that large, open it and read it in ' +
            'pieces rather than leaving it loaded.',
        );
      }
    }

    // 3. Targets this server does not own — a crashed predecessor's tabs, or a
    //    window a page opened, which no tool could have driven anyway.
    await this.#sweep();

    // 4. Nothing open for long enough.
    const emptyFor = this.#emptySince === null ? 0 : now - this.#emptySince;
    if (this.#cdp !== null && this.#emptySince !== null && emptyFor >= this.limits.idleExitMinutes * 60_000) {
      await this.#standDown();
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopTimer();
    for (const lease of [...this.#leases]) {
      lease.released = true;
      await this.#closeLease(lease, null);
    }
    this.#leases.clear();
    // Deliberately not `Browser.close`: a server shutting down is not a reason
    // to end a browser another deployment may be sharing, and the container's
    // own lifecycle governs it. What this owns is the socket and the contexts,
    // and both are gone by here.
    this.#cdp?.close();
    this.#cdp = null;
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  /** Close a run's tab and dispose its context, leaving it the sentence why. */
  async #closeLease(lease: Lease, notice: string | null): Promise<void> {
    const page = lease.page;
    const contextId = lease.contextId;
    lease.page = null;
    lease.contextId = null;
    if (notice !== null) lease.notice = notice;

    if (page !== null) {
      page.detach();
      await this.#cdp?.call('Target.closeTarget', { targetId: page.targetId }).catch(() => undefined);
    }
    if (contextId !== null) {
      // Disposing the context is what throws away the cookies and the storage,
      // so two runs testing the same app never share a login. Closing the tab
      // alone would leave the profile behind.
      this.#ourContexts.delete(contextId);
      await this.#cdp
        ?.call('Target.disposeBrowserContext', { browserContextId: contextId })
        .catch(() => undefined);
    }
    this.#noteEmpty();
  }

  /** Start the idle-exit clock when the last context goes. */
  #noteEmpty(): void {
    const anyLive = [...this.#leases].some((one) => one.contextId !== null);
    if (!anyLive && this.#emptySince === null) this.#emptySince = this.timers.now();
  }

  /**
   * Close every target and context this server does not own.
   *
   * Run once on connecting and on every maintenance pass. Measured on Chromium
   * 141 (2026-09-21): closing *every* target leaves the browser running with no
   * targets at all, so this cannot take the browser down by tidying — which the
   * old headless mode, where the last tab closing quit the process, would have.
   *
   * ## Ownership is by context, and that is a correction
   *
   * It used to be by target id, read off `lease.page`. `lease.page` is assigned
   * at the *end* of `openFor`, three round trips after the target exists, so a
   * maintenance pass landing in that window found a target belonging to no
   * lease and closed it — taking the tab out from under a run that was still
   * attaching to it, on a timer, once in a while, and reported as "that browser
   * is no longer open". A context is claimed the instant Chromium names it and
   * released only when it is disposed, so there is no window.
   *
   * It also gets the popup case right for free: a window a page opens with
   * `window.open` lives in *our* context, and closing it needs it to be
   * recognised as ours-but-unwanted rather than as a stranger's.
   */
  async #sweep(): Promise<void> {
    const cdp = this.#cdp;
    if (cdp === null || !cdp.open) return;
    // The tabs the leases are actually driving. Anything else in one of our
    // contexts is a window a page opened, which no tool could name.
    const ours = new Set([...this.#leases].map((one) => one.page?.targetId).filter((id): id is string => id !== undefined));

    let targets: unknown;
    try {
      targets = (await cdp.call('Target.getTargets'))['targetInfos'];
    } catch (error) {
      this.#log(`browser sweep could not list targets: ${messageOf(error)}`);
      return;
    }
    if (!Array.isArray(targets)) return;

    const strayContexts = new Set<string>();
    for (const one of targets) {
      const info = one as { targetId?: unknown; type?: unknown; browserContextId?: unknown };
      const targetId = typeof info.targetId === 'string' ? info.targetId : null;
      if (targetId === null || ours.has(targetId)) continue;
      const contextId = typeof info.browserContextId === 'string' ? info.browserContextId : null;
      /*
       * A target in a context we claimed but that no lease is driving yet is a
       * tab mid-setup. Left alone; the run that is building it will record it a
       * round trip from now, and closing it would be closing our own work.
       */
      if (contextId !== null && this.#ourContexts.has(contextId) && !this.#hasPage(contextId)) continue;
      /*
       * Documents only: `page`, and the two other kinds that render one.
       * `browser`, `service_worker`, `shared_worker` and `other` targets belong
       * to Chromium itself or outlive any one page, and closing them is not
       * tidying — a service worker is how a progressive web app the agent is
       * testing works at all.
       */
      if (info.type !== 'page' && info.type !== 'iframe' && info.type !== 'webview') continue;
      if (contextId !== null && !this.#ourContexts.has(contextId)) strayContexts.add(contextId);
      await cdp.call('Target.closeTarget', { targetId }).catch(() => undefined);
      this.#log(`browser sweep closed a target this server does not own (${targetId}).`);
    }
    for (const contextId of strayContexts) {
      await cdp.call('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => undefined);
    }
  }

  /** Is a lease actually driving a tab in this context yet? */
  #hasPage(contextId: string): boolean {
    return [...this.#leases].some((one) => one.page !== null && one.contextId === contextId);
  }

  /**
   * Give the browser's memory back, by the best route the deployment allows.
   *
   * See the file header on why the exit is the preferred one and what the
   * degraded form does instead.
   */
  async #standDown(): Promise<void> {
    const cdp = this.#cdp;
    if (cdp === null) return;
    this.#emptySince = null;
    await this.#sweep();

    if (!this.limits.idleExit) {
      // Everything a running Chromium can be asked to do. It is not much:
      // Chromium does not return a freed heap to the operating system promptly,
      // which is exactly why the exit above is the default.
      await cdp.call('Memory.forciblyPurgeJavaScriptMemory').catch(() => undefined);
      this.#log('browser idle: closed every context and purged what Chromium would free.');
      return;
    }

    this.#log('browser idle: asking Chromium to exit; the next browser_open starts a new one.');
    await cdp.call('Browser.close').catch(() => undefined);
    cdp.close();
    this.#cdp = null;
  }

  /**
   * The live connection, dialled and swept on first use and after an exit.
   *
   * Retried, because the exit above is expected to be followed by the
   * container's restart policy bringing a new browser up: the next
   * `browser_open` lands in the seconds where nothing is listening, and a
   * refusal there would make the idle exit look like a fault.
   */
  async #connection(): Promise<CdpConnection> {
    if (this.#cdp !== null && this.#cdp.open) return this.#cdp;
    if (this.#connecting !== null) return this.#connecting;

    this.#connecting = (async () => {
      let last: unknown;
      for (let attempt = 0; attempt < RECONNECT_TRIES; attempt += 1) {
        try {
          const endpoint = await resolveCdpEndpoint(this.#endpoint, this.#endpointDeps);
          const connection = new CdpConnection(await this.#dial(endpoint));
          connection.onClosed(() => {
            if (this.#cdp === connection) this.#cdp = null;
            // Context ids belong to the browser that is gone. Keeping them
            // would make the next browser's sweep spare a stranger's tabs that
            // happened to reuse an id.
            this.#ourContexts.clear();
            // Every lease's tab died with the socket. Say so, rather than
            // letting the next verb fail against a target that is not there.
            for (const lease of this.#leases) {
              if (lease.page === null && lease.contextId === null) continue;
              lease.page = null;
              lease.contextId = null;
              lease.notice =
                'The browser this conversation was using went away — it was restarted, or it ran out ' +
                'of memory. browser_open starts a new one.';
            }
            this.#noteEmpty();
          });
          this.#cdp = connection;
          await this.#sweep();
          return connection;
        } catch (error) {
          last = error;
          if (attempt < RECONNECT_TRIES - 1) await this.timers.after(RECONNECT_GAP_MS);
        }
      }
      throw new Error(
        `Could not reach the browser at ${this.#endpoint}: ${messageOf(last)}. ` +
          'It may be starting; try again in a moment. If it keeps happening the browser service is down.',
      );
    })().finally(() => {
      this.#connecting = null;
    });

    return this.#connecting;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One server's browser, or nothing when no browser is configured.
 *
 * Built once per process by the composition root. Nothing is dialled here: a
 * server whose runs never open a browser never opens a socket, which is what
 * makes it safe to build this whenever the variable is set.
 */
export function createServerBrowser(options: ServerBrowserOptions): ServerBrowser {
  return new ServerBrowserImpl(options);
}

/**
 * Read the limits an operator set out of the environment.
 *
 * Every value is validated and an unusable one is ignored rather than fatal: a
 * typo in a ceiling must not stop a server from starting, and the default it
 * falls back to is the safe number. The one flag, `ARTEMIS_BROWSER_IDLE_EXIT`,
 * is on unless it is explicitly `0` or `false` — see the file header on why it
 * is a choice between two ways of giving memory back and not a way of keeping
 * it.
 */
export function limitsFromEnvironment(env: Record<string, string | undefined>): ServerBrowserLimits {
  const positive = (name: string, fallback: number): number => {
    const declared = Number(env[name]);
    return Number.isFinite(declared) && declared > 0 ? declared : fallback;
  };
  const idleExit = (env['ARTEMIS_BROWSER_IDLE_EXIT'] ?? '').trim().toLowerCase();
  return {
    maxContexts: Math.floor(positive('ARTEMIS_BROWSER_MAX_CONTEXTS', DEFAULT_LIMITS.maxContexts)),
    idleMinutes: positive('ARTEMIS_BROWSER_IDLE_MINUTES', DEFAULT_LIMITS.idleMinutes),
    tabMemoryMb: positive('ARTEMIS_BROWSER_TAB_MEMORY_MB', DEFAULT_LIMITS.tabMemoryMb),
    idleExitMinutes: DEFAULT_LIMITS.idleExitMinutes,
    idleExit: idleExit !== '0' && idleExit !== 'false' && idleExit !== 'off',
    allowHosts: allowListFrom(env['ARTEMIS_BROWSER_ALLOW_HOSTS']).allowHosts,
  };
}
