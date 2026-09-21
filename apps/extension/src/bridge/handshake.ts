/**
 * The conversation that decides whether this browser is Artemis's to drive.
 * ============================================================================
 *
 * Two openings, one for each kind of connection:
 *
 *  - **Never paired.** The user has typed the code Artemis shows.
 *    `pair` → `paired`, and the secret arrives. The code is spent.
 *  - **Paired.** `hello` → `challenge` → `proof` → `ready`, and the secret is
 *    proved without being sent. See `proof.ts` for the encodings.
 *
 * Both end with a policy, which is the thing the extension actually needs: it
 * enforces the policy itself, so a connection that has not yet produced one
 * cannot be allowed to run a verb.
 *
 * ## Why this is a class with no socket in it
 *
 * Everything above is a state machine over messages, and the parts of it worth
 * being sure about — that a challenge before a hello is refused, that a call
 * arriving before `ready` is not run, that the mac is the mac — are exactly the
 * parts that a test with a real WebSocket, a real service worker and a real
 * Chrome would prove slowly and flakily. So the socket is somebody else's
 * problem: this takes parsed messages in and hands outcomes back, and
 * `worker.ts` is the thin thing that owns the wire.
 */

import { BRIDGE_PROTOCOL_VERSION, type BridgeCall, type BridgeFromArtemis, type BridgeFromExtension, type PagePolicy } from '@rx-artemis/protocol';

import { proveNonce } from './proof.js';

/** What this browser calls itself to Artemis. */
export interface BridgeIdentity {
  /** e.g. "Chrome on Windows". */
  readonly browserName: string;
  readonly extensionVersion: string;
}

/** What pairing left behind. */
export interface BridgeCredential {
  readonly browserId: string;
  /** Hex, per the contract. Never sent after the pairing that produced it. */
  readonly secret: string;
}

/** What the worker should do about one message from Artemis. */
export type BridgeOutcome =
  /** Put this on the wire. */
  | { readonly kind: 'send'; readonly message: BridgeFromExtension }
  /** Pairing succeeded: store these, then the connection is live. */
  | { readonly kind: 'paired'; readonly credential: BridgeCredential; readonly policy: PagePolicy }
  /** The connection is live. */
  | { readonly kind: 'ready'; readonly policy: PagePolicy }
  /** The policy changed under a live connection. */
  | { readonly kind: 'policy'; readonly policy: PagePolicy }
  /** Run this verb and answer with a `result`. */
  | { readonly kind: 'call'; readonly call: BridgeCall }
  /** Artemis said no, or said something at the wrong moment. Close, and say why. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** Nothing to do. A `pong`, or a repeat of something already handled. */
  | { readonly kind: 'ignore' };

/** How far along one connection is. */
export type HandshakePhase = 'opening' | 'awaiting-challenge' | 'proving' | 'live';

/**
 * One connection's half of the handshake.
 *
 * A fresh instance per connection — the phase is the connection's, not the
 * extension's, and reusing one across a reconnect is how a socket ends up
 * believing it is live because the last one was.
 */
export class BridgeHandshake {
  #phase: HandshakePhase = 'opening';

  readonly #identity: BridgeIdentity;
  readonly #credential: BridgeCredential | null;
  readonly #pairingCode: string | null;
  readonly #sign: (secret: string, nonce: string) => Promise<string>;

  constructor(options: {
    readonly identity: BridgeIdentity;
    /** What pairing left, or `null` on a connection that is trying to pair. */
    readonly credential: BridgeCredential | null;
    /** The code the user typed, on a connection that is trying to pair. */
    readonly pairingCode?: string | null;
    /** Swapped in the unit test for a deterministic mac. */
    readonly sign?: (secret: string, nonce: string) => Promise<string>;
  }) {
    this.#identity = options.identity;
    this.#credential = options.credential;
    this.#pairingCode = options.pairingCode ?? null;
    this.#sign = options.sign ?? proveNonce;
  }

  get phase(): HandshakePhase {
    return this.#phase;
  }

  /** Whether the connection has reached the point where a call may be run. */
  get live(): boolean {
    return this.#phase === 'live';
  }

  /**
   * The first message, sent the moment the socket opens.
   *
   * `null` when there is neither a credential nor a code, which is the
   * unpaired browser: there is nothing honest to say, so the worker does not
   * open a socket at all and the options page says "not paired".
   */
  opening(): BridgeFromExtension | null {
    if (this.#pairingCode !== null) {
      this.#phase = 'awaiting-challenge';
      return {
        type: 'pair',
        version: BRIDGE_PROTOCOL_VERSION,
        code: this.#pairingCode,
        browserName: this.#identity.browserName,
        extensionVersion: this.#identity.extensionVersion,
      };
    }
    if (this.#credential !== null) {
      this.#phase = 'awaiting-challenge';
      return {
        type: 'hello',
        version: BRIDGE_PROTOCOL_VERSION,
        browserId: this.#credential.browserId,
        browserName: this.#identity.browserName,
        extensionVersion: this.#identity.extensionVersion,
      };
    }
    return null;
  }

  /**
   * What to do about one message.
   *
   * Every branch states the phase it belongs to. A message that arrives in the
   * wrong one is refused rather than tolerated: a `call` before `ready` is the
   * shape an attempt to skip the handshake has, and answering it would make the
   * handshake decorative.
   */
  async receive(message: BridgeFromArtemis): Promise<BridgeOutcome> {
    switch (message.type) {
      case 'ping':
        return { kind: 'send', message: { type: 'pong' } };
      case 'pong':
        return { kind: 'ignore' };
      case 'refused':
        this.#phase = 'opening';
        return { kind: 'refused', reason: message.reason };

      case 'paired': {
        if (this.#phase !== 'awaiting-challenge' || this.#pairingCode === null) {
          return { kind: 'refused', reason: 'Artemis answered a pairing that was not asked for.' };
        }
        this.#phase = 'live';
        return {
          kind: 'paired',
          credential: { browserId: message.browserId, secret: message.secret },
          policy: message.policy,
        };
      }

      case 'challenge': {
        if (this.#phase !== 'awaiting-challenge' || this.#credential === null) {
          return { kind: 'refused', reason: 'Artemis challenged a browser that has not said hello.' };
        }
        const mac = await this.#sign(this.#credential.secret, message.nonce);
        this.#phase = 'proving';
        return { kind: 'send', message: { type: 'proof', mac } };
      }

      case 'ready': {
        if (this.#phase !== 'proving') {
          return { kind: 'refused', reason: 'Artemis said ready before this browser had proved anything.' };
        }
        this.#phase = 'live';
        return { kind: 'ready', policy: message.policy };
      }

      case 'policy': {
        if (this.#phase !== 'live') return { kind: 'refused', reason: 'Artemis sent a policy before the connection was live.' };
        return { kind: 'policy', policy: message.policy };
      }

      case 'call': {
        if (this.#phase !== 'live') return { kind: 'refused', reason: 'Artemis sent a call before the connection was live.' };
        return { kind: 'call', call: message };
      }
    }
  }
}
