/**
 * The user's own Chrome, as a {@link PageDriver}.
 * ============================================================================
 *
 * `embeddedPageDriver.ts` drives a `WebContentsView` by calling into Chromium
 * in this process. This driver has no page to call into: the page is in a
 * browser Artemis does not own, on the other side of a WebSocket the extension
 * dialled in on (`extensionBridge.ts`). So every verb here is the same shape —
 * put a {@link BridgeCall} on the wire with a fresh id and this run's key, wait
 * for the {@link BridgeResult} that carries the same id, hand back what it says
 * — and the interesting decisions are about what happens when the answer does
 * not come.
 *
 * ## Every ability is claimed, and the browser is what says no
 *
 * The embedded driver declines `cookies`, `storage` and `evaluate` outright,
 * because it has one session shared by every dock tab and no per-site anything.
 * This driver claims all five, and that is not Artemis being more relaxed about
 * a browser full of the user's logins — it is Artemis being in the wrong place
 * to decide. {@link PagePolicy} is enforced **inside the extension**, against
 * the address the tab actually has, so that a compromised or impersonated
 * Artemis cannot talk its way past it. A copy of the check here would be a
 * second opinion that is sometimes wrong and always redundant, and — worse —
 * a tool absent on this side would look to the model like a browser that cannot
 * do the thing, rather than a site where it is not allowed. The extension
 * refuses in words, through the contract's own `DriverResult`, and those words
 * reach the model unchanged.
 *
 * ## The refusals are the product
 *
 * Three things go wrong that are not the page's fault: no browser has ever been
 * paired, a paired browser's Chrome is not running, and a browser that is
 * connected does not answer in time. All three arrive at the model as a
 * sentence naming the actual situation and the actual remedy, because the agent
 * is the only party in the room who can tell the user — nobody is watching a
 * tool call fail. A thrown error, or a generic "the browser tool failed", would
 * have the agent guess: usually that the *page* is broken, which sends it
 * looking for a bug that is not there.
 *
 * ## Timeouts are per verb, not per driver
 *
 * A `navigate` that waits twenty seconds is waiting for a page to load, which
 * is a thing pages do. A `cookies` that waits twenty seconds is waiting for a
 * service worker that is never going to answer. One number for both would have
 * to be the larger, and the whole value of the refusal is that the agent gets
 * it while the turn is still worth continuing.
 */

import { randomUUID } from 'node:crypto';

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
  RunId,
  StorageSnapshot,
} from '@rx-artemis/protocol';

/* -------------------------------------------------------------------------- */
/* What the driver needs from the bridge                                      */
/* -------------------------------------------------------------------------- */

/**
 * How one call came out, before it is turned into words.
 *
 * Four cases and not a `DriverResult`, so that the sentences the model reads
 * live in this file with the rest of the driver's voice rather than in the
 * socket plumbing. `answered` carries the extension's own `DriverResult`
 * through untouched — a refusal it wrote is a refusal Artemis has nothing to
 * add to.
 */
export type BridgeCallOutcome =
  | { readonly status: 'answered'; readonly result: DriverResult<unknown> }
  /** No browser has ever been paired with this Artemis. */
  | { readonly status: 'unpaired' }
  /** A browser is paired, but nothing is connected right now. */
  | { readonly status: 'disconnected' }
  /** Sent, and nothing came back before the deadline. */
  | { readonly status: 'timeout' };

/**
 * The part of the bridge a driver uses.
 *
 * An interface rather than the bridge itself so the driver's decisions — the
 * verb mapping, the timeouts, the wording — can be exercised against a fake
 * that answers. Standing up a real WebSocket to assert that `read` says
 * `{ verb: 'read' }` would test `ws`.
 */
