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
 * ## Two settings, and they answer different questions
 *
 * {@link BrowserMode} is "which browser", a window preference, as its two
 * predecessors were: the extension bridges one browser at a time, and a
 * per-pane version of this would invite two columns to fight over it.
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

import type { ProviderId } from '@rx-artemis/protocol';

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

/** What the picker knows about the machine when it decides what to offer. */
export interface BrowserModeContext {
  /** The provider the conversation is running as. */
  readonly providerId: ProviderId | null;
  /** Whether any browser has been paired with Artemis. */
  readonly anyPaired: boolean;
  /** Whether a paired browser is connected right now. */
  readonly anyConnected: boolean;
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
    if (!context.anyPaired) return 'No browser is paired yet. Pair one in Settings → Browser.';
    if (!context.anyConnected) {
      return 'The paired browser is not connected. Open Chrome with the Artemis extension enabled.';
    }
  }
  return null;
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
 * Then, whatever came out, a mode that cannot work here falls back to embedded
 * rather than silently doing nothing. A stored `chrome` preference on a Codex
 * conversation used to mean the run had no browser tools at all and nobody
 * said so; it now means the dock browser, which is the honest degradation and
 * the one the picker is already showing as disabled.
 */
export function effectiveBrowserMode(options: {
  readonly windowMode: BrowserMode;
  readonly reach: ExtensionReach;
  readonly paneMode: BrowserMode | null;
  readonly context: BrowserModeContext;
}): BrowserMode {
  const chosen =
    options.paneMode ??
    (options.windowMode === 'extension' && options.reach === 'per-conversation'
      ? 'embedded'
      : options.windowMode);
  return browserModeUnavailable(chosen, options.context) === null ? chosen : 'embedded';
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
export function browserFlagsFor(mode: BrowserMode): {
  readonly chromeBrowser?: true;
  readonly extensionBrowser?: true;
  readonly externalBrowser?: true;
} {
  switch (mode) {
    case 'chrome':
      return { chromeBrowser: true };
    case 'extension':
      return { extensionBrowser: true };
    case 'external':
      return { externalBrowser: true };
    case 'embedded':
      return {};
  }
}
