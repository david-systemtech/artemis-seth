/**
 * What the extension decides about a page, with the user's logins on the other
 * end of it. `standingOf` itself is tested in `@rx-artemis/protocol`; what is
 * here is the extension's own layer — the blank page, the Web Store, the
 * wording of a refusal, and the cookie values that must not leave.
 */

import { DEFAULT_PAGE_POLICY, type PagePolicy, type SiteStanding } from '@rx-artemis/protocol';
import { describe, expect, it } from 'vitest';

import { blankPageRefusal, deepVerbRefusal, isBlankPage, redactCookies, redactionNotice, standingOfPage, type RawCookie } from './policy.js';

const policy = (over: Partial<PagePolicy> = {}): PagePolicy => ({ ...DEFAULT_PAGE_POLICY, ...over });

describe('standingOfPage', () => {
  it('calls a tab with nothing in it blank rather than blocked', () => {
    for (const url of ['', '   ', 'about:blank', 'ABOUT:BLANK', 'chrome://newtab/']) {
      expect(standingOfPage(url, policy()), url).toEqual({ kind: 'blank' });
    }
  });

  it('blocks a bank with the sentence the agent is given, and repeats it unchanged', () => {
    const standing = standingOfPage('https://www.chase.com/', policy());
    expect(standing.kind).toBe('blocked');
    expect(standing.kind === 'blocked' && standing.reason).toContain('do not try another route to it');
  });

  it('blocks the Chrome Web Store, which no setting can unblock because Chrome will not allow it either', () => {
    for (const url of ['https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/detail/x']) {
      const standing = standingOfPage(url, policy({ unblockedSites: ['chromewebstore.google.com', 'chrome.google.com'], devSites: ['chromewebstore.google.com'] }));
      expect(standing.kind, url).toBe('blocked');
      expect(standing.kind === 'blocked' && standing.reason).toContain('not a setting the user can change');
    }
  });

  it('blocks everything that is not a web page, which is where chrome:// and file:// go', () => {
    for (const url of ['chrome://settings', 'file:///etc/passwd', 'chrome-extension://abc/options.html', 'devtools://devtools/bundled/x.html']) {
      expect(standingOfPage(url, policy()).kind, url).toBe('blocked');
    }
  });

  it('gives an ordinary site the shallow verbs and a dev site everything', () => {
    expect(standingOfPage('https://github.com/x', policy())).toEqual({
      kind: 'open',
      url: 'https://github.com/x',
      standing: { blocked: false, deepRead: false, evaluate: false },
    });
    expect(standingOfPage('http://localhost:5173/', policy())).toMatchObject({
      kind: 'open',
      standing: { deepRead: true, evaluate: true },
    });
  });
});

describe('isBlankPage', () => {
  it('does not mistake a site called "about" for a blank tab', () => {
    expect(isBlankPage('https://about.gitlab.com/')).toBe(false);
    expect(isBlankPage('https://example.com/about:blank')).toBe(false);
  });
});

describe('a refusal names what the user could change', () => {
  const shallow: SiteStanding = { blocked: false, deepRead: false, evaluate: false };
  const deep: SiteStanding = { blocked: false, deepRead: true, evaluate: true };

  it('refuses storage off a dev site and says where the setting is', () => {
    const reason = deepVerbRefusal('storage', 'https://app.example.com/x', shallow);
    expect(reason).toContain('app.example.com');
    expect(reason).toContain('Artemis settings → dev sites');
  });

  it('refuses evaluate off a dev site and offers the verbs that are allowed', () => {
    const reason = deepVerbRefusal('evaluate', 'https://app.example.com/x', shallow);
    expect(reason).toContain('Use click, type and read instead');
  });

  it('allows both on a site the user is developing', () => {
    expect(deepVerbRefusal('storage', 'http://localhost:3000/', deep)).toBeNull();
    expect(deepVerbRefusal('evaluate', 'http://localhost:3000/', deep)).toBeNull();
  });

  it('never refuses cookies outright, because names and attributes are a developer’s business anywhere', () => {
    expect(deepVerbRefusal('cookies', 'https://app.example.com/', shallow)).toBeNull();
  });

  it('says what is missing from a page that has none', () => {
    expect(blankPageRefusal('read')).toContain('Open an address first');
  });
});

describe('redactCookies', () => {
  const raw: readonly RawCookie[] = [
    { name: 'sid', value: 'super-secret', domain: 'app.example.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: 1_800_000_000 },
    { name: 'theme', value: 'dark', domain: 'app.example.com', path: '/', expires: -1, sameSite: 'Nonsense' },
  ];

  it('gives values on a site the user is developing', () => {
    expect(redactCookies(raw, true)[0]).toEqual({
      name: 'sid',
      value: 'super-secret',
      domain: 'app.example.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      expires: 1_800_000_000,
    });
  });

  it('gives names and attributes but never a value anywhere else', () => {
    const redacted = redactCookies(raw, false);
    expect(redacted[0]).toEqual({ name: 'sid', domain: 'app.example.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: 1_800_000_000 });
    expect(JSON.stringify(redacted)).not.toContain('super-secret');
    expect(redacted.every((cookie) => !('value' in cookie))).toBe(true);
  });

  it('leaves out a session cookie’s expiry and a same-site value the contract does not have', () => {
    const [, theme] = redactCookies(raw, true);
    expect(theme).toEqual({ name: 'theme', value: 'dark', domain: 'app.example.com', path: '/', httpOnly: false, secure: false });
  });

  it('explains the omission in words the model can act on', () => {
    expect(redactionNotice('https://app.example.com/x')).toContain('the session cookie is the login');
    expect(redactionNotice('https://app.example.com/x')).toContain('Artemis settings → dev sites');
  });
});
