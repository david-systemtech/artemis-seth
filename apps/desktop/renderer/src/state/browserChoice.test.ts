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

import {
  browserFlagsFor,
  browserModeFromPrefs,
  browserModeUnavailable,
  effectiveBrowserMode,
  type BrowserModeContext,
} from './browserChoice';

/** A machine with a paired browser that is awake, unless a test says otherwise. */
function context(over: Partial<BrowserModeContext> = {}): BrowserModeContext {
  return { providerId: 'claude', anyPaired: true, anyConnected: true, ...over };
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

  it('falls back when the extension was chosen and nothing is paired', () => {
    expect(
      effectiveBrowserMode({
        ...base,
        windowMode: 'extension',
        reach: 'always-on',
        context: context({ anyPaired: false }),
      }),
    ).toBe('embedded');
  });

  it('falls back when the paired browser has gone away mid-session', () => {
    expect(
      effectiveBrowserMode({
        ...base,
        paneMode: 'extension',
        windowMode: 'embedded',
        context: context({ anyConnected: false }),
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