export interface ExtensionDriverHost {
  /**
   * Put one verb on the wire and wait for its answer.
   *
   * Contracted never to reject: everything that can go wrong is one of the
   * {@link BridgeCallOutcome} cases, because a driver's job is to answer.
   */
  call(
    runKey: string,
    id: string,
    verb: BridgeVerb,
    timeoutMs: number,
  ): Promise<BridgeCallOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Timeouts                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How long a verb that waits for a page to load is given.
 *
 * The same twenty seconds the embedded driver's `#settle` allows, and for the
 * same reason: a page still streaming after twenty seconds is usually a page
 * whose content arrived nineteen seconds ago with an analytics beacon still
 * open. `click` is here because a click very often navigates.
 */
const LOAD_TIMEOUT_MS = 20_000;

/**
 * How long a verb that only asks the page a question is given.
 *
 * Long enough for a service worker Chrome had parked to be woken and to reach
 * a content script; short enough that an agent told "the browser did not
 * answer" still has a turn left to do something else.
 */
const ASK_TIMEOUT_MS = 10_000;

/**
 * How long a screenshot is given.
 *
 * Between the two: capturing and base64-encoding a long page is real work in
 * the browser, and a slow machine doing it is not a fault.
 */
const SHOT_TIMEOUT_MS = 15_000;

/**
 * How long the closing call is given.
 *
 * Short on purpose. The run is over; nothing is waiting on the answer, and the
 * tab going away is the browser's business either way.
 */
const CLOSE_TIMEOUT_MS = 5_000;

/* -------------------------------------------------------------------------- */
/* The sentences                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What the model is told when no browser has been paired.
 *
 * It names the pane, because "pair a browser" is not a thing anyone can act on
 * without being told where, and the agent is the only one who will say it.
 */
const UNPAIRED =
  'The Artemis extension is not connected: no browser has been paired with ' +
  'Artemis yet. Ask the user to open Artemis settings → Browser, pair their ' +
  'Chrome with the code shown there, and say when it is done. Until then you ' +
  'have no browser at all — do not describe pages you have not seen.';

/** What the model is told when the paired browser's Chrome is not running. */
const DISCONNECTED =
  'The Artemis extension is not connected. Ask the user to open Chrome with ' +
  'the Artemis extension enabled, and say when it is running. Until then you ' +
  'have no browser at all — do not describe pages you have not seen.';

/**
 * What the model is told when a connected browser did not answer.
 *
 * Distinct from {@link DISCONNECTED} because the remedies are different and
 * one of them is "try again": a Chrome whose service worker was asleep answers
 * the second call, and a page mid-load finishes.
 */
function timedOut(seconds: number): string {
  return (
    `The browser did not answer within ${String(seconds)} seconds. It may be ` +
    'busy, or the page may still be loading. Try once more; if it happens ' +
    'again, ask the user whether Chrome is responding.'
  );
}

/* -------------------------------------------------------------------------- */
/* The driver                                                                 */
/* -------------------------------------------------------------------------- */

/** Every deep verb, because the browser is where the policy is applied. */
const EXTENSION_ABILITIES: PageDriverAbilities = {
  console: true,
  network: true,
  cookies: true,
  storage: true,
  evaluate: true,
};

/**
 * One run's hands on the user's own Chrome.
 *
 * Built per run by the composition root, closing over that run's id, which is
 * also the `runKey` the extension files the tab under. Targeting is therefore
 * a closure exactly as it is for the dock browser: no verb takes a tab id, so
 * the model cannot name a page belonging to another conversation, and the
 * extension would not honour it if it did — it only knows the key it was told.
 */
export function extensionPageDriver(runId: RunId, bridge: ExtensionDriverHost): PageDriver {
  return new ExtensionPageDriver(runId, bridge);
}

class ExtensionPageDriver implements PageDriver {
  readonly kind = 'extension' as const;
  readonly abilities = EXTENSION_ABILITIES;

  readonly #runKey: string;
  readonly #bridge: ExtensionDriverHost;

  constructor(runId: RunId, bridge: ExtensionDriverHost) {
    this.#runKey = runId;
    this.#bridge = bridge;
  }

  async open(url?: string): Promise<DriverResult<PageLocation>> {
    return this.#send<PageLocation>(
      url === undefined ? { verb: 'open' } : { verb: 'open', url },
      LOAD_TIMEOUT_MS,
    );
  }

  async navigate(url: string): Promise<DriverResult<PageLocation>> {
    return this.#send<PageLocation>({ verb: 'navigate', url }, LOAD_TIMEOUT_MS);
  }

