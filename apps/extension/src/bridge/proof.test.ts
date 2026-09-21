/**
 * The proof has to match a Node implementation byte for byte, because the other
 * end of this handshake is one. Every case here is a way the two could differ.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { proveNonce, secretKeyBytes } from './proof.js';

const secret = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const nonce = 'd4735e3a265e16eee03f59718b9b5d03';

describe('proveNonce', () => {
  it('produces what Node produces for the same secret and nonce', async () => {
    const theirs = createHmac('sha256', Buffer.from(secret, 'hex')).update(nonce).digest('hex');
    await expect(proveNonce(secret, nonce)).resolves.toBe(theirs);
  });

  it('answers in lowercase hex, which is what the wire says', async () => {
    await expect(proveNonce(secret, nonce)).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });

  it('answers differently for a different nonce, which is the point of a challenge', async () => {
    const first = await proveNonce(secret, nonce);
    const second = await proveNonce(secret, `${nonce}0`);
    expect(first).not.toBe(second);
  });

  it('answers differently for a different secret, which is the point of the secret', async () => {
    const first = await proveNonce(secret, nonce);
    const second = await proveNonce(secret.replace(/^9/u, '8'), nonce);
    expect(first).not.toBe(second);
  });
});

describe('secretKeyBytes', () => {
  it('reads a hex secret as the bytes it denotes, not as its characters', () => {
    expect([...secretKeyBytes('0a1b')]).toEqual([0x0a, 0x1b]);
    expect(secretKeyBytes(secret)).toHaveLength(32);
  });

  it('falls back to the characters when the secret is not hex at all', () => {
    // Not an encoding on offer: this is so a malformed secret from some future
    // Artemis produces a refusal the user can read rather than an exception.
    expect([...secretKeyBytes('zz')]).toEqual([0x7a, 0x7a]);
    expect([...secretKeyBytes('abc')]).toEqual([0x61, 0x62, 0x63]);
    expect([...secretKeyBytes('')]).toEqual([]);
  });
});
