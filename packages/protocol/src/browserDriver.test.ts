/**
 * What a site is, to an agent in the user's own browser.
 *
 * `standingOf` is the one function the extension and Artemis both call, so
 * that the browser and the app cannot disagree about whether a page may be
 * opened, read deeply, or scripted. Each case here is a way that could go
 * wrong with somebody's logins on the other end.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_PAGE_POLICY, hostMatches, isLocalHost, standingOf, type PagePolicy } from './browserDriver.js';

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
