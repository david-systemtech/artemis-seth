/**
 * Launching a headless Chromium with the extension in it, and talking CDP to it.
 * ============================================================================
 *
 * The test is a second CDP client on the same browser: the extension attaches
 * `chrome.debugger` to its own tabs, and this attaches to the *extension's*
 * pages — the options page and the popup — so that pairing and the stop button
 * are driven the way a person drives them rather than by seeding storage. The
 * two never attach to the same target, which is what makes both possible.
 *
 * The port is read from `DevToolsActivePort` rather than chosen, because
 * choosing one means a race with anything else on the machine, and a test that
 * fails once a fortnight on a port collision is worse than no test.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The Chromium this suite may drive, or `null` when it should not run.
 *
 * Three rules, and the second is the interesting one.
 *
 *  1. `ARTEMIS_E2E_CHROME` wins. Whoever sets it has said which browser, and
 *     nothing here second-guesses them.
 *  2. **Never on CI by default.** GitHub's Ubuntu runners ship Google Chrome at
 *     `/usr/bin/google-chrome`, so "look for a browser and run if you find one"
 *     would quietly turn this into a CI suite — a slow one, on a browser
 *     nobody pinned, that would start failing the day the image moved. The
 *     decision to run it there has to be somebody's, and rule 1 is how they
 *     make it.
 *  3. Otherwise a Playwright-managed Chromium, which is a pinned build a
 *     developer chose to download, rather than whatever the system happens to
 *     have as its everyday browser — which is also the browser with all of the
 *     developer's own logins in it.
 */
export function findChromium(): string | null {
  const named = process.env['ARTEMIS_E2E_CHROME'];
  if (named !== undefined && named.length > 0) return existsSync(named) ? named : null;
  if (process.env['CI'] !== undefined && process.env['CI'] !== '') return null;
  return playwrightChromiums().find((path) => existsSync(path)) ?? null;
}

/** Every `chromium-<build>` Playwright has downloaded, newest build first. */
function playwrightChromiums(): readonly string[] {
  const roots = [
    process.env['PLAYWRIGHT_BROWSERS_PATH'],
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    join(homedir(), 'AppData', 'Local', 'ms-playwright'),
  ].filter((path): path is string => typeof path === 'string' && path.length > 0);

  const found: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries.filter((name) => name.startsWith('chromium-')).sort().reverse()) {
      found.push(
        join(root, entry, 'chrome-linux', 'chrome'),
        join(root, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(root, entry, 'chrome-win', 'chrome.exe'),
      );
    }
  }
  return found;
}

/** One CDP connection: a target's, or the browser's own. */
export class Cdp {
  #socket: WebSocket;
  #nextId = 0;
  readonly #pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    this.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>;
      const id = message['id'];
      if (typeof id !== 'number') return;
      const waiting = this.#pending.get(id);
      if (waiting === undefined) return;
      this.#pending.delete(id);
      const error = message['error'];
      if (error !== undefined) waiting.reject(new Error(`CDP: ${JSON.stringify(error)}`));
      else waiting.resolve((message['result'] ?? {}) as Record<string, unknown>);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`could not open a CDP connection to ${url}`)), { once: true });
    });
    return new Cdp(socket);
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.#nextId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate in the target and return the value, throwing what the page threw. */
  async evaluate<T>(expression: string): Promise<T> {
    const answer = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const details = answer['exceptionDetails'] as { exception?: { description?: string } } | undefined;
    if (details !== undefined) throw new Error(`the page threw: ${details.exception?.description ?? JSON.stringify(details)}`);
    return (answer['result'] as { value: T }).value;
  }

  close(): void {
    this.#socket.close();
  }
}

/** One target as `/json/list` describes it. */
export interface CdpTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

export interface Browser {
  readonly devtoolsPort: number;
  targets(): Promise<readonly CdpTarget[]>;
  /** Wait for the first target matching a predicate, or give up. */
  awaitTarget(matches: (target: CdpTarget) => boolean, what: string, within?: number): Promise<CdpTarget>;
  /** Open a page at an address and connect to it. */
  openPage(url: string): Promise<Cdp>;
  close(): Promise<void>;
}

/**
 * Start Chromium with the built extension loaded and nothing else.
 *
 * The flags are all load-bearing. `--host-resolver-rules` is what lets the
 * suite exercise a blocked host and a public-looking host without a packet
 * leaving the machine. The throttling flags matter because every tab Artemis
 * opens is a background tab: with Chrome's defaults its timers are slowed to a
 * crawl and a page's own script never finishes. `--disable-features` keeps
 * Chrome from upgrading the suite's `http://` addresses to `https://`, which it
 * otherwise does for anything that looks like a real domain.
 */
