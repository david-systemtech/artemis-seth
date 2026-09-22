/**
 * Which browser a conversation gets, as one choice instead of two switches.
 * ============================================================================
 *
 * Artemis has four answers to "whose browser is the agent using", and until
 * now the user expressed them with two independent switches — "Browse with
 * your Chrome" and "Open pages in your default browser" — whose four
 * combinations were three answers and one that meant nothing. Adding the
 * Artemis extension would have made it three switches and eight combinations
 * for four answers, so the switches become a picker.
 *
 * The four are genuinely exclusive. A run gets one set of browser tools; the
 * decision table in `main/browserTools.ts` already resolves any overlap and
 * has to, because a run input can arrive from a server. What this module does
 * is make the *question* single-valued at the place a person answers it, so
 * the table never has to.
 *
 * ## Four modes, and any number of browsers under one of them
 *
 * `extension` is the one mode that is not a single browser. A person may pair
 * a work Chrome and a personal one with the same Artemis, so the picker grows
 * a row per pairing under "My Chrome" — "My Chrome: Work" — and a choice is a
 * {@link BrowserSelection}: a mode, plus which browser when the mode is that
 * one. The plain "My Chrome" row stays and means *whichever of them is open*,
 * which is what a person with one browser gets without ever meeting any of
 * this.
 *
 * ## Two settings, and they answer different questions
 *
 * {@link BrowserMode} is "which browser", a window preference, as its two
 * predecessors were: a per-pane *default* would invite two columns to fight
 * over it.
 *
 * {@link ExtensionReach} is "how do conversations *get* the paired browser",
 * and it exists because driving somebody's signed-in Chrome is a bigger grant
 * than the other three modes. Per conversation is the default — the choice is
 * there in every conversation and off until it is made — and always-on is for
 * the person who has decided once. David runs always-on; the default stays
 * per-conversation, which is his decision of 2026-09-21 in issue #436.
 *
 * ## Nothing here reads a store
 *
 * Every function takes what it needs and returns a value. That is what makes
 * the migration and the availability rules testable without standing up a
 * 13,000-line store, and it is where the interesting mistakes would otherwise
 * hide: the migration runs once, in the field, on data nobody can re-read.
 */

import type { PairedBrowserInfo, ProviderId } from '@rx-artemis/protocol';

/** Which browser an agent drives. Exactly one per run. */
export type BrowserMode =
  /** The `WebContentsView` in the Artemis dock. Its own session, no logins. */
  | 'embedded'
  /** The user's own Chrome, through the Artemis extension. */
  | 'extension'
  /** The user's own Chrome, through Claude's own bridge. Claude only. */
  | 'chrome'
  /** The user's default browser, opened at and not read. */
  | 'external';

/** Every mode, in the order the picker draws them. */
export const BROWSER_MODES: readonly BrowserMode[] = [
  'embedded',
  'extension',
  'chrome',
  'external',
];

/** How conversations get the paired browser. */
export type ExtensionReach = 'per-conversation' | 'always-on';

/** What a mode is called on screen. */
export const BROWSER_MODE_LABELS: Readonly<Record<BrowserMode, string>> = {
  embedded: 'Artemis’s built-in browser',
  extension: 'My Chrome (Artemis extension)',
  chrome: 'Claude in Chrome',
  external: 'Open in my browser (open only)',
};

/** One sentence each, saying what happens. */
export const BROWSER_MODE_NOTES: Readonly<Record<BrowserMode, string>> = {
  embedded:
    'A tab inside the Artemis window. Signed in to nothing, and the agent can read, click and type in it.',
  extension:
    'Your real Chrome, with your logins. The agent works in a tab group it keeps to itself, and some sites are refused.',
  chrome:
    'Claude drives your Chrome through the Claude in Chrome extension. Claude conversations only, on this machine.',
  external:
    'Pages open in your default browser for you to look at. The agent cannot read them.',
};

