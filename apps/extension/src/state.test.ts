/**
 * What the two pages are allowed to ask the worker.
 *
 * `asUiRequest` is the only boundary between an extension page and the socket:
 * a message that gets past it becomes a pairing, a port change or a stop. The
 * pages are the extension's own and cannot be opened by a site — but they are
 * documents, and a document is the part of an extension that scripts end up
 * in, so the shapes are proved rather than assumed.
 *
 * The name is the case worth the most care. A pairing carries the label the
 * user typed, and a pairing that arrived without one would produce a browser
 * called "Chrome on Windows" in Artemis — which is exactly the row a second
 * Chrome profile would be indistinguishable from.
 */

import { describe, expect, it } from 'vitest';

import { asUiRequest } from './state.js';

describe('the messages a page may send', () => {
  it('reads the five that carry nothing', () => {
    for (const type of ['state', 'unpair', 'stop', 'resume', 'audit'] as const) {
      expect(asUiRequest({ type })).toEqual({ type });
    }
  });

  it('refuses anything that is not one of them', () => {
    expect(asUiRequest({ type: 'drive' })).toBeNull();
    expect(asUiRequest('pair')).toBeNull();
    expect(asUiRequest(null)).toBeNull();
  });

  it('reads a port as a number and nothing else', () => {
    expect(asUiRequest({ type: 'setPort', port: 47_615 })).toEqual({
      type: 'setPort',
      port: 47_615,
    });
    expect(asUiRequest({ type: 'setPort', port: '47615' })).toBeNull();
  });
});

describe('a pairing carries a name for this browser', () => {
  it('reads the code and the name together', () => {
    expect(asUiRequest({ type: 'pair', code: 'K7P2MXQ4', browserName: 'Work' })).toEqual({
      type: 'pair',
      code: 'K7P2MXQ4',
      browserName: 'Work',
    });
  });

  it('trims the name, because a trailing space is not part of what it is called', () => {
    expect(asUiRequest({ type: 'pair', code: 'K7P2MXQ4', browserName: '  Work  ' })).toEqual({
      type: 'pair',
      code: 'K7P2MXQ4',
      browserName: 'Work',
    });
  });

  it('refuses a pairing with no name at all', () => {
    // The options page says so before it gets here; this is the same rule at
    // the boundary, so an unnamed browser cannot be paired by any route.
    expect(asUiRequest({ type: 'pair', code: 'K7P2MXQ4' })).toBeNull();
    expect(asUiRequest({ type: 'pair', code: 'K7P2MXQ4', browserName: '   ' })).toBeNull();
    expect(asUiRequest({ type: 'pair', code: 'K7P2MXQ4', browserName: 7 })).toBeNull();
  });

  it('refuses a name longer than Artemis will store', () => {
    // Bounded here and stripped of control characters there, by the one
    // `nameOf` both pairing routes go through.
    expect(
      asUiRequest({ type: 'pair', code: 'K7P2MXQ4', browserName: 'x'.repeat(81) }),
    ).toBeNull();
    expect(
      asUiRequest({ type: 'pair', code: 'K7P2MXQ4', browserName: 'x'.repeat(80) }),
    ).toMatchObject({ browserName: 'x'.repeat(80) });
  });

  it('still refuses a pairing with no code, name or not', () => {
    expect(asUiRequest({ type: 'pair', browserName: 'Work' })).toBeNull();
    expect(asUiRequest({ type: 'pair', code: '', browserName: 'Work' })).toBeNull();
  });
});
