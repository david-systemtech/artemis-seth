/**
 * What a browser can be asked to do, whichever browser it is.
 * ============================================================================
 *
 * Artemis has one set of browser tools (`artemisBrowser`: `browser_open`,
 * `browser_read`, …) and, as of this file, three browsers they may be driving:
 *
 *  - **embedded** — the `WebContentsView` in the desktop's dock. Its own
 *    session: nothing the user is signed in to anywhere else.
 *  - **server** — a headless Chromium beside an Artemis Server, driven over the
 *    DevTools protocol. Signed in to nothing, for testing what an agent built.
 *  - **extension** — the user's own Chrome, through the Artemis extension.
 *    Their logins, which is the point of it and the danger in it.
 *
 * The tools used to be written straight against Electron's `webContents`, so
 * only the first could exist. {@link PageDriver} is the seam: the tools are
 * written once against it, and each browser is an implementation. It lives in
 * `protocol` rather than in `core` because the extension implements the far end
 * of it and may import nothing that assumes Node.
 *
 * ## The verbs are things a person could do
 *
 * Open, go, read, look, click, type — and, for finding a bug, what a developer
 * would open DevTools for: the console, the network panel, cookies, storage.
 * {@link PageDriver.evaluate} is the exception and is treated as one: see
 * {@link PagePolicy}.
 *
 * ## A driver says what it cannot do, in words
 *
 * Every method resolves to a {@link DriverResult}. A refusal is a sentence the
 * model can read and act on — a selector that matched nothing, a site the user
 * has blocked, a tab closed for being idle — and not an exception, for the
 * reason `browserTools.ts` gives: a thrown error reaches the agent as a stack
 * trace and tells it nothing it can use.
 */

/** Which browser is on the other end. */
export type BrowserDriverKind = 'embedded' | 'server' | 'extension';

/** The outcome of one verb: what was asked for, or why not. */
export type DriverResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/** Where a page is. */
export interface PageLocation {
  readonly url: string;
  readonly title: string;
}

/** A page's readable text — `innerText`, not markup — and whether it was cut. */
export interface PageText extends PageLocation {
  readonly text: string;
  readonly truncated: boolean;
}

/** What a page looks like. Base64, because every transport here is JSON. */
export interface PageImage {
  readonly mimeType: 'image/png' | 'image/jpeg';
  readonly data: string;
}

/** One line of the console, or an error nobody caught. */
export interface ConsoleEntry {
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'exception';
  readonly text: string;
  /** Script and line, when the browser knows. */
  readonly source?: string;
  /** Milliseconds since the epoch. */
  readonly at: number;
}

/** One request the page made. Bodies are separate: see {@link PagePolicy}. */
export interface NetworkEntry {
  readonly method: string;
  readonly url: string;
  /** Absent for a request that never got an answer. */
  readonly status?: number;
  /** `document`, `xhr`, `fetch`, `script`, … as the browser names it. */
  readonly resourceType?: string;
  readonly durationMs?: number;
  /** Set when the request failed outright: DNS, CORS, blocked, aborted. */
  readonly failure?: string;
  readonly at: number;
}

/**
 * A cookie as a developer sees it. `value` is present only where the policy
 * allows values to be read — elsewhere a cookie is its name and attributes,
 * which is enough to see *that* a session exists and why it is not being sent.
 */
export interface CookieEntry {
  readonly name: string;
  readonly value?: string;
  readonly domain: string;
  readonly path: string;
  readonly expires?: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
}

/** `localStorage` and `sessionStorage` for the page's origin. */
export interface StorageSnapshot {
  readonly origin: string;
  readonly local: Readonly<Record<string, string>>;
  readonly session: Readonly<Record<string, string>>;
}

/**
 * How much of a page an agent may reach into, decided per site.
 * ============================================================================
 *
 * Reading the console and the network log of any page is what looking over
 * someone's shoulder gives you. Cookie values, stored tokens and running
 * JavaScript are different in kind: on a site the user is signed in to, the
 * session cookie *is* the login, and an agent steered by a malicious page could
 * hand it to someone. So those are for **dev sites** — what the user is
 * building — unless they have said otherwise.
 *
 * Where it is enforced depends on whose logins are at stake. In the extension,
 * the policy is applied *in the browser*, so a compromised Artemis cannot talk
 * its way past it. The server browser is signed in to nothing and treats every
 * site as a dev site. The embedded browser offers none of the deep verbs, as
 * before.
 */
