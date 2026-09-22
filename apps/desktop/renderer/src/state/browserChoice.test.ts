/**
 * One browser choice where there used to be two switches.
 *
 * These are pure functions over values, which is the whole reason they are in
 * their own module: the store is 13,000 lines and the interesting mistakes
 * here are in arithmetic nobody can re-run. The migration in particular runs
 * once, in the field, against a preferences file whose previous shape will
 * never be seen again — so a wrong answer is not a bug somebody reports, it is
 * a browser setting that silently changed on upgrade.
 */

import { describe, expect, it } from 'vitest';

import type { PairedBrowserInfo, ProviderId } from '@rx-artemis/protocol';

import {
  browserChoiceOf,
  browserChoiceValue,
  browserFlagsFor,
  browserModeFromPrefs,
  browserModeUnavailable,
  effectiveBrowserMode,
  effectiveBrowserSelection,
  effectiveBrowserSummary,
  FOLLOW_WINDOW,
  pairedBrowserUnavailable,
  paneBrowserChoice,
  paneBrowserOptions,
  type BrowserModeContext,
} from './browserChoice';

/** One paired browser, named and awake unless a test says otherwise. */
function browser(
  browserId: string,
  browserName: string,
  connected = true,
): PairedBrowserInfo {
  return { browserId, browserName, pairedAt: 0, connected };
}

/**
 * A machine with a paired browser that is awake, unless a test says otherwise.
 *
 * `anyPaired` and `anyConnected` are still how most of these tests describe a
 * machine, because most of them are about the four modes and not about which
 * browser — so the helper turns them into the one-browser list they always
 * meant. A test that cares about several passes `browsers` instead.
 */
function context(
  over: {
    readonly providerId?: ProviderId | null;
    readonly anyPaired?: boolean;
    readonly anyConnected?: boolean;
    readonly browsers?: readonly PairedBrowserInfo[];
  } = {},
): BrowserModeContext {
  const providerId = over.providerId ?? 'claude';
  if (over.browsers !== undefined) return { providerId, browsers: over.browsers };
  const paired = over.anyPaired ?? true;
  const connected = over.anyConnected ?? true;
  return { providerId, browsers: paired ? [browser('b-work', 'Work', connected)] : [] };
}

describe('the old switches become the new choice', () => {
  it('reads a stored choice when there is one', () => {
    expect(browserModeFromPrefs({ browserMode: 'extension' })).toBe('extension');
  });

  it('keeps Chrome for someone who had the Chrome switch on', () => {
    expect(browserModeFromPrefs({ agentChrome: true })).toBe('chrome');
  });

  it('keeps the default browser for someone who had the other switch on', () => {
    expect(browserModeFromPrefs({ openWebExternally: true })).toBe('external');
  });

  it('gives Chrome to someone who had both on, because that is what they were getting', () => {
    // The decision table gave Chrome the run and suppressed the host's tools
    // entirely, so the second switch was doing nothing for them. Migrating to
    // `external` would quietly take away the browser they had.
    expect(browserModeFromPrefs({ agentChrome: true, openWebExternally: true })).toBe('chrome');
  });

  it('gives the dock browser to someone who had neither', () => {
    expect(browserModeFromPrefs({})).toBe('embedded');
    expect(browserModeFromPrefs({ agentChrome: false, openWebExternally: false })).toBe('embedded');
  });

  it('ignores a stored choice that is not one of the four', () => {
    // A hand-edited file, or a mode from a newer build. Falling through to the
    // old switches is the same answer an older Artemis would have given.
    expect(browserModeFromPrefs({ browserMode: 'firefox', agentChrome: true })).toBe('chrome');
  });

  it('lets the new choice win over the old switches once it exists', () => {
    // Otherwise someone who migrated to the dock browser would be put back on
    // Chrome by a key that is still in their file and no longer written.
    expect(browserModeFromPrefs({ browserMode: 'embedded', agentChrome: true })).toBe('embedded');
  });
});

