/**
 * The manifest, and the argument for every line in it.
 * ============================================================================
 *
 * A manifest is the only part of an extension a user is shown before they trust
 * it, and Chrome renders it as a list of sentences about their browser. This
 * file is where each of those sentences is justified, because a permission
 * added without an argument is how an extension that drives one tab ends up
 * able to read every tab.
 *
 * It is TypeScript rather than a checked-in `manifest.json` for one reason:
 * {@link ExtensionManifest.version} has to follow the desktop app, which is
 * read off `apps/desktop/package.json` at build time. Keeping the rest of the
 * document here rather than in a template means the permission list is a value
 * the tests can assert on.
 *
 * ## The permissions, and why each one is the smallest thing that works
 *
 *  - **`debugger`** — the whole of what the extension does to a page. Navigate,
 *    screenshot, click, type, read the console, watch the network, read cookies
 *    and storage, evaluate: all of it is CDP 1.3 over `chrome.debugger`,
 *    attached only to tabs this extension opened. It is the heaviest permission
 *    Chrome has and it is not avoidable — `chrome.scripting` cannot give the
 *    console or the network panel, which is most of what an agent debugging a
 *    site needs. Chrome shows a yellow bar on every tab it is attached to,
 *    which is a feature here: it is the visible mark issue #436 asks for.
 *  - **`tabGroups`** — to title the group "Artemis" and colour it. Without it a
 *    group can still be made, but it is an unnamed grey one indistinguishable
 *    from a group the user made, and "the tab group is the mark" stops being
 *    true.
 *  - **`storage`** — the pairing secret, the port, the policy Artemis last
 *    sent, the run-to-tab map and the audit log. `local` for what must survive
 *    a browser restart, `session` for the console and network buffers.
 *  - **`alarms`** — an MV3 service worker is stopped when it goes quiet, and a
 *    stopped worker holds no socket. An alarm every thirty seconds is what
 *    brings it back to redial while Artemis is not running. `setTimeout` cannot
 *    do it: the timer dies with the worker that set it.
 *
 * ## What is deliberately *not* asked for
 *
 *  - **No `tabs`.** It reads as "Read your browsing history" in the install
 *    prompt, and it is what would let this extension enumerate the user's open
 *    tabs and read their addresses. It is not here, and the extension is
 *    written so that it could not use it: a tab's address and title come from
 *    `Target.getTargetInfo` on a debugger session the extension opened on its
 *    own tab, and `chrome.tabs.get` on somebody else's tab would answer with an
 *    empty object. Measured, not assumed — `tabs.create`, `tabs.group`,
 *    `tabs.remove` and `tabGroups.update` all work without it.
 *  - **No `host_permissions`.** A WebSocket to loopback needs none: WebSocket
 *    is not subject to CORS, and `chrome-extension://` is a secure context, so
 *    `ws://127.0.0.1` is not mixed content. Also measured. Host permissions
 *    would read as "Read and change all your data on all websites" and buy
 *    nothing — the debugger permission already implies the access.
 *  - **No `<all_urls>` content scripts, and no content scripts at all.** Every
 *    page interaction is CDP. A content script would run in pages the extension
 *    has no business in and would be a second enforcement point for the policy.
 *  - **No `cookies` permission.** It grants cookies for every site at once.
 *    `Network.getCookies` on the attached tab gives the cookies for the page
 *    the agent is actually on, which is the only set it should ever see.
 */

/** Chrome's tab-group colours. "purple" is the Artemis group. */
export const GROUP_COLOUR = 'purple';

/** What the Artemis tab group is called, in Chrome's tab strip. */
export const GROUP_TITLE = 'Artemis';

/**
 * The public half of an RSA key pair, base64 DER, which fixes the extension's
 * id at `pbdboognedfpknmikiajchompjfjhdal` on every machine that loads this
 * folder unpacked.
 *
 * Without it Chrome derives an id from the install path, so a developer's
 * unpacked extension has a different id on every machine and Artemis has no
 * stable name for "the extension". The id is what the options page URL is built
 * from and what the end-to-end test opens, so it has to be a constant.
 *
 * **Only the public half is here.** It was made once with
 *
 * ```
 * openssl genrsa 2048 > artemis-extension.pem
 * openssl rsa -in artemis-extension.pem -pubout -outform DER | base64 -w0
 * ```
 *
 * and the private half was not kept: nothing in this repository signs a `.crx`,
 * and a private key in a public repository is a key anybody can impersonate the
 * extension with. Should a Chrome Web Store listing happen later, the Store
 * issues its own key and this value is replaced by the one it assigns.
 */
