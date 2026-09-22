/**
 * The socket the Artemis extension dials into.
 * ============================================================================
 *
 * One WebSocket server, on loopback, on a fixed port. The extension dials
 * *out* to it — a browser extension can open a socket and cannot listen on
 * one — and everything that crosses it is in `protocol/browserDriver.ts`. This
 * file is the Artemis half: who is allowed to connect, how they prove it, and
 * how a tool call becomes a message and an answer becomes a `DriverResult`.
 *
 * ## What is keeping strangers out, and in what order
 *
 * Four gates, and each is doing a different job:
 *
 * 1. **Loopback only.** The server binds `127.0.0.1`, so nothing off this
 *    machine can reach it at all. A browser on another computer is out of
 *    scope by design — issue #436 says the extension only ever talks to the
 *    Artemis client it shares a machine with, and a served conversation
 *    reaches it through that client.
 * 2. **`Origin` must be the Artemis extension's own.** Browsers send `Origin`
 *    on a WebSocket handshake and cannot be talked out of it, so this is what
 *    stops an ordinary web page — which can also open a socket to
 *    `127.0.0.1` — from reaching the bridge. A page's origin is its site; an
 *    extension's is its id, and the Artemis extension's id is fixed by the
 *    `key` in its manifest, so the check is against *that one id* rather than
 *    against the scheme. A second extension the user installed is not the
 *    Artemis extension and has no business on this port.
 *
 *    {@link ARTEMIS_EXTENSION_ORIGIN_OVERRIDE} is the documented way past it,
 *    and it exists for one case: somebody building the extension from source
 *    without the manifest `key`, which Chrome then gives an id derived from
 *    the directory it was loaded from. That is a development machine, and the
 *    variable says so.
 * 3. **A pairing code, once.** Minted in Artemis, shown on screen, typed into
 *    the extension. Eight characters from an alphabet with no `O`/`0` or
 *    `I`/`1` in it, good for five minutes, spent on first use, and burned after
 *    a handful of wrong guesses. A local process could dial the socket while a
 *    code is live; it would have to guess the code before a person finishes
 *    reading it.
 * 4. **A secret, on every later connection.** Artemis sends a nonce, the
 *    extension answers `HMAC-SHA256(secret, nonce)`, and the comparison is
 *    constant-time. The secret itself never goes back on the wire after
 *    pairing, and a nonce is good for one connection.
 *
 * Gate 2 is doing the heavy lifting and gate 1 is doing more than it looks
 * like: together they mean the attacker this design is actually worried about
 * is a program already running as the user on their own machine, which is a
 * program that could read the extension's storage instead.
 *
 * ## One connection per paired browser
 *
 * A second connection claiming a browser id displaces the first, rather than
 * being refused. Chrome's MV3 service worker is killed and restarted whenever
 * Chrome feels like it, and a worker that comes back has no way to know
 * whether its predecessor's socket is still half-open on this side. Refusing
 * the new one would leave the browser permanently unreachable behind a socket
 * nobody is reading; displacing it means the freshest connection wins, which
 * is the one that can actually answer.
 *
 * ## Nothing here decides policy
 *
 * The {@link PagePolicy} is pushed to every connected browser and applied
 * *inside* the browser. That is the whole point of putting it there: a
 * compromised Artemis cannot talk its way past a rule the extension enforces
 * against the address a tab actually has. This file sends the policy and does
 * not check it.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  BRIDGE_DEFAULT_PORT,
  BRIDGE_PROTOCOL_VERSION,
  ARTEMIS_EXTENSION_ID,
  type BridgeFromArtemis,
  type BridgeVerb,
  type DriverResult,
  type ExtensionBridgeListening,
  type ExtensionBridgeState,
  type PagePolicy,
  type PairingOffer,
} from '@rx-artemis/protocol';

import type { BridgeCallOutcome, ExtensionDriverHost } from './extensionPageDriver.js';
import { createLogger } from './log.js';
import { info, type PairedBrowser, type PairedBrowsers } from './pairedBrowsers.js';

const log = createLogger('extension-bridge');

/**
 * The environment variable that widens the `Origin` gate.
 *
 * One or more `chrome-extension://…` origins, comma-separated. For somebody
 * running a build of the extension without the manifest `key` that fixes its
 * id — Chrome then derives one from the directory it was loaded from, so it
 * differs per machine and cannot be written down here.
 *
 * Not a general escape hatch: anything that is not a `chrome-extension://`
 * origin is dropped, so this cannot be used to let a web page in.
 */
