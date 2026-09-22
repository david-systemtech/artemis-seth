/**
 * The two halves, meeting: the real extension in a real Chrome, on the real
 * bridge.
 * ============================================================================
 *
 * Every other test of this feature exercises one side against a fake of the
 * other — `extensionBridge.test.ts` runs a fake extension at the real socket,
 * and the extension's own suite runs a fake Artemis at the real worker. Both
 * are worth having and neither can catch the one failure that matters most:
 * the two implementations agreeing with their own fakes and disagreeing with
 * each other. The proof encoding on `BridgeProof` is spelled out in the
 * contract precisely because that is how two honest implementations of "HMAC
 * of a secret" miss, and a spelled-out rule is still only a rule until
 * something checks it.
 *
 * So this builds the extension, loads it into a headless Chromium, pairs it
 * with **this** bridge by typing a code into the real options page, and drives
 * `ExtensionPageDriver` at a page served from loopback.
 *
 * ## It is skipped, loudly, where there is no Chromium
 *
 * Same three rules the extension's own end-to-end suite uses, and for the same
 * reasons:
 *
 *  1. `ARTEMIS_E2E_CHROME` wins — whoever set it has said which browser.
 *  2. **Never on CI by default.** GitHub's runners ship Google Chrome, so
 *     "run if you find a browser" would quietly make this a CI suite: a slow
 *     one, on a browser nobody pinned, failing the day the image moves.
 *  3. Otherwise a Playwright-managed Chromium, which is a pinned build a
 *     developer chose to download rather than the everyday browser with all of
 *     their own logins in it.
 *
 * The last test in the file always runs and says which way it went, so a skip
 * is visible in the report instead of silent.
 *
 * ## Nothing is imported from `apps/extension`
 *
 * The extension is built by running the workspace's own `build:extension`
 * script and read off disk. `@rx-artemis/desktop` deliberately does not depend
 * on `@rx-artemis/extension` — they are separate artifacts with separate
 * release paths, and a build-time edge between them would make that untrue.
 * The cost is the sixty lines of CDP below, which is the price of the rule.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { ARTEMIS_EXTENSION_ID, type PageLocation, type PageText, type RunId } from '@rx-artemis/protocol';

import {
  createBrowserCallClient,
  createBrowserRelay,
  createPushFeed,
  createArtemisServer,
  createWorkspaceResolver,
  type BrowserCallClient,
} from '@rx-artemis/core';

import { createExtensionBridge, type ExtensionBridge } from './extensionBridge';
import { extensionPageDriver } from './extensionPageDriver';
import { openPairedBrowsers } from './pairedBrowsers';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const extensionDist = join(repoRoot, 'apps', 'extension', 'dist');
const RUN = 'run-e2e-desktop' as RunId;

const binary = findChromium();

let dataDir = '';
let profileDir = '';
let bridge: ExtensionBridge | null = null;
/** The port the first bridge bound, so a second one can take it over. */
let bridgePort = 0;
let chrome: ChromeUnderTest | null = null;
let site: Server | null = null;
let siteUrl = '';

/*
 * One browser for the whole file, torn down after every describe in it.
 *
 * At the file's level rather than inside the first suite, because the second
 * one shares this browser and a suite's `afterAll` runs before the next
 * suite's tests — which closed Chrome out from under the served path and cost
 * one confusing run to find. A second headless Chromium would be fifteen
 * seconds and one more process to fail to reap.
 */
