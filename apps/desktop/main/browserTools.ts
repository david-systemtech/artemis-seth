/**
 * Which browser tools a run gets, and Electron's side of the seam.
 * ============================================================================
 *
 * The handlers themselves are no longer here. They live in
 * `@rx-artemis/core`'s `pageTools`, written once against `PageDriver` — the
 * contract in `@rx-artemis/protocol` that the embedded dock browser, a headless
 * browser beside an Artemis Server, and the user's own Chrome through the
 * Artemis extension all implement. This file is what only the desktop can
 * supply: the Electron driver behind the embedded browser
 * (`embeddedPageDriver.ts`), the open-only server for a user who prefers their
 * own browser, and the table that decides between them.
 *
 * ## Why an in-process MCP server
 *
 * The Agent SDK's `createSdkMcpServer` builds a server whose tool handlers run
 * **in the process that created it** — which for Artemis is the Electron main
 * process, which is exactly where the `WebContentsView` lives. So a tool call
 * reaches the page through a function call rather than through a socket, a port,
 * or a second copy of Chromium. Nothing is spawned and nothing listens.
 *
 * It is also why the driver stays on this side of the wall: core must never
 * import `electron` (`no-electron.test.ts` enforces it), and the driver touches
 * a `webContents` on every verb. The seam is `agentToolServers`, which takes a
 * factory and asks no questions about what is behind it.
 *
 * ## Every call goes through the permission prompt, for free
 *
 * An MCP tool is a tool, so `canUseTool` gates it exactly as it gates `Bash`.
 * The user sees `browser_navigate` with its arguments and allows or denies it,
 * and the existing "always allow this tool" machinery works unchanged. Nothing
 * in this file implements a permission model, and that is the point — a second
 * one would be a second thing to get wrong.
 *
 * ## Targeting is by closure, never by argument
 *
 * The factory is called **per run** and closes over that run's id, which is
 * what the driver is built around. A tool therefore acts on the browser
 * belonging to *its own* conversation, and the model has no way to name a
 * different one: there is no `browserId` parameter on any tool. An agent in the
 * left-hand column cannot drive the page in the right-hand one, and it cannot
 * do so precisely because it cannot say which page it means.
 *
 * ## What the dock browser will not do
 *
 * `browser_evaluate`, `browser_cookies` and `browser_storage` exist on the
 * contract now and are not offered here. That is a decision with reasons, and
 * the reasons live next to the code that acts on them, on
 * `embeddedPageDriver.ts`'s `abilities`.
 */

import { z } from 'zod';
import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import { pageToolInstructions, pageTools, pageToolServer } from '@rx-artemis/core';
import { browserUrlFor, type RunId } from '@rx-artemis/protocol';

import { embeddedPageDriver, type BrowserToolContext } from './embeddedPageDriver.js';
import { createLogger } from './log.js';

const log = createLogger('browser-tools');

export type { BrowserToolContext } from './embeddedPageDriver.js';

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

/*
 * The external server's own two result helpers. Core has the same pair for the
 * driven tools and does not export them: `say` and `refuse` are names too
 * general to put into a shared package's surface for the sake of the one tool
 * below, and four lines here is the cheaper of the two prices.
 */