export const ARTEMIS_EXTENSION_ORIGIN_OVERRIDE = 'ARTEMIS_EXTENSION_ORIGINS';

function developmentOrigins(): readonly string[] {
  const named = process.env[ARTEMIS_EXTENSION_ORIGIN_OVERRIDE];
  if (named === undefined) return [];
  return named
    .split(',')
    .map((one) => one.trim())
    .filter((one) => /^chrome-extension:\/\/[a-p]{32}$/u.test(one));
}

/* -------------------------------------------------------------------------- */
/* Constants with reasons                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The alphabet a pairing code is drawn from.
 *
 * Upper case, and without `I`, `O`, `0`, `1` — the four characters people
 * mistype when copying a code off one screen into another. What is left is 32
 * symbols, so eight characters carry forty bits: more than enough against an
 * attacker who has five minutes and gets five guesses.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** How long a code is. See {@link CODE_ALPHABET} for the arithmetic. */
const CODE_LENGTH = 8;

/**
 * How long a code is good for.
 *
 * Five minutes is the time it takes to find the Chrome window, open the
 * extension and type eight characters, with room for being interrupted. A code
 * that outlived the pane it was shown in would be a credential sitting in a
 * file nobody remembers is open.
 */
const CODE_TTL_MS = 5 * 60 * 1000;

/**
 * How many wrong codes before the offer is withdrawn.
 *
 * Forty bits does not need a small number here; the small number is for the
 * other case. A user mistyping twice is normal and the third try should work;
 * a process guessing has already told us something is wrong, and re-showing
 * the code costs the user one click. Five is the wrong-guess budget, counted
 * across every connection, because an attacker with five guesses per socket
 * would simply open more sockets.
 */
const CODE_ATTEMPTS = 5;

/**
 * Largest message accepted, in bytes.
 *
 * A screenshot of a tall page, base64-encoded, is the biggest thing the
 * contract carries and can reach a few megabytes. Eight is generous for that
 * and small enough that a peer sending garbage cannot grow this process's
 * heap. `ws` enforces it in its own frame reader and closes the connection,
 * so nothing oversized is ever assembled.
 */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/**
 * How long the handshake has to finish.
 *
 * A connection that has opened but said nothing holds a socket and an entry in
 * a map. Ten seconds is far longer than a `hello` takes and short enough that
 * a process opening sockets and stalling achieves nothing.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * How often Artemis pings a connected browser.
 *
 * MV3 kills an idle service worker in thirty seconds. A message on the socket
 * is activity, so this is what keeps the extension alive between tool calls —
 * without it a conversation's first browser verb after a pause would always
 * find a dead worker. Twenty seconds leaves margin for a late tick.
 */
const PING_INTERVAL_MS = 20_000;

/* -------------------------------------------------------------------------- */
/* The bridge                                                                 */
/* -------------------------------------------------------------------------- */

export interface ExtensionBridgeOptions {
  readonly store: PairedBrowsers;
  /** Where to listen. Defaults to {@link BRIDGE_DEFAULT_PORT}. */
  readonly port?: number;
  /** The extension version this build ships, or `null` when it ships none. */
  readonly bundledVersion?: string | null;
  /** Called whenever {@link ExtensionBridge.state} would answer differently. */
  readonly onStateChange?: (state: ExtensionBridgeState) => void;
  /**
   * Extra origins to accept beyond the shipped extension's.
   *
   * For tests, which load a build from a temporary directory and so meet an
   * id Chrome derived rather than the one the manifest's `key` fixes. In the
   * app this is unset and {@link ARTEMIS_EXTENSION_ORIGIN_OVERRIDE} is the
   * only way to widen it.
   */
  readonly extensionOrigins?: readonly string[];
}

