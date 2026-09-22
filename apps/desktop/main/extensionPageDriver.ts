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
 * Six things go wrong that are not the page's fault: no browser has ever been
 * paired, a paired browser's Chrome is not running, a browser that is connected
 * does not answer in time, the browser this conversation names has been
 * unpaired, the browser it names is closed while others are open, and — with
 * several browsers open and none chosen — nobody has said which one is meant.
 * All six arrive at the model as a sentence naming the actual situation and the
 * actual remedy, because the agent is the only party in the room who can tell
 * the user — nobody is watching a tool call fail. A thrown error, or a generic
 * "the browser tool failed", would have the agent guess: usually that the
 * *page* is broken, which sends it looking for a bug that is not there.
 *
 * The last of the six is the only refusal here that asks for something. See
 * {@link chooseBrowser}. There is a seventh that is not about the browser
 * being unreachable at all — see {@link alreadyChosen}, which is about who is
 * allowed to decide.
 *
 * ## Which browser, and how it is named
 *
 * A person may pair a work Chrome and a personal one with the same Artemis,
 * and both call themselves "Chrome on Windows" — so Artemis stores the label
 * they typed and everything from the picker to this file addresses a browser by
 * it. A driver holds a *selector* rather than an id: the picker supplies an id,
 * a model answering "which browser?" supplies a name, and this file resolves
 * either against the bridge's list. The bridge itself only ever sees an id.
 *
 * A model may name a browser **once**, and only for a run that had none. The
 * argument is an answer to a question, not a control: a conversation the user
 * pinned to their work profile must not be moved to their personal one by a
 * tool call, because the thing asking for the move may be a page the agent is
 * reading. See {@link ExtensionPageDriver.open}.
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
 * Seven cases and not a `DriverResult`, so that the sentences the model reads
 * live in this file with the rest of the driver's voice rather than in the
 * socket plumbing. `answered` carries the extension's own `DriverResult`
 * through untouched — a refusal it wrote is a refusal Artemis has nothing to
 * add to.
 *
 * The last three arrived with several paired browsers, and each is a
 * *different question to the user*: repair a conversation's stale choice, open
 * the browser it names, or say which of the open ones you meant. One refusal
 * covering all three would have the agent guess at the remedy.
 */
export type BridgeCallOutcome =
  | { readonly status: 'answered'; readonly result: DriverResult<unknown> }
  /** No browser has ever been paired with this Artemis. */
  | { readonly status: 'unpaired' }
  /** A browser is paired, but nothing is connected right now. */
  | { readonly status: 'disconnected' }
  /** Sent, and nothing came back before the deadline. */
  | { readonly status: 'timeout' }
  /** A browser was named, and no pairing answers to that id any more. */
  | { readonly status: 'no-such-browser' }
  /** The named browser is paired, and its Chrome is not running. */
  | { readonly status: 'browser-asleep'; readonly browserName: string }
  /** Nothing named a browser, and more than one is connected to choose from. */
  | { readonly status: 'ambiguous'; readonly browserNames: readonly string[] };

/** One paired browser, as the driver needs to see it: named, and reachable or not. */
export interface PairedBrowserRef {
  readonly browserId: string;
  readonly browserName: string;
  readonly connected: boolean;
}

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
   * `browserId` names which paired browser to send it to. Absent means
   * "whichever is connected", which is an answer only while exactly one is —
   * see {@link BridgeCallOutcome}'s `ambiguous`.
   *
   * Contracted never to reject: everything that can go wrong is one of the
   * {@link BridgeCallOutcome} cases, because a driver's job is to answer.
   */
  call(
    runKey: string,
    id: string,
    verb: BridgeVerb,
    timeoutMs: number,
    browserId?: string,
  ): Promise<BridgeCallOutcome>;
  /**
   * Every paired browser, named.
   *
   * Read by the driver for two things it cannot do without the list: turning a
   * name the *model* used into the id the bridge addresses, and saying which
   * browser a run settled on. Carries no secret — it is the same three fields
   * a settings pane is shown.
   */
  browsers(): readonly PairedBrowserRef[];
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