beforeAll(async () => {
  if (binary === null) return;
  // Built through the workspace script rather than imported, so this test
  // exercises the same command the release workflow runs.
  execFileSync('pnpm', ['run', 'build:extension'], { cwd: repoRoot, stdio: 'ignore' });
  if (!existsSync(join(extensionDist, 'manifest.json'))) {
    throw new Error('build:extension produced no manifest.json');
  }

  site = await startSite();
  siteUrl = `http://127.0.0.1:${String((site.address() as { port: number }).port)}/`;

  dataDir = await mkdtemp(join(tmpdir(), 'artemis-e2e-data-'));
  bridge = createExtensionBridge({ store: await openPairedBrowsers(dataDir), port: 0 });
  await bridge.start();
  const listening = bridge.state().listening;
  if (listening.kind !== 'listening') throw new Error('the bridge did not listen');
  bridgePort = listening.port;

  chrome = await launchChrome(binary as string, extensionDist);
  profileDir = chrome.profileDir;
  await chrome.awaitExtension();

  // Pairing driven through the real options page, the way a person does it:
  // the port Artemis is listening on, then the code Artemis is showing. The
  // `input` events are not decoration — the page treats a field that has
  // been typed into as the user's, so assigning `value` alone would exercise
  // a path nobody takes.
  const code = bridge.offerPairing(true).pairing?.code ?? '';
  const options = await chrome.openPage(`chrome-extension://${ARTEMIS_EXTENSION_ID}/options.html`);
  await options.evaluate(`(async () => {
    const type = (id, value) => {
      const field = document.getElementById(id);
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    type('port', ${JSON.stringify(String(bridgePort))});
    document.getElementById('save-port').click();
    await new Promise((r) => setTimeout(r, 200));
    type('code', ${JSON.stringify(code)});
    document.getElementById('pair').click();
  })()`);

  await until(() => bridge?.state().browsers.some((one) => one.connected) === true, 60_000);
}, 240_000);

