/**
 * A served run's browser, on the caller's own machine.
 * ============================================================================
 *
 * A run executing on an Artemis Server has three possible browsers and this is
 * the odd one: it is not on the serving machine at all. The agent asks for a
 * page; the server publishes that verb to **the connection the run came in
 * on**; the desktop client at the other end of that connection performs it
 * through the extension paired with *its* Chrome, and posts the answer back.
 *
 * David's decision of 2026-09-21 (issue #436): the agent stays where it is and
 * sends actions, and the client passes them on. A second agent on the client
 * was considered and set aside — it needs model credentials on the client, a
 * second set of approvals, and leaves the main agent reading summaries.
 *
 * ## Why this is not on the run's own event stream
 *
 * An `AgentEvent` describes what a run *did*; this asks a client to do
 * something and waits. Putting a question on the stream every client replays
 * would mean a reconnecting client answering a verb from ten minutes ago, and
 * a second client watching the same run answering a verb addressed to the
 * first. So it rides the push feed with {@link FeedScope.connectionId} set,
 * which is the axis that names a connection rather than describing an
 * audience, and the answer route checks the same id again.
 *
 * ## Nothing here is tailnet-specific, and that is the point
 *
 * The extension knows only about the Artemis on its own machine. A served
 * conversation reaches it over the connection the client already has, whatever
 * that connection is made of. Issue #436 states this as a property to keep:
 * a person running Artemis as a plain desktop app needs nothing
 * tunnel-related, and the extension never learns that servers exist.
 *
 * ## Three ways an answer does not come
 *
 * The client is not connected; the client is connected but has no paired
 * browser; the client took too long. The first and third are this file's to
 * report, in a sentence the agent can repeat. The second is the *client's*, and
 * it reports it by performing the verb against its own driver and posting that
 * driver's refusal — so the sentence a served run gets is word for word the
 * one a local run would have got, written once in `extensionPageDriver.ts`.
 *
 * ## Which of the caller's browsers, and who decides
 *
 * A caller may have a work Chrome and a personal one paired with their client.
 * Nothing on this machine can tell them apart — the pairings are on the client,
 * which is the only side holding the list — so the choice is carried and never
 * interpreted here. `artemis.extensionBrowserId` arrives as an id and rides on
 * every call; when the caller chose nothing and the client finds two browsers
 * open, the *client's* driver refuses with the sentence that asks which, that
 * sentence reaches the model unchanged, and the model's answer comes back as a
 * name on `browser_open`. A name and an id look alike from here, and that is
 * fine: this file passes whichever it was given, and the client resolves it.
 *
 * The answer is taken once, and only for a run that arrived without a browser.
 * A caller who sent `artemis.extensionBrowserId` pinned that conversation to
 * one of their own browsers, and a model that could move it afterwards could
 * act as a different signed-in person because a page it was reading suggested
 * it. See {@link RelayedPageDriver.open}.
 */

import { randomBytes } from 'node:crypto';

import type {
  BridgeVerb,
  ConsoleEntry,
  CookieEntry,
  DriverResult,
  NetworkEntry,
  PageDriver,
  PageDriverAbilities,
  PageImage,
  PageLocation,
  PageText,
  ServerBrowserCall,
  StorageSnapshot,
} from '@rx-artemis/protocol';

/* -------------------------------------------------------------------------- */
/* Timeouts                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How long a verb that waits for a page to load is given.
 *
 * The same twenty seconds `extensionPageDriver.ts` allows, plus nothing for
 * the network hop. That is deliberate: the client's own driver holds a
 * twenty-second deadline of its own and answers with a refusal when it passes,
 * so the answer to a slow page arrives *as an answer*. This deadline is for
 * the case where no answer is coming at all, and making it longer would only
 * make that case slower to find out about.
 */
const LOAD_TIMEOUT_MS = 20_000;

/** How long a verb that only asks the page a question is given. */
const ASK_TIMEOUT_MS = 12_000;

/** How long a screenshot is given. Between the two; the image crosses a wire. */
const SHOT_TIMEOUT_MS = 18_000;

