/**
 * CDP payloads are reconciled into the contract's entries here, so these are
 * real payload shapes rather than invented ones — the levels, the argument
 * previews and the four-event network request are all as Chrome sends them.
 */

import { describe, expect, it } from 'vitest';

import { consoleEntryFor, describeRemoteObject, NetworkLedger } from './events.js';

describe('consoleEntryFor', () => {
  it('reads a console.log with its arguments joined the way a person would see them', () => {
    const entry = consoleEntryFor(
      'Runtime.consoleAPICalled',
      {
        type: 'log',
        args: [{ type: 'string', value: 'cart total' }, { type: 'number', value: 42 }],
        stackTrace: { callFrames: [{ url: 'http://localhost:3000/app.js', lineNumber: 11 }] },
      },
      1_000,
    );
    expect(entry).toEqual({ level: 'log', text: 'cart total 42', at: 1_000, source: 'http://localhost:3000/app.js:12' });
  });

  it('maps CDP’s console types onto the contract’s levels', () => {
    const level = (type: string): string | undefined => consoleEntryFor('Runtime.consoleAPICalled', { type, args: [] }, 0)?.level;
    expect(level('warning')).toBe('warn');
    expect(level('error')).toBe('error');
    expect(level('assert')).toBe('error');
    expect(level('trace')).toBe('debug');
    expect(level('info')).toBe('info');
    expect(level('dir')).toBe('log');
  });

  it('prefers an exception’s description, which carries the stack a developer wants', () => {
    const entry = consoleEntryFor(
      'Runtime.exceptionThrown',
      {
        exceptionDetails: {
          text: 'Uncaught',
          url: 'http://localhost:3000/app.js',
          lineNumber: 4,
          exception: { className: 'TypeError', description: 'TypeError: cart is not defined\n    at checkout (app.js:5:3)' },
        },
      },
      2_000,
    );
    expect(entry).toMatchObject({ level: 'exception', at: 2_000, source: 'http://localhost:3000/app.js:5' });
    expect(entry?.text).toContain('at checkout');
  });

  it('falls back to CDP’s own text when something that is not an Error was thrown', () => {
    const entry = consoleEntryFor('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught (in promise) 7' } }, 0);
    expect(entry?.text).toBe('Uncaught (in promise) 7');
  });

  it('reads the browser’s own messages about the page, which is where a failed request shows up', () => {
    const entry = consoleEntryFor(
      'Log.entryAdded',
      { entry: { source: 'network', level: 'error', text: 'Failed to load resource: net::ERR_CONNECTION_REFUSED', url: 'http://localhost:9/missing' } },
      3_000,
    );
    expect(entry).toEqual({ level: 'error', text: 'Failed to load resource: net::ERR_CONNECTION_REFUSED', at: 3_000, source: 'http://localhost:9/missing' });
  });

  it('ignores every event that is not one of the three', () => {
    expect(consoleEntryFor('Network.requestWillBeSent', { requestId: '1' }, 0)).toBeNull();
    expect(consoleEntryFor('Runtime.consoleAPICalled', 'not an object', 0)).toBeNull();
  });
});

describe('describeRemoteObject', () => {
  it('uses the preview rather than "[object Object]", which is the least useful string in software', () => {
    expect(
      describeRemoteObject({
        type: 'object',
        description: 'Object',
        preview: { properties: [{ name: 'id', value: '7' }, { name: 'sku', value: 'CJ-1' }], overflow: true },
      }),
    ).toBe('{ id: 7, sku: CJ-1, … }');
  });

  it('falls back to the description when there is no preview', () => {
    expect(describeRemoteObject({ type: 'function', description: 'function checkout() {}' })).toBe('function checkout() {}');
    expect(describeRemoteObject({ type: 'undefined' })).toBe('undefined');
  });
});

describe('NetworkLedger', () => {
  const ledger = (): NetworkLedger => new NetworkLedger();

  it('assembles a request from the four events that describe it', () => {
    const log = ledger();
    log.observe('Network.requestWillBeSent', { requestId: '1', timestamp: 100, type: 'XHR', request: { method: 'POST', url: 'http://localhost:3000/api/cart' } }, 5);
    log.observe('Network.responseReceived', { requestId: '1', timestamp: 100.2, type: 'XHR', response: { status: 201 } }, 5);
    log.observe('Network.loadingFinished', { requestId: '1', timestamp: 100.25 }, 5);
    expect(log.drain(false).entries).toEqual([
      { method: 'POST', url: 'http://localhost:3000/api/cart', at: 5, status: 201, resourceType: 'XHR', durationMs: 250 },
    ]);
  });

  it('keeps a request that never came back, which is the one an agent is usually asking about', () => {
    const log = ledger();
    log.observe('Network.requestWillBeSent', { requestId: '1', timestamp: 10, type: 'Fetch', request: { method: 'GET', url: 'http://127.0.0.1:9/gone' } }, 5);
    log.observe('Network.loadingFailed', { requestId: '1', timestamp: 10.05, errorText: 'net::ERR_CONNECTION_REFUSED' }, 5);
    const [entry] = log.drain(false).entries;
    expect(entry).toMatchObject({ url: 'http://127.0.0.1:9/gone', failure: 'net::ERR_CONNECTION_REFUSED', durationMs: 50 });
    expect(entry?.status).toBeUndefined();
  });

  it('reports a request still in flight, without a status or a duration', () => {
    const log = ledger();
    log.observe('Network.requestWillBeSent', { requestId: '1', timestamp: 10, request: { method: 'GET', url: 'http://a.test/slow' } }, 5);
    expect(log.drain(false).entries).toEqual([{ method: 'GET', url: 'http://a.test/slow', at: 5 }]);
  });

  it('keeps only the failures when asked, and still consumes the rest so they are not replayed', () => {
    const log = ledger();
    log.observe('Network.requestWillBeSent', { requestId: '1', timestamp: 1, request: { method: 'GET', url: 'http://a.test/ok' } }, 5);
    log.observe('Network.responseReceived', { requestId: '1', timestamp: 1, response: { status: 200 } }, 5);
    log.observe('Network.loadingFinished', { requestId: '1', timestamp: 1 }, 5);
    log.observe('Network.requestWillBeSent', { requestId: '2', timestamp: 1, request: { method: 'GET', url: 'http://a.test/404' } }, 5);
    log.observe('Network.responseReceived', { requestId: '2', timestamp: 1, response: { status: 404 } }, 5);
    log.observe('Network.loadingFinished', { requestId: '2', timestamp: 1 }, 5);

    expect(log.drain(true).entries.map((entry) => entry.url)).toEqual(['http://a.test/404']);
    expect(log.drain(false).entries).toEqual([]);
  });

  it('counts what a page that never stops requesting pushed off the end', () => {
    const log = ledger();
    for (let i = 0; i < 520; i += 1) {
      log.observe('Network.requestWillBeSent', { requestId: String(i), timestamp: 1, request: { method: 'GET', url: `http://a.test/${String(i)}` } }, 5);
    }
    const drained = log.drain(false);
    expect(drained.entries).toHaveLength(500);
    expect(drained.dropped).toBe(20);
    expect(drained.entries[0]?.url).toBe('http://a.test/20');
  });

  it('ignores an event for a request it never saw begin', () => {
    const log = ledger();
    log.observe('Network.loadingFinished', { requestId: 'ghost', timestamp: 1 }, 5);
    expect(log.drain(false).entries).toEqual([]);
  });
});