export const EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4QAkO5x8owM9qT+RC6c/AkAojfn+nFXAxMRvj1KGMOL7cnzl6IobfUmIbuMvXUyjzzE/6b1qqeBr7doz56tM5MSGEcx1378BLdsB0zog7+jq4d5k3PA3M/CZB07o5NQrbc1HTQWr86H7UMvnrLDLinxKuw1kyKCSIwyQqHu7vaYZHhYJRO0ei05VxJX4hp7sXAA+L4plFDWDsEPE+lTaBZyO0gHDQVM0OSTNcUjh7i+ts5V8llOFORz9gbYtvkMC5SJ82Vb45/EkiL9hjK2ONdLPhv5W48rYu/3Psz+8Gd0kiTmmL4MtsrJfTZMpqky/9Po4vMQv5B18t+wVBRd47QIDAQAB';

/**
 * The id {@link EXTENSION_KEY} produces: the first sixteen bytes of the DER's
 * SHA-256, each nibble mapped from `0-f` onto `a-p`. Recorded so the test suite
 * and the README can state it without re-deriving it, and asserted in
 * `manifest.test.ts` so a change to the key cannot leave this stale.
 */
export const EXTENSION_ID = 'pbdboognedfpknmikiajchompjfjhdal';

/** The four permissions, in the order the header argues for them. */
export const MANIFEST_PERMISSIONS = ['debugger', 'tabGroups', 'storage', 'alarms'] as const;

/** The shape written to `dist/manifest.json`. */
export interface ExtensionManifest {
  readonly manifest_version: 3;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly key: string;
  readonly minimum_chrome_version: string;
  readonly background: { readonly service_worker: string; readonly type: 'module' };
  readonly action: { readonly default_popup: string; readonly default_title: string; readonly default_icon: Record<string, string> };
  readonly options_page: string;
  readonly icons: Record<string, string>;
  readonly permissions: readonly string[];
  readonly content_security_policy: { readonly extension_pages: string };
}

/**
 * Build the manifest for a version of the desktop app.
 *
 * The CSP is stricter than MV3's default in two ways that matter. `script-src
 * 'self'` is MV3's floor and already forbids remote code and `eval`; the
 * additions are `connect-src`, which pins every network connection the
 * extension's pages and worker can make to loopback — a second, browser-enforced
 * copy of the rule `bridgeUrl` enforces in code — and `object-src 'none'`,
 * which removes plugin embedding outright rather than restricting it.
 *
 * `connect-src` names exactly one address, `ws://127.0.0.1:*`, because that is
 * exactly what `bridgeUrl` builds and `isBridgeUrl` will accept. It once also
 * named `ws://localhost:*`, on the argument that somebody forwarding their
 * Artemis port to a `localhost`-only listener would otherwise meet a CSP
 * violation with no explanation — but no code path here dials that name, so
 * the entry permitted a socket this extension refuses to open. A policy wider
 * than the code stops being a second opinion about it: it says the browser
 * would allow something, and the only thing preventing it is that the code
 * currently declines to ask. If dialling `localhost` is ever wanted, the
 * address builder is where it starts and this line follows it.
 *
 * `http:` and `https:` are absent, so no page of this extension can fetch
 * anything from the web.
 */
export function extensionManifest(version: string): ExtensionManifest {
  return {
    manifest_version: 3,
    name: 'Artemis',
    version,
    description: "Lets an Artemis conversation drive this browser, in its own tab group, over a socket to Artemis on this machine.",
    key: EXTENSION_KEY,
    // `chrome.debugger` with CDP 1.3 and promise-returning extension APIs. 116
    // is also where a WebSocket's traffic began to keep a service worker alive,
    // which the keepalive in `worker.ts` relies on.
    minimum_chrome_version: '116',
    background: { service_worker: 'worker.js', type: 'module' },
    action: {
      default_popup: 'popup.html',
      default_title: 'Artemis',
      default_icon: { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png' },
    },
    options_page: 'options.html',
    icons: { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png' },
    permissions: [...MANIFEST_PERMISSIONS],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; connect-src 'self' ws://127.0.0.1:*;",
    },
  };
}