/** How long the closing call is given. The run is over; nobody is waiting. */
const CLOSE_TIMEOUT_MS = 5_000;

/* -------------------------------------------------------------------------- */
/* The sentences                                                              */
/* -------------------------------------------------------------------------- */

/** What the model is told when nothing is listening at the other end. */
const NO_CLIENT =
  'The client that owns the browser is not connected. This conversation runs ' +
  'on an Artemis Server, and the browser it drives is on the machine the user ' +
  'started it from — so it is reachable only while their Artemis is running ' +
  'and connected. Ask them to open Artemis, and say when it is back. Until ' +
  'then you have no browser at all — do not describe pages you have not seen.';

/**
 * What the model is told when it names a browser for a conversation that
 * already has one.
 *
 * Unnamed on purpose, unlike the desktop driver's version of this sentence.
 * The selector in force here may be an id the caller's client issued, and this
 * machine has never seen the list that would turn it into a name — printing
 * the id instead would be a sentence the user cannot read either.
 */
const ALREADY_CHOSEN =
  'This conversation is already set to one of the browsers on the user’s machine, ' +
  'so it cannot be moved to another one from here. Carry on in the browser it has, ' +
  'or tell the user what you wanted the other one for — changing it is done in the ' +
  'conversation’s own Browser row, by them. Do not work around this.';

function timedOut(seconds: number): string {
  return (
    `The client that owns the browser did not answer within ${String(seconds)} seconds. ` +
    'Their Artemis may have gone offline, or the page may still be loading. ' +
    'Try once more; if it happens again, ask the user whether Artemis is still running.'
  );
}

/* -------------------------------------------------------------------------- */
/* The relay                                                                  */
/* -------------------------------------------------------------------------- */

/** Why an answer was refused. `null` means it was accepted. */
export type AnswerOutcome = null | 'unknown-call' | 'wrong-connection';

export interface BrowserRelay {
  /**
   * A driver for one served run, publishing to one connection.
   *
   * Built per run by the host, closing over the connection that started it —
   * targeting is a closure here for the same reason it is everywhere else in
   * the browser tools: no verb takes a client id, so an agent cannot name a
   * machine that is not the one its conversation came from.
   *
   * `browser` says which of *that machine's* paired browsers to drive, from
   * `artemis.extensionBrowserId`. It is carried and never interpreted: the
   * list it names is on the client, and the client resolves it.
   */
  driverFor(connectionId: string, runKey: string, browser?: string): PageDriver;
  /**
   * Settle a call with what the client's browser said.
   *
   * Takes the answering connection's id and checks it against the one the call
   * was addressed to. The id is already unguessable, so this is the second
   * lock on the same door — and the one that holds when a call id leaks into a
   * log that a second connection's owner can read.
   */
  answer(
    connectionId: string,
    callId: string,
    result: DriverResult<unknown>,
  ): AnswerOutcome;
  /** How many calls are outstanding. For tests, and for a health read. */
  pendingCount(): number;
}

export interface BrowserRelayOptions {
  /**
   * Put one verb on the feed, scoped to the connection it is addressed to.
   *
   * Injected rather than taking the feed itself, so this module knows nothing
   * about channels or scopes and a test can watch what was published without
   * standing up a stream.
   */
  readonly publish: (connectionId: string, call: ServerBrowserCall) => void;
  /** Whether that connection has a live event stream. Absent means "assume so". */
  readonly isConnected?: (connectionId: string) => boolean;
}