/* -------------------------------------------------------------------------- */
/* Migration                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The stored preference, from whichever version of it is on disk.
 *
 * Artemis's preferences have no schema version — every field is independently
 * optional and defensively read — so a migration here is a fallback chain
 * rather than a numbered step. `browserMode` wins when it is there; otherwise
 * the two old switches are read in the order the decision table reads them,
 * which is what makes the answer the same one the user was already getting.
 *
 * Both switches on meant "Chrome", because `agentBrowserServers` gave Chrome
 * the run and suppressed the host's tools entirely — so a user who had both
 * ticked was using Chrome, whatever the second switch looked like it said.
 * Migrating them to `external` would quietly take away the browser they had.
 */
export function browserModeFromPrefs(prefs: {
  readonly browserMode?: string;
  readonly agentChrome?: boolean;
  readonly openWebExternally?: boolean;
}): BrowserMode {
  const stored = prefs.browserMode;
  if (stored !== undefined && isBrowserMode(stored)) return stored;
  if (prefs.agentChrome === true) return 'chrome';
  if (prefs.openWebExternally === true) return 'external';
  return 'embedded';
}

export function isBrowserMode(value: unknown): value is BrowserMode {
  return typeof value === 'string' && (BROWSER_MODES as readonly string[]).includes(value);
}

export function isExtensionReach(value: unknown): value is ExtensionReach {
  return value === 'per-conversation' || value === 'always-on';
}

/* -------------------------------------------------------------------------- */
/* What a mode can do right now                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the picker knows about the machine when it decides what to offer.
 *
 * The browsers as a list rather than two booleans about them, because a person
 * may have paired a work Chrome and a personal one and the picker now draws a
 * row for each. `anyPaired` and `anyConnected` are still the questions the four
 * mode rows ask, and they are folded from the list here rather than carried
 * beside it — two copies of the same fact are two things to keep in step.
 */
export interface BrowserModeContext {
  /** The provider the conversation is running as. */
  readonly providerId: ProviderId | null;
  /** Every paired browser, in the order Artemis lists them. */
  readonly browsers: readonly PairedBrowserInfo[];
}

/** Whether any browser has been paired with Artemis. */
function anyPaired(context: BrowserModeContext): boolean {
  return context.browsers.length > 0;
}

/** Whether a paired browser is connected right now. */
function anyConnected(context: BrowserModeContext): boolean {
  return context.browsers.some((one) => one.connected);
}

/**
 * Why a mode cannot be chosen, or `null` when it can.
 *
 * A sentence and not a boolean, because a disabled option with no reason is a
 * dead end: the user can see that Artemis will not let them have the thing and
 * has nothing to act on. Each of these names what to do about it.
 */
export function browserModeUnavailable(
  mode: BrowserMode,
  context: BrowserModeContext,
): string | null {
  if (mode === 'chrome' && context.providerId !== 'claude') {
    return 'Only Claude conversations can use the Claude in Chrome extension.';
  }
  if (mode === 'extension') {
    if (!anyPaired(context)) return 'No browser is paired yet. Pair one in Settings → Browser.';
    if (!anyConnected(context)) {
      return 'The paired browser is not connected. Open Chrome with the Artemis extension enabled.';
    }
  }
  return null;
}

/**
 * Why *one named browser* cannot be chosen, or `null` when it can.
 *
 * The same rule as the plain extension row applied to one browser rather than
 * to the set, which is what it has to be once there are several: with a work
 * Chrome open and a personal one shut, "a paired browser is connected" is true
 * and says nothing about the one this row names. A row for a browser that is
 * not running is still drawn — see {@link browserPickerOptions} — because a
 * user who cannot find "My Chrome: Personal" concludes Artemis has forgotten
 * it, where a dimmed row saying to open it has told them what to do.
 */
export function pairedBrowserUnavailable(
  browserId: string,
  context: BrowserModeContext,
): string | null {
  const browser = context.browsers.find((one) => one.browserId === browserId);
  if (browser === undefined) {
    return 'That browser is no longer paired with Artemis. Pair it again in Settings → Browser.';
  }
  if (!browser.connected) {
    return `${browser.browserName} is not connected. Open it with the Artemis extension enabled.`;
  }
  return null;
}

