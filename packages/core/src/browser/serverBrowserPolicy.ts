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
 * ## A name is not an address, and the first version of this forgot it
 *
 * Every rule above was applied to the *name* in the URL and to nothing else,
 * which made the whole policy a spelling check. `http://169.254.169.254.nip.io/`
 * is a public name that resolves to the metadata service; so is any A record an
 * attacker controls. The claim that metadata "can never be reached" was false.
 *
 * So the rule is applied three times, to two different things:
 *
 *  1. {@link navigationStanding} — the **name**, before anything else. Cheap,
 *     and it catches the obvious cases without a resolver.
 *  2. {@link addressStanding}, over the addresses the name **resolves to**,
 *     before navigating. A metadata address is refused whatever the name is and
 *     whatever the allow-list says. A private address is refused unless the
 *     *name* is allow-listed — `artemis-server` and `localhost` legitimately
 *     resolve into private space, and refusing them would refuse the dev
 *     servers this browser exists for.
 *  3. {@link addressStanding} again, over `remoteIPAddress` — the address the
 *     browser **actually connected to** for the main document, reported by
 *     `Network.responseReceived`. This is the only one that defeats DNS
 *     rebinding: a name that resolved publicly a moment ago can resolve into
 *     private space by the time Chromium fetches it, and the lookup in step 2
 *     cannot see that.
 *
 * ## What this still cannot do
 *
 * It gates **navigation**, in every frame: the address an agent names, the
 * address the page ends up at after redirects or its own scripting, the address
 * the main document was actually served from, and the address any frame inside
 * the page reaches — including one the agent wrote itself with
 * `browser_evaluate`. A page one of whose frames is refused is refused whole;
 * `cdpPageDriver.ts` says why that is the honest answer here.
 *
 * It does **not** gate the requests a page makes once it is loaded: a `fetch`,
 * an `XMLHttpRequest`, an `<img src>`, a stylesheet or a beacon to a private
 * address happens inside Chromium's own network stack, below anything the
 * DevTools protocol lets a client veto without `Fetch.enable` on every request
 * — which would put an Artemis round trip in front of every subresource of
 * every page. None of those renders anything or is read back through a verb, so
 * what they can do is *reach* an address rather than report it; that is a
 * smaller hole than a frame, and it is the one that is left. The fence for it
 * is the container's network, and it is the reason the compose service in
 * `docker/docker-compose.yml` puts the browser on its own network with only the
 * server reachable from it. See `docs/SERVER-BROWSER.md`.
 *
 * And a document with **no** remote address — one served from the cache, or a
 * `data:`/`about:` page — leaves step 3 with nothing to check, so those pages
 * are held by steps 1 and 2 alone. That is a narrow gap here rather than a
 * silent one: `Network.enable` is on for every tab this driver opens, which
 * disables that tab's disk cache, so a document being served from cache is a
 * case this browser does not have.
 */

import { lookup } from 'node:dns/promises';

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
 * Apply the rule to the **name** in an address. The first of three gates.
 *
 * Used before navigating and on the address the page has after every load,
 * including one it reached by its own scripting. The later calls are not
 * belt-and-braces: a public address that redirects to `http://10.0.0.5/` is the
 * attack this exists for, and the first call cannot see it.
 *
 * On its own this is a spelling check, and it is named one here so that nobody
 * reads it as the whole policy: a name is not an address, and
 * `169.254.169.254.nip.io` passes every test in this function.
 * {@link addressStanding} is the gate that means something. `hostOf` is the
 * contract's parser — see its comment on why it refuses rather than guesses,
 * which is the property a gate needs.
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

/* -------------------------------------------------------------------------- */
/* The gate that means something                                              */
/* -------------------------------------------------------------------------- */

/**
 * Hostname → the addresses it resolves to. Injected, so a test never asks DNS.
 *
 * Rejecting is an answer: a name that cannot be resolved is a name this browser
 * refuses to open, and the resolver's own words say why better than anything
 * written here.
 */
export type HostResolver = (host: string) => Promise<readonly string[]>;

