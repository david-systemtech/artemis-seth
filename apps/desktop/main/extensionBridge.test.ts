/**
 * The socket the extension dials into, exercised by a fake extension.
 * ============================================================================
 *
 * A real {@link WebSocketServer} on a real loopback port, with a real `ws`
 * client on the other end speaking the contract in
 * `protocol/browserDriver.ts`. Nothing here is mocked, and that is the point:
 * the things worth pinning about this file are the ones a fake socket would
 * have let through — that `Origin` is checked before any of the peer's own
 * framing is read, that a replayed nonce is refused, that the second
 * connection for a browser displaces the first rather than being turned away.
 *
 * The fake extension is {@link FakeExtension}: it connects, it answers a
 * challenge with an HMAC, it replies to calls, and it can be told to do each
 * of those wrongly. What it is *not* is a stand-in for the real extension's
 * behaviour — it never opens a tab, and the policy it is handed is one it
 * ignores. That is the correct shape for a test of this file, which is the
 * half of the wire Artemis owns.
 *
 * Port `0` throughout: these run on machines where a real Artemis may be
 * holding {@link BRIDGE_DEFAULT_PORT}, and a suite that fought it would fail
 * for a reason that is not the code's.
 */

import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  ARTEMIS_EXTENSION_ID,
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_PAGE_POLICY,
} from '@rx-artemis/protocol';

import { createExtensionBridge, type ExtensionBridge } from './extensionBridge';
import { openPairedBrowsers } from './pairedBrowsers';

/** The Artemis extension's own origin — the only one the bridge accepts. */
const EXTENSION_ORIGIN = `chrome-extension://${ARTEMIS_EXTENSION_ID}`;

/** A different extension's origin, well formed and not ours. */
const OTHER_EXTENSION_ORIGIN = 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh';

let directory = '';
let bridges: ExtensionBridge[] = [];
let sockets: WebSocket[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'artemis-bridge-'));
  bridges = [];
  sockets = [];
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const bridge of bridges.splice(0)) await bridge.dispose();
  /*
   * The store writes through a temporary file and a rename, fired and not
   * awaited from the bridge's message handler — so a pairing made in the last
   * line of a test can still be landing here. A tick plus `maxRetries` is what
   * keeps that from failing the *next* test's cleanup with ENOTEMPTY.
   */
  await new Promise((done) => setTimeout(done, 20));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** A bridge on a free port, with its own store, already listening. */
async function bridgeOn(): Promise<{ bridge: ExtensionBridge; port: number }> {
  const store = await openPairedBrowsers(directory);
  const bridge = createExtensionBridge({ store, port: 0, bundledVersion: '2.19.1' });
  bridges.push(bridge);
  await bridge.start();
  const listening = bridge.state().listening;
  if (listening.kind !== 'listening') throw new Error(`The bridge did not listen: ${listening.kind}`);
  return { bridge, port: listening.port };
}

/* -------------------------------------------------------------------------- */
/* A fake extension                                                           */
/* -------------------------------------------------------------------------- */

/** One message from Artemis, as the fake reads it. */
type FromArtemis = Record<string, unknown> & { readonly type: string };

/**
 * A client that speaks the contract, and can be asked to speak it badly.
 *
 * Messages are queued as they arrive rather than handed to a callback, so a
 * test reads the exchange in the order the contract states it — `await
 * next('challenge')` — instead of assembling a state machine per test.
 */
class FakeExtension {
  readonly socket: WebSocket;
  readonly #inbox: FromArtemis[] = [];
  readonly #waiting: ((message: FromArtemis) => void)[] = [];
  closed = false;