export interface ExtensionBridge extends ExtensionDriverHost {
  /** Bind the port. Resolves once the outcome — bound or not — is known. */
  start(): Promise<void>;
  /** Everything Settings draws. Carries no secret. */
  state(): ExtensionBridgeState;
  /** Show a pairing code, or withdraw the one on screen. */
  offerPairing(offer: boolean): ExtensionBridgeState;
  /** Forget a browser, cutting its connection. */
  unpair(browserId: string): Promise<ExtensionBridgeState>;
  /** Save the policy and push it to every connected browser. */
  setPolicy(policy: PagePolicy): Promise<ExtensionBridgeState>;
  /** Tell every connected browser this run is over, and forget its calls. */
  endRun(runKey: string): void;
  /** Close the port and every connection. */
  dispose(): Promise<void>;
}

/** One live, authenticated connection. */
interface Connection {
  readonly socket: WebSocket;
  readonly browserId: string;
  /** Calls sent and not yet answered, by id. */
  readonly pending: Map<string, (outcome: BridgeCallOutcome) => void>;
}

export function createExtensionBridge(options: ExtensionBridgeOptions): ExtensionBridge {
  const port = options.port ?? BRIDGE_DEFAULT_PORT;
  const store = options.store;
  const bundledVersion = options.bundledVersion ?? null;

  /**
   * The origins allowed through gate 2: the shipped extension, plus whatever
   * a developer named. See the file header on why that override exists.
   */
  const allowedOrigins = new Set([
    `chrome-extension://${ARTEMIS_EXTENSION_ID}`,
    ...(options.extensionOrigins ?? developmentOrigins()),
  ]);

  let listening: ExtensionBridgeListening = { kind: 'stopped' };
  let server: WebSocketServer | null = null;
  let pairing: (PairingOffer & { attempts: number }) | null = null;
  let pairingTimer: NodeJS.Timeout | null = null;
  /** browserId → its one live connection. */
  const connections = new Map<string, Connection>();

  function announce(): ExtensionBridgeState {
    const next = currentState();
    try {
      options.onStateChange?.(next);
    } catch (error) {
      log.error('An extension-bridge state listener threw', error);
    }
    return next;
  }

  function currentState(): ExtensionBridgeState {
    return {
      listening,
      browsers: store.all().map((browser) => info(browser, connections.has(browser.browserId))),
      pairing: pairing === null ? null : { code: pairing.code, expiresAt: pairing.expiresAt },
      policy: store.policy(),
      bundledVersion,
    };
  }

  function send(socket: WebSocket, message: BridgeFromArtemis): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      // A socket that died between the readyState check and the write. The
      // close handler is what cleans up; there is nothing to do here but not
      // take the caller down with it.
      log.debug('Could not write to a bridge connection', error);
    }
  }

  /** End a connection, having said why. `ws` sends the close after the frame. */
  function refuse(socket: WebSocket, reason: string): void {
    send(socket, { type: 'refused', reason });
    socket.close();
  }

  function withdrawPairing(): void {
    if (pairingTimer !== null) {
      clearTimeout(pairingTimer);
      pairingTimer = null;
    }
    pairing = null;
  }

  /**
   * Drop a connection's record and fail everything it owed us.
   *
   * The pending calls matter. A browser that goes away mid-verb leaves a tool
   * call waiting on a promise nobody will ever settle, and the run would hang
   * until its own timeout — which is up to twenty seconds of a turn spent on a
   * socket that is provably gone. Settling them now turns that into the
   * sentence the driver has ready.
   */
  function drop(browserId: string, connection: Connection): void {
    if (connections.get(browserId) !== connection) return;
    connections.delete(browserId);
    for (const settle of connection.pending.values()) settle({ status: 'disconnected' });
    connection.pending.clear();
    announce();
  }

  /* ------------------------------------------------------------------ */
  /* The handshake                                                      */
  /* ------------------------------------------------------------------ */

  function accept(socket: WebSocket, request: IncomingMessage): void {
    /*
     * The Origin gate, first, before a byte of the peer's own framing is
     * parsed. A browser sets this header itself and a page cannot forge it, so
     * this is the line between "the Artemis extension" and "a web page that
     * knows the port". A non-browser client can of course send anything it
     * likes here — which is what the pairing code and the proof are for.
     */
    const origin = request.headers.origin;
    if (origin === undefined || !allowedOrigins.has(origin)) {
      log.warn(`Refused a bridge connection from ${String(origin)}, which is not the Artemis extension.`);
      refuse(socket, 'This port only accepts connections from the Artemis browser extension.');
      return;
    }

    /** Authenticated? And if not, what are we waiting for? */
    let stage: 'greeting' | 'challenged' | 'live' = 'greeting';
    let nonce: string | null = null;
    let claimed: PairedBrowser | null = null;
    // What the extension said it was when it introduced itself, kept for the
    // proof: the stored record's version is what it was at pairing, and an
    // extension the user has since updated reconnects rather than re-pairs.
    let claimedVersion: string | undefined;
    let connection: Connection | null = null;
    let ping: NodeJS.Timeout | null = null;

    const handshakeTimer = setTimeout(() => {
      if (stage !== 'live') refuse(socket, 'The handshake did not finish in time.');
    }, HANDSHAKE_TIMEOUT_MS);

    const stopTimers = (): void => {
      clearTimeout(handshakeTimer);
      if (ping !== null) {
        clearInterval(ping);
        ping = null;
      }
    };

    /** Everything after a good proof or a good code: one connection, live. */
    const goLive = (browser: PairedBrowser, extensionVersion: string): void => {
      stage = 'live';
      clearTimeout(handshakeTimer);
      /*
       * One connection per browser, newest wins. See the file header: an MV3
       * worker that was killed and restarted cannot know whether its old
       * socket is still half-open here, and refusing the new one would leave
       * the browser unreachable behind a socket nobody reads.
       */
      const existing = connections.get(browser.browserId);
      if (existing !== undefined) {
        log.info(`A second connection claimed ${browser.browserName}; the older one is closing.`);
        drop(browser.browserId, existing);
        refuse(existing.socket, 'This browser connected again; the earlier connection is closing.');
      }
      connection = { socket, browserId: browser.browserId, pending: new Map() };
      connections.set(browser.browserId, connection);
      ping = setInterval(() => {
        send(socket, { type: 'ping' });
      }, PING_INTERVAL_MS);
      void store.noteSeen(browser.browserId, extensionVersion, Date.now()).then(() => {
        announce();
      });
      announce();
    };

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const message = parse(raw);
      if (message === null) {
        refuse(socket, 'That was not a message this bridge understands.');
        return;
      }

      switch (message.type) {
        case 'ping':
          send(socket, { type: 'pong' });
          return;
        case 'pong':
          return;

        case 'pair': {
          if (stage !== 'greeting') {
            refuse(socket, 'This connection has already been introduced.');
            return;
          }
          if (message.version !== BRIDGE_PROTOCOL_VERSION) {
            refuse(socket, versionMismatch(message.version));
            return;
          }
          const paired = spendCode(message.code);
          if (paired === null) {
            // Deliberately one sentence for "wrong", "expired" and "already
            // used". Which of the three it was is a fact about Artemis's
            // state, and telling a peer that cannot name a code which kind of
            // no it got is telling it how to search.
            refuse(socket, 'That pairing code is not valid. Ask Artemis for a new one.');
            return;
          }
          const browser: PairedBrowser = {
            browserId: randomBytes(16).toString('hex'),
            secret: randomBytes(32).toString('hex'),
            browserName: nameOf(message.browserName),
            pairedAt: Date.now(),
            extensionVersion: message.extensionVersion,
            lastSeenAt: Date.now(),
          };
          void store.add(browser).then(() => {
            announce();
          });
          log.info(`Paired with ${browser.browserName}.`);
          send(socket, {
            type: 'paired',
            browserId: browser.browserId,
            secret: browser.secret,
            policy: store.policy(),
          });
          goLive(browser, message.extensionVersion);
          return;
        }

        case 'hello': {
          if (stage !== 'greeting') {
            refuse(socket, 'This connection has already been introduced.');
            return;
          }
          if (message.version !== BRIDGE_PROTOCOL_VERSION) {
            refuse(socket, versionMismatch(message.version));
            return;
          }
          const found = store.find(message.browserId);
          /*
           * A browser Artemis has forgotten is challenged anyway, against a
           * secret that does not exist, and fails at the proof. The peer
           * learns "no" either way, and learns it at the same point in the
           * exchange — a hello answered with an immediate refusal would turn
           * this port into an oracle for which browser ids are paired.
           */
          claimed = found;
          claimedVersion = message.extensionVersion;
          nonce = randomBytes(32).toString('hex');
          stage = 'challenged';
          send(socket, { type: 'challenge', nonce });
          return;
        }

        case 'proof': {
          if (stage !== 'challenged' || nonce === null) {
            refuse(socket, 'Nothing was asked of this connection yet.');
            return;
          }
          const asked = nonce;
          // A nonce is good for exactly one answer. Clearing it here is what
          // makes a replayed proof useless: the second one finds no challenge
          // outstanding and is refused above.
          nonce = null;
          stage = 'greeting';
          if (claimed === null || !proves(claimed.secret, asked, message.mac)) {
            log.warn('Refused a bridge connection that could not prove its pairing.');
            refuse(socket, 'This browser is not paired with Artemis. Pair it again in Artemis settings.');
            return;
          }
          goLive(claimed, claimedVersion ?? claimed.extensionVersion ?? 'unknown');
          send(socket, { type: 'ready', policy: store.policy() });
          return;
        }

        case 'result': {
          if (stage !== 'live' || connection === null) {
            refuse(socket, 'This connection has not been introduced.');
            return;
          }
          const settle = connection.pending.get(message.id);
          if (settle === undefined) {
            // An answer to a call that already timed out, or an id nobody
            // sent. Dropped in silence: it is the expected shape of a slow
            // browser answering late, and there is nobody left to tell.
            return;
          }
          connection.pending.delete(message.id);
          settle({ status: 'answered', result: message.result });
          return;
        }

        case 'refused':
          log.info(`The extension closed a connection: ${message.reason}`);
          socket.close();
          return;
      }
    });

    socket.on('close', () => {
      stopTimers();
      if (connection !== null) drop(connection.browserId, connection);
    });

    socket.on('error', (error: unknown) => {
      log.debug('A bridge connection errored', error);
      stopTimers();
      if (connection !== null) drop(connection.browserId, connection);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Pairing codes                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Check a code and spend it, or count the miss.
   *
   * Constant-time, like the proof, and for a weaker version of the same
   * reason: the code is short-lived and rate-limited, so a timing oracle is
   * not the way in — but a comparison that leaks the matching prefix would
   * turn forty bits into eight guesses, and `timingSafeEqual` costs nothing.
   */
  function spendCode(presented: unknown): true | null {
    if (pairing === null) return null;
    if (Date.now() > pairing.expiresAt) {
      withdrawPairing();
      announce();
      return null;
    }
    const given = typeof presented === 'string' ? presented.trim().toUpperCase() : '';
    if (given.length === pairing.code.length && constantTimeEquals(given, pairing.code)) {
      withdrawPairing();
      return true;
    }
    pairing = { ...pairing, attempts: pairing.attempts + 1 };
    if (pairing.attempts >= CODE_ATTEMPTS) {
      log.warn('Withdrew a pairing code after too many wrong guesses.');
      withdrawPairing();
    }
    announce();
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* The public surface                                                 */
  /* ------------------------------------------------------------------ */

  return {
    async start(): Promise<void> {
      if (server !== null) return;
      await new Promise<void>((done) => {
        const created = new WebSocketServer({
          host: '127.0.0.1',
          port,
          maxPayload: MAX_MESSAGE_BYTES,
          // The extension is the only client and speaks no subprotocol; not
          // negotiating one keeps the handshake to what it says it is.
          perMessageDeflate: false,
        });
        created.on('connection', (socket: WebSocket, request: IncomingMessage) => {
          accept(socket, request);
        });
        created.on('listening', () => {
          server = created;
          /*
           * The port the OS actually gave us, not the one that was asked for.
           * They are the same number in the app — the extension dials a fixed
           * address, so nothing here may drift — and different only when a
           * caller passes `0` to mean "any free port", which is what a test
           * does to avoid fighting a real Artemis on the same machine.
           */
          const bound = created.address();
          const boundPort = typeof bound === 'object' && bound !== null ? bound.port : port;
          listening = { kind: 'listening', port: boundPort };
          log.info(`The extension bridge is listening on 127.0.0.1:${String(boundPort)}.`);
          announce();
          done();
        });
        created.on('error', (error: NodeJS.ErrnoException) => {
          /*
           * A taken port is reported and not routed around. The extension
           * dials a fixed address; an Artemis that quietly moved would be an
           * Artemis no browser can find, with no symptom but a pairing that
           * never completes. See `ExtensionBridgeListening`.
           */
          listening =
            error.code === 'EADDRINUSE'
              ? { kind: 'port-in-use', port }
              : { kind: 'failed', port, message: error.message };
          log.error(`The extension bridge could not listen on port ${String(port)}`, error);
          announce();
          done();
        });
      });
    },

    state: currentState,

    offerPairing(offer: boolean): ExtensionBridgeState {
      withdrawPairing();
      if (offer) {
        pairing = { code: mintCode(), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 };
        // The code expires on its own even if nobody is looking at the pane.
        // `unref` so a forgotten offer cannot hold the process open.
        pairingTimer = setTimeout(() => {
          withdrawPairing();
          announce();
        }, CODE_TTL_MS);
        pairingTimer.unref?.();
      }
      return announce();
    },

    async unpair(browserId: string): Promise<ExtensionBridgeState> {
      /*
       * Cut first, forget second. The requirement is that unpairing stops a
       * live run's *next* tool call, and the connection is what a tool call
       * travels down: a browser whose record is gone but whose socket is still
       * open would keep answering until it happened to reconnect.
       */
      const live = connections.get(browserId);
      if (live !== undefined) {
        drop(browserId, live);
        refuse(live.socket, 'Artemis has unpaired this browser. Pair it again to reconnect.');
      }
      await store.remove(browserId);
      return announce();
    },

    async setPolicy(policy: PagePolicy): Promise<ExtensionBridgeState> {
      await store.setPolicy(policy);
      // Pushed rather than waited for: a browser that is asleep gets the
      // policy again in its `ready` when it wakes, so the only thing a failed
      // push costs is nothing.
      for (const connection of connections.values()) {
        send(connection.socket, { type: 'policy', policy });
      }
      return announce();
    },

    endRun(runKey: string): void {
      for (const connection of connections.values()) {
        send(connection.socket, {
          type: 'call',
          id: randomBytes(8).toString('hex'),
          runKey,
          verb: 'close',
        });
      }
    },

    async call(
      runKey: string,
      id: string,
      verb: BridgeVerb,
      timeoutMs: number,
    ): Promise<BridgeCallOutcome> {
      if (store.all().length === 0) return { status: 'unpaired' };
      /*
       * The first connected browser, and there is normally exactly one. A
       * verb takes no browser id — targeting is by run, as it is everywhere
       * else in the browser tools — so with two paired browsers both awake
       * this picks the one that connected first and keeps picking it, which is
       * stable and explainable. Choosing per call would have a conversation
       * silently change browsers mid-turn.
       */
      const connection = connections.values().next();
      if (connection.done === true) return { status: 'disconnected' };
      const live = connection.value;

      return new Promise<BridgeCallOutcome>((resolve) => {
        let settled = false;
        const settle = (outcome: BridgeCallOutcome): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          live.pending.delete(id);
          resolve(outcome);
        };
        const timer = setTimeout(() => {
          settle({ status: 'timeout' });
        }, timeoutMs);
        timer.unref?.();
        live.pending.set(id, settle);
        send(live.socket, { type: 'call', id, runKey, ...verb });
      });
    },

    async dispose(): Promise<void> {
      withdrawPairing();
      for (const [browserId, connection] of [...connections]) {
        drop(browserId, connection);
        connection.socket.close();
      }
      const created = server;
      server = null;
      listening = { kind: 'stopped' };
      if (created === null) return;
      await new Promise<void>((done) => {
        created.close(() => {
          done();
        });
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Small parts                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A code, from a generator that is not `Math.random`.
 *
 * `randomInt` rather than the obvious modulo of a random byte: 256 is not a
 * multiple of 32 — it happens to be here, but the alphabet is a constant
 * somebody will edit — and a biased code is a code with fewer bits than the
 * comment above it claims.
 */
function mintCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Whether a MAC is the one this secret makes of this nonce.
 *
 * The three encodings are the contract's, spelled out on {@link BridgeProof},
 * and they are spelled out there because two independent implementations of
 * "HMAC of a secret" disagree about them and meet as a refusal nobody can
 * debug. The key is the **bytes the hex secret denotes** and not the
 * characters of the hex string; the message is the nonce's UTF-8 bytes as
 * sent, undecoded; the mac is lowercase hex.
 */
function proves(secret: string, nonce: string, mac: unknown): boolean {
  if (typeof mac !== 'string') return false;
  const expected = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(nonce, 'utf8')
    .digest('hex');
  return constantTimeEquals(mac.toLowerCase(), expected);
}

/**
 * Equality that does not leak where two strings first differ.
 *
 * Lengths are compared first and in the clear, which is not a leak worth
 * caring about: both operands here have a length this file decided.
 */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The peer's name for itself, bounded and stripped of anything that is not text. */
function nameOf(raw: unknown): string {
  if (typeof raw !== 'string') return 'A browser';
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  return cleaned.length === 0 ? 'A browser' : cleaned.slice(0, 80);
}

function versionMismatch(theirs: unknown): string {
  return (
    `This Artemis speaks bridge version ${String(BRIDGE_PROTOCOL_VERSION)} and the extension ` +
    `speaks ${String(theirs)}. Update whichever is older.`
  );
}

/**
 * A frame, as one of the messages the extension is allowed to send.
 *
 * Shape-checked to the depth the switch above relies on, and no further. The
 * fields a verb's *answer* carries are the tools' business — see
 * `extensionPageDriver.ts` on why they are not re-derived here — but `type`,
 * `id` and the handshake's fields are read by this file to decide what to do
 * next, and every one of them is proved before it is used.
 */
function parse(raw: Buffer | ArrayBuffer | Buffer[]): FromExtension | null {
  let text: string;
  try {
    text = Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.from(raw as Buffer).toString('utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  const type = message['type'];

  switch (type) {
    case 'ping':
    case 'pong':
      return { type };
    case 'pair':
      if (typeof message['code'] !== 'string') return null;
      if (typeof message['extensionVersion'] !== 'string') return null;
      return {
        type: 'pair',
        version: message['version'],
        code: message['code'],
        browserName: message['browserName'],
        extensionVersion: message['extensionVersion'],
      };
    case 'hello':
      if (typeof message['browserId'] !== 'string') return null;
      return {
        type: 'hello',
        version: message['version'],
        browserId: message['browserId'],
        extensionVersion:
          typeof message['extensionVersion'] === 'string' ? message['extensionVersion'] : 'unknown',
      };
    case 'proof':
      return { type: 'proof', mac: message['mac'] };
    case 'result': {
      if (typeof message['id'] !== 'string') return null;
      const result = message['result'];
      if (typeof result !== 'object' || result === null) return null;
      const outcome = result as {
        ok?: unknown;
        reason?: unknown;
        value?: unknown;
        notice?: unknown;
      };
      if (outcome.ok === true) {
        return {
          type: 'result',
          id: message['id'],
          result: {
            ok: true,
            value: outcome.value,
            // Something true about a successful answer that is not part of it
            // — a console buffer that dropped its oldest entries, a wait that
            // reported what had arrived. Carried through rather than read: the
            // contract added it so a driver could not silently hand back a
            // partial answer, and dropping it here would be exactly that.
            ...(typeof outcome.notice === 'string' ? { notice: outcome.notice } : {}),
          },
        };
      }
      if (outcome.ok === false && typeof outcome.reason === 'string') {
        return { type: 'result', id: message['id'], result: { ok: false, reason: outcome.reason } };
      }
      return null;
    }
    case 'refused':
      return { type: 'refused', reason: typeof message['reason'] === 'string' ? message['reason'] : '' };
    default:
      return null;
  }
}

/** What {@link parse} may return: the wire's own union, with `version` left unread. */
type FromExtension =
  | { readonly type: 'ping' | 'pong' }
  | {
      readonly type: 'pair';
      readonly version: unknown;
      readonly code: string;
      readonly browserName: unknown;
      readonly extensionVersion: string;
    }
  | {
      readonly type: 'hello';
      readonly version: unknown;
      readonly browserId: string;
      readonly extensionVersion: string;
    }
  | { readonly type: 'proof'; readonly mac: unknown }
  | { readonly type: 'result'; readonly id: string; readonly result: DriverResult<unknown> }
  | { readonly type: 'refused'; readonly reason: string };
