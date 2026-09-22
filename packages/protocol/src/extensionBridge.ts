/**
 * What Settings knows about the browser extension, and what it may ask for.
 * ============================================================================
 *
 * `browserDriver.ts` holds the contract between Artemis and the extension —
 * the verbs, the policy, and the messages that cross the socket. This file
 * holds the other conversation: the one between the main process, which owns
 * that socket, and the renderer, which draws a pane about it.
 *
 * They are separate files because they have separate audiences and separate
 * rules. The wire types are implemented by code a colleague is writing in
 * another repository and must stay narrow. These types are IPC payloads, and
 * the rule that governs them is the one in SECURITY.md: **no secret crosses
 * into the renderer.** A paired browser holds a 32-byte secret, and nothing on
 * this page carries it. {@link PairedBrowserInfo} is what a person needs in
 * order to recognise a browser and decide whether to unpair it — a name, a
 * date, whether it is connected — and it is deliberately the whole of what the
 * renderer is told. `main/redact.ts` scans every reply on the way out; this
 * shape is what makes that scan uneventful rather than load-bearing.
 */

import type { PagePolicy } from './browserDriver.js';

/**
 * One browser this Artemis has paired with, as Settings draws it.
 *
 * Note the absent field. The secret established at pairing stays in the main
 * process's store; the renderer has no use for it — it does not speak the
 * bridge protocol — and a value that never leaves main cannot leak from a
 * window.
 */
export interface PairedBrowserInfo {
  /** Artemis's own id for the browser. Meaningless outside this machine. */
  readonly browserId: string;
  /** What the extension called itself, e.g. "Chrome on Windows". */
  readonly browserName: string;
  /** When the pairing was made. Milliseconds since the epoch. */
  readonly pairedAt: number;
  /** Whether that browser has a live connection to the bridge right now. */
  readonly connected: boolean;
  /**
   * The extension's version, as of its most recent connection.
   *
   * Absent for a browser that has not connected since Artemis started keeping
   * this — which is also the honest reading for one that has never connected.
   * Compared against {@link ExtensionBridgeState.bundledVersion} to say when
   * an unpacked extension has fallen behind the app that ships it.
   */
  readonly extensionVersion?: string;
  /** When it last connected. Absent if it never has. */
  readonly lastSeenAt?: number;
}

/**
 * Whether the bridge has a port, and what happened if it does not.
 *
 * `port-in-use` is a state and not a retry, deliberately. The extension dials
 * a fixed address; an Artemis that quietly moved to another port would be an
 * Artemis no extension could find, and the only symptom would be a browser
 * that never connects for reasons nobody can see. So the port is what it is,
 * the failure is shown, and the user is told which port to free — or given the
 * field to change it on both sides.
 */
export type ExtensionBridgeListening =
  /** Bound, and the extension can reach it. */
  | { readonly kind: 'listening'; readonly port: number }
  /** Something else holds the port. Named so the message can say which. */
  | { readonly kind: 'port-in-use'; readonly port: number }
  /** Not started, or stopped. */
  | { readonly kind: 'stopped' }
  /** Bound and then failed, or failed for a reason that is not the port. */
  | { readonly kind: 'failed'; readonly port: number; readonly message: string };

/**
 * A pairing code that is being shown right now.
 *
 * Carries the code because the whole point is to put it on screen, and the
 * expiry as an absolute instant rather than a remaining duration: a countdown
 * computed in the renderer from a timestamp stays right across a push that
 * arrives late, and one shipped as "270 seconds left" does not.
 */
export interface PairingOffer {
  readonly code: string;
  /** When the code stops working. Milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** Everything the Browser pane draws, in one object. */
export interface ExtensionBridgeState {
  readonly listening: ExtensionBridgeListening;
  /** Every paired browser, oldest pairing first. */
  readonly browsers: readonly PairedBrowserInfo[];
  /** The code on screen, or `null` when none is being offered. */
  readonly pairing: PairingOffer | null;
  /** What the paired browsers are allowed to do. Pushed to them as it changes. */
  readonly policy: PagePolicy;
  /**
   * The version of the extension this build of Artemis ships, or `null` when
   * it ships none — a development build, or a packaging step that did not run.
   *
   * `null` is what turns "Get the extension" into a sentence explaining why it
   * cannot help, rather than a button that saves nothing.
   */
  readonly bundledVersion: string | null;
}

/** Whether any browser is connected — the one question most callers have. */
export function anyBrowserConnected(state: ExtensionBridgeState): boolean {
  return state.browsers.some((browser) => browser.connected);
}

/**
 * Whether a paired browser is running an extension older than the app's.
 *
 * A string comparison would call `1.10.0` older than `1.9.0`, so the parts are
 * compared as numbers. Anything that is not a dotted number — a build someone
 * loaded by hand, a version this function cannot read — is reported as *not*
 * outdated: nagging about a version nobody can interpret would be noise, and
 * an unpacked extension is by definition one somebody is managing themselves.
 */
export function extensionIsOutdated(
  installed: string | undefined,
  bundled: string | null,
): boolean {
  if (installed === undefined || bundled === null) return false;
  const left = versionParts(installed);
  const right = versionParts(bundled);
  if (left === null || right === null) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

function versionParts(version: string): number[] | null {
  // A pre-release suffix is dropped rather than refused: `2.19.1-beta.3` is
  // close enough to `2.19.1` for "is this behind the app" to be answerable.
  const core = version.trim().split(/[-+]/u)[0] ?? '';
  if (!/^\d+(?:\.\d+)*$/u.test(core)) return null;
  return core.split('.').map((part) => Number(part));
}
