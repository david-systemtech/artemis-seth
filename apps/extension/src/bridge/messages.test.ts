/**
 * Everything that comes down this socket is parsed before it is believed. The
 * cases here are the ones where believing it would matter: a call with a verb
 * nobody implements, a policy that is not a policy, a frame that is not JSON.
 */

import { describe, expect, it } from 'vitest';

import { parseFromArtemis } from './messages.js';

const wire = (value: unknown): string => JSON.stringify(value);

describe('parseFromArtemis', () => {
  it('reads each of the messages Artemis sends', () => {
    expect(parseFromArtemis(wire({ type: 'challenge', nonce: 'n' }))).toEqual({ type: 'challenge', nonce: 'n' });
    expect(parseFromArtemis(wire({ type: 'ping' }))).toEqual({ type: 'ping' });
    expect(parseFromArtemis(wire({ type: 'refused', reason: 'no' }))).toEqual({ type: 'refused', reason: 'no' });
  });

  it('reads a policy with all five of its fields and nothing else', () => {
    const parsed = parseFromArtemis(
      wire({
        type: 'ready',
        policy: { devSites: ['a.test'], blockedSites: [], unblockedSites: ['*.stripe.com'], evaluateEverywhere: true, deepReadEverywhere: false, extra: 'ignored' },
      }),
    );
    expect(parsed).toEqual({
      type: 'ready',
      policy: { devSites: ['a.test'], blockedSites: [], unblockedSites: ['*.stripe.com'], evaluateEverywhere: true, deepReadEverywhere: false },
    });
  });

  it('refuses a policy whose lists are not lists of host patterns', () => {
    for (const policy of [
      { devSites: 'a.test', blockedSites: [], unblockedSites: [] },
      { devSites: [1], blockedSites: [], unblockedSites: [] },
      { devSites: [], blockedSites: [] },
      { devSites: [], blockedSites: [], unblockedSites: [Array.from({ length: 300 }).join('x')] },
    ]) {
      expect(parseFromArtemis(wire({ type: 'ready', policy })), JSON.stringify(policy)).toBeNull();
    }
  });

  it('reads each verb with its own arguments', () => {
    const head = { type: 'call', id: '7', runKey: 'run-a' };
    expect(parseFromArtemis(wire({ ...head, verb: 'open' }))).toEqual({ ...head, verb: 'open' });
    expect(parseFromArtemis(wire({ ...head, verb: 'open', url: 'https://a.test/' }))).toEqual({ ...head, verb: 'open', url: 'https://a.test/' });
    expect(parseFromArtemis(wire({ ...head, verb: 'type', selector: '#a', text: 'hi' }))).toEqual({ ...head, verb: 'type', selector: '#a', text: 'hi' });
    expect(parseFromArtemis(wire({ ...head, verb: 'network' }))).toEqual({ ...head, verb: 'network', failedOnly: false });
    expect(parseFromArtemis(wire({ ...head, verb: 'network', failedOnly: true }))).toEqual({ ...head, verb: 'network', failedOnly: true });
  });

  it('refuses a call whose verb’s own arguments are missing or the wrong type', () => {
    const head = { type: 'call', id: '7', runKey: 'run-a' };
    expect(parseFromArtemis(wire({ ...head, verb: 'navigate' }))).toBeNull();
    expect(parseFromArtemis(wire({ ...head, verb: 'click' }))).toBeNull();
    expect(parseFromArtemis(wire({ ...head, verb: 'type', selector: '#a' }))).toBeNull();
    expect(parseFromArtemis(wire({ ...head, verb: 'evaluate', expression: 42 }))).toBeNull();
    expect(parseFromArtemis(wire({ ...head, verb: 'open', url: 42 }))).toBeNull();
  });

  it('refuses a verb this extension does not implement', () => {
    expect(parseFromArtemis(wire({ type: 'call', id: '7', runKey: 'a', verb: 'download' }))).toBeNull();
    expect(parseFromArtemis(wire({ type: 'call', id: '7', runKey: 'a', verb: '__proto__' }))).toBeNull();
  });

  it('refuses a call with no id or no run, which is a call that could not be answered', () => {
    expect(parseFromArtemis(wire({ type: 'call', runKey: 'a', verb: 'read' }))).toBeNull();
    expect(parseFromArtemis(wire({ type: 'call', id: '7', verb: 'read' }))).toBeNull();
  });

  it('refuses what is not a message at all', () => {
    for (const raw of ['', 'null', '[]', '"hello"', '{', wire({ type: 'nonsense' }), wire({})]) {
      expect(parseFromArtemis(raw), raw).toBeNull();
    }
  });

  it('refuses a field long enough to be an attack on a service worker’s memory', () => {
    const huge = 'a'.repeat(70_000);
    expect(parseFromArtemis(wire({ type: 'call', id: '7', runKey: 'a', verb: 'click', selector: huge }))).toBeNull();
    expect(parseFromArtemis(wire({ type: 'refused', reason: huge }))).toBeNull();
  });
});
