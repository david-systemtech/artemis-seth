/**
 * Where the server's browser may go.
 * ============================================================================
 *
 * The embedded browser and the extension answer a question about *the user's
 * logins*: a browser holding a live session on a bank is a browser an agent
 * must not be steered into using. That is what `standingOf` and
 * `DEFAULT_BLOCKED_SITES` in `protocol/browserDriver.ts` are for, and **none of
 * it is reused here**. This browser is signed in to nothing. There is no
 * session on `chase.com` for a prompt injection to spend, so blocking
 * `chase.com` would buy nothing and would stop an agent reading a public help
 * page. Every site gets deep reads and `evaluate`, which is what the contract
 * says a `server` driver does.
 *
 * The question this browser has instead is about *the operator's network*. It
 * runs in a container beside the Artemis Server, so it can route to everything
 * that container can route to: the dev servers, which are the whole point, and
 * also the unauthenticated admin page on the LAN, the Docker socket proxy
 * someone exposed on a private address, and — the one that turns a browsing
 * agent into a credential thief — the cloud metadata endpoint.
 *
 * So the rule is the inverse of the desktop's. The public internet is open.
 * Everything internal is shut unless an operator named it.
 *
 *  - **Allowed**: any public address, plus the hosts in
 *    {@link ServerBrowserAllowList} (`ARTEMIS_BROWSER_ALLOW_HOSTS`, defaulting
 *    to {@link DEFAULT_ALLOW_HOSTS}).
 *  - **Refused**: loopback, RFC 1918, link-local, CGNAT and IPv6 unique-local
 *    addresses, and `.local` / `.internal` / `.lan` names, unless named.
 *  - **Refused whatever the allow-list says**: the cloud metadata addresses.
 *    An operator who lists `169.254.169.254` has made a mistake, and what is
 *    behind it is the *host's* credentials rather than anything the agent is
 *    testing. This is the one rule with no switch.
 *
 * ## What this cannot do
 *
 * It gates **navigation**, which is the address an agent names and the address
 * the page ends up at after redirects. It does **not** gate the requests a page
 * makes once it is loaded: an `<img src>` or a `fetch()` to a private address
 * happens inside Chromium's own network stack, below anything the DevTools
 * protocol lets a client veto without `Fetch.enable` on every request — which
 * would put an Artemis round trip in front of every subresource of every page.
 * The fence for that is the container's network, and it is the reason the
 * compose service in `docker/docker-compose.yml` puts the browser on its own
 * network with only the server reachable from it. See `docs/SERVER-BROWSER.md`.
 */

import { hostMatches, hostOf, isLocalHost } from '@rx-artemis/protocol';

/**
 * The internal hosts a browser nobody has configured may open.
 *
 * Loopback, because a single-container deployment puts the dev server there —
 * and note that in the two-container arrangement loopback is the *browser's*
 * own, which reaches nothing, so it is harmless rather than useful. And
 * `artemis-server`, which is the compose service name of the server in
 * `docker/docker-compose.yml`: an operator who renamed the service adds theirs
 * to `ARTEMIS_BROWSER_ALLOW_HOSTS`.
 */
export const DEFAULT_ALLOW_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '::1',
  'artemis-server',
];

/**
 * Addresses that are refused however the allow-list is written.
 *
 * Every cloud's instance-credential endpoint, by name and by address. A page
 * that reaches one of these is reading the *host's* role credentials, which is
 * not a thing the agent is testing and not a thing an operator can mean to
 * allow. `169.254.169.254` is inside the link-local range and so already
 * refused by the general rule; it is named as well so that removing link-local
 * from that rule could never quietly open it.
 */
const METADATA_HOSTS: readonly string[] = [
  '169.254.169.254',
  '169.254.170.2', // ECS task credentials
  'fd00:ec2::254',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
];

/** The hosts an operator has named, as the driver holds them. */
export interface ServerBrowserAllowList {
  /**
   * Host patterns, matched as `PagePolicy.devSites` are: `*.example.com`
   * matches the domain and its subdomains, anything else matches exactly.
   */
  readonly allowHosts: readonly string[];
}

/** Whether an address may be opened, and the sentence to say when not. */
export type NavigationStanding =
  | { readonly allowed: true; readonly host: string }
  | { readonly allowed: false; readonly reason: string };

/**
 * Apply the rule above to one address.
 *
 * Used before navigating **and** on the address the page actually has once it
 * has loaded. The second call is not belt-and-braces: a public address that
 * redirects to `http://169.254.169.254/` is the attack this exists for, and the
 * first call cannot see it. `hostOf` is the contract's parser — see its comment
 * on why it refuses rather than guesses, which is the property a gate needs.
 */
export function navigationStanding(url: string, policy: ServerBrowserAllowList): NavigationStanding {
  const parsed = hostOf(url);
  if (parsed === null) {
    return { allowed: false, reason: `“${url}” is not an address.` };
  }
  const { scheme, host } = parsed;
  if (scheme !== 'http' && scheme !== 'https') {
    return {
      allowed: false,
      reason: `Only http and https pages can be opened, not ${scheme}: pages.`,
    };
  }

  if (METADATA_HOSTS.some((one) => host === one)) {
    return {
      allowed: false,
      reason:
        `${host} is a cloud metadata address and is never opened, whatever ` +
        'ARTEMIS_BROWSER_ALLOW_HOSTS says. What is behind it is the host ' +
        'machine’s own credentials, not anything this browser is here to test.',
    };
  }

  if (policy.allowHosts.some((pattern) => hostMatches(host, pattern))) {
    return { allowed: true, host };
  }

  if (isLocalHost(host)) {
    return {
      allowed: false,
      reason:
        `${host} is inside the operator’s own network, and this browser only ` +
        'opens the internal hosts the operator named. Public addresses are ' +
        'open; the server’s own dev ports are reachable by the names in ' +
        'ARTEMIS_BROWSER_ALLOW_HOSTS. Do not look for another route to it.',
    };
  }

  return { allowed: true, host };
}

/**
 * Read the allow-list an operator wrote as one comma-separated line.
 *
 * The defaults are kept and the operator's names are added to them, rather than
 * replaced: the server's own dev ports are the reason the browser exists, and
 * an operator adding `staging.internal` did not mean to cut them off. An
 * operator who wants them gone edits {@link DEFAULT_ALLOW_HOSTS}, which is a
 * code change and should be.
 */
export function allowListFrom(declared: string | undefined): ServerBrowserAllowList {
  const extra = (declared ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  return { allowHosts: [...new Set([...DEFAULT_ALLOW_HOSTS, ...extra])] };
}
