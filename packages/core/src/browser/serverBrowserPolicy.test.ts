/**
 * Where the server's browser may go.
 *
 * The rule is the inverse of the desktop's, and that inversion is the thing
 * worth pinning: this browser holds no logins, so the bank list is irrelevant
 * to it, and it sits inside the operator's network, so everything private is
 * the thing it must not touch. A rewrite that quietly reused `standingOf` would
 * pass a casual reading and open the LAN.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_BLOCKED_SITES } from '@rx-artemis/protocol';

import { DEFAULT_ALLOW_HOSTS, allowListFrom, navigationStanding } from './serverBrowserPolicy.js';

const DEFAULTS = { allowHosts: DEFAULT_ALLOW_HOSTS };

function reasonFor(url: string, allowHosts: readonly string[] = DEFAULT_ALLOW_HOSTS): string {
  const standing = navigationStanding(url, { allowHosts });
  if (standing.allowed) throw new Error(`${url} was allowed`);
  return standing.reason;
}

describe('the public internet is open to it', () => {
  it('opens an ordinary address', () => {
    expect(navigationStanding('https://example.com/docs', DEFAULTS)).toEqual({
      allowed: true,
      host: 'example.com',
    });
  });

  it('opens a site the desktop browsers refuse, because it holds no login there', () => {
    // The whole reason this file exists rather than calling `standingOf`. That
    // list is about a browser holding the *user's* sessions; a refusal here
    // would cost an agent a public help page and prevent nothing.
    expect(DEFAULT_BLOCKED_SITES).toContain('*.paypal.com');
    expect(navigationStanding('https://developer.paypal.com/docs', DEFAULTS).allowed).toBe(true);
  });

  it('refuses a scheme that is not http or https', () => {
    expect(reasonFor('file:///etc/passwd')).toContain('Only http and https');
    expect(reasonFor('javascript:alert(1)')).toContain('Only http and https');
  });

  it('refuses something that is not an address at all', () => {
    expect(reasonFor('not a url')).toContain('is not an address');
  });

  it('reads the host past userinfo, as the contract parser does', () => {
    // `https://example.com@169.254.169.254/` is the metadata service wearing a
    // public name. The gate has to see the host the browser would see.
    expect(reasonFor('http://example.com@169.254.169.254/latest/meta-data/')).toContain(
      'cloud metadata address',
    );
  });
});

describe('the operator’s own network is shut unless they named it', () => {
  it('refuses a private address', () => {
    expect(reasonFor('http://192.168.1.10/admin')).toContain('inside the operator’s own network');
  });

  it('refuses the tailnet’s CGNAT range', () => {
    expect(reasonFor('http://100.101.102.103:8080/')).toContain('inside the operator’s own network');
  });

  it('refuses an IPv6 unique-local address', () => {
    expect(reasonFor('http://[fd12:3456::1]/')).toContain('inside the operator’s own network');
  });

  it('refuses a .internal name', () => {
    expect(reasonFor('https://wiki.internal/')).toContain('inside the operator’s own network');
  });

  it('opens the server’s own loopback and compose name by default', () => {
    expect(navigationStanding('http://localhost:5173/', DEFAULTS).allowed).toBe(true);
    expect(navigationStanding('http://127.0.0.1:5173/', DEFAULTS).allowed).toBe(true);
    expect(navigationStanding('http://artemis-server:3000/orders', DEFAULTS).allowed).toBe(true);
  });

  it('opens an internal host the operator named, and only that one', () => {
    const policy = allowListFrom('staging.internal, 192.168.1.50');
    expect(navigationStanding('https://staging.internal/app', policy).allowed).toBe(true);
    expect(navigationStanding('http://192.168.1.50:8080/', policy).allowed).toBe(true);
    expect(navigationStanding('http://192.168.1.51:8080/', policy).allowed).toBe(false);
  });

  it('keeps the server’s own hosts when an operator adds their own', () => {
    // An operator naming a staging box did not mean to cut the browser off from
    // the dev servers, which are the reason it exists.
    const policy = allowListFrom('staging.internal');
    expect(policy.allowHosts).toEqual(expect.arrayContaining([...DEFAULT_ALLOW_HOSTS]));
  });

  it('takes a wildcard pattern for a whole internal domain', () => {
    const policy = allowListFrom('*.corp.example');
    expect(navigationStanding('https://build.corp.example/', policy).allowed).toBe(true);
    expect(navigationStanding('https://corp.example/', policy).allowed).toBe(true);
  });

  it('says what to do instead, rather than only saying no', () => {
    expect(reasonFor('http://10.0.0.5/')).toContain('ARTEMIS_BROWSER_ALLOW_HOSTS');
    expect(reasonFor('http://10.0.0.5/')).toContain('Do not look for another route to it');
  });
});

describe('the cloud metadata services have no switch', () => {
  it('refuses them by address and by name', () => {
    expect(reasonFor('http://169.254.169.254/latest/meta-data/')).toContain('cloud metadata');
    expect(reasonFor('http://[fd00:ec2::254]/')).toContain('cloud metadata');
    expect(reasonFor('http://metadata.google.internal/computeMetadata/v1/')).toContain(
      'cloud metadata',
    );
  });

  it('refuses them even when an operator put one on the allow-list', () => {
    // The one rule with no operator override. What is behind it is the host's
    // own credentials, which is not a thing anybody means to allow.
    const policy = allowListFrom('169.254.169.254,metadata.google.internal');
    expect(navigationStanding('http://169.254.169.254/', policy).allowed).toBe(false);
    expect(navigationStanding('http://metadata.google.internal/', policy).allowed).toBe(false);
  });
});

describe('reading the allow-list an operator wrote', () => {
  it('ignores blank entries and normalises case', () => {
    const policy = allowListFrom(' , Staging.Internal ,, ');
    expect(policy.allowHosts).toContain('staging.internal');
    expect(policy.allowHosts.filter((one) => one.length === 0)).toEqual([]);
  });

  it('is the defaults when nothing was set', () => {
    expect(allowListFrom(undefined).allowHosts).toEqual([...DEFAULT_ALLOW_HOSTS]);
  });
});