export interface PagePolicy {
  /**
   * Origins the user is developing: full access. Host patterns, matched against
   * the page's host — `localhost`, `*.test`, `staging.example.com`. Loopback and
   * private addresses count without being listed.
   */
  readonly devSites: readonly string[];
  /**
   * Let {@link PageDriver.evaluate} run on every site, not only dev sites. Off
   * by default; David's call of 2026-09-21 was dev sites only, with this as a
   * setting for the day he wants it everywhere.
   */
  readonly evaluateEverywhere: boolean;
  /**
   * Read cookie values, storage and response bodies on every site, not only dev
   * sites. Off by default, on the same reasoning.
   */
  readonly deepReadEverywhere: boolean;
  /**
   * Sites the agent may not open at all, on top of {@link DEFAULT_BLOCKED_SITES}.
   * Host patterns, as {@link devSites}.
   */
  readonly blockedSites: readonly string[];
  /** Hosts removed from the default block list, by hand. */
  readonly unblockedSites: readonly string[];
}

/** What a browser nobody has configured is allowed. */
export const DEFAULT_PAGE_POLICY: PagePolicy = {
  devSites: [],
  evaluateEverywhere: false,
  deepReadEverywhere: false,
  blockedSites: [],
  unblockedSites: [],
};

/**
 * Where an agent does not go in a browser with the user's logins, unless the
 * user takes the entry off by hand.
 *
 * A list and not a prompt per site, by David's decision of 2026-09-21: the
 * fewest approvals that still leave a layer. It is not a claim to completeness
 * — nobody can list every bank — it is the places where one wrong click costs
 * money or every other password.
 */
export const DEFAULT_BLOCKED_SITES: readonly string[] = [
  // Password managers
  '*.1password.com',
  '*.bitwarden.com',
  '*.lastpass.com',
  '*.dashlane.com',
  'passwords.google.com',
  // Payments and money movement
  '*.paypal.com',
  '*.stripe.com',
  '*.wise.com',
  '*.venmo.com',
  '*.coinbase.com',
  '*.binance.com',
  '*.kraken.com',
  'pay.google.com',
  'wallet.google.com',
  // Banks: the large ones by name, which is a start and not a fence
  '*.chase.com',
  '*.bankofamerica.com',
  '*.wellsfargo.com',
  '*.citi.com',
  '*.capitalone.com',
  '*.americanexpress.com',
  '*.hsbc.com',
  '*.barclays.co.uk',
  '*.bdo.com.ph',
  '*.bpi.com.ph',
  '*.unionbankph.com',
  '*.gcash.com',
  // Account recovery and security settings
  'myaccount.google.com',
  'account.microsoft.com',
  'appleid.apple.com',
];

/**
 * Whether `host` matches a pattern from a {@link PagePolicy} list.
 *
 * `*.example.com` matches `example.com` and every subdomain of it; anything
 * else matches exactly. Case-insensitive, because hosts are.
 */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const bare = p.slice(2);
    return h === bare || h.endsWith(`.${bare}`);
  }
  return h === p;
}

/**
 * Whether a host is the user's own machine or network: loopback, a private
 * range, link-local, the tailnet's CGNAT range, or a `.local` / `.localhost` /
 * `.test` / `.internal` name. These are dev sites without being listed —
 * nobody's bank is at `192.168.1.10`.
 */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/gu, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (/\.(?:local|localhost|test|internal|lan|home\.arpa)$/u.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(h);
  if (v4 !== null) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT, where tailnets live
    return false;
  }
  // IPv6 unique-local and link-local.
  return /^f[cd][0-9a-f]{2}:/u.test(h) || /^fe[89ab][0-9a-f]:/u.test(h);
}

/**
 * The scheme and host of an address, or `null` for anything that is not plainly
 * one.
 *
 * A regular expression rather than `new URL()`, for the reason `github.ts`
 * gives: this package is built without the DOM or Node's globals. That makes
 * this a parser a block list depends on, so it refuses instead of guessing:
 *
 *  - whitespace, control characters and backslashes are rejected outright - a
 *    browser reads `\` as `/` in an http address, and a reader here would not;
 *  - userinfo is discarded, so `https://paypal.com@evil.test/` is `evil.test`;
 *  - the host ends at the first `/`, `?` or `#`, then at the port.
 *
 * A difference of opinion with the browser is still possible in principle,
 * which is why a driver also checks the address the page *actually* has after
 * every load. This is the first gate, not the only one.
 */
