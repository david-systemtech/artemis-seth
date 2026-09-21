/**
 * The one address this extension is allowed to dial.
 * ============================================================================
 *
 * The extension connects *out*, to Artemis, on the machine they share. Nothing
 * it does ever reaches a network, and that claim is only as good as the place
 * the address is built — so there is exactly one such place, it takes a port
 * and nothing else, and the host is a constant in this file.
 *
 * The options page therefore offers a port and no host field. That is not a
 * simplification of a more general setting; a host field would be the setting
 * that turns a browser full of live sessions into something a remote machine
 * can drive, and the value of having it is zero — Artemis listens on loopback.
 *
 * The manifest's `connect-src` says the same thing a second time, in a place
 * the extension's own code cannot reach. Two enforcement points for one rule is
 * usually a smell; here it is deliberate, because one of them is enforced by
 * the browser rather than by us.
 */

/** Loopback by literal address. Never a name, which could resolve elsewhere. */
export const BRIDGE_HOST = '127.0.0.1';

/**
 * The WebSocket address for a port, or `null` when the port is not one.
 *
 * Returning `null` rather than throwing because the caller is the reconnect
 * loop reading a number out of `chrome.storage`, and a stored value that has
 * been corrupted should stop the loop with a sentence on the options page, not
 * crash the service worker on every alarm.
 */
export function bridgeUrl(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return `ws://${BRIDGE_HOST}:${String(port)}/`;
}

/**
 * Whether an address is the bridge's own, checked the way a reader would.
 *
 * Used by the socket adapter as a last assertion before `new WebSocket(...)`,
 * so that a future refactor that starts building the address somewhere else
 * fails loudly rather than quietly dialling a stranger.
 */
export function isBridgeUrl(url: string): boolean {
  const match = /^ws:\/\/127\.0\.0\.1:(\d{1,5})\/$/u.exec(url);
  return match !== null && bridgeUrl(Number(match[1])) === url;
}