/**
 * Why a whole choice — a mode, and which browser when it is the extension —
 * cannot be used, or `null` when it can.
 *
 * One function so that every caller asks the question the same way. The
 * difference it resolves is narrow and easy to get wrong in two places: a
 * choice that names a browser is judged against *that* browser, and one that
 * names none is judged against the set.
 */
export function browserChoiceUnavailable(
  mode: BrowserMode,
  browserId: string | null,
  context: BrowserModeContext,
): string | null {
  if (mode === 'extension' && browserId !== null) {
    return pairedBrowserUnavailable(browserId, context);
  }
  return browserModeUnavailable(mode, context);
}

/**
 * The mode a conversation will actually run with.
 *
 * Three inputs and one answer, in this order:
 *
 *  1. What *this conversation* chose, if it chose anything. A pane override is
 *     the most specific statement anybody made.
 *  2. Otherwise the window's mode — except that a window set to `extension`
 *     under *per conversation* does not hand the paired browser to a
 *     conversation that has not asked. That is the whole difference between
 *     the two reach settings, and it lives here so that nothing downstream has
 *     to remember it.
 *  3. Falling back to the embedded browser, which is the one that grants
 *     nothing.
 *
 * Then, a mode that cannot work here may be dropped for the embedded browser —
 * and whether it is turns on one question, which is **not** how loudly the
 * user asked for it. It is whether the run itself can say what went wrong.
 *
 *  - **A window default is dropped.** Nobody is waiting on an answer: the
 *    picker draws that option disabled with its reason beside it, so a run
 *    started under it is not where anyone should discover the problem, and the
 *    dock browser is a browser that works.
 *  - **A conversation's own choice of the extension is kept.** Artemis builds
 *    the extension tool server for it regardless — see `agentBrowserServers`
 *    in `apps/desktop/main/browserTools.ts`, which states this rule from the
 *    other side — and every verb of that server refuses in a sentence the
 *    agent can repeat: pair a browser, or open Chrome. Handing the run the
 *    dock browser instead would have it browse a session signed in to nothing
 *    and report on it as though it were the user's Chrome, which is the exact
 *    failure the wording in `pageTools.ts` exists to prevent.
 *  - **A conversation's own choice of Chrome is still dropped**, and that is
 *    what makes this a rule about self-explanation rather than about
 *    insistence. `chromeBrowser` is the *absence* of Artemis's tools: the CLI
 *    brings its own. On a provider with no bridge there is no driver to refuse
 *    in words, so the run would have no browser at all and nothing would say
 *    so — which is the failure this fallback was written for.
 */
export function effectiveBrowserSelection(options: {
  readonly windowMode: BrowserMode;
  readonly windowBrowserId?: string | null;
  readonly reach: ExtensionReach;
  readonly paneMode: BrowserMode | null;
  readonly paneBrowserId?: string | null;
  readonly context: BrowserModeContext;
}): BrowserSelection {
  const chosen: BrowserSelection =
    options.paneMode !== null
      ? { mode: options.paneMode, browserId: options.paneBrowserId ?? null }
      : options.windowMode === 'extension' && options.reach === 'per-conversation'
        ? WHICHEVER_EMBEDDED
        : { mode: options.windowMode, browserId: options.windowBrowserId ?? null };
  if (browserChoiceUnavailable(chosen.mode, chosen.browserId, options.context) === null) {
    return chosen;
  }
  // Unavailable. Kept only when this conversation asked for it *and* the run
  // will explain itself; see the note above on why those are two conditions
  // and not one.
  return options.paneMode !== null && explainsItsOwnAbsence(chosen.mode)
    ? chosen
    : WHICHEVER_EMBEDDED;
}

/** The answer that grants nothing, which every fallback here lands on. */
const WHICHEVER_EMBEDDED: BrowserSelection = { mode: 'embedded', browserId: null };

