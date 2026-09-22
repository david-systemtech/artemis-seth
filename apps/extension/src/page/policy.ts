/**
 * The policy, decided here, in the browser.
 * ============================================================================
 *
 * Artemis sends a {@link PagePolicy} and the extension holds it — but it is the
 * extension that decides, on every verb, against the address the tab *actually*
 * has. That is the whole security posture of this package in one sentence, and
 * it follows from what is on the other end of the socket: a browser full of the
 * user's live sessions, and a caller that might be a compromised Artemis or a
 * process that opened the port first. A policy the caller could assert would be
 * a policy.
 *
 * `standingOf` comes from `@rx-artemis/protocol` rather than being reimplemented
 * here, so that Artemis's settings screen and this file cannot come to different
 * conclusions about the same site.
 *
 * ## The address is re-read, every time
 *
 * A page can leave the site it was opened on without the extension asking it
 * to: a redirect, a meta refresh, a link the agent clicked, `window.location`
 * set by script on a page the agent is reading. So {@link standingOfPage} is
 * called with the address the tab has *now* — read from the debugger session,
 * not from what was navigated to — before every verb and again after every
 * load. A page that has arrived somewhere blocked is sent to `about:blank` and
 * the verb is refused.
 *
 * ## Two gates, not one
 *
 * `standingOf` blocks everything that is not `http`/`https`, which covers
 * `chrome://`, `chrome-extension://`, `file://` and `devtools://`. What it
 * cannot cover is the Chrome Web Store, which is an ordinary https site that
 * Chrome forbids extensions from scripting — an agent that opened it would get
 * a tab it cannot read and a string of confusing failures. {@link
 * FORBIDDEN_HOSTS} is that second gate, and unlike the default block list it is
 * not lifted by the user's `unblockedSites`: there is nothing to unblock,
 * because the browser will refuse regardless.
 */

import { standingOf, type CookieEntry, type PagePolicy, type SiteStanding } from '@rx-artemis/protocol';

/**
 * Hosts no policy can open, because Chrome will not let an extension work
 * there and a half-working tab is worse than a refusal.
 */
export const FORBIDDEN_HOSTS: readonly string[] = ['chromewebstore.google.com', 'chrome.google.com'];

/** The address a tab is sent to when it has arrived somewhere it may not be. */
export const BLANK_PAGE = 'about:blank';

/** Where a tab is, as far as the policy is concerned. */
export type PageStanding =
  /** No page yet: a new tab, or one that has just been sent to `about:blank`. */
  | { readonly kind: 'blank' }
  /** The tab is somewhere the agent may not be. `reason` is for the model. */
  | { readonly kind: 'blocked'; readonly reason: string }
  /** An ordinary page, with what the policy allows on it. */
  | { readonly kind: 'open'; readonly url: string; readonly standing: SiteStanding };

/** Whether an address is one of the blanks Chrome hands a new tab. */
export function isBlankPage(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  return trimmed.length === 0 || trimmed === 'about:blank' || trimmed === 'about:newtab' || trimmed === 'chrome://newtab/';
}

/**
 * What the policy says about the address a tab is at.
 *
 * Used both ways round: on the address an agent asked for, before anything is
 * opened, and on the address the tab reports afterwards.
 */
export function standingOfPage(url: string, policy: PagePolicy): PageStanding {
  if (isBlankPage(url)) return { kind: 'blank' };

  const standing = standingOf(url, policy);
  if (standing.blocked) return { kind: 'blocked', reason: standing.reason ?? `${url} is blocked.` };

  const host = hostOfOpenPage(url);
  if (host !== null && FORBIDDEN_HOSTS.some((forbidden) => host === forbidden || host.endsWith(`.${forbidden}`))) {
    return {
      kind: 'blocked',
      reason: `${host} is the Chrome Web Store, which Chrome does not allow an extension to read or act on. This is not a setting the user can change.`,
    };
  }

  return { kind: 'open', url, standing };
}

/**
 * The host of an address that has already been through `standingOf` and come
 * back unblocked, which is the only place this is called from — so the parse
 * has already succeeded once and this is reading, not deciding.
 */
function hostOfOpenPage(url: string): string | null {
  const match = /^https?:\/\/(?:[^@/?#]*@)?([^/?#:]*)/iu.exec(url.trim());
  return match === null ? null : (match[1] as string).toLowerCase().replace(/\.$/u, '');
}

/** The sentence a verb gets when the page has no page. */
export function blankPageRefusal(verb: string): string {
  return `This conversation's tab has no page open, so there is nothing to ${verb}. Open an address first.`;
}

/**
 * Why a deep verb is refused on this page, or `null` when it is allowed.
 *
 * Every sentence names the setting that would change the answer, because the
 * agent reading it cannot change the setting and the user reading the
 * transcript can. "Artemis settings → dev sites" is the path in the app.
 */
export function deepVerbRefusal(verb: 'storage' | 'evaluate' | 'cookies', url: string, standing: SiteStanding): string | null {
  const host = hostOfOpenPage(url) ?? url;
  switch (verb) {
    case 'storage':
      if (standing.deepRead) return null;
      return (
        `Local and session storage are not read on ${host}, which is not a site the user is developing. ` +
        'On a site they are signed in to, a stored token is the login. The user can add this site under Artemis settings → dev sites, ' +
        'or turn on deep reads everywhere in the same place.'
      );
    case 'evaluate':
      if (standing.evaluate) return null;
      return (
        `Running JavaScript is not allowed on ${host}, which is not a site the user is developing. ` +
        'Use click, type and read instead. The user can add this site under Artemis settings → dev sites, ' +
        'or allow evaluate everywhere in the same place.'
      );
    case 'cookies':
      // Never refused outright: names and attributes are enough to see that a
      // session exists and why it is not being sent, and that is a thing a
      // developer legitimately needs on any site. Only the values are held
      // back — see `redactCookies`.
      return null;
  }
}

/** The note that goes on a cookie result whose values were held back. */
export function redactionNotice(url: string): string {
  const host = hostOfOpenPage(url) ?? url;
  return (
    `Cookie values are omitted on ${host}, which is not a site the user is developing — on a site they are signed in to, ` +
    'the session cookie is the login. Names and attributes are shown. The user can add this site under Artemis settings → dev sites.'
  );
}

/** A cookie as CDP's `Network.getCookies` reports it. */
export interface RawCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  /** Seconds since the epoch, or -1 for a session cookie. */
  readonly expires?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: string;
}

/**
 * Cookies as the contract describes them, with values only where allowed.
 *
 * The omission is by construction — `value` is never written onto the object
 * unless `deepRead` — rather than by deleting a field afterwards, because the
 * version of this that builds the whole cookie and then strips it is the
 * version where one code path forgets to strip.
 */
export function redactCookies(raw: readonly RawCookie[], deepRead: boolean): readonly CookieEntry[] {
  return raw.map((cookie) => {
    const sameSite = cookie.sameSite === 'Strict' || cookie.sameSite === 'Lax' || cookie.sameSite === 'None' ? cookie.sameSite : undefined;
    const entry: CookieEntry = {
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure === true,
      ...(deepRead ? { value: cookie.value } : {}),
      ...(typeof cookie.expires === 'number' && cookie.expires > 0 ? { expires: cookie.expires } : {}),
      ...(sameSite === undefined ? {} : { sameSite }),
    };
    return entry;
  });
}