  constructor(port: number, origin: string = EXTENSION_ORIGIN) {
    this.socket = new WebSocket(`ws://127.0.0.1:${String(port)}`, { origin });
    sockets.push(this.socket);
    this.socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8')) as FromArtemis;
      const waiter = this.#waiting.shift();
      if (waiter === undefined) this.#inbox.push(message);
      else waiter(message);
    });
    this.socket.on('close', () => {
      this.closed = true;
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((done, fail) => {
      this.socket.once('open', done);
      this.socket.once('error', fail);
      this.socket.once('close', () => {
        fail(new Error('The bridge closed the connection before it opened.'));
      });
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  /** The next message, waiting for one if the inbox is empty. */
  async next(): Promise<FromArtemis> {
    const queued = this.#inbox.shift();
    if (queued !== undefined) return queued;
    return new Promise<FromArtemis>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('The bridge said nothing within two seconds.'));
      }, 2_000);
      this.#waiting.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  /** Wait for the socket to close, which is how a refusal ends. */
  async untilClosed(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((done) => {
      this.socket.once('close', () => {
        done();
      });
    });
  }
}

/** Pair a fake extension and return what the bridge gave it. */
async function pair(
  bridge: ExtensionBridge,
  port: number,
  overrides: { readonly browserName?: string; readonly extensionVersion?: string } = {},
): Promise<{ extension: FakeExtension; browserId: string; secret: string }> {
  const offered = bridge.offerPairing(true);
  const code = offered.pairing?.code;
  if (code === undefined) throw new Error('No pairing code was offered.');

  const extension = new FakeExtension(port);
  await extension.open();
  extension.send({
    type: 'pair',
    version: BRIDGE_PROTOCOL_VERSION,
    code,
    browserName: overrides.browserName ?? 'Chrome on Linux',
    extensionVersion: overrides.extensionVersion ?? '2.19.1',
  });
  const paired = await extension.next();
  if (paired['type'] !== 'paired') throw new Error(`Expected "paired", got ${String(paired['type'])}`);
  return {
    extension,
    browserId: paired['browserId'] as string,
    secret: paired['secret'] as string,
  };
}

/** Reconnect as a paired browser and prove the secret. */
async function reconnect(
  port: number,
  browserId: string,
  secret: string,
): Promise<FakeExtension> {
  const extension = new FakeExtension(port);
  await extension.open();
  extension.send({
    type: 'hello',
    version: BRIDGE_PROTOCOL_VERSION,
    browserId,
    browserName: 'Chrome on Linux',
    extensionVersion: '2.19.1',
  });
  const challenge = await extension.next();
  extension.send({ type: 'proof', mac: macOf(secret, challenge['nonce'] as string) });
  const ready = await extension.next();
  if (ready['type'] !== 'ready') throw new Error(`Expected "ready", got ${String(ready['type'])}`);
  return extension;
}

function macOf(secret: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(nonce).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Who may connect                                                            */
/* -------------------------------------------------------------------------- */

describe('who may open a connection', () => {
  it('refuses a connection from a web page, which can also reach loopback', async () => {
    // The gate that matters most. A page at any origin can open a WebSocket to
    // 127.0.0.1; what it cannot do is lie about `Origin`, because the browser
    // sets it. Without this check the bridge would be reachable from any tab.
    const { port } = await bridgeOn();
    const page = new FakeExtension(port, 'https://evil.example');
    await page.open();

    const message = await page.next();

    expect(message['type']).toBe('refused');
    await page.untilClosed();
  });

  it('refuses another extension, which a scheme check alone would let in', async () => {
    // The gate is the *id*, not `chrome-extension://…`. A second extension the
    // user installed is not the Artemis extension and has no business here,
    // and its origin is as unforgeable as ours.
    const { port } = await bridgeOn();
    const stranger = new FakeExtension(port, OTHER_EXTENSION_ORIGIN);
    await stranger.open();

    expect((await stranger.next())['type']).toBe('refused');
    await stranger.untilClosed();
  });

  it('refuses a connection that sends no Origin at all', async () => {
    // A plain socket client — curl, a script, a program already on the machine.
    // It is refused at the same gate, and has to get past the pairing code
    // after that even if it starts forging the header.
    const { port } = await bridgeOn();
    const client = new FakeExtension(port, '');
    await client.open();

    expect((await client.next())['type']).toBe('refused');
  });

  it('accepts a connection whose origin is an extension', async () => {
    const { bridge, port } = await bridgeOn();
    const { extension } = await pair(bridge, port);

    expect(extension.closed).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Pairing                                                                    */
/* -------------------------------------------------------------------------- */

describe('pairing with a code', () => {
  it('pairs on the code Artemis is showing, and answers with a browser id and a secret', async () => {
    const { bridge, port } = await bridgeOn();

    const { browserId, secret } = await pair(bridge, port, { browserName: 'Chrome on Windows' });

    expect(browserId).toMatch(/^[0-9a-f]{32}$/u);
    // 32 bytes, as the contract says, and as the HMAC below depends on.
    expect(secret).toMatch(/^[0-9a-f]{64}$/u);
    expect(bridge.state().browsers).toEqual([
      expect.objectContaining({ browserId, browserName: 'Chrome on Windows', connected: true }),
    ]);
  });

  it('refuses a wrong code without saying which kind of wrong it was', async () => {
    const { bridge, port } = await bridgeOn();
    bridge.offerPairing(true);

    const extension = new FakeExtension(port);
    await extension.open();
    extension.send({
      type: 'pair',
      version: BRIDGE_PROTOCOL_VERSION,
      code: 'AAAAAAAA',
      browserName: 'Chrome',
      extensionVersion: '2.19.1',
    });

    const message = await extension.next();
    expect(message['type']).toBe('refused');
    // Nothing is paired, and the code the user is looking at is still theirs
    // to use — one miss is a typo, not an attack.
    expect(bridge.state().browsers).toEqual([]);
    expect(bridge.state().pairing).not.toBeNull();
  });

  it('refuses a code nobody is offering', async () => {
    const { bridge, port } = await bridgeOn();

    const extension = new FakeExtension(port);
    await extension.open();
    extension.send({
      type: 'pair',
      version: BRIDGE_PROTOCOL_VERSION,
      code: 'K7P2MXQ4',
      browserName: 'Chrome',
      extensionVersion: '2.19.1',
    });

    expect((await extension.next())['type']).toBe('refused');
    expect(bridge.state().browsers).toEqual([]);
  });

  it('spends a code on first use, so a second browser cannot pair on it', async () => {
    const { bridge, port } = await bridgeOn();
    const offered = bridge.offerPairing(true);
    const code = offered.pairing?.code ?? '';

    const first = new FakeExtension(port);
    await first.open();
    first.send({
      type: 'pair',
      version: BRIDGE_PROTOCOL_VERSION,
      code,
      browserName: 'The first browser',
      extensionVersion: '2.19.1',
    });
    expect((await first.next())['type']).toBe('paired');

    const second = new FakeExtension(port);
    await second.open();
    second.send({
      type: 'pair',
      version: BRIDGE_PROTOCOL_VERSION,
      code,
      browserName: 'The second browser',
      extensionVersion: '2.19.1',
    });

    expect((await second.next())['type']).toBe('refused');
    expect(bridge.state().browsers).toHaveLength(1);
  });

  it('burns the code after five wrong guesses, so a caller cannot search for it', async () => {
    const { bridge, port } = await bridgeOn();
    bridge.offerPairing(true);

    // Each guess on its own connection, which is what an attacker would do:
    // the budget has to be counted against the *code*, not against a socket.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const guess = new FakeExtension(port);
      await guess.open();
      guess.send({
        type: 'pair',
        version: BRIDGE_PROTOCOL_VERSION,
        code: 'BBBBBBBB',
        browserName: 'Chrome',
        extensionVersion: '2.19.1',
      });
      expect((await guess.next())['type']).toBe('refused');
    }

    expect(bridge.state().pairing).toBeNull();
  });

  it('stops honouring a code once it has expired', async () => {
    const { bridge, port } = await bridgeOn();
    const offered = bridge.offerPairing(true);
    const code = offered.pairing?.code ?? '';
    // Five minutes on, without waiting five minutes. The bridge reads the
    // clock when the code is presented, which is what makes this testable.
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      const late = new FakeExtension(port);
      await late.open();
      late.send({
        type: 'pair',
        version: BRIDGE_PROTOCOL_VERSION,
        code,
        browserName: 'Chrome',
        extensionVersion: '2.19.1',
      });
      expect((await late.next())['type']).toBe('refused');
    } finally {
      Date.now = realNow;
    }
    expect(bridge.state().browsers).toEqual([]);
  });

  it('withdraws the code when the pane asks it to', async () => {
    const { bridge } = await bridgeOn();
    bridge.offerPairing(true);

    const after = bridge.offerPairing(false);

    // Closing the pane has to withdraw the offer: a code left live is a code
    // somebody else could still spend.
    expect(after.pairing).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The handshake                                                              */
/* -------------------------------------------------------------------------- */

describe('proving a pairing on a later connection', () => {
  it('lets a paired browser back in when it answers the challenge', async () => {
    const { bridge, port } = await bridgeOn();
    const { extension, browserId, secret } = await pair(bridge, port);
    extension.socket.close();
    await extension.untilClosed();

    const back = await reconnect(port, browserId, secret);

    expect(back.closed).toBe(false);
    expect(bridge.state().browsers[0]?.connected).toBe(true);
  });

  it('hands the policy over with the ready, so a browser never acts on a stale one', async () => {
    const { bridge, port } = await bridgeOn();
    const { extension, browserId, secret } = await pair(bridge, port);
    await bridge.setPolicy({ ...DEFAULT_PAGE_POLICY, devSites: ['*.test'] });
    extension.socket.close();
    await extension.untilClosed();

    const back = new FakeExtension(port);
    await back.open();
    back.send({
      type: 'hello',
      version: BRIDGE_PROTOCOL_VERSION,
      browserId,
      browserName: 'Chrome',
      extensionVersion: '2.19.1',
    });
    const challenge = await back.next();
    back.send({ type: 'proof', mac: macOf(secret, challenge['nonce'] as string) });
    const ready = await back.next();

    expect(ready['type']).toBe('ready');
    expect(ready['policy']).toMatchObject({ devSites: ['*.test'] });
  });

  it('refuses a proof made with the wrong secret', async () => {
    const { bridge, port } = await bridgeOn();
    const { extension, browserId } = await pair(bridge, port);
    extension.socket.close();
    await extension.untilClosed();

    const impostor = new FakeExtension(port);
    await impostor.open();
    impostor.send({
      type: 'hello',
      version: BRIDGE_PROTOCOL_VERSION,
      browserId,
      browserName: 'Chrome',
      extensionVersion: '2.19.1',
    });
    const challenge = await impostor.next();
    impostor.send({ type: 'proof', mac: macOf('00'.repeat(32), challenge['nonce'] as string) });

    expect((await impostor.next())['type']).toBe('refused');
    await impostor.untilClosed();
  });

  it('challenges a browser id it has never heard of, and refuses it at the proof', async () => {
    // An immediate no to the hello would turn this port into an oracle for
    // which ids are paired. The exchange has the same shape either way.
    const { port } = await bridgeOn();

    const stranger = new FakeExtension(port);
    await stranger.open();
    stranger.send({
      type: 'hello',
      version: BRIDGE_PROTOCOL_VERSION,
      browserId: 'a browser that was never paired',
      browserName: 'Chrome',
      extensionVersion: '2.19.1',
    });

    const challenge = await stranger.next();
    expect(challenge['type']).toBe('challenge');
    stranger.send({ type: 'proof', mac: macOf('00'.repeat(32), challenge['nonce'] as string) });
    expect((await stranger.next())['type']).toBe('refused');
  });

  it('refuses a nonce replayed from an earlier connection', async () => {
    const { bridge, port } = await bridgeOn();
    const { extension, browserId, secret } = await pair(bridge, port);
    extension.socket.close();
    await extension.untilClosed();

    // Capture one good exchange's nonce and the MAC that answered it.
    const watched = new FakeExtension(port);
    await watched.open();
    watched.send({
      type: 'hello',
      version: BRIDGE_PROTOCOL_VERSION,
      browserId,
      browserName: 'Chrome',
      extensionVersion: '2.19.1',
    });
    const challenge = await watched.next();
    const capturedNonce = challenge['nonce'] as string;
    const capturedMac = macOf(secret, capturedNonce);
    watched.send({ type: 'proof', mac: capturedMac });
    expect((await watched.next())['type']).toBe('ready');

    // Replay it on a new connection. The nonce is this connection's own and
    // random, so the captured MAC cannot answer it.
    const replayer = new FakeExtension(port);
    await replayer.open();
    replayer.send({
      type: 'hello',
      version: BRIDGE_PROTOCOL_VERSION,
      browserId,
      browserName: 'Chrome',
      extensionVersion: '2.19.1',
    });
    const fresh = await replayer.next();
    expect(fresh['nonce']).not.toBe(capturedNonce);
    replayer.send({ type: 'proof', mac: capturedMac });

    expect((await replayer.next())['type']).toBe('refused');
  });

  it('refuses a proof answered twice on one connection', async () => {
    // The nonce is cleared when it is answered, so a second proof on the same
    // socket finds nothing outstanding.
    const { bridge, port } = await bridgeOn();
    const { extension, browserId, secret } = await pair(bridge, port);
    extension.socket.close();
    await extension.untilClosed();

    const back = new FakeExtension(port);
    await back.open();
    back.send({
      type: 'hello',
      version: BRIDGE_PROTOCOL_VERSION,
      browserId,
      browserName: 'Chrome',
      extensionVersion: '2.19.1',
    });
    const challenge = await back.next();
    const mac = macOf(secret, challenge['nonce'] as string);
    back.send({ type: 'proof', mac });
    expect((await back.next())['type']).toBe('ready');

    back.send({ type: 'proof', mac });
    expect((await back.next())['type']).toBe('refused');
  });

  it('refuses an extension speaking a different bridge version', async () => {
    const { bridge, port } = await bridgeOn();
    bridge.offerPairing(true);

    const future = new FakeExtension(port);
    await future.open();
    future.send({
      type: 'pair',
      version: BRIDGE_PROTOCOL_VERSION + 1,
      code: bridge.state().pairing?.code ?? '',
      browserName: 'Chrome',
      extensionVersion: '99.0.0',
    });

    const refusal = await future.next();
    expect(refusal['type']).toBe('refused');
    expect(String(refusal['reason'])).toContain('Update whichever is older');
  });
});

/* -------------------------------------------------------------------------- */
/* One connection per browser                                                 */
/* -------------------------------------------------------------------------- */

describe('one connection per paired browser', () => {
  it('lets the newest connection displace the older one', async () => {
    // An MV3 worker that was killed and restarted cannot know whether its old
    // socket is still half-open here. Refusing the new one would leave the
    // browser unreachable behind a socket nobody reads.
    const { bridge, port } = await bridgeOn();
    const { extension: first, browserId, secret } = await pair(bridge, port);

    const second = await reconnect(port, browserId, secret);

    await first.untilClosed();
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(bridge.state().browsers[0]?.connected).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Calls                                                                      */
/* -------------------------------------------------------------------------- */

describe('a verb on the wire', () => {
  it('carries the run key and the verb, and hands back what the browser answered', async () => {
    const { bridge, port } = await bridgeOn();
    const { extension } = await pair(bridge, port);

    const answering = bridge.call('run-7', 'call-1', { verb: 'navigate', url: 'https://example.com' }, 2_000);
    const call = await extension.next();
    expect(call).toMatchObject({
      type: 'call',
      id: 'call-1',
      runKey: 'run-7',
      verb: 'navigate',
      url: 'https://example.com',
    });
    extension.send({
      type: 'result',
      id: 'call-1',
      result: { ok: true, value: { url: 'https://example.com', title: 'Example' } },
    });

    expect(await answering).toEqual({
      status: 'answered',
      result: { ok: true, value: { url: 'https://example.com', title: 'Example' } },
    });
  });

  it('carries a notice on a successful answer, which is how a partial one says so', async () => {
    // `notice` is the contract's way for a driver to say a successful answer
    // is incomplete — a console buffer that dropped its oldest entries. A
    // bridge that rebuilt the result and left it out would be exactly the
    // silent partial answer it was added to prevent.
    const { bridge, port } = await bridgeOn();
    const { extension } = await pair(bridge, port);

    const answering = bridge.call('run-7', 'call-n', { verb: 'console' }, 2_000);
    await extension.next();
    extension.send({
      type: 'result',
      id: 'call-n',
      result: { ok: true, value: [], notice: 'older console entries were dropped' },
    });

    expect(await answering).toEqual({
      status: 'answered',
      result: { ok: true, value: [], notice: 'older console entries were dropped' },
    });
  });

  it('passes the extension’s own refusal through untouched', async () => {
    // The extension applies the page policy and says no in words. Those words
    // are what the model reads; nothing on this side rewrites them.
    const { bridge, port } = await bridgeOn();
    const { extension } = await pair(bridge, port);

    const answering = bridge.call('run-7', 'call-2', { verb: 'cookies' }, 2_000);
    await extension.next();
    extension.send({
      type: 'result',
      id: 'call-2',
      result: { ok: false, reason: 'bank.example is on the list of sites an agent does not open.' },
    });

    expect(await answering).toEqual({
      status: 'answered',
      result: { ok: false, reason: 'bank.example is on the list of sites an agent does not open.' },
    });
  });

  it('reports a browser that never answers as a timeout', async () => {
    const { bridge, port } = await bridgeOn();
    const { extension } = await pair(bridge, port);

    const answering = bridge.call('run-7', 'call-3', { verb: 'read' }, 50);
    await extension.next();

    expect(await answering).toEqual({ status: 'timeout' });
  });

  it('reports no paired browser and no connected one as different things', async () => {
    const { bridge, port } = await bridgeOn();

    // Nothing paired at all: the user has never set this up.
    expect(await bridge.call('run-7', 'a', { verb: 'read' }, 500)).toEqual({ status: 'unpaired' });

    const { extension } = await pair(bridge, port);
    extension.socket.close();
    await extension.untilClosed();

    // Paired, but their Chrome is closed. A different sentence, a different fix.
    expect(await bridge.call('run-7', 'b', { verb: 'read' }, 500)).toEqual({
      status: 'disconnected',
    });
  });

  it('fails a call in flight the moment the browser goes away, without waiting for its timeout', async () => {
    // Otherwise a run spends up to twenty seconds on a socket that is provably
    // gone, and the agent learns nothing until the turn is half over.
    const { bridge, port } = await bridgeOn();
    const { extension } = await pair(bridge, port);

    const answering = bridge.call('run-7', 'call-4', { verb: 'read' }, 30_000);
    await extension.next();
    extension.socket.close();

    expect(await answering).toEqual({ status: 'disconnected' });
  });

  it('ignores an answer to a call that is not outstanding', async () => {
    // A slow browser answering after a timeout, or an id nobody sent. Either
    // way there is nobody left to tell, and the connection must survive it.
    const { bridge, port } = await bridgeOn();
    const { extension } = await pair(bridge, port);

    extension.send({ type: 'result', id: 'nobody-asked', result: { ok: true, value: null } });

    const answering = bridge.call('run-7', 'call-5', { verb: 'read' }, 2_000);
    const call = await extension.next();
    extension.send({ type: 'result', id: call['id'], result: { ok: true, value: 'still here' } });
    expect(await answering).toMatchObject({ status: 'answered' });
  });
});

/* -------------------------------------------------------------------------- */
/* Policy and unpairing                                                       */
/* -------------------------------------------------------------------------- */

describe('the policy reaches the browsers that enforce it', () => {
  it('pushes the policy to a connected browser when settings change', async () => {
    const { bridge, port } = await bridgeOn();
    const { extension } = await pair(bridge, port);

    await bridge.setPolicy({
      ...DEFAULT_PAGE_POLICY,
      devSites: ['localhost', '*.test'],
      evaluateEverywhere: true,
    });

    const pushed = await extension.next();
    expect(pushed['type']).toBe('policy');
    expect(pushed['policy']).toMatchObject({
      devSites: ['localhost', '*.test'],
      evaluateEverywhere: true,
    });
  });

  it('keeps the policy across a restart of Artemis', async () => {
    const { bridge } = await bridgeOn();
    await bridge.setPolicy({ ...DEFAULT_PAGE_POLICY, blockedSites: ['news.example'] });

    const reopened = await openPairedBrowsers(directory);

    expect(reopened.policy().blockedSites).toEqual(['news.example']);
  });
});

describe('unpairing', () => {
  it('cuts the live connection and makes the next call refuse', async () => {
    // The requirement from issue #436: revoking a browser stops a live run's
    // next tool call. The connection is what a tool call travels down, so
    // forgetting the record without cutting the socket would not be enough.
    const { bridge, port } = await bridgeOn();
    const { extension, browserId } = await pair(bridge, port);

    await bridge.unpair(browserId);

    await extension.untilClosed();
    expect(bridge.state().browsers).toEqual([]);
    expect(await bridge.call('run-7', 'after', { verb: 'read' }, 500)).toEqual({
      status: 'unpaired',
    });
  });

  it('forgets the browser on disk, so it cannot prove itself after a restart', async () => {
    const { bridge, port } = await bridgeOn();
    const { browserId } = await pair(bridge, port);

    await bridge.unpair(browserId);
    const reopened = await openPairedBrowsers(directory);

    expect(reopened.find(browserId)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The secret                                                                 */
/* -------------------------------------------------------------------------- */

describe('the pairing secret', () => {
  it('is nowhere in the state the renderer is given', async () => {
    // SECURITY.md's first claim, for this feature: no secret crosses IPC. The
    // renderer does not speak the bridge protocol and has no use for one.
    const { bridge, port } = await bridgeOn();
    const { secret } = await pair(bridge, port);

    const state = bridge.state();

    expect(JSON.stringify(state)).not.toContain(secret);
    expect(Object.keys(state.browsers[0] ?? {})).not.toContain('secret');
  });

  it('survives two writes landing at once, which pairing and connecting do', async () => {
    /*
     * A regression. Pairing writes the browser and going live writes that it
     * was seen, and the two overlap in ordinary use — the end-to-end suite met
     * them racing on its first run. Both wrote `paired-browsers.json.tmp`, the
     * first rename consumed it, and the second failed with `ENOENT` against a
     * path that had just existed.
     */
    const store = await openPairedBrowsers(directory);
    const browser = {
      browserId: 'b1',
      secret: '00'.repeat(32),
      browserName: 'Chrome',
      pairedAt: 1,
    };

    await Promise.all([
      store.add(browser),
      store.noteSeen('b1', '2.19.1', 2),
      store.setPolicy({ ...DEFAULT_PAGE_POLICY, devSites: ['*.test'] }),
    ]);

    // The last write wins on disk, and every one of them completed: a reopened
    // store sees the browser and the policy rather than a file that was never
    // written.
    const reopened = await openPairedBrowsers(directory);
    expect(reopened.find('b1')?.browserName).toBe('Chrome');
    expect(reopened.policy().devSites).toEqual(['*.test']);
  });

  it('is written to a file only the owner can read', async () => {
    const { bridge, port } = await bridgeOn();
    const { secret } = await pair(bridge, port);
    // The write is fire-and-forget from the message handler, so give it a tick.
    await new Promise((done) => setTimeout(done, 50));

    const written = await readFile(join(directory, 'paired-browsers.json'), 'utf8');

    expect(written).toContain(secret);
  });
});

/* -------------------------------------------------------------------------- */
/* Listening                                                                  */
/* -------------------------------------------------------------------------- */

describe('the port', () => {
  it('reports a port somebody else holds rather than quietly moving', async () => {
    // The extension dials a fixed address. An Artemis that found another port
    // would be an Artemis no browser can reach, with no symptom at all.
    const { port } = await bridgeOn();
    const store = await openPairedBrowsers(await mkdtemp(join(tmpdir(), 'artemis-bridge-2-')));
    const second = createExtensionBridge({ store, port });
    bridges.push(second);

    await second.start();

    expect(second.state().listening).toEqual({ kind: 'port-in-use', port });
  });
});