/**
 * The mode alone, for the callers that have no use for which browser it is.
 *
 * Kept beside {@link effectiveBrowserSelection} rather than folded into it
 * because most of the app genuinely only asks "which kind of browser" — the
 * decision table, the fallback rules, the disabled states — and a caller
 * forced to take an object it then drops half of reads as though the half
 * mattered.
 */
export function effectiveBrowserMode(options: {
  readonly windowMode: BrowserMode;
  readonly windowBrowserId?: string | null;
  readonly reach: ExtensionReach;
  readonly paneMode: BrowserMode | null;
  readonly paneBrowserId?: string | null;
  readonly context: BrowserModeContext;
}): BrowserMode {
  return effectiveBrowserSelection(options).mode;
}

/**
 * Whether a run given this mode, on a machine where it cannot work, will say
 * so in words the agent can pass on.
 *
 * True of the extension alone. Artemis owns that driver, so an unpaired or
 * closed browser becomes a refusal per verb rather than a silence. The other
 * three either always work (`embedded`, `external`) or are the absence of
 * Artemis's tools (`chrome`), and nothing can be refused by a driver that was
 * never built.
 */
function explainsItsOwnAbsence(mode: BrowserMode): boolean {
  return mode === 'extension';
}

/* -------------------------------------------------------------------------- */
/* Onto the run input                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The three booleans a mode sets, with at most one of them `true`.
 *
 * Absent rather than `false` for the ones that are off, matching how the two
 * switches have always crossed IPC: a field that is there and false and a
 * field that is not there mean the same thing to every reader, and the shorter
 * payload is the one whose tests have always pinned it.
 *
 * `embedded` sets nothing at all, which is what the decision table reads as
 * the dock browser.
 */
export function browserFlagsFor(
  mode: BrowserMode,
  browserId: string | null = null,
): {
  readonly chromeBrowser?: true;
  readonly extensionBrowser?: true;
  readonly extensionBrowserId?: string;
  readonly externalBrowser?: true;
} {
  switch (mode) {
    case 'chrome':
      return { chromeBrowser: true };
    case 'extension':
      // The id only beside the flag, and only when there is one. Absent means
      // whichever paired browser is open, which is what every run meant before
      // a person could have two — and is still what the plain "My Chrome" row
      // means.
      return browserId === null
        ? { extensionBrowser: true }
        : { extensionBrowser: true, extensionBrowserId: browserId };
    case 'external':
      return { externalBrowser: true };
    case 'embedded':
      return {};
  }
}

/* -------------------------------------------------------------------------- */
/* The control one conversation gets                                          */
/* -------------------------------------------------------------------------- */

/**
 * The extra option a *conversation's* picker has that the window's does not.
 *
 * "Follow the window default" is not a fifth browser, it is the absence of a
 * choice — which is a different state from choosing whatever the window
 * currently says, and the difference is what happens when the window changes.
 * A conversation following the default moves with it; one that picked the dock
 * browser keeps the dock browser. `SessionState.browserMode` spells the first
 * `null`, and this is that `null` with a name a menu can carry.
 */
export const FOLLOW_WINDOW = 'follow';

/**
 * How a picker row names a *particular* paired browser: `extension:<id>`.
 *
 * One string, because a radio group carries one value per row and a picker is
 * the wrong place to invent a second channel for the half of a choice that is
 * an id. The prefix is what keeps the four mode names and any number of
 * browser ids in one space without either being able to be mistaken for the
 * other — a browser whose id happened to be `external` would otherwise select
 * the wrong row, and browser ids are thirty-two hex characters that nobody
 * chose.
 */
const NAMED_BROWSER_PREFIX = 'extension:';

/** What a browser picker is set to: a mode, one named browser, or the default. */
export type BrowserChoiceValue = string;

/** One whole answer to "which browser": a mode, and which one when it is Chrome. */
export interface BrowserSelection {
  readonly mode: BrowserMode;
  /**
   * Which paired browser, or `null` for whichever of them is open.
   *
   * Only ever set alongside `extension`. The other three modes each have one
   * browser by construction.
   */
  readonly browserId: string | null;
}