/**
 * What the model is told when the browser this conversation names is gone.
 *
 * Distinct from {@link UNPAIRED} because the remedy is different and the
 * difference matters: other browsers may be paired and working, and an agent
 * told "no browser has been paired" would send the user to pair one they
 * already have. What is actually wrong is that *this conversation* points at a
 * pairing that no longer exists — someone unpaired it — and the fix is to
 * choose again.
 */
function noSuchBrowser(asked: string): string {
  return (
    `This conversation is set to a browser Artemis is no longer paired with (${quoted(asked)}). ` +
    'Ask the user to choose a browser for this conversation again — the browser ' +
    'row in the conversation’s menu, or Artemis settings → Browser to pair it ' +
    'afresh. Until then you have no browser at all — do not describe pages you ' +
    'have not seen.'
  );
}

/**
 * What the model is told when the browser it was given is paired and closed.
 *
 * It names the browser, and it says not to use another one. With several
 * profiles paired, "the browser is not connected" invites exactly the wrong
 * recovery: the agent reaches for whatever else is open, acts as the wrong
 * signed-in person, and reports success. The logins this conversation was
 * pointed at are in that browser and nowhere else.
 */
function browserAsleep(name: string): string {
  return (
    `This conversation drives the browser called ${quoted(name)}, and it is not ` +
    `connected. Ask the user to open ${quoted(name)} with the Artemis extension ` +
    'enabled, and say when it is running. Do not use a different browser instead ' +
    '— the logins this conversation needs are in that one. Until then you have ' +
    'no browser at all — do not describe pages you have not seen.'
  );
}

/**
 * What the model is told when several browsers are connected and none was
 * chosen.
 *
 * The one refusal in this file that asks for something rather than reporting
 * something, and the design David chose in issue #443: no new card, no new
 * window, no Artemis-side prompt. The agent already has a way to ask the user
 * a question, it is already mid-turn, and the answer is one word. So the
 * refusal names the browsers, says to ask, and says exactly which call to make
 * with the answer — because a model told only "be more specific" will guess,
 * and guessing here means acting in somebody's work profile from a
 * conversation about their personal one.
 *
 * It is a refusal and not a notice, so the verb does not happen. That is the
 * point: there is no browser it could have happened in that would not have
 * been a guess.
 */
function chooseBrowser(names: readonly string[]): string {
  const example = names[0] ?? 'Work';
  return (
    `More than one browser is connected to Artemis: ${names.map(quoted).join(', ')}. ` +
    'This conversation has not been set to one of them, so there is no way to ' +
    'know which the user means. Ask the user which browser to use — with your own ' +
    'question tool, AskUserQuestion on Claude, offering each of those names as an ' +
    'option — then call browser_open again with the browser argument set to their ' +
    // Straight quotes here and curly ones above, deliberately: the list is
    // prose the model reads out, and this is a call it copies. A model handed
    // a curly quote inside an example has been known to send one.
    `answer, for example browser_open(browser: "${example}"). Artemis remembers ` +
    'it for the rest of the conversation, so you are asked once. Do not guess, ' +
    'and do not describe pages you have not seen.'
  );
}

/**
 * What the model is told when it names a browser for a conversation that
 * already has one.
 *
 * The argument answers a question, and this conversation was not asked one:
 * somebody chose its browser in the picker, or answered the question already.
 * Either way that is a statement about whose logins this conversation acts
 * with, made by the only party entitled to make it — so the remedy named here
 * is the control the *user* has, and the model is told plainly that the choice
 * is not its own to change.
 */
function alreadyChosen(current: string, asked: string): string {
  return (
    `This conversation is set to the browser called ${quoted(current)}, so it cannot ` +
    `be moved to ${quoted(asked)} from here. Carry on in ${quoted(current)}, or tell the ` +
    'user what you wanted the other browser for — changing it is done in the ' +
    'conversation’s own Browser row, by them. Do not work around this.'
  );
}

