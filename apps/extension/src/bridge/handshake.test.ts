/**
 * The handshake decides whether a browser full of the user's logins is
 * Artemis's to drive, so every case here is a way somebody could try to skip a
 * step of it.
 */

import { DEFAULT_PAGE_POLICY, type PagePolicy } from '@rx-artemis/protocol';
import { describe, expect, it } from 'vitest';

import { BridgeHandshake, type BridgeCredential } from './handshake.js';

const identity = { browserName: 'Chrome on Windows', extensionVersion: '2.19.1' };
const credential: BridgeCredential = { browserId: 'browser-1', secret: 'a1b2' };
const policy: PagePolicy = { ...DEFAULT_PAGE_POLICY, devSites: ['*.cool-jams.com'] };
const sign = async (secret: string, nonce: string): Promise<string> => `mac(${secret},${nonce})`;

const paired = (): BridgeHandshake => new BridgeHandshake({ identity, credential, sign });
const pairing = (code: string): BridgeHandshake => new BridgeHandshake({ identity, credential: null, pairingCode: code, sign });

describe('the first message of a connection', () => {
  it('offers the code the user typed when this browser has never paired', () => {
    expect(pairing('884 210').opening()).toEqual({
      type: 'pair',
      version: 1,
      code: '884 210',
      browserName: 'Chrome on Windows',
      extensionVersion: '2.19.1',
    });
  });

  it('says hello with the browser id when this browser has paired before', () => {
    expect(paired().opening()).toEqual({
      type: 'hello',
      version: 1,
      browserId: 'browser-1',
      browserName: 'Chrome on Windows',
      extensionVersion: '2.19.1',
    });
  });

  it('has nothing to say when there is neither a credential nor a code', () => {
    expect(new BridgeHandshake({ identity, credential: null }).opening()).toBeNull();
  });
});

describe('pairing', () => {
  it('keeps the browser id and secret Artemis sent, and is live from that moment', async () => {
    const handshake = pairing('884 210');
    handshake.opening();
    const outcome = await handshake.receive({ type: 'paired', browserId: 'b2', secret: 'cafe', policy });
    expect(outcome).toEqual({ kind: 'paired', credential: { browserId: 'b2', secret: 'cafe' }, policy });
    expect(handshake.live).toBe(true);
  });

  it('refuses a pairing answer nobody asked for', async () => {
    const handshake = paired();
    handshake.opening();
    const outcome = await handshake.receive({ type: 'paired', browserId: 'b2', secret: 'cafe', policy });
    expect(outcome).toMatchObject({ kind: 'refused' });
    expect(handshake.live).toBe(false);
  });
});

describe('proving the secret', () => {
  it('answers a challenge with the mac of the nonce and does not send the secret', async () => {
    const handshake = paired();
    handshake.opening();
    const outcome = await handshake.receive({ type: 'challenge', nonce: 'nonce-1' });
    expect(outcome).toEqual({ kind: 'send', message: { type: 'proof', mac: 'mac(a1b2,nonce-1)' } });
    expect(JSON.stringify(outcome)).not.toContain('"a1b2"');
  });

  it('is live once Artemis says ready, and not before', async () => {
    const handshake = paired();
    handshake.opening();
    expect(handshake.live).toBe(false);
    await handshake.receive({ type: 'challenge', nonce: 'n' });
    expect(handshake.live).toBe(false);
    await handshake.receive({ type: 'ready', policy });
    expect(handshake.live).toBe(true);
  });

  it('refuses a ready that arrives before anything has been proved', async () => {
    const handshake = paired();
    handshake.opening();
    await expect(handshake.receive({ type: 'ready', policy })).resolves.toMatchObject({ kind: 'refused' });
    expect(handshake.live).toBe(false);
  });

  it('refuses a challenge to a browser that has not said hello', async () => {
    const handshake = pairing('884 210');
    handshake.opening();
    await expect(handshake.receive({ type: 'challenge', nonce: 'n' })).resolves.toMatchObject({ kind: 'refused' });
  });
});

describe('a live connection', () => {
  const live = async (): Promise<BridgeHandshake> => {
    const handshake = paired();
    handshake.opening();
    await handshake.receive({ type: 'challenge', nonce: 'n' });
    await handshake.receive({ type: 'ready', policy });
    return handshake;
  };

  it('hands a call on for the driver to run', async () => {
    const handshake = await live();
    const call = { type: 'call', id: '1', runKey: 'run-a', verb: 'read' } as const;
    await expect(handshake.receive(call)).resolves.toEqual({ kind: 'call', call });
  });

  it('refuses a call that arrives before the handshake finished, which is what skipping it looks like', async () => {
    const handshake = paired();
    handshake.opening();
    const outcome = await handshake.receive({ type: 'call', id: '1', runKey: 'run-a', verb: 'read' });
    expect(outcome).toEqual({ kind: 'refused', reason: 'Artemis sent a call before the connection was live.' });
  });

  it('takes a new policy from Artemis while connected, and not otherwise', async () => {
    const handshake = await live();
    const wider: PagePolicy = { ...policy, evaluateEverywhere: true };
    await expect(handshake.receive({ type: 'policy', policy: wider })).resolves.toEqual({ kind: 'policy', policy: wider });

    const fresh = paired();
    fresh.opening();
    await expect(fresh.receive({ type: 'policy', policy: wider })).resolves.toMatchObject({ kind: 'refused' });
  });

  it('answers a ping with a pong, at any point, so the socket stays up', async () => {
    const before = paired();
    await expect(before.receive({ type: 'ping' })).resolves.toEqual({ kind: 'send', message: { type: 'pong' } });
    const after = await live();
    await expect(after.receive({ type: 'ping' })).resolves.toEqual({ kind: 'send', message: { type: 'pong' } });
  });

  it('reports Artemis’s refusal verbatim and stops being live', async () => {
    const handshake = await live();
    const outcome = await handshake.receive({ type: 'refused', reason: 'That browser was revoked in settings.' });
    expect(outcome).toEqual({ kind: 'refused', reason: 'That browser was revoked in settings.' });
    expect(handshake.live).toBe(false);
  });
});