/** The value a picker row carries, for a mode and optionally one browser. */
export function browserChoiceValue(
  mode: BrowserMode | null,
  browserId: string | null = null,
): BrowserChoiceValue {
  if (mode === null) return FOLLOW_WINDOW;
  if (mode === 'extension' && browserId !== null) return `${NAMED_BROWSER_PREFIX}${browserId}`;
  return mode;
}

/**
 * What a picker row's value means.
 *
 * `mode: null` is "follow the window default", which is a state and not a
 * browser — see {@link FOLLOW_WINDOW}. A value that is neither a known mode nor
 * a named browser reads as the default, which is what a stale menu and a
 * hand-edited preferences file both produce.
 */
export function browserChoiceOf(value: BrowserChoiceValue): {
  readonly mode: BrowserMode | null;
  readonly browserId: string | null;
} {
  if (value.startsWith(NAMED_BROWSER_PREFIX)) {
    const browserId = value.slice(NAMED_BROWSER_PREFIX.length);
    return browserId.length === 0
      ? { mode: 'extension', browserId: null }
      : { mode: 'extension', browserId };
  }
  return isBrowserMode(value) ? { mode: value, browserId: null } : { mode: null, browserId: null };
}

/** Short enough for the trailing edge of a menu row. */
export const BROWSER_MODE_SHORT_LABELS: Readonly<Record<BrowserMode, string>> = {
  embedded: 'Built-in',
  extension: 'My Chrome',
  chrome: 'Claude in Chrome',
  external: 'My browser',
};

/**
 * One row of a browser picker, in either the window's copy or a pane's.
 *
 * Two sentences rather than one, because the two pickers have different room
 * for them. Settings draws the note under the label and hangs the reason off a
 * tooltip; a menu row has nowhere to put a tooltip anybody would find, so it
 * shows the reason *instead of* the note. Folding them here would have given
 * the settings row the same sentence twice.
 */
export interface BrowserPickerOption {
  readonly id: BrowserChoiceValue;
  readonly label: string;
  /** What choosing it does. */
  readonly note: string;
  /** Why it cannot be chosen right now, and absent when it can. */
  readonly unavailable?: string;
}

/**
 * What the picker on a conversation is currently set to.
 *
 * Takes both halves of the pane's choice, because "My Chrome" and "My Chrome:
 * Work" are different rows and a control that showed the first when the second
 * was set would be a control lying about a conversation's logins.
 */
export function paneBrowserChoice(
  paneMode: BrowserMode | null,
  paneBrowserId: string | null = null,
): BrowserChoiceValue {
  return browserChoiceValue(paneMode, paneBrowserId);
}

/**
 * The rows a browser picker draws: the four modes, plus one per paired
 * browser.
 *
 * The per-browser rows sit directly under the plain "My Chrome" row, which
 * stays and means *whichever of them is open* — the answer somebody with one
 * browser wants and never has to think about, and the answer that lets a
 * conversation say "my Chrome" without pinning it to a profile. Each named row
 * is drawn whether that browser is running or not, disabled with the reason
 * when it is not, under exactly the rule the plain row has always followed:
 * hiding it would have a user conclude Artemis had forgotten the browser they
 * paired.
 *
 * The rows are not built for a machine with no pairings at all, beyond the
 * plain row that is already there saying so.
 */