/** A name inside the curly quotes the rest of Artemis's copy uses. */
function quoted(text: string): string {
  return `“${text}”`;
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

/** What a driver is told about the browser it is for, beyond the run. */
export interface ExtensionDriverOptions {
  /**
   * Which paired browser this run drives, by the id Artemis issued or by the
   * name the user gave it.
   *
   * Either, because the two arrive from opposite directions and only this
   * process can compare them. `RunInput.extensionBrowserId` carries an id,
   * chosen in a picker that listed real pairings. A served run whose agent was
   * asked which browser to use carries back a *name*, because a name is what a
   * person answers with and what the model was shown — and the machine that
   * holds the pairings is this one. Resolution is the same either way: exact
   * id first, then name.
   *
   * Absent means whichever browser is connected, which is an answer while
   * exactly one is and a question when more are.
   */
  readonly browser?: string | undefined;
  /**
   * Told when this run settled on a browser mid-turn, so the conversation can
   * be moved onto it.
   *
   * Only fires for a choice *made here* — the agent answering the question in
   * {@link chooseBrowser} — and never for a browser the run was started with,
   * which the conversation already knows about. The desktop pushes it at the
   * pane holding the run; see `IPC_PUSH.runBrowserChoice`.
   */
  readonly onChosen?: (browserId: string) => void;
}

/**
 * One run's hands on the user's own Chrome.
 *
 * Built per run by the composition root, closing over that run's id, which is
 * also the `runKey` the extension files the tab under. Targeting is therefore
 * a closure exactly as it is for the dock browser: no verb takes a tab id, so
 * the model cannot name a page belonging to another conversation, and the
 * extension would not honour it if it did — it only knows the key it was told.
 *
 * {@link ExtensionDriverOptions.browser} is the one thing a model may name,
 * and it names a *browser* rather than a page: which of the user's paired
 * Chrome profiles this conversation acts in. See `browser_open`'s `browser`
 * argument in `pageTools.ts`, and the refusal that asks for it.
 */
export function extensionPageDriver(
  runId: RunId,
  bridge: ExtensionDriverHost,
  options: ExtensionDriverOptions = {},
): PageDriver {
  return new ExtensionPageDriver(runId, bridge, options);
}

class ExtensionPageDriver implements PageDriver {
  readonly kind = 'extension' as const;
  readonly abilities = EXTENSION_ABILITIES;

  readonly #runKey: string;
  readonly #bridge: ExtensionDriverHost;
  readonly #onChosen: ((browserId: string) => void) | null;

  /**
   * The browser this run drives, as an id or a name, or `null` for "whichever".
   *
   * Mutable for one reason: the agent may answer the "which browser?" question
   * mid-run, and the answer holds for the rest of the run. It is never
   * un-chosen — a conversation that has settled on a browser does not drift
   * back to "whichever is open" because a second Chrome started.
   */
  #browser: string | null;

  constructor(runId: RunId, bridge: ExtensionDriverHost, options: ExtensionDriverOptions) {
    this.#runKey = runId;
    this.#bridge = bridge;
    this.#browser = emptyToNull(options.browser);
    this.#onChosen = options.onChosen ?? null;
  }

  /**
   * Open this run's page, and — the first time the agent names one, and only
   * then — decide which browser the rest of the conversation happens in.
   *
   * **Once.** The `browser` argument exists to answer a question Artemis
   * asked, and a run that already has a browser was not asked one. Honouring
   * it a second time would let a model move a conversation the user pinned to
   * their work profile onto their personal one — and on the desktop that
   * choice is written back into the pane, so every later turn would run there
   * too. A page the agent is reading is untrusted input, and "move to the
   * other browser" is a thing a page could ask for.
   *
   * The choice is taken before the verb rather than after it, and it sticks
   * even when the open then fails. A name that resolved is the user's answer
   * to a question they were asked; a page that would not load is a fact about
   * a page. Forgetting the first because of the second would ask the question
   * again on the next tool call.
   */
  async open(url?: string, browser?: string): Promise<DriverResult<PageLocation>> {
    const named = emptyToNull(browser);
    if (named !== null) {
      const found = this.#find(named);
      if (found === null) return { ok: false, reason: this.#unknownBrowser(named) };
      if (this.#browser === null) {
        this.#browser = found.browserId;
        this.#onChosen?.(found.browserId);
      } else {
        /*
         * Already set. Naming the *same* browser is not a move and carries on
         * in silence — a model that repeats its own answer has not asked for
         * anything. Naming another one is refused.
         *
         * A pinned browser that no longer resolves falls through instead of
         * refusing here, so the model gets `#send`'s sentence about the
         * browser this conversation lost rather than one about the browser it
         * just named. That is the more useful of the two.
         */
        const current = this.#find(this.#browser);
        if (current !== null && current.browserId !== found.browserId) {
          return { ok: false, reason: alreadyChosen(current.browserName, found.browserName) };
        }
      }
    }
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
    await this.#send<unknown>({ verb: 'close' }, CLOSE_TIMEOUT_MS);
  }

  /**
   * One paired browser, by the id Artemis issued or by the name the user gave
   * it.
   *
   * Id first, and exactly. A name is matched case-insensitively and after
   * trimming, because it is a thing a person typed into a settings field and
   * then a model typed back — "work" and "Work " are the same browser, and
   * refusing over a capital would be a refusal nobody can act on. Two browsers
   * sharing a name resolve to the first, which is the same browser every time
   * rather than a coin toss; nothing stops a user naming both "Chrome", and a
   * stable wrong answer is at least visible in the run navigator.
   */
  #find(selector: string): PairedBrowserRef | null {
    const browsers = this.#bridge.browsers();
    const byId = browsers.find((one) => one.browserId === selector);
    if (byId !== undefined) return byId;
    const wanted = selector.trim().toLowerCase();
    return browsers.find((one) => one.browserName.trim().toLowerCase() === wanted) ?? null;
  }

  /**
   * What to say about a name that matches no paired browser.
   *
   * A model that mistyped one of the names it was just given, and a
   * conversation pointing at a browser somebody unpaired, arrive here
   * together. The sentence is {@link noSuchBrowser}'s, with the names that
   * *would* work appended when there are any — which turns a mistyped answer
   * into a second attempt rather than into a dead end.
   */
  #unknownBrowser(selector: string): string {
    const connected = this.#bridge.browsers().filter((one) => one.connected);
    if (connected.length === 0) return noSuchBrowser(selector);
    return (
      `${noSuchBrowser(selector)} Connected right now: ` +
      `${connected.map((one) => quoted(one.browserName)).join(', ')}.`
    );
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
    /*
     * A name is turned into an id here rather than being sent as it stands,
     * because the bridge addresses browsers by id and a name is the user's
     * word for one. Resolving on every verb rather than once at construction
     * is deliberate: a browser can be unpaired or renamed mid-run, and the
     * honest answer to a verb after that is a sentence about *this* browser,
     * not a call sent to an id nothing answers to.
     */
    const selector = this.#browser;
    let browserId: string | undefined;
    if (selector !== null) {
      const found = this.#find(selector);
      if (found === null) return { ok: false, reason: this.#unknownBrowser(selector) };
      browserId = found.browserId;
    }

    const outcome = await this.#bridge.call(this.#runKey, freshId(), verb, timeoutMs, browserId);
    switch (outcome.status) {
      case 'answered':
        return outcome.result as DriverResult<T>;
      case 'unpaired':
        return { ok: false, reason: UNPAIRED };
      case 'disconnected':
        return { ok: false, reason: DISCONNECTED };
      case 'timeout':
        return { ok: false, reason: timedOut(Math.round(timeoutMs / 1000)) };
      case 'no-such-browser':
        return { ok: false, reason: this.#unknownBrowser(selector ?? '') };
      case 'browser-asleep':
        return { ok: false, reason: browserAsleep(outcome.browserName) };
      case 'ambiguous':
        return { ok: false, reason: chooseBrowser(outcome.browserNames) };
    }
  }
}

/** A browser nobody named, spelled one way. An empty string is not a choice. */
function emptyToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
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
export const EXTENSION_REFUSALS = {
  UNPAIRED,
  DISCONNECTED,
  timedOut,
  noSuchBrowser,
  browserAsleep,
  chooseBrowser,
  alreadyChosen,
} as const;
