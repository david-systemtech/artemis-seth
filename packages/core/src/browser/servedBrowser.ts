/**
 * Which browser a **served** run gets.
 * ============================================================================
 *
 * `apps/desktop/main/browserTools.ts` holds the same table for a run executing
 * on the desktop. A run executing on an Artemis Server has a different set of
 * browsers available to it, so it needs its own table rather than a parameter
 * on that one:
 *
 *  - There is no embedded dock browser. Nobody is looking at the serving
 *    machine, and a `WebContentsView` needs Electron, which this package may
 *    never import.
 *  - There is no open-only external browser either, for the same reason with
 *    the same force: opening a page on a machine in a cupboard shows it to
 *    nobody. A served run that asked for one gets no browser tools at all,
 *    which is the honest answer.
 *  - There *is* a browser on the caller's own machine, reached back down the
 *    connection their client already holds — see `relayedPageDriver.ts`.
 *  - And there is, or will be, a headless browser beside the server itself,
 *    signed in to nothing, for testing what an agent just built (issue #437).
 *
 * | `chromeBrowser` | `extensionBrowser` | The agent gets                     |
 * |-----------------|--------------------|------------------------------------|
 * | true            | —                  | nothing — the CLI's own bridge, on whichever machine it runs |
 * | false           | true               | the caller's own Chrome, through their client |
 * | false           | false              | the server's headless browser, where there is one |
 *
 * The order matches the desktop's for the reason the desktop's has it: Chrome
 * is the absence of Artemis's tools rather than a variation on them, and a
 * browser with the user's logins answers questions a browser signed in to
 * nothing cannot. The server's own browser is last because it is the fallback
 * nobody asked for by name.
 *
 * `build.extension` is absent on a host that does not relay to clients — an
 * operator who set `ARTEMIS_ALLOW_CLIENT_BROWSER=0`, or a call that arrived
 * without a connection to relay *to*. `build.server` is absent on a host with
 * no headless browser. Either absence falls through to the next row rather
 * than producing a tool set that cannot work.
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/**
 * The one decision table for a served run's browser tools.
 *
 * A function of the input rather than inline in the host so it is testable
 * without standing up a server, and the builders are thunks so a mode that is
 * not chosen is never built.
 */
export function servedBrowserServers(
  input: { readonly chromeBrowser?: boolean; readonly extensionBrowser?: boolean },
  build: {
    readonly server?: () => McpServerConfig;
    readonly extension?: () => McpServerConfig;
  },
): Record<string, McpServerConfig> | undefined {
  if (input.chromeBrowser === true) return undefined;
  if (input.extensionBrowser === true && build.extension !== undefined) {
    return { artemisBrowser: build.extension() };
  }
  if (build.server !== undefined) return { artemisBrowser: build.server() };
  return undefined;
}
