/**
 * Which browser tools a *served* run gets.
 * ============================================================================
 *
 * The desktop's version of this decision is `agentBrowserServers` in
 * `apps/desktop/main/browserTools.ts`, and this is its sibling for a run on an
 * Artemis Server. It is a separate function rather than a shared one because
 * the two hosts have different browsers to offer: the desktop chooses between
 * the dock browser and the open-only external server, and a server has neither
 * — it has the headless Chromium beside it, if an operator configured one.
 *
 * | `chromeBrowser` | a server browser is configured | The agent gets        |
 * |-----------------|-------------------------------|-----------------------|
 * | true            | —                             | nothing from Artemis — the CLI's own Chrome bridge |
 * | false           | yes                           | the server's headless browser |
 * | false           | no                            | no browser tools at all |
 *
 * Chrome wins for the same reason it wins on the desktop, and the reason is
 * stronger here. A run that asked for Claude in Chrome is driving the *serving
 * account's* real browser through the CLI's own bridge, which already registers
 * a `browser_open`; handing it a second tool of the same name over a browser
 * that is signed in to nothing would give the model two tools with one name's
 * worth of purpose, and it would pick the one that cannot see the user's
 * account. `ARTEMIS_ALLOW_CHROME_BROWSER` is what lets a run ask at all — see
 * `apps/server/src/main.ts`.
 *
 * The last row is a decision and not a gap. A server with no
 * `ARTEMIS_BROWSER_CDP_URL` offers no browser tools rather than a server that
 * refuses every call: an absent tool is the honest signal, and registering one
 * in order to say "no browser is configured here" spends context teaching the
 * model a verb it must not use. It is the same argument `pageTools.ts` makes
 * about the abilities it does not register.
 *
 * A pure function of its input, in its own file, so it can be asserted without
 * standing up a server — and so that the *third* driver now being built (the
 * user's own Chrome, reached by a relay through the desktop client, asked for
 * per run with an `extensionBrowser` flag) lands in one obvious place rather
 * than in the middle of `host.ts`. See the marked spot below.
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
}

/** The browsers this host could build, each lazily. */
export interface ServedBrowserBuilders {
  /**
   * The headless Chromium beside this server. Absent when the operator set no
   * `ARTEMIS_BROWSER_CDP_URL`.
   */
  readonly server?: () => McpServerConfig;
  /*
   * ------------------------------------------------------------------------
   * The user's own Chrome, through the relay to their desktop client, goes
   * here — `readonly extension?: () => McpServerConfig`, with
   * `extensionBrowser?: boolean` on {@link ServedBrowserInput} above and one
   * more row in the table in this file's header. It is being built in
   * parallel; this is the place it belongs so that the two changes meet in one
   * function rather than in `apps/server/src/host.ts`.
   *
   * The ordering question it will have to answer: a run that asked for the
   * extension *and* has a server browser configured wants the extension, on
   * the same reasoning that gives Chrome the first row — the user asked for a
   * particular browser, and the server's is the fallback for a run that
   * expressed no preference.
   * ------------------------------------------------------------------------
   */
}

/**
 * The one decision table for a served run's browser tools.
 *
 * `undefined` rather than an empty record for "no tools", because that is what
 * the `agentToolServers` seam spreads to nothing — see `host.ts`, where the
 * result joins the memory tools.
 */
export function servedBrowserServers(
  input: ServedBrowserInput,
  build: ServedBrowserBuilders,
): Record<string, McpServerConfig> | undefined {
  if (input.chromeBrowser === true) return undefined;
  if (build.server === undefined) return undefined;
  return { [BROWSER_TOOL_SERVER]: build.server() };
}
