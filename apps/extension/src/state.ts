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
  /**
   * What the user called this browser when they paired it.
   *
   * Stored rather than derived, because it is a label a person typed and not a
   * fact about the machine. `naming.ts` can only say "Chrome on Windows",
   * which is what two profiles on one computer both say — and telling them
   * apart is the whole reason Artemis asks for a name.
   */
  browserName: 'artemis.browserName',
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
  /**
   * What this browser calls itself: the label the user gave it, or — before
   * they have given one — what `naming.ts` can work out on its own.
   *
   * One field for both because both are the same thing to every reader of it:
   * the name this browser goes by. The options page shows it, and offers it as
   * the pairing field's starting text, which is where the machine-derived
   * version earns its keep.
   */
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
  | { readonly type: 'pair'; readonly code: string; readonly browserName: string }
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
    case 'pair': {
      /*
       * Both fields required, and the name is the one worth saying why about.
       * A pairing with no name produces a browser called "Chrome on Windows"
       * in Artemis, which is exactly the row a second profile would be
       * indistinguishable from — so the page makes the field required and this
       * refuses a message that arrived without one rather than quietly pairing
       * an unnamed browser. Bounded here at the length Artemis stores; the
       * control characters are stripped there, once, by `nameOf`.
       */
      const code = value['code'];
      const browserName = value['browserName'];
      if (typeof code !== 'string' || code.length === 0 || code.length > 128) return null;
      if (typeof browserName !== 'string') return null;
      const named = browserName.trim();
      if (named.length === 0 || named.length > 80) return null;
      return { type: 'pair', code, browserName: named };
    }
    case 'setPort':
      return typeof value['port'] === 'number' ? { type: 'setPort', port: value['port'] } : null;
    default:
      return null;
  }
}
