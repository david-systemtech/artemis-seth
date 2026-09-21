/**
 * A fake Artemis, for the end-to-end test.
 * ============================================================================
 *
 * A WebSocket server on a free loopback port that speaks the wire in
 * `@rx-artemis/protocol`: it answers a pairing code with a browser id and a
 * secret, challenges every later connection, verifies the proof with Node's own
 * HMAC, and sends calls whose results it awaits.
 *
 * It verifies the proof rather than accepting it, and that is the point of
 * having one. A fake that said "ready" to anything would let the extension pass
 * the suite while computing the mac over the wrong bytes — which is exactly the
 * mistake the encodings note on `BridgeProof` exists to prevent, and the only
 * way to catch it is to have a second implementation disagree.
 */

import { createHmac, randomBytes } from 'node:crypto';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  DEFAULT_PAGE_POLICY,
  type BridgeFromArtemis,
  type BridgeFromExtension,
  type BridgeVerb,
  type DriverResult,
  type PagePolicy,
} from '@rx-artemis/protocol';

/** One connection the extension made, for the test to assert on. */
export interface BridgeConnection {
  readonly opening: BridgeFromExtension;
  /** Whether the proof matched, on a connection that got as far as one. */
  proofVerified?: boolean;
}

export class FakeArtemis {
  readonly connections: BridgeConnection[] = [];
  readonly pings: number[] = [];

  /** Set to make the next proof be rejected, whatever it is. */
  rejectNextProof = false;

  #server: WebSocketServer | null = null;
  #socket: WebSocket | null = null;
  #code = '884210';
  #secret = randomBytes(32).toString('hex');
  #browserId = 'browser-under-test';
  #policy: PagePolicy = DEFAULT_PAGE_POLICY;
  #nextCallId = 0;
  readonly #pending = new Map<string, (result: DriverResult<unknown>) => void>();
  readonly #ready: (() => void)[] = [];

  get pairingCode(): string {
    return this.#code;
  }

  get port(): number {
    const address = this.#server?.address();
    if (address === null || address === undefined || typeof address === 'string') throw new Error('The fake Artemis is not listening.');
    return address.port;
  }

  get connected(): boolean {
    return this.#socket !== null && this.#socket.readyState === this.#socket.OPEN;
  }

  async listen(): Promise<this> {
    this.#server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => this.#server?.once('listening', resolve));
    this.#server.on('connection', (socket) => {
      this.#socket = socket;
      socket.on('message', (raw) => {
        void this.#receive(socket, String(raw));
      });
      socket.on('close', () => {
        if (this.#socket === socket) this.#socket = null;
      });
    });
    return this;
  }

  /** Resolves once a connection has reached `ready` or `paired`. */
  async waitUntilLive(within = 30_000): Promise<void> {
    if (this.connected && this.#liveSockets.has(this.#socket as WebSocket)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The extension never finished a handshake.')), within);
      this.#ready.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Resolves once the live connection has gone away. */
  async waitUntilClosed(within = 30_000): Promise<void> {
    const deadline = Date.now() + within;
    while (this.connected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.connected) throw new Error('The extension kept the connection open.');
  }

  /** Send a policy update down a live connection. */
  setPolicy(policy: PagePolicy): void {
    this.#policy = policy;
    this.#send({ type: 'policy', policy });
  }

  /** Run one verb on one conversation's page and wait for the answer. */
  async call(runKey: string, verb: BridgeVerb, within = 60_000): Promise<DriverResult<unknown>> {
    const id = `call-${String(++this.#nextCallId)}`;
    return new Promise<DriverResult<unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`The extension never answered ${verb.verb} (${id}).`));
      }, within);
      this.#pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.#send({ type: 'call', id, runKey, ...verb } as BridgeFromArtemis);
    });
  }

  /** Drop the live connection, so the extension has to redial and prove itself. */
  dropConnection(): void {
    this.#socket?.close();
    this.#socket = null;
  }

  async close(): Promise<void> {
    for (const resolve of this.#pending.values()) resolve({ ok: false, reason: 'the fake Artemis shut down' });
    this.#pending.clear();
    this.#socket?.terminate();
    await new Promise<void>((resolve) => {
      if (this.#server === null) {
        resolve();
        return;
      }
      for (const client of this.#server.clients) client.terminate();
      this.#server.close(() => resolve());
    });
  }

  readonly #liveSockets = new Set<WebSocket>();

  #send(message: BridgeFromArtemis): void {
    if (this.#socket === null || this.#socket.readyState !== this.#socket.OPEN) throw new Error('No live connection to Artemis’s extension.');
    this.#socket.send(JSON.stringify(message));
  }

  async #receive(socket: WebSocket, raw: string): Promise<void> {
    const message = JSON.parse(raw) as BridgeFromExtension;
    const answer = (value: BridgeFromArtemis): void => socket.send(JSON.stringify(value));

    switch (message.type) {
      case 'ping':
        this.pings.push(Date.now());
        answer({ type: 'pong' });
        return;

      case 'pair': {
        this.connections.push({ opening: message });
        if (message.code.replace(/\s/gu, '') !== this.#code) {
          answer({ type: 'refused', reason: 'That pairing code is not the one Artemis is showing.' });
          return;
        }
        answer({ type: 'paired', browserId: this.#browserId, secret: this.#secret, policy: this.#policy });
        this.#goLive(socket);
        return;
      }

      case 'hello': {
        this.connections.push({ opening: message });
        this.#nonce = randomBytes(16).toString('hex');
        answer({ type: 'challenge', nonce: this.#nonce });
        return;
      }

      case 'proof': {
        const expected = createHmac('sha256', Buffer.from(this.#secret, 'hex')).update(this.#nonce).digest('hex');
        const verified = message.mac === expected && !this.rejectNextProof;
        const connection = this.connections.at(-1);
        if (connection !== undefined) connection.proofVerified = message.mac === expected;
        if (!verified) {
          this.rejectNextProof = false;
          answer({ type: 'refused', reason: 'That browser could not prove it is the one Artemis paired with.' });
          return;
        }
        answer({ type: 'ready', policy: this.#policy });
        this.#goLive(socket);
        return;
      }

      case 'result': {
        this.#pending.get(message.id)?.(message.result);
        this.#pending.delete(message.id);
        return;
      }

      default:
        return;
    }
  }

  #nonce = '';

  #goLive(socket: WebSocket): void {
    this.#socket = socket;
    this.#liveSockets.add(socket);
    for (const resolve of this.#ready.splice(0)) resolve();
  }
}
