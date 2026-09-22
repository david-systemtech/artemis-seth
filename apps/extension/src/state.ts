/**
 * What the options page and the popup ask the service worker, and what it
 * answers.
 * ============================================================================
 *
 * An MV3 extension's pages are separate documents with no shared memory, and
 * the worker holding the socket is stopped and restarted underneath them. So
 * the UI never holds state: it asks, renders the answer, and asks again when
 * the worker says something changed. Both pages are small enough for that to
 * cost nothing and it removes the class of bug where a popup shows "connected"
 * about a socket that closed ten minutes ago.
 *
 * The storage keys are here too, in one place, because a key spelled two ways
 * is a pairing that survives in one file and not in another.
 */

import type { PagePolicy } from '@rx-artemis/protocol';

import type { AuditEntry } from './audit.js';

/** `chrome.storage.local` — survives a browser restart. */
export const LOCAL_KEYS = {
  /** The port Artemis listens on. */
  port: 'artemis.port',
  /** `{ browserId, secret }` from pairing. The one secret this extension holds. */
  credential: 'artemis.credential',
  /** The last policy Artemis sent, so a verb can be refused before it connects. */
  policy: 'artemis.policy',
  /** Which conversation has which tab, and the Artemis group. */
  tabs: 'artemis.tabs',
  /** The user's log of what was done in their browser. */
  audit: 'artemis.audit',
  /** Set by "Stop Artemis". Nothing reconnects until the user clears it. */
  stopped: 'artemis.stopped',
} as const;

/** `chrome.storage.session` — survives a worker restart, not a browser one. */
export const SESSION_KEYS = {
  /** Per-tab console buffers, so "since the last call" survives the worker. */
  buffers: 'artemis.buffers',
} as const;

/** Where the connection to Artemis has got to. */
export type BridgeStatus =
  /** No pairing yet. The options page is the only thing that can change this. */
  | 'unpaired'
  /** Dialling, or waiting out a backoff because Artemis is not running. */
  | 'connecting'
  /** Handshake finished, policy in hand, calls will be answered. */
  | 'connected'
  /** Artemis said no. `detail` is its sentence, shown verbatim. */
  | 'refused'
  /** The user pressed "Stop Artemis". Nothing reconnects until they say so. */
  | 'stopped';

/** One conversation's page, as the popup lists them. */
export interface RunSummary {
  readonly runKey: string;
  readonly tabId: number;
}

/** Everything the two pages draw. */
export interface ExtensionState {
  readonly status: BridgeStatus;
  /** Why, when there is a why: a refusal from Artemis, or a bad port. */
  readonly detail?: string;
  readonly port: number;
  readonly browserName: string;
  readonly extensionVersion: string;
  /** True once pairing has produced a credential, whatever the socket is doing. */
  readonly paired: boolean;
  readonly runs: readonly RunSummary[];
  /** The policy in force, for the options page to show what is allowed. */
  readonly policy: PagePolicy | null;
}

/** Options page or popup → worker. */
export type UiRequest =
  | { readonly type: 'state' }
  | { readonly type: 'pair'; readonly code: string }
  | { readonly type: 'unpair' }
  | { readonly type: 'setPort'; readonly port: number }
  | { readonly type: 'stop' }
  | { readonly type: 'resume' }
  | { readonly type: 'audit' };

/** Worker → options page or popup. */
export type UiResponse =
  | { readonly ok: true; readonly state: ExtensionState }
  | { readonly ok: true; readonly audit: readonly AuditEntry[] }
  | { readonly ok: false; readonly error: string };

/** Worker → every open page: something changed, ask again. */
export const STATE_CHANGED = 'artemis.stateChanged';

/** Whether a message from a page is one of the seven this extension answers. */
export function asUiRequest(message: unknown): UiRequest | null {
  if (typeof message !== 'object' || message === null) return null;
  const value = message as Record<string, unknown>;
  switch (value['type']) {
    case 'state':
    case 'unpair':
    case 'stop':
    case 'resume':
    case 'audit':
      return { type: value['type'] } as UiRequest;
    case 'pair':
      return typeof value['code'] === 'string' && value['code'].length > 0 && value['code'].length <= 128
        ? { type: 'pair', code: value['code'] }
        : null;
    case 'setPort':
      return typeof value['port'] === 'number' ? { type: 'setPort', port: value['port'] } : null;
    default:
      return null;
  }
}