export function hostOf(url: string): { readonly scheme: string; readonly host: string } | null {
  const text = url.trim();
  if (text.length === 0 || text.length > 8_192) return null;
  if (/[\s\u0000-\u001f\u007f\\]/u.test(text)) return null;
  const match = /^([a-z][a-z0-9+.-]*):(?:\/\/)?([^/?#]*)/iu.exec(text);
  if (match === null) return null;
  const scheme = (match[1] as string).toLowerCase();
  const authority = match[2] as string;
  const afterUserinfo = authority.slice(authority.lastIndexOf('@') + 1);
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d*)?$/iu.exec(afterUserinfo);
  const host = bracketed !== null ? (bracketed[1] as string) : afterUserinfo.replace(/:\d*$/u, '');
  if (host.length === 0 && (scheme === 'http' || scheme === 'https')) return null;
  return { scheme, host: host.toLowerCase().replace(/\.$/u, '') };
}

/** What a policy says about one address. */
export interface SiteStanding {
  /** The agent may not open it. `reason` is the sentence the model is given. */
  readonly blocked: boolean;
  readonly reason?: string;
  /** Cookie values, storage and response bodies may be read. */
  readonly deepRead: boolean;
  /** {@link PageDriver.evaluate} may run. */
  readonly evaluate: boolean;
}

/**
 * Apply a {@link PagePolicy} to an address. One function, used by every driver
 * that has a policy and by the extension itself, so the browser and Artemis
 * cannot disagree about what a site is.
 */
export function standingOf(url: string, policy: PagePolicy): SiteStanding {
  const parsed = hostOf(url);
  if (parsed === null) {
    return { blocked: true, reason: `“${url}” is not an address.`, deepRead: false, evaluate: false };
  }
  const { host, scheme } = parsed;
  if (scheme !== 'http' && scheme !== 'https') {
    return {
      blocked: true,
      reason: `Only http and https pages can be driven, not ${scheme}: pages.`,
      deepRead: false,
      evaluate: false,
    };
  }

  const unblocked = policy.unblockedSites.some((p) => hostMatches(host, p));
  const blockedByDefault = !unblocked && DEFAULT_BLOCKED_SITES.some((p) => hostMatches(host, p));
  const blockedByUser = policy.blockedSites.some((p) => hostMatches(host, p));
  if (blockedByDefault || blockedByUser) {
    return {
      blocked: true,
      reason:
        `${host} is on the list of sites an agent does not open in the user's own browser` +
        (blockedByUser ? '.' : ' (passwords, payments and banks, by default).') +
        ' The user can change that in Artemis settings; do not try another route to it.',
      deepRead: false,
      evaluate: false,
    };
  }

  const dev = isLocalHost(host) || policy.devSites.some((p) => hostMatches(host, p));
  return {
    blocked: false,
    deepRead: dev || policy.deepReadEverywhere,
    evaluate: dev || policy.evaluateEverywhere,
  };
}

/** Which of the deep verbs a driver has at all. The tools offer only these. */
export interface PageDriverAbilities {
  readonly console: boolean;
  readonly network: boolean;
  readonly cookies: boolean;
  readonly storage: boolean;
  readonly evaluate: boolean;
}

/**
 * One conversation's hands on one browser.
 *
 * A driver belongs to a run — targeting is by closure, as it always was: no
 * verb takes a browser or a tab id, so an agent cannot name a page that is not
 * its own. `open` makes the page if there is none and reuses it if there is.
 */
export interface PageDriver {
  readonly kind: BrowserDriverKind;
  readonly abilities: PageDriverAbilities;

  /** Open this run's page, optionally at an address. Reuses one that exists. */
  open(url?: string): Promise<DriverResult<PageLocation>>;
  /** Go somewhere, and wait for the load to settle. */
  navigate(url: string): Promise<DriverResult<PageLocation>>;
  /** The page's readable text. */
  read(): Promise<DriverResult<PageText>>;
  /** What the page looks like now. */
  screenshot(): Promise<DriverResult<PageImage>>;
  /** Click the first element matching a CSS selector. */
  click(selector: string): Promise<DriverResult<PageLocation>>;
  /** Replace the contents of an input, textarea or contenteditable. */
  type(selector: string, text: string): Promise<DriverResult<PageLocation>>;

  /** Console lines and uncaught errors since the last call. */
  console(): Promise<DriverResult<readonly ConsoleEntry[]>>;
  /** Requests since the last call. `failedOnly` drops the ones that went fine. */
  network(options?: { readonly failedOnly?: boolean }): Promise<DriverResult<readonly NetworkEntry[]>>;
  /** Cookies the current page would send. Values only where the policy allows. */
  cookies(): Promise<DriverResult<readonly CookieEntry[]>>;
  /** Local and session storage for the current origin, where the policy allows. */
  storage(): Promise<DriverResult<StorageSnapshot>>;
  /**
   * Run an expression in the page and return its JSON-serialisable result.
   * Refused wherever the policy does not allow it — see {@link PagePolicy}.
   */
  evaluate(expression: string): Promise<DriverResult<unknown>>;

  /** Close this run's page and let go of whatever it held. */
  close(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* The wire between Artemis and its extension                                 */
/* -------------------------------------------------------------------------- */

/**
 * Artemis ⇄ extension, over a WebSocket on the machine they share.
 * ============================================================================
 *
 * The extension dials *out* to `ws://127.0.0.1:<port>` — the desktop listens,
 * on loopback only, and the browser never does. Nothing here crosses a
 * network: a served conversation reaches the browser through the desktop
 * client, over the connection that client already has with its server.
 *
 * ## Pairing
 *
 * Artemis shows a short code. The user types it into the extension, which
 * sends {@link BridgePairRequest}; Artemis answers with a browser id and a
 * secret, and the code is spent. Every later connection proves the secret
 * without sending it: Artemis sends a nonce ({@link BridgeChallenge}), the
 * extension answers with `HMAC-SHA256(secret, nonce)` in hex. A local process
 * that can open the port still cannot drive the browser, and one that can read
 * the extension's storage already owns the browser.
 *
 * ## Calls
 *
 * One verb per message, matched by `id`. `runKey` names the conversation's page
 * — opaque to the extension, which keeps one tab per key inside its own tab
 * group and cannot be asked about any other tab.
 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Where the desktop listens unless told otherwise. */
export const BRIDGE_DEFAULT_PORT = 47_615;

/** Extension → Artemis, first message of a first connection. */
export interface BridgePairRequest {
  readonly type: 'pair';
  readonly version: number;
  readonly code: string;
  /** e.g. "Chrome on Windows" — shown in Artemis settings. */
  readonly browserName: string;
  readonly extensionVersion: string;
}

/** Artemis → extension, when the code was good. */
export interface BridgePaired {
  readonly type: 'paired';
  readonly browserId: string;
  /** Hex. Stored by the extension; never sent again. */
  readonly secret: string;
  readonly policy: PagePolicy;
}

/** Extension → Artemis, first message of every later connection. */
export interface BridgeHello {
  readonly type: 'hello';
  readonly version: number;
  readonly browserId: string;
  readonly browserName: string;
  readonly extensionVersion: string;
}

/** Artemis → extension, in answer to a hello. */
export interface BridgeChallenge {
  readonly type: 'challenge';
  readonly nonce: string;
}

/** Extension → Artemis: `HMAC-SHA256(secret, nonce)`, hex. */
export interface BridgeProof {
  readonly type: 'proof';
  readonly mac: string;
}

/** Artemis → extension: the connection is live, and here is the policy now. */
export interface BridgeReady {
  readonly type: 'ready';
  readonly policy: PagePolicy;
}

/** Artemis → extension: the policy changed in settings. */
export interface BridgePolicyUpdate {
  readonly type: 'policy';
  readonly policy: PagePolicy;
}

/** Either way: the connection is refused or ending, and why. */
export interface BridgeRefusal {
  readonly type: 'refused';
  readonly reason: string;
}

/** The verbs of {@link PageDriver}, as they cross the wire. */
export type BridgeVerb =
  | { readonly verb: 'open'; readonly url?: string }
  | { readonly verb: 'navigate'; readonly url: string }
  | { readonly verb: 'read' }
  | { readonly verb: 'screenshot' }
  | { readonly verb: 'click'; readonly selector: string }
  | { readonly verb: 'type'; readonly selector: string; readonly text: string }
  | { readonly verb: 'console' }
  | { readonly verb: 'network'; readonly failedOnly?: boolean }
  | { readonly verb: 'cookies' }
  | { readonly verb: 'storage' }
  | { readonly verb: 'evaluate'; readonly expression: string }
  | { readonly verb: 'close' };

/** Artemis → extension: do this, on this conversation's page. */
export type BridgeCall = BridgeVerb & {
  readonly type: 'call';
  readonly id: string;
  readonly runKey: string;
};

/** Extension → Artemis: what happened. `result.value` is the verb's own type. */
export interface BridgeResult {
  readonly type: 'result';
  readonly id: string;
  readonly result: DriverResult<unknown>;
}

/** Either way, to keep an MV3 service worker and the socket alive. */
export interface BridgePing {
  readonly type: 'ping' | 'pong';
}

export type BridgeFromExtension = BridgePairRequest | BridgeHello | BridgeProof | BridgeResult | BridgePing | BridgeRefusal;
export type BridgeFromArtemis =
  | BridgePaired
  | BridgeChallenge
  | BridgeReady
  | BridgePolicyUpdate
  | BridgeCall
  | BridgePing
  | BridgeRefusal;