afterAll(async () => {
  await chrome?.close();
  await bridge?.dispose();
  await new Promise<void>((done) => {
    if (site === null) return done();
    site.closeAllConnections();
    site.close(() => done());
  });
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
  if (profileDir !== '') {
    await rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});


describe.skipIf(binary === null)('the real extension on the real bridge', () => {
  it('paired, and reports the browser by the name the extension gave', () => {
    // The whole handshake in one assertion: a code minted here, typed there,
    // answered with a browser id and a secret this side stored.
    const browsers = bridge?.state().browsers ?? [];
    expect(browsers).toHaveLength(1);
    expect(browsers[0]?.connected).toBe(true);
    expect(browsers[0]?.browserName.length).toBeGreaterThan(0);
    // And the extension reported its version, which is what the "update the
    // extension" line in Settings compares against the bundled one.
    expect(browsers[0]?.extensionVersion).toMatch(/^\d+\./u);
  });

  it('opens a page, reads it, and clicks something on it', async () => {
    const driver = extensionPageDriver(RUN, bridge as ExtensionBridge);

    const opened = await driver.open(siteUrl);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect((opened.value as PageLocation).url).toContain('127.0.0.1');

    const read = await driver.read();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect((read.value as PageText).text).toContain('The page under test');

    const clicked = await driver.click('#go');
    expect(clicked.ok).toBe(true);

    // The click swaps the heading, so reading again proves the click reached
    // the page rather than merely that a selector matched.
    const after = await driver.read();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect((after.value as PageText).text).toContain('Clicked');

    await driver.close();
  }, 120_000);

  it('refuses a selector that matches nothing, in the extension’s own words', async () => {
    // The refusal crosses the wire as a `DriverResult` and reaches the model
    // unchanged — which is the contract's central claim about failures, and
    // the one a fake on either side cannot prove on its own.
    const driver = extensionPageDriver(RUN, bridge as ExtensionBridge);
    await driver.open(siteUrl);

    const result = await driver.click('#nothing-matches-this');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
    await driver.close();
  }, 120_000);

  it('pushes a policy change to the browser that is enforcing it', async () => {
    // The policy is applied *inside* Chrome, so this is the only end of it
    // Artemis can assert on: that the message goes out on a live connection
    // and the socket survives it. What the extension then does with it is its
    // own suite's business, against three kinds of host.
    await bridge?.setPolicy({
      devSites: ['127.0.0.1'],
      blockedSites: [],
      unblockedSites: [],
      evaluateEverywhere: false,
      deepReadEverywhere: false,
    });

    await until(() => bridge?.state().browsers.some((one) => one.connected) === true, 30_000);
    expect(bridge?.state().policy.devSites).toEqual(['127.0.0.1']);
  }, 60_000);

  it('lets the paired browser back in on a second connection, proving the secret', async () => {
    /*
     * The encoding check, and the reason this file exists.
     *
     * Pairing hands the secret over in the clear; every connection after it is
     * an HMAC over a nonce, and the contract spells out all three encodings
     * because two honest implementations of "HMAC of a secret" disagree about
     * them and meet as a refusal nobody can debug. Nothing else in the repo
     * has the mac computed by the extension and verified by this bridge.
     *
     * The reconnect is forced by replacing the bridge: disposing it drops the
     * socket, and a second one on the same port with the same store is, to the
     * extension, the same Artemis restarting. It dials again with the id and
     * the secret it stored — there is no code to pair with this time — so
     * getting back to `connected` is the proof.
     */
    const before = bridge?.state().browsers[0]?.browserId;
    const store = await openPairedBrowsers(dataDir);

    await bridge?.dispose();
    bridge = createExtensionBridge({ store, port: bridgePort });
    await bridge.start();
    expect(bridge.state().listening).toEqual({ kind: 'listening', port: bridgePort });
    // Nothing is being offered: a browser that could only pair would be stuck.
    expect(bridge.state().pairing).toBeNull();

    await until(() => bridge?.state().browsers.some((one) => one.connected) === true, 60_000);

    expect(bridge.state().browsers[0]?.browserId).toBe(before);

    // And it is a working connection, not merely an open socket.
    const driver = extensionPageDriver(RUN, bridge);
    const opened = await driver.open(siteUrl);
    expect(opened.ok).toBe(true);
    await driver.close();
  }, 180_000);
});

/* -------------------------------------------------------------------------- */
/* The served path                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The whole relay, with a real server at one end and a real Chrome at the
 * other.
 *
 * Everything between them is the shipping code: `createArtemisServer` serving
 * `/api/v0/events` and `/api/v0/browser/answer`, `createBrowserRelay`
 * publishing verbs scoped to one connection, `createBrowserCallClient`
 * listening on that connection and performing them, `ExtensionPageDriver`
 * putting them on the bridge, and the extension doing them in a tab.
 *
 * The one thing standing in for something is the run: a fake `RunSource` whose
 * `startRun` drives the relayed driver, rather than an agent deciding to. What
 * that skips is `/v1/chat/completions` deciding whether the run may have a
 * browser at all, which has its own tests in `completions.test.ts` and needs
 * no browser to be exercised.
 *
 * It shares the browser, the bridge and the pairing above, because a second
 * headless Chromium is fifteen seconds and one more process to fail to reap.
 */
describe.skipIf(binary === null)('a run on a server, driving the browser here', () => {
  const TOKEN = 'served-e2e-token-abcdefghijklmnop';
  const CONNECTION = {
    id: 'conn-e2e',
    label: 'The client with the browser',
    workspace: { kind: 'directory' as const, path: '/w' },
    token: TOKEN,
    createdAt: 0,
  };
  const SERVED_RUN = 'served-run-1';

  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let client: BrowserCallClient | null = null;

  /** A core server with the relay wired, on a free port. */
  async function startServer() {
    const relay = createBrowserRelay({
      publish: (connectionId, call) => {
        feed.publish('artemis:push:browser-call', call, { connectionId });
      },
    });
    const feed = createPushFeed();
    /*
     * A run source that does what an agent's browser tools would: it takes the
     * relayed driver and uses it. `startRun` is never called here — the tests
     * drive the driver directly — but the shape is the seam a real host fills.
     */
    const runs = {
      startRun: async () => {
        throw new Error('not under test');
      },
      subscribe: () => () => undefined,
      interrupt: async () => undefined,
      respondToPermission: async () => undefined,
      disposeRun: async () => undefined,
    };
    const made = createArtemisServer({
      port: 0,
      connections: () => [CONNECTION],
      version: '1.1.1',
      catalogue: { read: async () => [], invalidate: () => undefined },
      runs: runs as never,
      workspaces: createWorkspaceResolver(),
      feed,
      browserRelay: relay,
    });
    const port = await made.listen();
    return { server: made, relay, root: `http://127.0.0.1:${String(port)}` };
  }

  beforeAll(async () => {
    server = await startServer();
    client = createBrowserCallClient({
      root: server.root,
      headers: () => ({ authorization: `Bearer ${TOKEN}` }),
      // The same driver a local run gets, so a served run drives the same
      // Chrome under the same policy and reads the same refusals.
      driverFor: (runKey) => extensionPageDriver(runKey as RunId, bridge as ExtensionBridge),
    });
    client.own(SERVED_RUN);
    /*
     * And wait for the feed before the first verb. A test publishes the
     * instant it claims a run, where a real conversation takes a model round
     * trip to decide it wants a browser — see `BrowserCallClient.ready`.
     */
    await client.ready();
  }, 60_000);

  afterAll(async () => {
    client?.stop();
    await server?.server.close();
  });

  it('opens, reads and clicks a page from the server side', async () => {
    // The verbs start on the server, travel to this machine over the feed, are
    // performed in a real Chrome, and come back as answers the server's own
    // driver resolves. Nothing here touches the bridge directly.
    const driver = (server as NonNullable<typeof server>).relay.driverFor(CONNECTION.id, SERVED_RUN);

    const opened = await driver.open(siteUrl);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect((opened.value as PageLocation).url).toContain('127.0.0.1');

    const read = await driver.read();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect((read.value as PageText).text).toContain('The page under test');

    const clicked = await driver.click('#go');
    expect(clicked.ok).toBe(true);

    // Read again: the click swapped the heading, so this proves the action
    // reached the page rather than that a selector matched somewhere.
    const after = await driver.read();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect((after.value as PageText).text).toContain('Clicked');
  }, 180_000);

  it('brings the extension’s own refusal back to the server', async () => {
    const driver = (server as NonNullable<typeof server>).relay.driverFor(CONNECTION.id, SERVED_RUN);
    await driver.open(siteUrl);

    const result = await driver.click('#nothing-matches-this');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The extension's sentence, not the relay's deadline — which is the whole
    // point: a refusal travels as an answer, so the agent hears why rather
    // than waiting out a timeout and guessing.
    expect(result.reason).not.toContain('did not answer');
    expect(result.reason).toMatch(/#nothing-matches-this/u);
  }, 120_000);

  it('leaves a run this client does not own unanswered', async () => {
    /*
     * The ownership rule, end to end. Another window of the same connection
     * would be the one holding that run, and this client must not act for it —
     * a click performed twice is a form submitted twice. With nobody holding
     * it at all, the server's own deadline is what answers, in words.
     */
    const driver = (server as NonNullable<typeof server>).relay.driverFor(
      CONNECTION.id,
      'a-run-nobody-here-started',
    );

    const result = await driver.read();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('did not answer');
  }, 60_000);

  it('closes the run’s tab when the server says the run has ended', async () => {
    // What the registry's lifecycle hook sends on `run.ended`. The tab is in a
    // tab group Artemis put in somebody's Chrome, and a week of conversations
    // leaving one behind each is a browser nobody can find anything in.
    const driver = (server as NonNullable<typeof server>).relay.driverFor(CONNECTION.id, SERVED_RUN);
    await driver.open(siteUrl);

    await driver.close();

    // The tab is gone, so the next verb has no page to act on and says so
    // rather than answering about a page that is not there.
    const after = await driver.read();
    expect(after.ok).toBe(false);
  }, 120_000);
});

/* -------------------------------------------------------------------------- */
/* Two Chrome profiles, one Artemis                                           */
/* -------------------------------------------------------------------------- */

/**
 * The feature of issue #443, with two real browsers.
 *
 * Everything above runs against one Chrome, which is the arrangement the old
 * bridge comment described: "the first connected browser, and there is
 * normally exactly one". The whole of this feature is what happens when that
 * stops being true, and it is not a thing a fake can prove — the failure it
 * removes is that *every verb succeeds* while acting in the wrong signed-in
 * profile, so the only evidence is which browser a page turned up in.
 *
 * So this launches two Chromiums with their own `--user-data-dir`s, which is
 * what makes them two profiles as far as the extension is concerned: each gets
 * its own `chrome.storage`, pairs separately, and holds its own connection.
 * Each is named through the real options page, because the name is what the
 * user types and what every refusal quotes back.
 *
 * ## How "it drove A and not B" is proved
 *
 * By the tab book. The extension files one tab per `runKey` and knows nothing
 * about any other browser, so a page opened for a run in one browser is
 * readable through that browser and refused through the other — "this
 * conversation's tab has no page open". That is a fact about where the page
 * actually is, rather than about what Artemis believes.
 *
 * ## The shared browser is closed first
 *
 * This box has been OOM-killed by parallel suites, and three headless
 * Chromiums at once is the arrangement most likely to do it again. The one the
 * suites above share has finished its work by the time this runs, so it goes
 * before these two start. The file's own `afterAll` is null-safe.
 */
describe.skipIf(binary === null)('two Chrome profiles paired with one Artemis', () => {
  const RUN_A = 'run-e2e-two-a' as RunId;
  const RUN_B = 'run-e2e-two-b' as RunId;
  const RUN_C = 'run-e2e-two-c' as RunId;
  const RUN_SERVED = 'run-e2e-two-served';

  let twoDataDir = '';
  let twoBridge: ExtensionBridge | null = null;
  let work: ChromeUnderTest | null = null;
  let personal: ChromeUnderTest | null = null;
  let workId = '';
  let personalId = '';
  /**
   * Every browser this suite started, for teardown to close.
   *
   * Kept separately from `work` and `personal` because those are assigned
   * *after* a pairing succeeds, and a pairing that throws — a code that did not
   * land, an options page that never came up — would otherwise leave a
   * headless Chromium running with nobody holding a reference to it. One was
   * found that way while this suite was being written.
   */
  const started: ChromeUnderTest[] = [];

  /**
   * Launch one Chromium, and pair it under a name through the options page.
   *
   * The `input` events are not decoration, here for the reason the suite above
   * gives and one more: the page stops overwriting the name field once it has
   * been typed into, and a test that only assigned `value` would be pairing
   * under whatever the browser called itself — which is the same string for
   * both of these and would prove nothing.
   */
  async function pairOne(name: string): Promise<{ chrome: ChromeUnderTest; browserId: string }> {
    const bridge = twoBridge as ExtensionBridge;
    const listening = bridge.state().listening;
    if (listening.kind !== 'listening') throw new Error('the bridge is not listening');

    const launched = await launchChrome(binary as string, extensionDist);
    started.push(launched);
    await launched.awaitExtension();

    const code = bridge.offerPairing(true).pairing?.code ?? '';
    const options = await launched.openPage(
      `chrome-extension://${ARTEMIS_EXTENSION_ID}/options.html`,
    );
    await options.evaluate(`(async () => {
      const type = (id, value) => {
        const field = document.getElementById(id);
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      };
      type('port', ${JSON.stringify(String(listening.port))});
      document.getElementById('save-port').click();
      await new Promise((r) => setTimeout(r, 200));
      type('browser-label', ${JSON.stringify(name)});
      type('code', ${JSON.stringify(code)});
      document.getElementById('pair').click();
    })()`);

    await until(
      () => bridge.state().browsers.some((one) => one.browserName === name && one.connected),
      90_000,
    );
    const paired = bridge.state().browsers.find((one) => one.browserName === name);
    if (paired === undefined) throw new Error(`${name} did not pair`);
    return { chrome: launched, browserId: paired.browserId };
  }

  beforeAll(async () => {
    await chrome?.close();
    chrome = null;

    twoDataDir = await mkdtemp(join(tmpdir(), 'artemis-e2e-two-'));
    twoBridge = createExtensionBridge({ store: await openPairedBrowsers(twoDataDir), port: 0 });
    await twoBridge.start();

    const first = await pairOne('Work');
    work = first.chrome;
    workId = first.browserId;
    const second = await pairOne('Personal');
    personal = second.chrome;
    personalId = second.browserId;
  }, 420_000);

  afterAll(async () => {
    /*
     * Every browser that was started, whatever happened to it, and before the
     * bridge: one left running holds a socket this process is about to stop
     * reading. Closing one twice is harmless — the last test closes the first
     * browser on purpose — and closing one the suite never got to pair is the
     * case this list exists for.
     */
    for (const browser of started) await browser.close();
    await twoBridge?.dispose();
    for (const directory of [twoDataDir, ...started.map((one) => one.profileDir)]) {
      if (directory === '') continue;
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it('pairs two browsers under the names typed into their own options pages', () => {
    const browsers = twoBridge?.state().browsers ?? [];

    expect(browsers.map((one) => one.browserName)).toEqual(['Work', 'Personal']);
    expect(browsers.every((one) => one.connected)).toBe(true);
    // Two ids, because two profiles pair separately: each runs its own copy of
    // the extension with its own storage and its own secret.
    expect(workId).not.toBe(personalId);
  });

  it('drives the browser a conversation names, and leaves the other one alone', async () => {
    const driver = extensionPageDriver(RUN_A, twoBridge as ExtensionBridge, { browser: workId });

    const opened = await driver.open(siteUrl);
    expect(opened.ok).toBe(true);

    const read = await driver.read();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect((read.value as PageText).text).toContain('The page under test');

    /*
     * And the page is in Work and nowhere else. The extension files one tab
     * per run key and knows about no other browser, so asking Personal about
     * this run finds nothing — which is the assertion that would have failed
     * under "the first connected browser" and succeeded silently.
     */
    const elsewhere = await extensionPageDriver(RUN_A, twoBridge as ExtensionBridge, {
      browser: personalId,
    }).read();
    expect(elsewhere.ok).toBe(false);
    if (elsewhere.ok) return;
    expect(elsewhere.reason).toContain('no page open');

    await driver.close();
  }, 180_000);

  it('asks which browser when a conversation named none, then drives the one answered', async () => {
    const driver = extensionPageDriver(RUN_B, twoBridge as ExtensionBridge);

    // The first verb refuses rather than guessing, and the sentence carries
    // both names because the agent is about to read them out to the user.
    const refused = await driver.open(siteUrl);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain('“Work”');
    expect(refused.reason).toContain('“Personal”');
    expect(refused.reason).toContain('browser_open');

    // The answer, as `browser_open`'s new argument carries it.
    const opened = await driver.open(siteUrl, 'Personal');
    expect(opened.ok).toBe(true);

    // In Personal, and nowhere else.
    const here = await extensionPageDriver(RUN_B, twoBridge as ExtensionBridge, {
      browser: personalId,
    }).read();
    expect(here.ok).toBe(true);
    if (!here.ok) return;
    expect((here.value as PageText).text).toContain('The page under test');

    const elsewhere = await extensionPageDriver(RUN_B, twoBridge as ExtensionBridge, {
      browser: workId,
    }).read();
    expect(elsewhere.ok).toBe(false);

    // And the run stays on the browser it was told, without being told again.
    const again = await driver.read();
    expect(again.ok).toBe(true);

    await driver.close();
  }, 240_000);

  /*
   * The served path, with the same two browsers.
   *
   * Everything between the run and the page is the shipping code, as in the
   * suite above: a real `createArtemisServer`, the relay publishing verbs
   * scoped to one connection, the client listening on it and performing them.
   * What is added here is the browser id — `artemis.extensionBrowserId`'s
   * journey, from the relay's `driverFor` to the call on the feed to the
   * driver the client builds — and the thing being proved is the same one:
   * the page turns up in the browser that was named.
   */
  it('drives the named browser from a run on a server', async () => {
    const TOKEN = 'served-two-token-abcdefghijklmnop';
    const CONNECTION = {
      id: 'conn-e2e-two',
      label: 'The client with two browsers',
      workspace: { kind: 'directory' as const, path: '/w' },
      token: TOKEN,
      createdAt: 0,
    };

    const feed = createPushFeed();
    const relay = createBrowserRelay({
      publish: (connectionId, call) => {
        feed.publish('artemis:push:browser-call', call, { connectionId });
      },
    });
    const server = createArtemisServer({
      port: 0,
      connections: () => [CONNECTION],
      version: '1.1.1',
      catalogue: { read: async () => [], invalidate: () => undefined },
      runs: {
        startRun: async () => {
          throw new Error('not under test');
        },
        subscribe: () => () => undefined,
        interrupt: async () => undefined,
        respondToPermission: async () => undefined,
        disposeRun: async () => undefined,
      } as never,
      workspaces: createWorkspaceResolver(),
      feed,
      browserRelay: relay,
    });
    const port = await server.listen();

    const client = createBrowserCallClient({
      root: `http://127.0.0.1:${String(port)}`,
      headers: () => ({ authorization: `Bearer ${TOKEN}` }),
      // The same driver a local run gets, built for whichever browser the
      // server named — which is the client's half of the whole feature.
      driverFor: (runKey, browserId) =>
        extensionPageDriver(runKey as RunId, twoBridge as ExtensionBridge, { browser: browserId }),
    });

    try {
      client.own(RUN_SERVED);
      await client.ready();

      const driver = relay.driverFor(CONNECTION.id, RUN_SERVED, workId);
      const opened = await driver.open(siteUrl);
      expect(opened.ok).toBe(true);

      const read = await driver.read();
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect((read.value as PageText).text).toContain('The page under test');

      // In Work, because that is the id the run carried all the way across.
      const elsewhere = await extensionPageDriver(RUN_SERVED as RunId, twoBridge as ExtensionBridge, {
        browser: personalId,
      }).read();
      expect(elsewhere.ok).toBe(false);

      await driver.close();
    } finally {
      client.stop();
      await server.close();
    }
  }, 240_000);

  /*
   * Last, because it kills one of the browsers the tests above need.
   */
  it('drives the one that is left, silently, once the other is closed', async () => {
    await work?.close();
    work = null;
    await until(
      () => (twoBridge?.state().browsers.filter((one) => one.connected).length ?? 0) === 1,
      60_000,
    );

    // No id, one browser: the person with one Chrome never meets any of this,
    // and neither does the person who has just shut their other one.
    const driver = extensionPageDriver(RUN_C, twoBridge as ExtensionBridge);

    const opened = await driver.open(siteUrl);
    expect(opened.ok).toBe(true);

    const read = await driver.read();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect((read.value as PageText).text).toContain('The page under test');

    // And a conversation still pointed at the closed one is told which browser
    // to open rather than being handed the one that happens to be running.
    const pinned = await extensionPageDriver(RUN_C, twoBridge as ExtensionBridge, {
      browser: workId,
    }).read();
    expect(pinned.ok).toBe(false);
    if (pinned.ok) return;
    expect(pinned.reason).toContain('“Work”');
    expect(pinned.reason).toContain('Do not use a different browser instead');

    await driver.close();
  }, 240_000);
});

/*
 * Always runs, so the skip above is visible in the report. A suite that is
 * silently absent is a suite that stops being maintained.
 */
it('says whether the browser half of this feature was exercised', () => {
  if (binary === null) {
    console.warn(
      'No Chromium: the extension was not driven in a real browser. Set ARTEMIS_E2E_CHROME, ' +
        'or install a Playwright Chromium, to run it.',
    );
  }
  expect(true).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* The browser                                                                */
/* -------------------------------------------------------------------------- */

/** See the file header for the three rules. */
function findChromium(): string | null {
  const named = process.env['ARTEMIS_E2E_CHROME'];
  if (named !== undefined && named.length > 0) return existsSync(named) ? named : null;
  if (process.env['CI'] !== undefined && process.env['CI'] !== '') return null;

  const roots = [
    process.env['PLAYWRIGHT_BROWSERS_PATH'],
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    join(homedir(), 'AppData', 'Local', 'ms-playwright'),
  ].filter((path): path is string => typeof path === 'string' && path.length > 0);

  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries.filter((name) => name.startsWith('chromium-')).sort().reverse()) {
      const candidates = [
        join(root, entry, 'chrome-linux', 'chrome'),
        join(root, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(root, entry, 'chrome-win', 'chrome.exe'),
      ];
      const found = candidates.find((path) => existsSync(path));
      if (found !== undefined) return found;
    }
  }
  return null;
}

interface Page {
  evaluate<T>(expression: string): Promise<T>;
  close(): void;
}

interface ChromeUnderTest {
  readonly profileDir: string;
  /**
   * Wait until the extension's service worker exists in this browser.
   *
   * Before it does, `chrome-extension://…/options.html` is a URL Chrome has
   * nothing to serve: the target is created, the document loads as an error
   * page, `readyState` reaches `complete`, and every `getElementById` on it
   * answers `null`. That is a pairing script failing on a line that looks
   * correct, and it was found by launching a second browser — the first one in
   * the file had a bridge and a web server built between launching and opening
   * a page, which was enough time by accident.
   */
  awaitExtension(): Promise<void>;
  openPage(url: string): Promise<Page>;
  close(): Promise<void>;
}

/**
 * Chromium with the built extension in it and nothing else.
 *
 * The throttling flags are load-bearing: every tab the extension opens is a
 * background tab, and with Chrome's defaults a background tab's timers are
 * slowed until a page's own script never finishes.
 */
async function launchChrome(binaryPath: string, extensionDir: string): Promise<ChromeUnderTest> {
  const profile = await mkdtemp(join(tmpdir(), 'artemis-e2e-profile-'));
  const child = spawn(binaryPath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=HttpsUpgrades,DialMediaRouteProvider',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  /*
   * A runner that dies before `close` — a timeout, an interrupted suite —
   * would leave this browser running with no parent. One was found that way,
   * nineteen minutes old. An `exit` handler has to be synchronous, which a
   * signal is.
   */
  const killOnExit = (): void => {
    child.kill('SIGTERM');
  };
  process.once('exit', killOnExit);

  const port = await readDevToolsPort(join(profile, 'DevToolsActivePort'));
  const sockets: WebSocket[] = [];

  const targets = async (): Promise<readonly { type: string; url: string; webSocketDebuggerUrl: string }[]> =>
    (await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()) as never;

  return {
    profileDir: profile,

    awaitExtension: async () => {
      await untilValue(
        async () =>
          (await targets()).find(
            (one) => one.type === 'service_worker' && one.url.includes(ARTEMIS_EXTENSION_ID),
          ),
        30_000,
      );
    },

    openPage: async (url) => {
      await fetch(`http://127.0.0.1:${String(port)}/json/new?${encodeURIComponent(url)}`, {
        method: 'PUT',
      });
      const target = await untilValue(
        async () => (await targets()).find((one) => one.type === 'page' && one.url.startsWith(url)),
        30_000,
      );
      const page = await connect(target.webSocketDebuggerUrl);
      sockets.push(page.socket);
      // A target exists as soon as Chrome decides to make one, which is before
      // it has a document; without this the first `getElementById` finds
      // nothing, intermittently.
      await until(async () => (await page.evaluate<string>('document.readyState')) === 'complete', 30_000);
      return page;
    },

    close: async () => {
      for (const socket of sockets) socket.close();
      process.off('exit', killOnExit);
      /*
       * Asked first, then made to. SIGKILL alone reaps the browser process and
       * orphans its zygote and its renderers, which go on holding several
       * hundred megabytes with nobody left to stop them. A Chrome given
       * SIGTERM takes its children down with it; the kill is for the one that
       * does not answer.
       */
      child.kill('SIGTERM');
      const exited = new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once('exit', () => done());
      });
      const gaveUp = setTimeout(() => child.kill('SIGKILL'), 3_000);
      await exited;
      clearTimeout(gaveUp);
    },
  };
}

/** Chrome writes its chosen port once it is ready, so this waits for both. */
async function readDevToolsPort(file: string, within = 30_000): Promise<number> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const first = readFileSync(file, 'utf8').split('\n')[0] ?? '';
      const port = Number(first.trim());
      if (Number.isInteger(port) && port > 0) return port;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Chromium never wrote its DevTools port');
}

/** One CDP connection, with just enough of the protocol to evaluate. */
async function connect(url: string): Promise<Page & { socket: WebSocket }> {
  const socket = new WebSocket(url);
  await new Promise<void>((done, fail) => {
    socket.once('open', () => done());
    socket.once('error', () => fail(new Error(`could not open a CDP connection to ${url}`)));
  });

  let nextId = 0;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  socket.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    const id = message['id'];
    if (typeof id !== 'number') return;
    pending.get(id)?.(message);
    pending.delete(id);
  });

  return {
    socket,
    evaluate: async <T,>(expression: string): Promise<T> => {
      const id = (nextId += 1);
      const answer = await new Promise<Record<string, unknown>>((done) => {
        pending.set(id, done);
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
      });
      const result = answer['result'] as { result?: { value?: T }; exceptionDetails?: unknown };
      if (result?.exceptionDetails !== undefined) {
        throw new Error(`the page threw: ${JSON.stringify(result.exceptionDetails)}`);
      }
      return result?.result?.value as T;
    },
    close: () => {
      socket.close();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The page under test                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One page on loopback, which is a dev site without being listed.
 *
 * Deliberately trivial: this suite is about the wire, not about what the
 * extension can extract from a complicated document — the extension's own
 * suite covers that against three kinds of host. What is needed here is
 * something to read and something to click whose effect is visible in the
 * text, so a click that matched a selector and did nothing is distinguishable
 * from a click that happened.
 */
async function startSite(): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><html><head><title>Under test</title></head><body>' +
        '<h1 id="heading">The page under test</h1>' +
        '<button id="go">Go</button>' +
        '<script>document.getElementById("go").addEventListener("click", () => {' +
        'document.getElementById("heading").textContent = "Clicked";});</script>' +
        '</body></html>',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

/* -------------------------------------------------------------------------- */
/* Waiting                                                                    */
/* -------------------------------------------------------------------------- */

async function until(condition: () => boolean | Promise<boolean>, within: number): Promise<void> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`nothing satisfied the condition within ${String(within)}ms`);
}

async function untilValue<T>(produce: () => Promise<T | undefined>, within: number): Promise<T> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    const value = await produce();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`nothing appeared within ${String(within)}ms`);
}
