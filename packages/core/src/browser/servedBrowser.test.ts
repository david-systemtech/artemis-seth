/**
 * Which browser a served run gets.
 *
 * The desktop's table has the same shape and different rows, and both are
 * pinned the same way: with builders that record being asked and return
 * markers, so a test can assert *which* one was built and that the others were
 * not. Laziness is part of the contract — a run that gets the caller's browser
 * must not stand up a headless Chromium it will never use.
 */

import { describe, expect, it } from 'vitest';

import { servedBrowserServers } from './servedBrowser.js';

function builders(): {
  asked: string[];
  build: { server: () => never; extension: () => never };
} {
  const asked: string[] = [];
  return {
    asked,
    build: {
      server: () => {
        asked.push('server');
        return 'the server browser' as never;
      },
      extension: () => {
        asked.push('extension');
        return 'the caller’s browser' as never;
      },
    },
  };
}

describe('which browser a served run gets', () => {
  it('gives a run with no preference the server’s own browser', () => {
    const { asked, build } = builders();

    // The key is the contract, on this host as on the desktop: permission
    // rules and skills address `mcp__artemisBrowser__…` whatever is behind it.
    expect(servedBrowserServers({}, build)).toEqual({ artemisBrowser: 'the server browser' });
    expect(asked).toEqual(['server']);
  });

  it('gives a run that asked for the caller’s browser the relayed one', () => {
    const { asked, build } = builders();

    expect(servedBrowserServers({ extensionBrowser: true }, build)).toEqual({
      artemisBrowser: 'the caller’s browser',
    });
    expect(asked).toEqual(['extension']);
  });

  it('gives a Chrome-bridge run nothing at all, and builds nothing', () => {
    const { asked, build } = builders();

    // The CLI brings its own tool set, wherever it is running.
    expect(servedBrowserServers({ chromeBrowser: true }, build)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('lets Chrome win over the caller’s browser', () => {
    const { asked, build } = builders();

    expect(
      servedBrowserServers({ chromeBrowser: true, extensionBrowser: true }, build),
    ).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('falls through to the server’s browser when there is nothing to relay to', () => {
    // A host with no relay, or a request that arrived without a connection to
    // publish verbs back to. A tool set whose every verb refuses would be the
    // wrong answer when there was never a client to begin with.
    const { asked, build } = builders();

    expect(servedBrowserServers({ extensionBrowser: true }, { server: build.server })).toEqual({
      artemisBrowser: 'the server browser',
    });
    expect(asked).toEqual(['server']);
  });

  it('gives a run no browser at all when the host has neither', () => {
    // Honest: a server has no dock browser and no default browser worth
    // opening on a machine nobody is looking at, so "none" is a real answer.
    expect(servedBrowserServers({}, {})).toBeUndefined();
    expect(servedBrowserServers({ extensionBrowser: true }, {})).toBeUndefined();
  });
});