interface Pending {
  readonly connectionId: string;
  readonly settle: (result: DriverResult<unknown>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createBrowserRelay(options: BrowserRelayOptions): BrowserRelay {
  const pending = new Map<string, Pending>();

  function send(
    connectionId: string,
    runKey: string,
    verb: BridgeVerb,
    timeoutMs: number,
    browser?: string,
  ): Promise<DriverResult<unknown>> {
    if (options.isConnected?.(connectionId) === false) {
      return Promise.resolve({ ok: false, reason: NO_CLIENT });
    }
    /*
     * Sixteen random bytes, not a counter. A call id is the only thing an
     * answer names, so a predictable one would let a connection that guessed
     * it answer a call it never received — and the connection check below
     * would be the only thing standing in the way. Two locks, one door.
     */
    const callId = randomBytes(16).toString('hex');

    return new Promise<DriverResult<unknown>>((resolve) => {
      let settled = false;
      const settle = (result: DriverResult<unknown>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(callId);
        resolve(result);
      };
      const timer = setTimeout(() => {
        settle({ ok: false, reason: timedOut(Math.round(timeoutMs / 1000)) });
      }, timeoutMs);
      timer.unref?.();
      pending.set(callId, { connectionId, settle, timer });

      try {
        options.publish(connectionId, {
          object: 'artemis.browser.call',
          callId,
          runId: runKey,
          runKey,
          // On every call and not only the first. The client builds a driver
          // per call and keeps nothing between them, so a choice stated once
          // would be a choice forgotten by the next verb — and the next verb
          // would be the ambiguous one again.
          ...(browser === undefined ? {} : { browserId: browser }),
          ...verb,
        });
      } catch {
        // A feed that threw is a client that will never hear the question.
        // Answering now beats waiting out the deadline to say the same thing.
        settle({ ok: false, reason: NO_CLIENT });
      }
    });
  }

  return {
    driverFor: (connectionId, runKey, browser) =>
      new RelayedPageDriver(connectionId, runKey, send, browser),

    answer: (connectionId, callId, result) => {
      const waiting = pending.get(callId);
      // Deliberately the same answer for "no such call" and "already settled".
      // A caller that could tell them apart could probe which ids exist.
      if (waiting === undefined) return 'unknown-call';
      if (waiting.connectionId !== connectionId) return 'wrong-connection';
      waiting.settle(result);
      return null;
    },

    pendingCount: () => pending.size,
  };
}

/* -------------------------------------------------------------------------- */
/* The driver                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every ability, for the reason the extension driver claims them all: the page
 * policy is enforced inside the user's browser, two machines away from here,
 * and a tool absent on this side would read to the model as a browser that
 * cannot rather than a site where it may not.
 */
const RELAYED_ABILITIES: PageDriverAbilities = {
  console: true,
  network: true,
  cookies: true,
  storage: true,
  evaluate: true,
};

type Send = (
  connectionId: string,
  runKey: string,
  verb: BridgeVerb,
  timeoutMs: number,
  browser?: string,
) => Promise<DriverResult<unknown>>;

/**
 * One served run's hands on the caller's own browser.
 *
 * `kind: 'extension'` and not a fourth kind, deliberately. The wording the
 * tools give the model — "your tabs live in a tab group Artemis keeps to
 * itself", "treat it as someone else's signed-in browser" — is true of this
 * browser in exactly the same way, because it *is* that browser. A fourth kind
 * would mean a fourth set of instructions saying the same things, and the one
 * thing that differs (the client can go offline) is already said by the
 * refusals rather than by the instructions.
 */
class RelayedPageDriver implements PageDriver {
  readonly kind = 'extension' as const;
  readonly abilities = RELAYED_ABILITIES;

  readonly #connectionId: string;
  readonly #runKey: string;
  readonly #send: Send;

  /**
   * Which of the caller's browsers, as the caller named it, or `null` for
   * whichever of them is open.
   *
   * Mutable for the one case that changes it: the client refused a verb
   * because two of the user's browsers were connected and neither had been
   * chosen, the agent asked the user, and the answer came back as a name on
   * `browser_open`. Nothing on this machine can check that name — the list is
   * on the client — so it is stored as given and sent as given.
   */
  #browser: string | null;

  constructor(connectionId: string, runKey: string, send: Send, browser?: string) {
    this.#connectionId = connectionId;
    this.#runKey = runKey;
    this.#send = send;
    this.#browser = browser ?? null;
  }

  /**
   * Open this run's page, and take the agent's answer to "which browser?" —
   * once, and only for a run that had no browser.
   *
   * Remembered here, on the server, rather than on the client: the client
   * builds a driver per relayed call and holds nothing between them, so the
   * only place a choice can outlive one verb is the driver the run owns. It is
   * kept only once the client has driven something with it. Nothing here can
   * tell a mistyped name from a page that would not load — the list is on the
   * client, and what comes back is a sentence — so a first answer the client
   * refuses is let go of again, and the agent can answer once more. Kept, a
   * wrong name would be a dead end: every later verb refused as unknown, every
   * correction refused as a move.
   *
   * A run that arrived with `artemis.extensionBrowserId` was never asked the
   * question, so the argument is refused for it: the caller pinned that
   * conversation to one of their browsers, and a model that could move it
   * could act as a different signed-in person because a page suggested it.
   * Repeating the selector already in force is not a move and carries on
   * quietly; comparison is textual, because the two spellings a selector can
   * have — an id and a name — are only comparable on the client.
   */
  async open(url?: string, browser?: string): Promise<DriverResult<PageLocation>> {
    const named = browser?.trim() ?? '';
    let firstAnswer = false;
    if (named.length > 0) {
      if (this.#browser === null) {
        this.#browser = named;
        firstAnswer = true;
      } else if (this.#browser.trim().toLowerCase() !== named.toLowerCase()) {
        return { ok: false, reason: ALREADY_CHOSEN };
      }
    }
    const result = await this.#ask<PageLocation>(
      url === undefined ? { verb: 'open' } : { verb: 'open', url },
      LOAD_TIMEOUT_MS,
    );
    if (firstAnswer && !result.ok) this.#browser = null;
    return result;
  }

  async navigate(url: string): Promise<DriverResult<PageLocation>> {
    return this.#ask<PageLocation>({ verb: 'navigate', url }, LOAD_TIMEOUT_MS);
  }

  async read(): Promise<DriverResult<PageText>> {
    return this.#ask<PageText>({ verb: 'read' }, ASK_TIMEOUT_MS);
  }

  async screenshot(): Promise<DriverResult<PageImage>> {
    return this.#ask<PageImage>({ verb: 'screenshot' }, SHOT_TIMEOUT_MS);
  }

  async click(selector: string): Promise<DriverResult<PageLocation>> {
    return this.#ask<PageLocation>({ verb: 'click', selector }, LOAD_TIMEOUT_MS);
  }

  async type(selector: string, text: string): Promise<DriverResult<PageLocation>> {
    return this.#ask<PageLocation>({ verb: 'type', selector, text }, ASK_TIMEOUT_MS);
  }

  async console(): Promise<DriverResult<readonly ConsoleEntry[]>> {
    return this.#ask<readonly ConsoleEntry[]>({ verb: 'console' }, ASK_TIMEOUT_MS);
  }

  async network(options?: {
    readonly failedOnly?: boolean;
  }): Promise<DriverResult<readonly NetworkEntry[]>> {
    return this.#ask<readonly NetworkEntry[]>(
      { verb: 'network', failedOnly: options?.failedOnly === true },
      ASK_TIMEOUT_MS,
    );
  }

