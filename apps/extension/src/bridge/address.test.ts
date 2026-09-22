import { describe, expect, it } from 'vitest';

import { bridgeUrl, isBridgeUrl } from './address.js';

describe('bridgeUrl', () => {
  it('builds an address on loopback and nowhere else', () => {
    expect(bridgeUrl(47_615)).toBe('ws://127.0.0.1:47615/');
    expect(bridgeUrl(1)).toBe('ws://127.0.0.1:1/');
    expect(bridgeUrl(65_535)).toBe('ws://127.0.0.1:65535/');
  });

  it('refuses a port that is not one, rather than dialling something odd', () => {
    for (const port of [0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(bridgeUrl(port)).toBeNull();
    }
  });
});

describe('isBridgeUrl', () => {
  it('accepts what bridgeUrl produced', () => {
    expect(isBridgeUrl('ws://127.0.0.1:47615/')).toBe(true);
  });

  it('rejects every other host, scheme and shape', () => {
    for (const url of [
      'ws://localhost:47615/',
      'ws://127.0.0.2:47615/',
      'ws://127.0.0.1.evil.test:47615/',
      'wss://127.0.0.1:47615/',
      'ws://127.0.0.1:47615/path',
      'ws://user@127.0.0.1:47615/',
      'ws://127.0.0.1:0/',
      'http://127.0.0.1:47615/',
    ]) {
      expect(isBridgeUrl(url), url).toBe(false);
    }
  });
});
