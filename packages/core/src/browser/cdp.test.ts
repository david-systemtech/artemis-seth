/**
 * The wire: matching answers to questions, and turning a compose file's idea of
 * an address into something that can be dialled.
 *
 * The endpoint resolution is the half with a trap in it. Chromium refuses an
 * HTTP request to its DevTools port whose `Host` header is a name rather than
 * an address, which is exactly what `http://browser:9222` produces — so the
 * name is resolved here and the address is what asks. A regression would look
 * like "the browser service is down" and would be nothing of the kind.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { CdpConnection, resolveCdpEndpoint, type CdpTransport } from './cdp.js';

/** A socket that records what was written and lets a test answer it. */
function fakeTransport(): {
  transport: CdpTransport;
  sent: Record<string, unknown>[];
  reply: (message: Record<string, unknown>) => void;
  raw: (text: string) => void;
  end: () => void;
} {
  const sent: Record<string, unknown>[] = [];
  let onMessage: ((message: string) => void) | null = null;
  let onClose: (() => void) | null = null;
  return {
    sent,
    reply: (message) => onMessage?.(JSON.stringify(message)),
    raw: (text) => onMessage?.(text),
    end: () => onClose?.(),
    transport: {
      send: (message) => sent.push(JSON.parse(message) as Record<string, unknown>),
      close: () => onClose?.(),
      onMessage: (listener) => {
        onMessage = listener;
      },
      onClose: (listener) => {
        onClose = listener;
      },
    },
  };
}

describe('a connection matches answers to questions', () => {
  it('resolves a call with the result that carries its id', async () => {
    const fake = fakeTransport();
    const cdp = new CdpConnection(fake.transport);
    const call = cdp.call('Browser.getVersion');
    expect(fake.sent[0]).toMatchObject({ id: 1, method: 'Browser.getVersion', params: {} });
    fake.reply({ id: 1, result: { product: 'HeadlessChrome/141' } });
    await expect(call).resolves.toEqual({ product: 'HeadlessChrome/141' });
  });

  it('carries a session id so a flattened connection reaches one tab', async () => {
    const fake = fakeTransport();
    const cdp = new CdpConnection(fake.transport);
    void cdp.call('Page.enable', {}, 'session-a');
    expect(fake.sent[0]).toMatchObject({ sessionId: 'session-a' });
  });

  it('rejects with the browser’s own words, and its detail', async () => {
    const fake = fakeTransport();
    const cdp = new CdpConnection(fake.transport);
    const call = cdp.call('DOM.querySelector');
    fake.reply({ id: 1, error: { message: 'Invalid selector', data: 'unexpected token' } });
    await expect(call).rejects.toThrow('Invalid selector: unexpected token');
  });

  it('answers out of order without confusing two callers', async () => {
    const fake = fakeTransport();
    const cdp = new CdpConnection(fake.transport);
    const first = cdp.call('A');
    const second = cdp.call('B');
    fake.reply({ id: 2, result: { which: 'B' } });
    fake.reply({ id: 1, result: { which: 'A' } });
    await expect(first).resolves.toEqual({ which: 'A' });
    await expect(second).resolves.toEqual({ which: 'B' });
  });

  it('fans an event out only to the session that asked for it', () => {
    const fake = fakeTransport();
    const cdp = new CdpConnection(fake.transport);
    const mine: unknown[] = [];
    const theirs: unknown[] = [];
    cdp.on('Runtime.consoleAPICalled', (params) => mine.push(params), 'session-a');
    cdp.on('Runtime.consoleAPICalled', (params) => theirs.push(params), 'session-b');
    fake.reply({ method: 'Runtime.consoleAPICalled', sessionId: 'session-a', params: { type: 'log' } });
    expect(mine).toEqual([{ type: 'log' }]);
    expect(theirs).toEqual([]);
  });

  it('stops delivering to a listener that unsubscribed', () => {
    const fake = fakeTransport();
    const cdp = new CdpConnection(fake.transport);
    const seen: unknown[] = [];
    const off = cdp.on('Page.loadEventFired', () => seen.push(1), 's');
    fake.reply({ method: 'Page.loadEventFired', sessionId: 's', params: {} });
    off();
    fake.reply({ method: 'Page.loadEventFired', sessionId: 's', params: {} });
    expect(seen).toHaveLength(1);
  });

  it('ends every call in flight when the socket dies, rather than leaving them hanging', async () => {
    // A promise that never settles would park the turn until the run's own
    // deadline hours later. A sentence is an answer; silence is not.
    const fake = fakeTransport();
    const cdp = new CdpConnection(fake.transport);
    const call = cdp.call('Page.navigate');
    fake.end();
    await expect(call).rejects.toThrow('The browser connection closed.');
    await expect(cdp.call('Page.navigate')).rejects.toThrow('The browser connection closed.');
    expect(cdp.open).toBe(false);
  });

  it('tells whoever is holding it that the socket went away', () => {
    const fake = fakeTransport();
    const cdp = new CdpConnection(fake.transport);
    const told = vi.fn();
    cdp.onClosed(told);
    fake.end();
    expect(told).toHaveBeenCalledTimes(1);
  });

  it('ignores a frame that is not JSON rather than failing a caller for it', async () => {
    const fake = fakeTransport();
    const cdp = new CdpConnection(fake.transport);
    const call = cdp.call('Browser.getVersion');
    // There is no call this could be the answer to; inventing a failure for
    // somebody still waiting would be worse than dropping it.
    fake.raw('<html>a proxy said something</html>');
    fake.reply({ id: 1, result: {} });
    await expect(call).resolves.toEqual({});
  });
});