export async function launchBrowser(options: { readonly binary: string; readonly extensionDir: string }): Promise<Browser> {
  const profile = await mkdtemp(join(tmpdir(), 'artemis-extension-e2e-'));
  const mapped = ['www.paypal.com', 'shop.example'].map((host) => `MAP ${host} 127.0.0.1`).join(', ');

  const child: ChildProcess = spawn(
    options.binary,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,DialMediaRouteProvider',
      `--host-resolver-rules=${mapped}`,
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--load-extension=${options.extensionDir}`,
      `--disable-extensions-except=${options.extensionDir}`,
      'about:blank',
    ],
    // Chrome on a machine with no D-Bus writes a great deal of noise to stderr
    // that has nothing to do with this suite.
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  /*
   * A runner that dies before `close` - a timeout, an interrupted suite - would
   * leave this browser running with no parent. One was found that way, 19
   * minutes old. An `exit` handler has to be synchronous, which a signal is.
   */
  const killOnExit = (): void => {
    child.kill('SIGTERM');
  };
  process.once('exit', killOnExit);

  const devtoolsPort = await readDevToolsPort(join(profile, 'DevToolsActivePort'), child);

  const targets = async (): Promise<readonly CdpTarget[]> => {
    const response = await fetch(`http://127.0.0.1:${String(devtoolsPort)}/json/list`);
    return (await response.json()) as readonly CdpTarget[];
  };

  const awaitTarget = async (matches: (target: CdpTarget) => boolean, what: string, within = 30_000): Promise<CdpTarget> => {
    const deadline = Date.now() + within;
    while (Date.now() < deadline) {
      const found = (await targets()).find(matches);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`no ${what} target appeared within ${String(within)}ms`);
  };

  const browserEndpoint = ((await (await fetch(`http://127.0.0.1:${String(devtoolsPort)}/json/version`)).json()) as { webSocketDebuggerUrl: string })
    .webSocketDebuggerUrl;
  const browserCdp = await Cdp.connect(browserEndpoint);

  return {
    devtoolsPort,
    targets,
    awaitTarget,
    openPage: async (url: string): Promise<Cdp> => {
      await browserCdp.send('Target.createTarget', { url });
      const target = await awaitTarget((candidate) => candidate.type === 'page' && candidate.url.startsWith(url.split('#')[0] ?? url), url);
      const page = await Cdp.connect(target.webSocketDebuggerUrl);
      // A target exists as soon as Chrome has decided to make one, which is
      // before it has a document. Without this wait the first
      // `getElementById` finds nothing — intermittently, because whether it
      // does depends on how long the caller happened to take.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const ready = await page.evaluate<string>('document.readyState');
        if (ready === 'complete') return page;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`${url} never finished loading`);
    },
    close: async (): Promise<void> => {
      browserCdp.close();
      process.off('exit', killOnExit);
      /*
       * Asked first, then made to. SIGKILL alone reaps the browser process and
       * orphans its zygote and renderers, which were measured here going on
       * holding several hundred megabytes with nobody left to stop them. A
       * Chrome given SIGTERM takes its children down with it; the kill is for
       * the one that does not answer.
       */
      child.kill('SIGTERM');
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
      const gaveUp = setTimeout(() => child.kill('SIGKILL'), 3_000);
      await exited;
      clearTimeout(gaveUp);
      // A killed Chrome's child processes go on writing to the profile for a
      // moment after the parent is reaped, so a plain recursive remove
      // intermittently fails with ENOTEMPTY — and a test suite that is green
      // except for its own cleanup is a suite people learn to rerun. These are
      // the retries `fs.rm` already has for exactly this.
      await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}

/**
 * Read the port Chrome chose, which it writes to the profile once it is ready.
 *
 * Waiting for the file is also how this waits for the browser to be up at all,
 * so a Chromium that dies on start fails here with its exit status rather than
 * thirty seconds later with a confusing timeout.
 */
async function readDevToolsPort(file: string, child: ChildProcess, within = 30_000): Promise<number> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chromium exited with status ${String(child.exitCode)} before it was ready`);
    if (existsSync(file)) {
      const first = readFileSync(file, 'utf8').split('\n')[0] ?? '';
      const port = Number(first.trim());
      if (Number.isInteger(port) && port > 0) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chromium never wrote its DevTools port');
}