/** Does this look like an address already, so no resolver is involved? */
export function isAddressLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/gu, '');
  return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(bare) || bare.includes(':');
}

/** One of the cloud instance-credential endpoints, by address. */
function isMetadataAddress(address: string): boolean {
  const bare = address.toLowerCase().replace(/^\[|\]$/gu, '');
  return METADATA_HOSTS.includes(bare);
}

/**
 * Apply the rule to the addresses behind a name.
 *
 * Called twice per navigation and once per verb, over two different sources:
 * the addresses `HostResolver` gave before the fetch, and the single
 * `remoteIPAddress` Chromium reports for the main document after it. The same
 * function for both, because "may this browser talk to this address" has one
 * answer and two places that need it.
 *
 * **Any** address decides it, not all of them: a name with one public A record
 * and one pointing at `169.254.169.254` is a name this browser does not open,
 * because which one Chromium picks is not ours to choose.
 *
 * The allow-list is consulted by **name**, and that is the load-bearing part.
 * `artemis-server` resolves to a private address by design — it is the dev
 * server this browser exists to test — so a rule that refused every private
 * address would refuse the whole feature. What the allow-list cannot buy is a
 * metadata address: an operator who lists a name that resolves to one has made
 * a mistake, and what is behind it is the host machine's own credentials.
 */
export function addressStanding(
  host: string,
  addresses: readonly string[],
  policy: ServerBrowserAllowList,
): NavigationStanding {
  const metadata = addresses.find((address) => isMetadataAddress(address));
  if (metadata !== undefined) {
    return {
      allowed: false,
      reason:
        `${host} resolves to ${metadata}, a cloud metadata address, and is never ` +
        'opened — whatever ARTEMIS_BROWSER_ALLOW_HOSTS says, and whatever the ' +
        'name looks like. What is behind it is the host machine’s own ' +
        'credentials, not anything this browser is here to test.',
    };
  }

  // Named by the operator: a private address behind it is the point of naming
  // it. Checked after the metadata rule, which has no such escape.
  if (policy.allowHosts.some((pattern) => hostMatches(host, pattern))) {
    return { allowed: true, host };
  }

  const internal = addresses.find((address) => isLocalHost(address));
  if (internal !== undefined) {
    return {
      allowed: false,
      reason:
        `${host} resolves to ${internal}, which is inside the operator’s own ` +
        'network. A public name that points at a private address is refused ' +
        'exactly as the address would be. This browser opens public addresses ' +
        'and the internal hosts named in ARTEMIS_BROWSER_ALLOW_HOSTS; do not ' +
        'look for another route to it.',
    };
  }

  return { allowed: true, host };
}

/**
 * The whole of the pre-navigation gate: the name, then what it resolves to.
 *
 * An address literal is not resolved — {@link navigationStanding} has already
 * judged it as the address it is, and asking a resolver about `10.0.0.5` would
 * be asking it to agree with itself.
 */
export async function navigationStandingFor(
  url: string,
  policy: ServerBrowserAllowList,
  resolve: HostResolver,
): Promise<NavigationStanding> {
  const named = navigationStanding(url, policy);
  if (!named.allowed) return named;
  if (isAddressLiteral(named.host)) return named;

  let addresses: readonly string[];
  try {
    addresses = await resolve(named.host);
  } catch (error) {
    return {
      allowed: false,
      reason:
        `${named.host} could not be resolved: ${error instanceof Error ? error.message : String(error)}. ` +
        'This browser does not open a name it cannot look up.',
    };
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: `${named.host} resolves to no address at all.` };
  }
  return addressStanding(named.host, addresses, policy);
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

/**
 * The resolver this uses when nobody injected one.
 *
 * `all: true`, because a name with several A records must be judged on every
 * one of them: Chromium picks whichever it likes, and a rule that read only the
 * first would be a rule an attacker chooses the order of.
 */
export function systemHostResolver(): HostResolver {
  return async (host: string) => (await lookup(host, { all: true })).map((one) => one.address);
}
