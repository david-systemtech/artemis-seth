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

describe.skipIf(binary === null)('the real extension on the real bridge', () => {
  beforeAll(async () => {
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

  const port = await readDevToolsPort(join(profile, 'DevToolsActivePort'));
  const sockets: WebSocket[] = [];

  const targets = async (): Promise<readonly { type: string; url: string; webSocketDebuggerUrl: string }[]> =>
    (await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()) as never;

  return {
    profileDir: profile,

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
      child.kill('SIGKILL');
      await new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once('exit', () => done());
      });
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