  async read(): Promise<DriverResult<PageText>> {
    return this.#send<PageText>({ verb: 'read' }, ASK_TIMEOUT_MS);
  }

  async screenshot(): Promise<DriverResult<PageImage>> {
    return this.#send<PageImage>({ verb: 'screenshot' }, SHOT_TIMEOUT_MS);
  }

  async click(selector: string): Promise<DriverResult<PageLocation>> {
    return this.#send<PageLocation>({ verb: 'click', selector }, LOAD_TIMEOUT_MS);
  }

  async type(selector: string, text: string): Promise<DriverResult<PageLocation>> {
    return this.#send<PageLocation>({ verb: 'type', selector, text }, ASK_TIMEOUT_MS);
  }

  async console(): Promise<DriverResult<readonly ConsoleEntry[]>> {
    return this.#send<readonly ConsoleEntry[]>({ verb: 'console' }, ASK_TIMEOUT_MS);
  }

  async network(options?: {
    readonly failedOnly?: boolean;
  }): Promise<DriverResult<readonly NetworkEntry[]>> {
    return this.#send<readonly NetworkEntry[]>(
      { verb: 'network', failedOnly: options?.failedOnly === true },
      ASK_TIMEOUT_MS,
    );
  }

  async cookies(): Promise<DriverResult<readonly CookieEntry[]>> {
    return this.#send<readonly CookieEntry[]>({ verb: 'cookies' }, ASK_TIMEOUT_MS);
  }

  async storage(): Promise<DriverResult<StorageSnapshot>> {
    return this.#send<StorageSnapshot>({ verb: 'storage' }, ASK_TIMEOUT_MS);
  }

  async evaluate(expression: string): Promise<DriverResult<unknown>> {
    return this.#send<unknown>({ verb: 'evaluate', expression }, ASK_TIMEOUT_MS);
  }

  /**
   * Let go of this run's tab.
   *
   * A real close, unlike the embedded driver's: the tab is in a tab group
   * Artemis put there, opened by an agent rather than by the user, and leaving
   * it behind would have a week of conversations accumulate in someone's
   * browser. The answer is discarded — the run is over and there is nobody to
   * report it to — but the call is still awaited so a browser that is mid-reply
   * is not cut off in the same tick.
   */
  async close(): Promise<void> {
    await this.#bridge.call(this.#runKey, freshId(), { verb: 'close' }, CLOSE_TIMEOUT_MS);
  }

  /**
   * One verb, from the wire's vocabulary to the contract's.
   *
   * The cast on the extension's value is the one unchecked step in this file
   * and it is deliberate: {@link BridgeResult} carries `DriverResult<unknown>`,
   * because the wire cannot know which verb an id belonged to, and re-deriving
   * that here would mean a validator per verb — twelve schemas that would each
   * have to be kept in step with the contract they already are the contract of.
   * What the tools do with the value is render it, and a renderer that meets a
   * missing field prints an empty column rather than crashing; the boundary
   * that matters, the one where a *stranger* could send this, is the bridge's
   * handshake, not this line.
   */
  async #send<T>(verb: BridgeVerb, timeoutMs: number): Promise<DriverResult<T>> {
    const outcome = await this.#bridge.call(this.#runKey, freshId(), verb, timeoutMs);
    switch (outcome.status) {
      case 'answered':
        return outcome.result as DriverResult<T>;
      case 'unpaired':
        return { ok: false, reason: UNPAIRED };
      case 'disconnected':
        return { ok: false, reason: DISCONNECTED };
      case 'timeout':
        return { ok: false, reason: timedOut(Math.round(timeoutMs / 1000)) };
    }
  }
}

/**
 * The id one call is matched by.
 *
 * A UUID rather than a counter. The ids cross a socket a local process could
 * in principle have connected to before the handshake refused it, and a
 * predictable id is the one thing that would let such a process answer a call
 * it never received. It costs nothing to make that impossible.
 */
function freshId(): string {
  return randomUUID();
}

/** The refusal sentences, exported for the tests that pin them. */
export const EXTENSION_REFUSALS = { UNPAIRED, DISCONNECTED, timedOut } as const;
