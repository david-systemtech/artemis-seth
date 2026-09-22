/**
 * Which browser tools a *served* run gets.
 * ============================================================================
 *
 * The desktop's version of this decision is `agentBrowserServers` in
 * `apps/desktop/main/browserTools.ts`, and this is its sibling for a run on an
 * Artemis Server. It is a separate function rather than a shared one because
 * the two hosts have different browsers to offer. The desktop chooses between
 * the dock browser and the open-only external server; a server has neither -
 * nobody is looking at the serving machine, and a `WebContentsView` needs
 * Electron, which this package may never import. What a server has instead:
 * the caller's own Chrome, reached back down the connection their client
 * already holds (`relayedPageDriver.ts`), and the headless Chromium beside the
 * server itself, signed in to nothing, if an operator configured one.
 *
 * | `chromeBrowser` | `extensionBrowser` | a server browser is configured | The agent gets |
 * |-----------------|--------------------|-------------------------------|----------------|
 * | true            | -                  | -                             | nothing from Artemis - the CLI's own Chrome bridge |
 * | false           | true               | -                             | the caller's own Chrome, through their client |
 * | false           | false              | yes                           | the server's headless browser |
 * | false           | false              | no                            | no browser tools at all |
 *
 * Chrome wins for the same reason it wins on the desktop, and the reason is
 * stronger here. A run that asked for Claude in Chrome is driving the *serving
 * account's* real browser through the CLI's own bridge, which already registers
 * a `browser_open`; handing it a second tool of the same name over a browser
 * that is signed in to nothing would give the model two tools with one name's
 * worth of purpose, and it would pick the one that cannot see the user's
 * account. `ARTEMIS_ALLOW_CHROME_BROWSER` is what lets a run ask at all - see
 * `apps/server/src/main.ts`.
 *
 * The caller's browser comes before the server's on the same reasoning: the
 * user asked for a particular browser, one with their logins, which answers
 * questions a browser signed in to nothing cannot. The server's own browser is
 * the fallback for a run that expressed no preference. `build.extension` is
 * absent on a host that does not relay to clients - an operator who set
 * `ARTEMIS_ALLOW_CLIENT_BROWSER=0`, or a call that arrived without a connection
 * to relay *to* - and the absence falls through to the next row rather than
 * producing a tool set whose every verb would refuse.
 *
 * The last row is a decision and not a gap. A server with no
 * `ARTEMIS_BROWSER_CDP_URL` offers no browser tools rather than a server that
 * refuses every call: an absent tool is the honest signal, and registering one
 * in order to say "no browser is configured here" spends context teaching the
 * model a verb it must not use. It is the same argument `pageTools.ts` makes
 * about the abilities it does not register.
 *
 * A pure function of its input, in its own file, so it can be asserted without
 * standing up a server. The builders are thunks so a browser that is not chosen
 * is never built.
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/**
 * The key the tools are registered under, whatever browser is behind them.
 *
 * The name is the contract: permission rules and skills address
 * `mcp__artemisBrowser__browser_open`, and a user whose run moved from the
 * desktop to a server must not lose an allow-list they built.
 */
export const BROWSER_TOOL_SERVER = 'artemisBrowser';

/** What a served run asked for, as far as this decision is concerned. */
export interface ServedBrowserInput {
  /** The run is connected to a Chrome through the provider's own bridge. */
  readonly chromeBrowser?: boolean;
  /** The run asked for the caller's own Chrome, through their client. */
  readonly extensionBrowser?: boolean;
  /**
   * *Which* of the caller's paired browsers, when they have more than one.
   *
   * An id the client issued, meaningful only there. It is carried across this
   * table rather than resolved by it - the serving machine has never seen the
   * list it names, and nothing here could check it.
   */
  readonly extensionBrowserId?: string;
}

/** The browsers this host could build, each lazily. */
export interface ServedBrowserBuilders {
  /**
   * The headless Chromium beside this server. Absent when the operator set no
   * `ARTEMIS_BROWSER_CDP_URL`.
   */
  readonly server?: () => McpServerConfig;
  /**
   * The caller's own Chrome, through the relay to their client. Absent on a
   * host with no relay, or for a request with no connection to relay to.
   *
   * Takes the browser the run named, which only the client can resolve.
   */
  readonly extension?: (browserId: string | undefined) => McpServerConfig;
}

/**
 * The one decision table for a served run's browser tools.
 *
 * `undefined` rather than an empty record for "no tools", because that is what
 * the `agentToolServers` seam spreads to nothing - see `host.ts`, where the
 * result joins the memory tools.
 */
export function servedBrowserServers(
  input: ServedBrowserInput,
  build: ServedBrowserBuilders,
): Record<string, McpServerConfig> | undefined {
  if (input.chromeBrowser === true) return undefined;
  if (input.extensionBrowser === true && build.extension !== undefined) {
    return { [BROWSER_TOOL_SERVER]: build.extension(input.extensionBrowserId) };
  }
  if (build.server === undefined) return undefined;
  return { [BROWSER_TOOL_SERVER]: build.server() };
}