describe('an option that cannot work says why', () => {
  it('lets every provider have the dock browser and the default browser', () => {
    for (const providerId of ['claude', 'codex', 'opencode'] as const) {
      expect(browserModeUnavailable('embedded', context({ providerId }))).toBeNull();
      expect(browserModeUnavailable('external', context({ providerId }))).toBeNull();
    }
  });

  it('offers Claude in Chrome to Claude and nobody else, and names the reason', () => {
    expect(browserModeUnavailable('chrome', context({ providerId: 'claude' }))).toBeNull();
    expect(browserModeUnavailable('chrome', context({ providerId: 'codex' }))).toContain(
      'Only Claude conversations',
    );
  });

  it('points at the pane that fixes it when no browser is paired', () => {
    // A disabled option with no reason is a dead end: the user can see Artemis
    // will not give them the thing and has nothing to act on.
    const reason = browserModeUnavailable('extension', context({ anyPaired: false }));
    expect(reason).toContain('No browser is paired');
    expect(reason).toContain('Settings → Browser');
  });

  it('says to open Chrome when the paired browser is asleep', () => {
    const reason = browserModeUnavailable(
      'extension',
      context({ anyPaired: true, anyConnected: false }),
    );
    expect(reason).toContain('not connected');
    expect(reason).toContain('Open Chrome');
  });

  it('offers the extension to every provider, which is the point of it', () => {
    for (const providerId of ['claude', 'codex', 'opencode'] as const) {
      expect(browserModeUnavailable('extension', context({ providerId }))).toBeNull();
    }
  });
});

describe('which browser a conversation actually gets', () => {
  const base = { reach: 'per-conversation' as const, paneMode: null, context: context() };

  it('follows the window when the conversation has said nothing', () => {
    expect(effectiveBrowserMode({ ...base, windowMode: 'external' })).toBe('external');
  });

  it('holds the paired Chrome back under “each conversation chooses”', () => {
    // The whole difference between the two reach settings. A window set to the
    // extension does not hand a browser full of live sessions to a
    // conversation that has not asked for it.
    expect(effectiveBrowserMode({ ...base, windowMode: 'extension' })).toBe('embedded');
  });

  it('gives it to every conversation under “always on”', () => {
    expect(effectiveBrowserMode({ ...base, windowMode: 'extension', reach: 'always-on' })).toBe(
      'extension',
    );
  });

  it('lets a conversation take the paired Chrome even under “each conversation chooses”', () => {
    expect(effectiveBrowserMode({ ...base, windowMode: 'embedded', paneMode: 'extension' })).toBe(
      'extension',
    );
  });

  it('lets a conversation opt out under “always on”', () => {
    expect(
      effectiveBrowserMode({
        ...base,
        windowMode: 'extension',
        reach: 'always-on',
        paneMode: 'embedded',
      }),
    ).toBe('embedded');
  });

  it('falls back to the dock browser rather than silently giving a run no browser', () => {
    // A stored `chrome` preference on a Codex conversation used to mean the
    // run had no browser tools at all and nothing said so.
    expect(
      effectiveBrowserMode({
        ...base,
        windowMode: 'chrome',
        context: context({ providerId: 'codex' }),
      }),
    ).toBe('embedded');
  });
});

/*
 * The two halves of one rule, and the thing that decides between them is not
 * how loudly the user asked: it is whether the run itself can say what went
 * wrong. See `effectiveBrowserMode`, and `agentBrowserServers` in
 * `apps/desktop/main/browserTools.ts`, which states the same rule from the
 * other side.
 */
describe('an unavailable browser: who says so, and when', () => {
  const base = { reach: 'per-conversation' as const, paneMode: null, context: context() };

  it('drops a window default that cannot work, because the picker already says why', () => {
    // Nobody is waiting on an answer here. The option is drawn disabled with
    // its reason next to it, so a run started under it is not the place to
    // find out — and the dock browser is a working browser.
    expect(
      effectiveBrowserMode({
        ...base,
        windowMode: 'extension',
        reach: 'always-on',
        context: context({ anyPaired: false }),
      }),
    ).toBe('embedded');
  });

  it('keeps a conversation’s own choice of the paired Chrome when nothing is paired', () => {
    /*
     * The agent is the only party who will tell the user. Handing this run the
     * dock browser instead would have it browse a session signed in to nothing
     * and report on it as though it were their Chrome — the exact failure the
     * wording in `pageTools.ts` exists to prevent. The extension tool server
     * is built anyway and every verb of it refuses in a sentence.
     */
    expect(
      effectiveBrowserMode({
        ...base,
        paneMode: 'extension',
        windowMode: 'embedded',
        context: context({ anyPaired: false }),
      }),
    ).toBe('extension');
  });

  it('keeps it when the paired browser has gone away mid-session', () => {
    // The commonest case by far: the user closed Chrome. "Open Chrome and say
    // when it is running" is a sentence they can act on; a quiet swap to the
    // dock browser is not.
    expect(
      effectiveBrowserMode({
        ...base,
        paneMode: 'extension',
        windowMode: 'embedded',
        context: context({ anyConnected: false }),
      }),
    ).toBe('extension');
  });

  it('drops a conversation’s own choice of Claude in Chrome, which cannot explain itself', () => {
    /*
     * The other half, and why the rule is not simply "an explicit choice
     * wins". `chromeBrowser` is the *absence* of Artemis's tools — the CLI
     * brings its own — so on a provider with no bridge the run gets no browser
     * at all and nothing anywhere says so. There is no driver to refuse in
     * words, so the honest degradation is a browser that works.
     */
    expect(
      effectiveBrowserMode({
        ...base,
        paneMode: 'chrome',
        windowMode: 'embedded',
        context: context({ providerId: 'codex' }),
      }),
    ).toBe('embedded');
  });
});