export function browserPickerOptions(context: BrowserModeContext): readonly BrowserPickerOption[] {
  return BROWSER_MODES.flatMap((mode): BrowserPickerOption[] => {
    const unavailable = browserModeUnavailable(mode, context);
    const row: BrowserPickerOption = {
      id: browserChoiceValue(mode),
      label: BROWSER_MODE_LABELS[mode],
      // Said only where it answers a question the user actually has. With one
      // browser paired there is nothing for "whichever" to choose between, and
      // the sentence would be a warning about a situation they are not in.
      note:
        mode === 'extension' && context.browsers.length > 1
          ? `${BROWSER_MODE_NOTES[mode]} Whichever of them is open.`
          : BROWSER_MODE_NOTES[mode],
      ...(unavailable === null ? {} : { unavailable }),
    };
    if (mode !== 'extension') return [row];
    return [
      row,
      ...context.browsers.map((browser): BrowserPickerOption => {
        const why = pairedBrowserUnavailable(browser.browserId, context);
        return {
          id: browserChoiceValue('extension', browser.browserId),
          label: namedBrowserLabel(browser.browserName),
          note: 'Always this browser, whatever else is open.',
          ...(why === null ? {} : { unavailable: why }),
        };
      }),
    ];
  });
}

/** "My Chrome: Work" — the mode, then the name the user gave that browser. */
export function namedBrowserLabel(browserName: string): string {
  return `${BROWSER_MODE_SHORT_LABELS.extension}: ${browserName}`;
}

/**
 * The rows a conversation's browser picker draws.
 *
 * Everything the window offers, plus the one above them that says "whatever
 * the window says". Its note names what the window resolves to *right now*,
 * because "follow the default" answers nothing on its own — and under
 * `per-conversation` reach the answer is the built-in browser even when the
 * window's own picker says My Chrome, which is exactly the state this control
 * exists to let somebody out of.
 */
export function paneBrowserOptions(options: {
  readonly windowMode: BrowserMode;
  readonly windowBrowserId?: string | null;
  readonly reach: ExtensionReach;
  readonly context: BrowserModeContext;
}): readonly BrowserPickerOption[] {
  const inherited = effectiveBrowserSelection({ ...options, paneMode: null });
  return [
    {
      id: FOLLOW_WINDOW,
      label: 'Follow the window default',
      note: `Currently ${selectionLabel(inherited, options.context)}.`,
    },
    ...browserPickerOptions(options.context),
  ];
}

/**
 * A whole selection in the picker's own words.
 *
 * Falls back to the plain mode label when the browser it names is not in the
 * list, which is what a conversation set to a browser somebody has since
 * unpaired looks like. Saying "My Chrome" there is not a cover-up: the run
 * itself refuses with a sentence naming the missing browser, and a menu row
 * reading "My Chrome: undefined" would help nobody read it.
 */
function selectionLabel(selection: BrowserSelection, context: BrowserModeContext): string {
  const named =
    selection.browserId === null
      ? undefined
      : context.browsers.find((one) => one.browserId === selection.browserId);
  return named === undefined
    ? BROWSER_MODE_LABELS[selection.mode]
    : namedBrowserLabel(named.browserName);
}

/**
 * What this conversation's browser is, in the words a status row uses.
 *
 * `inherited` is what lets the row say *(default)*. A user looking at two
 * panes on the built-in browser needs to know which of them will move when
 * they change the window's setting and which will not, and that is not
 * recoverable from the browser's name.
 */
export function effectiveBrowserSummary(options: {
  readonly windowMode: BrowserMode;
  readonly windowBrowserId?: string | null;
  readonly reach: ExtensionReach;
  readonly paneMode: BrowserMode | null;
  readonly paneBrowserId?: string | null;
  readonly context: BrowserModeContext;
}): { readonly mode: BrowserMode; readonly label: string; readonly inherited: boolean } {
  const selection = effectiveBrowserSelection(options);
  const named =
    selection.browserId === null
      ? undefined
      : options.context.browsers.find((one) => one.browserId === selection.browserId);
  return {
    mode: selection.mode,
    /*
     * The browser's own name when this conversation has one, because that is
     * the fact the row exists to carry. With a work Chrome and a personal one
     * paired, "My Chrome" on both panes is the exact ambiguity the whole
     * feature removes; the trigger is where a user checks which they are about
     * to act in.
     */
    label:
      named === undefined
        ? BROWSER_MODE_SHORT_LABELS[selection.mode]
        : namedBrowserLabel(named.browserName),
    inherited: options.paneMode === null,
  };
}