/** An MCP tool result carrying one block of text. */
function say(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * A failure the model should read and act on, rather than an exception.
 *
 * MCP distinguishes "the tool threw" from "the tool ran and the answer is no",
 * and almost everything here is the second. Throwing would surface a stack
 * trace as the tool result and tell the agent nothing it could use to try
 * something else.
 */
function refuse(text: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { ...say(text), isError: true as const };
}

/* -------------------------------------------------------------------------- */
/* The embedded server                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build one run's browser tools over the dock browser.
 *
 * Called once per run by the composition root in `index.ts`, closing over the
 * run id — see the header on why targeting is a closure rather than a parameter.
 */
export function browserToolServer(runId: RunId, context: BrowserToolContext): McpServerConfig {
  return pageToolServer(embeddedPageDriver(runId, context));
}

/**
 * The embedded browser's tool definitions, before the SDK packages them.
 *
 * Kept addressable for the reason it always was: `createSdkMcpServer` consumes
 * the definitions into an opaque `McpServer` whose handlers are reachable
 * through a transport and not through the object, so a test that wants to ask
 * what a tool decides has to be handed the definitions.
 */
export function browserTools(runId: RunId, context: BrowserToolContext) {
  return pageTools(embeddedPageDriver(runId, context));
}

/**
 * What the model is told the embedded server is for.
 *
 * The wording lives in core with the tools, per driver kind — see `pageTools.ts`
 * on why it has to. Exported from here as well because it is anti-hallucination
 * copy this app's tests pin: an agent once told a user a page was open "in your
 * Chrome" after driving the dock tab, and a rewrite that drops "not the user's
 * browser" would quietly reintroduce that.
 */
export const INSTRUCTIONS = pageToolInstructions('embedded');

/* -------------------------------------------------------------------------- */
/* The external variant                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The browser tools for a user who prefers their own browser.
 *
 * One tool, same name, same server name. The name is the contract: permission
 * rules and skills address `mcp__artemisBrowser__browser_open`, and a user
 * flipping a preference must not invalidate an allow-list they built under the
 * other mode. What changes is what the tool *does* — the page opens in the
 * user's default browser, with their logins and their password manager —
 * and what is no longer offered: `browser_read`, `browser_screenshot`,
 * `browser_click` and `browser_type` only make sense against a page this
 * process owns, and registering them just to refuse would spend context
 * teaching the model tools it must not use. Absent tools are the honest
 * signal, and the open tool's own description says what became of them.
 */
export function externalBrowserToolServer(
  openExternal: (url: string) => void | Promise<void>,
): McpServerConfig {
  return createSdkMcpServer({
    name: 'artemis-browser',
    version: '1',
    instructions: EXTERNAL_INSTRUCTIONS,
    tools: externalBrowserTools(openExternal),
  });
}

/** The external variant's tool definitions. Addressable for the same reason {@link browserTools} is. */
export function externalBrowserTools(openExternal: (url: string) => void | Promise<void>) {
  return [
    tool(
      'browser_open',
      'Open an address in the user’s own browser, in a new tab they can see. ' +
        'You cannot read, screenshot, or interact with that page — the user has ' +
        'chosen to browse with their own logins. To verify a page yourself, use ' +
        'other means (logs, tests, curl for public pages) or ask the user what ' +
        'they see.',
      { url: z.string().describe('Address to open, e.g. http://localhost:5173') },
      async ({ url }) => {
        // The same gate the embedded browser applies, for the same reason —
        // and with more riding on it: this URL leaves the sandbox for the
        // user's real browser, so a scheme like file: or javascript: must
        // stop here, not there.
        if (browserUrlFor(url) === null) {
          return refuse(`“${url}” is not an http or https address.`);
        }
        try {
          await openExternal(url);
          return say(
            `Opened ${url} in the user’s browser. You cannot see that page; ` +
              'ask the user if you need to know what it shows.',
          );
        } catch (error) {
          return refuse(messageOf(error));
        }
      },
    ),
  ];
}

/** What the model is told when the user prefers their own browser. */
const EXTERNAL_INSTRUCTIONS =
  'Opens pages in the user’s own browser — their logins, their tabs. ' +
  'The page is visible to the user, not to you: there is no way to read or ' +
  'screenshot it from here. Open a page when the user should look at ' +
  'something; verify your own work through logs and tests instead.';

/* -------------------------------------------------------------------------- */
/* Which tools a run gets                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The one decision table for a run's browser tools.
 *
 * | `chromeBrowser` | `externalBrowser` | The agent gets                      |
 * |-----------------|-------------------|-------------------------------------|
 * | true            | —                 | nothing from Artemis — the CLI's own Chrome bridge |
 * | false           | true              | the open-only external server       |
 * | false           | false             | the embedded dock browser           |
 *
 * Chrome wins over external because it is the stronger form of the same
 * preference: both mean "the user's own browser", and the bridge can also read
 * what it opened. Handing the CLI's tool set a sibling `browser_open` would
 * give the model two tools with one name's worth of purpose and let it pick
 * the one that cannot see.
 *
 * A function of the input rather than inline in the composition root so the
 * table is testable without Electron — the builders are injected precisely so
 * a test can hand in markers and assert which one was asked for.
 */
export function agentBrowserServers(
  input: { readonly chromeBrowser?: boolean; readonly externalBrowser?: boolean },
  build: {
    readonly embedded: () => McpServerConfig;
    readonly external: () => McpServerConfig;
  },
): Record<string, McpServerConfig> | undefined {
  if (input.chromeBrowser === true) return undefined;
  return { artemisBrowser: input.externalBrowser === true ? build.external() : build.embedded() };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  log.debug('A browser tool failed with a non-Error', error);
  return 'The browser tool failed.';
}