describe('turning a compose file’s address into an endpoint', () => {
  const lookup = async (name: string): Promise<string> =>
    name === 'browser' ? '172.20.0.3' : Promise.reject(new Error(`no such host ${name}`));

  it('resolves an http address through /json/version, asking by IP', async () => {
    // The trap: Chromium answers `500 Host header is specified and is not an IP
    // address or localhost` to `http://browser:9222/json/version`. The request
    // has to be made to the address.
    const asked: string[] = [];
    const endpoint = await resolveCdpEndpoint('http://browser:9222', {
      lookup,
      fetchJson: async (url) => {
        asked.push(url);
        return { webSocketDebuggerUrl: 'ws://172.20.0.3:9222/devtools/browser/abc' };
      },
    });
    expect(asked).toEqual(['http://172.20.0.3:9222/json/version']);
    expect(endpoint).toBe('ws://172.20.0.3:9222/devtools/browser/abc');
  });

  it('resolves a bare ws address the same way, because the path carries a UUID', async () => {
    const asked: string[] = [];
    await resolveCdpEndpoint('ws://browser:9222', {
      lookup,
      fetchJson: async (url) => {
        asked.push(url);
        return { webSocketDebuggerUrl: 'ws://172.20.0.3:9222/devtools/browser/abc' };
      },
    });
    expect(asked).toEqual(['http://172.20.0.3:9222/json/version']);
  });

  it('uses a full devtools endpoint as it stands, with the name resolved', async () => {
    const endpoint = await resolveCdpEndpoint('ws://browser:9222/devtools/browser/abc', {
      lookup,
      fetchJson: async () => {
        throw new Error('should not have asked');
      },
    });
    expect(endpoint).toBe('ws://172.20.0.3:9222/devtools/browser/abc');
  });

  it('leaves an address literal alone rather than resolving it', async () => {
    const endpoint = await resolveCdpEndpoint('ws://127.0.0.1:9222/devtools/browser/abc', {
      lookup: async () => {
        throw new Error('should not have looked anything up');
      },
    });
    expect(endpoint).toBe('ws://127.0.0.1:9222/devtools/browser/abc');
  });

  it('brackets an IPv6 address in a full devtools endpoint too', async () => {
    /*
     * The failure this pins is silent. `ws:` is a special scheme, so the WHATWG
     * host parser refuses a bare IPv6 literal — and `URL.hostname =` does not
     * throw when it refuses, it leaves the old host alone. Without the
     * brackets the endpoint comes back still naming `browser`, which is the
     * one thing resolving it was for.
     */
    const endpoint = await resolveCdpEndpoint('ws://browser:9222/devtools/browser/abc', {
      lookup: async () => 'fd00::5',
    });
    expect(endpoint).toBe('ws://[fd00::5]:9222/devtools/browser/abc');
  });

  it('brackets an IPv6 address when it asks', async () => {
    const asked: string[] = [];
    await resolveCdpEndpoint('http://browser:9222', {
      lookup: async () => 'fd00::5',
      fetchJson: async (url) => {
        asked.push(url);
        return { webSocketDebuggerUrl: 'ws://[fd00::5]:9222/devtools/browser/abc' };
      },
    });
    expect(asked).toEqual(['http://[fd00::5]:9222/json/version']);
  });

  it('says which variable is wrong when the address is not one', async () => {
    await expect(resolveCdpEndpoint('browser:9222')).rejects.toThrow('ARTEMIS_BROWSER_CDP_URL');
    await expect(resolveCdpEndpoint('ftp://browser/')).rejects.toThrow('must be http, https, ws or wss');
  });

  it('says the host could not be resolved, and does not pretend it did', async () => {
    await expect(
      resolveCdpEndpoint('http://nowhere:9222', { lookup }),
    ).rejects.toThrow('Could not resolve "nowhere"');
  });

  it('says so when something is listening but is not a browser', async () => {
    await expect(
      resolveCdpEndpoint('http://browser:9222', { lookup, fetchJson: async () => ({ ok: true }) }),
    ).rejects.toThrow('did not name a webSocketDebuggerUrl');
  });

  it('gives up on an endpoint that accepts the connection and then says nothing', async () => {
    /*
     * The one place on the connect path with nothing above it: this runs before
     * any `CdpConnection` exists, so none of that class's deadlines apply. A
     * half-started container, or a proxy holding the request open, used to hang
     * the run's first `browser_open` for the life of the run.
     *
     * The stub honours the signal and does nothing else, which is exactly the
     * endpoint being described — so what settles this promise is the deadline
     * or nothing at all.
     */
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', async (_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('This operation was aborted', 'AbortError'));
          });
        });
      });
      const resolving = resolveCdpEndpoint('http://browser:9222', { lookup });
      const said = expect(resolving).rejects.toThrow(
        'The browser at http://172.20.0.3:9222/json/version did not answer within 10 seconds.',
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await said;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe('the source of this feature is source', () => {
  it('holds no raw control byte, so git does not call a file binary', () => {
    /*
     * This is here because it happened. A listener key was joined with a
     * literal NUL written straight into a template string, which made git
     * classify `cdp.ts` as binary: `git diff` showed `- -` instead of line
     * counts, the pull request could not be reviewed, and `git grep` skipped
     * the file. The fix is to write the separator as an escape; this is what
     * stops the next one.
     *
     * Tab and newline are the two control characters source legitimately has.
     * Everything else below 0x20, plus DEL, is a byte that arrived by accident
     * — from a paste, or from a tool that decoded an escape on the way in.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    for (const name of readdirSync(here)) {
      if (!name.endsWith('.ts')) continue;
      const bytes = readFileSync(join(here, name));
      const at = bytes.findIndex(
        (byte) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f,
      );
      if (at >= 0) offenders.push(`${name} at byte ${String(at)} (0x${bytes[at]?.toString(16) ?? ''})`);
    }
    expect(offenders).toEqual([]);
  });
});
