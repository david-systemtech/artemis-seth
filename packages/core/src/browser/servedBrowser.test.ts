/**
 * Which browser tools a served run gets.
 *
 * A table with three rows, and every row is a decision somebody could
 * reasonably have made the other way. The markers are enough: what is being
 * asserted is which builder was asked, not what it built.
 */

import { describe, expect, it } from 'vitest';

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import { BROWSER_TOOL_SERVER, servedBrowserServers } from './servedBrowser.js';

/** A stand-in for a built server: identity is all these tests compare. */
const SERVER = { type: 'sdk', name: 'artemis-browser' } as unknown as McpServerConfig;

describe('a served run’s browser tools', () => {
  it('gets the server’s headless browser when one is configured', () => {
    expect(servedBrowserServers({}, { server: () => SERVER })).toEqual({
      [BROWSER_TOOL_SERVER]: SERVER,
    });
  });

  it('gets nothing at all when no browser is configured on this server', () => {
    // An absent tool is the honest signal. A `browser_open` that exists in
    // order to answer "no browser is configured here" would spend context
    // teaching the model a verb it must not use.
    expect(servedBrowserServers({}, {})).toBeUndefined();
  });

  it('gets nothing when the run is already driving a Chrome', () => {
    // The provider's own bridge has registered a browser_open of its own, over
    // the user's real browser. A second tool with the same name and no logins
    // is one the model would sometimes pick, and it cannot see their account.
    expect(servedBrowserServers({ chromeBrowser: true }, { server: () => SERVER })).toBeUndefined();
  });

  it('does not build the browser it is not going to hand over', () => {
    let built = 0;
    servedBrowserServers(
      { chromeBrowser: true },
      {
        server: () => {
          built += 1;
          return SERVER;
        },
      },
    );
    expect(built).toBe(0);
  });

  it('registers under the name every host uses, whatever browser is behind it', () => {
    // Permission rules and skills address `mcp__artemisBrowser__browser_open`.
    // A user whose run moved from the desktop to a server must not lose an
    // allow-list they built.
    expect(BROWSER_TOOL_SERVER).toBe('artemisBrowser');
  });
});