  async cookies(): Promise<DriverResult<readonly CookieEntry[]>> {
    return this.#ask<readonly CookieEntry[]>({ verb: 'cookies' }, ASK_TIMEOUT_MS);
  }

  async storage(): Promise<DriverResult<StorageSnapshot>> {
    return this.#ask<StorageSnapshot>({ verb: 'storage' }, ASK_TIMEOUT_MS);
  }

  async evaluate(expression: string): Promise<DriverResult<unknown>> {
    return this.#ask<unknown>({ verb: 'evaluate', expression }, ASK_TIMEOUT_MS);
  }

  async close(): Promise<void> {
    await this.#ask<unknown>({ verb: 'close' }, CLOSE_TIMEOUT_MS);
  }

  /** See `extensionPageDriver.ts` on why the value is not re-derived here. */
  async #ask<T>(verb: BridgeVerb, timeoutMs: number): Promise<DriverResult<T>> {
    return (await this.#send(
      this.#connectionId,
      this.#runKey,
      verb,
      timeoutMs,
      this.#browser ?? undefined,
    )) as DriverResult<T>;
  }
}

/** The refusal sentences, exported for the tests that pin them. */
export const RELAY_REFUSALS = { NO_CLIENT, timedOut, ALREADY_CHOSEN } as const;