describe('a mode becomes at most one boolean', () => {
  it('sets nothing for the dock browser, which is what absence means', () => {
    expect(browserFlagsFor('embedded')).toEqual({});
  });

  it('sets exactly one flag for each of the other three', () => {
    expect(browserFlagsFor('chrome')).toEqual({ chromeBrowser: true });
    expect(browserFlagsFor('extension')).toEqual({ extensionBrowser: true });
    expect(browserFlagsFor('external')).toEqual({ externalBrowser: true });
  });

  it('never sets two, whatever it is given', () => {
    // The picker is single-valued, so the run input cannot ask for two
    // browsers. The decision table in main still resolves an overlap, because
    // a run input can arrive from a server — but not from here.
    for (const mode of ['embedded', 'extension', 'chrome', 'external'] as const) {
      expect(Object.values(browserFlagsFor(mode)).filter((one) => one === true)).toHaveLength(
        mode === 'embedded' ? 0 : 1,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The picker one conversation gets                                           */
/* -------------------------------------------------------------------------- */

describe('a conversation’s own browser picker', () => {
  const window = { windowMode: 'embedded' as const, reach: 'per-conversation' as const };

  it('offers the window’s four, and following the window above them', () => {
    const rows = paneBrowserOptions({ ...window, context: context() });

    expect(rows.map((row) => row.id)).toEqual([
      FOLLOW_WINDOW,
      'embedded',
      'extension',
      // The one paired browser, by id, directly under the row that means
      // "whichever of them is open".
      'extension:b-work',
      'chrome',
      'external',
    ]);
  });

  it('says what following the window resolves to, because the words do not', () => {
    // And the answer is not the window's own picker: under per-conversation
    // reach a window set to My Chrome resolves to the built-in browser, which
    // is the state this control exists to let somebody out of.
    const rows = paneBrowserOptions({
      windowMode: 'extension',
      reach: 'per-conversation',
      context: context(),
    });

    expect(rows[0]?.note).toContain('built-in browser');
    expect(rows[0]?.unavailable).toBeUndefined();
  });

  it('follows always-on to the paired Chrome instead', () => {
    const rows = paneBrowserOptions({
      windowMode: 'extension',
      reach: 'always-on',
      context: context(),
    });

    expect(rows[0]?.note).toContain('My Chrome');
  });

  it('disables an option that cannot work, and puts the reason where its note goes', () => {
    // A menu row has nowhere to hang a tooltip that anybody would find, so the
    // reason takes the note's place. It is the same sentence the window's
    // picker shows.
    const rows = paneBrowserOptions({ ...window, context: context({ anyPaired: false }) });
    const extension = rows.find((row) => row.id === 'extension');

    expect(extension?.unavailable).toContain('No browser is paired yet');
    // And the note still says what the option *does*, because Settings draws
    // both and only a menu has to choose between them.
    expect(extension?.note).toContain('Your real Chrome');
  });

  it('disables Claude in Chrome on a provider that has never heard of it', () => {
    const rows = paneBrowserOptions({ ...window, context: context({ providerId: 'codex' }) });

    expect(rows.find((row) => row.id === 'chrome')?.unavailable).toContain(
      'Only Claude conversations',
    );
    expect(rows.find((row) => row.id === 'external')?.unavailable).toBeUndefined();
  });

  it('never disables following the window, which is always a thing to do', () => {
    const rows = paneBrowserOptions({
      windowMode: 'chrome',
      reach: 'per-conversation',
      context: context({ providerId: 'codex', anyPaired: false }),
    });

    expect(rows[0]?.unavailable).toBeUndefined();
  });
});

describe('what a conversation’s picker is set to', () => {
  it('reads no choice as following the window', () => {
    expect(paneBrowserChoice(null)).toBe(FOLLOW_WINDOW);
    expect(paneBrowserChoice('extension')).toBe('extension');
  });

  it('writes following the window back as no choice, not as the window’s value', () => {
    // The difference that makes the follow row a row rather than a fifth
    // browser: a conversation following the default moves when the window
    // changes, and one that picked the same browser does not.
    expect(browserChoiceOf(FOLLOW_WINDOW)).toEqual({ mode: null, browserId: null });
    expect(browserChoiceOf('embedded')).toEqual({ mode: 'embedded', browserId: null });
  });
});

describe('what a status row says this conversation is on', () => {
  it('names the effective browser, not the stored one', () => {
    const summary = effectiveBrowserSummary({
      windowMode: 'extension',
      reach: 'per-conversation',
      paneMode: null,
      context: context(),
    });

    expect(summary.mode).toBe('embedded');
    expect(summary.label).toBe('Built-in');
  });

  it('marks a conversation that is following the window', () => {
    const following = effectiveBrowserSummary({
      windowMode: 'embedded',
      reach: 'per-conversation',
      paneMode: null,
      context: context(),
    });
    const chosen = effectiveBrowserSummary({
      windowMode: 'embedded',
      reach: 'per-conversation',
      paneMode: 'embedded',
      context: context(),
    });

    // The same browser, two states: only the first moves when the window's
    // setting does, and the name alone cannot say which is which.
    expect(following.label).toBe(chosen.label);
    expect(following.inherited).toBe(true);
    expect(chosen.inherited).toBe(false);
  });

  it('keeps naming the paired Chrome after it has gone away', () => {
    // The rule from the split above, seen from the status row: the choice
    // stands and the run explains itself, so a row that said "Built-in" here
    // would be contradicting the browser tools.
    const summary = effectiveBrowserSummary({
      windowMode: 'embedded',
      reach: 'per-conversation',
      paneMode: 'extension',
      context: context({ anyConnected: false }),
    });

    expect(summary.label).toBe('My Chrome');
  });
});

/* -------------------------------------------------------------------------- */
/* Several paired browsers                                                    */
/* -------------------------------------------------------------------------- */

/*
 * Issue #443 from this side. A person may pair a work Chrome and a personal
 * one with the same Artemis; both describe themselves as "Chrome on Windows",
 * and until the picker can say which, every conversation drives whichever
 * connected first. What is pinned here is that a choice carries *which*, all
 * the way onto the run input.
 */
describe('a choice that names one of several browsers', () => {
  const TWO = [browser('b-work', 'Work'), browser('b-personal', 'Personal', false)];

  it('reads and writes a named browser as one picker value', () => {
    // One string, because a radio group carries one value per row. The prefix
    // is what keeps ids and mode names from being mistaken for one another.
    expect(browserChoiceValue('extension', 'b-work')).toBe('extension:b-work');
    expect(browserChoiceOf('extension:b-work')).toEqual({
      mode: 'extension',
      browserId: 'b-work',
    });
  });

  it('reads the plain row as the extension with no browser named', () => {
    expect(browserChoiceValue('extension')).toBe('extension');
    expect(browserChoiceOf('extension')).toEqual({ mode: 'extension', browserId: null });
  });

  it('reads a value that names nothing as following the window', () => {
    // A stale menu, or a hand-edited preferences file.
    expect(browserChoiceOf('firefox')).toEqual({ mode: null, browserId: null });
  });

  it('draws a row per paired browser, under the one that means whichever is open', () => {
    const rows = paneBrowserOptions({
      windowMode: 'embedded',
      reach: 'per-conversation',
      context: context({ browsers: TWO }),
    });

    expect(rows.map((row) => row.id)).toEqual([
      FOLLOW_WINDOW,
      'embedded',
      'extension',
      'extension:b-work',
      'extension:b-personal',
      'chrome',
      'external',
    ]);
    expect(rows.find((row) => row.id === 'extension:b-work')?.label).toBe('My Chrome: Work');
  });

  it('says the plain row means whichever is open, but only when there are several', () => {
    // With one browser paired there is nothing for "whichever" to choose
    // between, and the sentence would warn about a situation nobody is in.
    const many = paneBrowserOptions({
      windowMode: 'embedded',
      reach: 'per-conversation',
      context: context({ browsers: TWO }),
    });
    const one = paneBrowserOptions({
      windowMode: 'embedded',
      reach: 'per-conversation',
      context: context(),
    });

    expect(many.find((row) => row.id === 'extension')?.note).toContain('Whichever of them is open');
    expect(one.find((row) => row.id === 'extension')?.note).not.toContain('Whichever');
  });

  it('disables the row for a browser whose Chrome is shut, and names it', () => {
    // The plain row is still live — something *is* connected — so a rule about
    // the set would say nothing about this browser.
    const rows = paneBrowserOptions({
      windowMode: 'embedded',
      reach: 'per-conversation',
      context: context({ browsers: TWO }),
    });

    expect(rows.find((row) => row.id === 'extension:b-work')?.unavailable).toBeUndefined();
    const shut = rows.find((row) => row.id === 'extension:b-personal');
    expect(shut?.unavailable).toContain('Personal is not connected');
  });

  it('says a browser is gone when nothing answers to its id', () => {
    expect(pairedBrowserUnavailable('b-gone', context({ browsers: TWO }))).toContain(
      'no longer paired',
    );
    expect(pairedBrowserUnavailable('b-work', context({ browsers: TWO }))).toBeNull();
  });

  it('carries the browser onto the run input beside the flag', () => {
    expect(browserFlagsFor('extension', 'b-work')).toEqual({
      extensionBrowser: true,
      extensionBrowserId: 'b-work',
    });
    // And never without it: the plain row means whichever is open, which is
    // what every run meant before a person could have two.
    expect(browserFlagsFor('extension', null)).toEqual({ extensionBrowser: true });
  });

  it('sets no browser id on a mode that has only one browser', () => {
    // Guarding against a stale id surviving a change of mode: a run on the
    // dock browser that carried one would be carrying a choice nothing reads.
    expect(browserFlagsFor('embedded', 'b-work')).toEqual({});
    expect(browserFlagsFor('external', 'b-work')).toEqual({ externalBrowser: true });
  });

  it('resolves a conversation’s own named browser, and keeps it when its Chrome is shut', () => {
    // The rule the whole module turns on, applied to one browser rather than
    // to the set: the run refuses in a sentence naming that browser, and a
    // quiet swap to the dock browser would contradict it.
    expect(
      effectiveBrowserSelection({
        windowMode: 'embedded',
        reach: 'per-conversation',
        paneMode: 'extension',
        paneBrowserId: 'b-personal',
        context: context({ browsers: TWO }),
      }),
    ).toEqual({ mode: 'extension', browserId: 'b-personal' });
  });

  it('drops a window default pointed at a browser that is shut, as it always has', () => {
    // Nobody is waiting on an answer: the picker is already drawing that row
    // disabled with the reason, and the dock browser is a browser that works.
    expect(
      effectiveBrowserSelection({
        windowMode: 'extension',
        windowBrowserId: 'b-personal',
        reach: 'always-on',
        paneMode: null,
        context: context({ browsers: TWO }),
      }),
    ).toEqual({ mode: 'embedded', browserId: null });
  });

  it('keeps a window default pointed at a browser that is running', () => {
    expect(
      effectiveBrowserSelection({
        windowMode: 'extension',
        windowBrowserId: 'b-work',
        reach: 'always-on',
        paneMode: null,
        context: context({ browsers: TWO }),
      }),
    ).toEqual({ mode: 'extension', browserId: 'b-work' });
  });

  it('names the browser on the status row, not just the mode', () => {
    // "My Chrome" on two panes driving two signed-in profiles is the exact
    // ambiguity this feature removes.
    const summary = effectiveBrowserSummary({
      windowMode: 'embedded',
      reach: 'per-conversation',
      paneMode: 'extension',
      paneBrowserId: 'b-work',
      context: context({ browsers: TWO }),
    });

    expect(summary.label).toBe('My Chrome: Work');
  });

  it('falls back to the plain name when the browser it names has been unpaired', () => {
    // Not a cover-up: the run refuses with a sentence naming the missing
    // browser, and a row reading "My Chrome: undefined" would help nobody.
    const summary = effectiveBrowserSummary({
      windowMode: 'embedded',
      reach: 'per-conversation',
      paneMode: 'extension',
      paneBrowserId: 'b-gone',
      context: context({ browsers: TWO }),
    });

    expect(summary.label).toBe('My Chrome');
  });

  it('migrates an old stored choice to the plain row, naming no browser', () => {
    // The migration is unchanged by any of this: a preferences file written
    // before browsers had names cannot name one, and "whichever is open" is
    // exactly what that user was already getting.
    expect(browserModeFromPrefs({ browserMode: 'extension' })).toBe('extension');
    expect(paneBrowserChoice('extension', null)).toBe('extension');
  });
});
