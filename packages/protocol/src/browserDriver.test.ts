/**
 * What a site is, to an agent in the user's own browser.
 *
 * `standingOf` is the one function the extension and Artemis both call, so
 * that the browser and the app cannot disagree about whether a page may be
 * opened, read deeply, or scripted. Each case here is a way that could go
 * wrong with somebody's logins on the other end.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE_POLICY,
  hostMatches,
  hostOf,
  isLocalHost,
  standingOf,
  type DriverResult,
  type PagePolicy,
} from './browserDriver.js';

const policy = (over: Partial<PagePolicy> = {}): PagePolicy => ({ ...DEFAULT_PAGE_POLICY, ...over });

describe('hostMatches', () => {
  it('matches a wildcard against the bare domain and its subdomains, and nothing that merely ends the same', () => {
    expect(hostMatches('paypal.com', '*.paypal.com')).toBe(true);
    expect(hostMatches('www.paypal.com', '*.paypal.com')).toBe(true);
    expect(hostMatches('notpaypal.com', '*.paypal.com')).toBe(false);
    expect(hostMatches('paypal.com.evil.test', '*.paypal.com')).toBe(false);
  });

  it('matches anything else exactly, whatever its case', () => {
    expect(hostMatches('Staging.Example.com', 'staging.example.com')).toBe(true);
    expect(hostMatches('app.staging.example.com', 'staging.example.com')).toBe(false);
  });
});

describe('isLocalHost', () => {
  it.each(['localhost', '127.0.0.1', '10.0.0.5', '172.16.4.1', '172.31.255.1', '192.168.1.10', '169.254.1.1', '100.109.204.54', '[::1]', 'fd7a:115c:a1e0::1', 'nas.local', 'app.test', 'svc.internal'])(
    'counts %s as the user’s own machine or network',
    (host) => expect(isLocalHost(host)).toBe(true),
  );

  it.each(['example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.1.1', 'localhost.evil.com', 'mytest'])(
    'does not count %s',
    (host) => expect(isLocalHost(host)).toBe(false),
  );
});

describe('hostOf', () => {
  it('reads the host a browser would go to, not the one a reader sees first', () => {
    expect(hostOf('https://paypal.com@evil.test/login')).toEqual({ scheme: 'https', host: 'evil.test' });
    expect(hostOf('https://user:pw@www.paypal.com:8443/x?y#z')).toEqual({ scheme: 'https', host: 'www.paypal.com' });
    expect(hostOf('HTTPS://WWW.PayPal.COM./')).toEqual({ scheme: 'https', host: 'www.paypal.com' });
    expect(hostOf('http://[::1]:3000/')).toEqual({ scheme: 'http', host: '::1' });
  });

  it('refuses what it cannot read the way a browser would', () => {
    // A browser treats a backslash as a slash in an http address.
    expect(hostOf('https://evil.test\\@www.paypal.com/')).toBeNull();
    expect(hostOf('https://www.paypal.com\tevil.test/')).toBeNull();
    expect(hostOf('https:///')).toBeNull();
    expect(hostOf('')).toBeNull();
  });
});

describe('standingOf', () => {
  it('keeps an agent out of banks, payments and password managers by default', () => {
    for (const url of ['https://www.paypal.com/signin', 'https://vault.bitwarden.com/', 'https://online.bdo.com.ph/']) {
      const standing = standingOf(url, policy());
      expect(standing.blocked).toBe(true);
      expect(standing.reason).toContain('do not try another route');
    }
  });

  it('lets the user take a default entry off by hand, and only that one', () => {
    const mine = policy({ unblockedSites: ['*.stripe.com'] });
    expect(standingOf('https://dashboard.stripe.com/', mine).blocked).toBe(false);
    expect(standingOf('https://www.paypal.com/', mine).blocked).toBe(true);
  });

  it('blocks what the user added, even a dev site', () => {
    const mine = policy({ blockedSites: ['localhost'], devSites: ['localhost'] });
    expect(standingOf('http://localhost:3000/', mine).blocked).toBe(true);
  });

  it('is not fooled by a blocked name in the userinfo, in either direction', () => {
    expect(standingOf('https://github.com@www.paypal.com/', policy()).blocked).toBe(true);
    expect(standingOf('https://www.paypal.com@github.com/', policy()).blocked).toBe(false);
  });

  it('refuses anything that is not a web page', () => {
    for (const url of ['chrome://settings', 'file:///etc/passwd', 'chrome-extension://abc/page.html', 'javascript:alert(1)', 'not a url']) {
      expect(standingOf(url, policy()).blocked).toBe(true);
    }
  });

  it('gives an ordinary site the shallow verbs only', () => {
    expect(standingOf('https://github.com/', policy())).toEqual({ blocked: false, deepRead: false, evaluate: false });
  });

  it('gives the user’s own machine and network everything, unlisted', () => {
    for (const url of ['http://localhost:5173/', 'http://192.168.1.20:8080/', 'http://100.109.204.54:6472/']) {
      expect(standingOf(url, policy())).toEqual({ blocked: false, deepRead: true, evaluate: true });
    }
  });

  it('gives a listed dev site everything', () => {
    const mine = policy({ devSites: ['*.cool-jams.com'] });
    expect(standingOf('https://staging.cool-jams.com/cart', mine)).toEqual({ blocked: false, deepRead: true, evaluate: true });
  });

  it('widens scripting and deep reads separately, when the user asks for them everywhere', () => {
    expect(standingOf('https://github.com/', policy({ evaluateEverywhere: true }))).toEqual({
      blocked: false,
      deepRead: false,
      evaluate: true,
    });
    expect(standingOf('https://github.com/', policy({ deepReadEverywhere: true }))).toEqual({
      blocked: false,
      deepRead: true,
      evaluate: false,
    });
  });

  it('never lets "everywhere" reach a blocked site', () => {
    const wide = policy({ evaluateEverywhere: true, deepReadEverywhere: true });
    expect(standingOf('https://www.chase.com/', wide)).toMatchObject({ blocked: true, deepRead: false, evaluate: false });
  });
});

describe('DriverResult', () => {
  it('lets a driver hand back an answer and say what is missing from it', () => {
    // The shape a bounded console buffer needs: the lines that survived, plus
    // the fact that older ones did not. Compiling is most of the assertion —
    // before `notice` existed there was nowhere to put that sentence.
    const dropped: DriverResult<readonly string[]> = {
      ok: true,
      value: ['the last line'],
      notice: 'Artemis dropped 12 earlier console entries; the buffer holds 500.',
    };
    const whole: DriverResult<readonly string[]> = { ok: true, value: ['the last line'] };
    expect(dropped.ok && dropped.notice).toContain('dropped 12');
    expect(whole.ok && whole.notice).toBeUndefined();
  });
});
