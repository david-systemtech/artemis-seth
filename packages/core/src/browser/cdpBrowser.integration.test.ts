/**
 * The server browser against a real Chromium and a real page.
 * ============================================================================
 *
 * `serverBrowser.test.ts` pins what the driver *asks for*; this pins that a
 * browser answers. The two are different questions and the second one has
 * caught things the first cannot: that `Input.insertText` really does fire the
 * `input` event a framework listens for, that `Network.loadingFailed` really
 * carries the error text for a connection nothing is listening on, that
 * `Runtime.getHeapUsage` really moves when a page allocates.
 *
 * ## It skips itself where there is no browser
 *
 * GitHub's runners have no Chromium at the path below, and a test that fails
 * there would train everyone to ignore a red build. So it skips with a sentence
 * saying what is missing and how to get it. Set `ARTEMIS_CHROMIUM` to point at
 * any Chromium or headless shell; otherwise Playwright's cached one is looked
 * for, which is what the development container has.
 *
 * ## Nothing it starts outlives it
 *
 * A browser, a temporary profile directory and an HTTP server, all torn down in
 * `afterAll` whether the tests passed or not — the same rule the feature itself
 * is built around.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createSocketServer } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PageDriver } from '@rx-artemis/protocol';

import { createServerBrowser, type BrowserTimers, type ServerBrowser } from './serverBrowser.js';

/* -------------------------------------------------------------------------- */
/* Finding a browser                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Playwright's cached headless shell, which the development container has.
 *
 * Named by its exact version rather than globbed: a glob that matched two
 * versions would pick one by lexical accident, and a test that silently
 * changed browser between runs is worse than one that skipped.
 */
const CACHED_CHROMIUM = join(
  process.env['HOME'] ?? '/root',
  '.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell',
);

function chromiumPath(): string | null {
  const declared = process.env['ARTEMIS_CHROMIUM'];
  if (declared !== undefined && declared.length > 0 && existsSync(declared)) return declared;
  return existsSync(CACHED_CHROMIUM) ? CACHED_CHROMIUM : null;
}

const CHROMIUM = chromiumPath();

/** A port nothing is listening on. */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createSocketServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Wait for something to become true, or give up with a sentence. */
async function until(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/* -------------------------------------------------------------------------- */
/* A tiny site with everything a browser test needs to see                    */
/* -------------------------------------------------------------------------- */

/**
 * One page with a form, a console line, an uncaught error, a request that
 * fails, a cookie and a stored value — the six things an agent opens DevTools
 * for, on one document so one load produces all of them.
 */
function pageHtml(port: number): string {
  return `<!doctype html>
<html><head><title>Orders</title></head>
<body style="font-family: sans-serif">
  <h1>Orders</h1>
  <p id="intro">Nothing here yet.</p>
  <form id="form">
    <input id="email" value="old@example.com">
    <div id="note" contenteditable="true">a note</div>
    <button id="save" type="button">Save</button>
  </form>
  <p id="result">unsaved</p>
  <p id="events"></p>
  <div id="hidden" style="display:none">you cannot click me</div>
  <script>
    localStorage.setItem('token', 'abc123');
    sessionStorage.setItem('draft', 'yes');
    document.cookie = 'visited=1; path=/';
    console.log('page is up');
    console.warn('a warning');

    var seen = [];
    document.getElementById('email').addEventListener('input', function () { seen.push('input'); });
    document.getElementById('email').addEventListener('change', function () { seen.push('change'); });
    document.getElementById('events').textContent = '';
    window.seenEvents = function () { return seen.join(','); };

    document.getElementById('save').addEventListener('click', function () {
      document.getElementById('result').textContent =
        'saved ' + document.getElementById('email').value;
    });

    // A request that answers 404 and one that answers nothing at all.
    fetch('/api/missing').catch(function () {});
    fetch('http://127.0.0.1:${String(port)}/nothing-listening').catch(function () {});

    // Uncaught, so it arrives as Runtime.exceptionThrown rather than a console line.
    setTimeout(function () { throw new Error('the page broke'); }, 0);
  </script>
</body></html>`;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A clock the test owns, so no lifecycle rule is waited for in real time. */
class TestTimers implements BrowserTimers {
  #now = Date.now();
  readonly ticks: (() => void)[] = [];

  now(): number {
    return this.#now;
  }
  every(_ms: number, fn: () => void): () => void {
    this.ticks.push(fn);
    return () => {
      const at = this.ticks.indexOf(fn);
      if (at >= 0) this.ticks.splice(at, 1);
    };
  }
  async after(): Promise<void> {
    // Reconnection backoff. Nothing here tests it, and waiting would be a
    // second of nothing.
  }
  advanceMinutes(minutes: number): void {
    this.#now += minutes * 60_000;
  }
}

let chromium: ChildProcess | null = null;
let profileDir: string | null = null;
let site: Server | null = null;
let sitePort = 0;
/** A port with nothing behind it, for the request that cannot connect. */
let deadPort = 0;
let cdpPort = 0;
let origin = '';
let timers: TestTimers;

/**
 * The allow-list is deliberately `127.0.0.1` and not `localhost`.
 *
 * Both reach the same test site, so `http://localhost:<port>/` is a page that
 * is genuinely reachable and genuinely refused — which is what the redirect
 * check needs. Redirecting to a private address that nothing answers on would
 * fail the navigation before the policy ever saw it, and would pin the wrong
 * behaviour.
 */
const ALLOW_HOSTS = ['127.0.0.1'];

function build(limits?: Record<string, unknown>): ServerBrowser {
  return createServerBrowser({
    endpoint: `http://127.0.0.1:${String(cdpPort)}`,
    timers,
    limits: { allowHosts: ALLOW_HOSTS, ...limits },
  });
}

async function value<T>(result: Promise<{ ok: boolean; value?: T; reason?: string }>): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new Error(`refused: ${settled.reason ?? ''}`);
  return settled.value as T;
}

async function refusal(result: Promise<{ ok: boolean; reason?: string }>): Promise<string> {
  const settled = await result;
  if (settled.ok) throw new Error('expected a refusal');
  return settled.reason ?? '';
}

beforeAll(async () => {
  if (CHROMIUM === null) return;
  timers = new TestTimers();

  sitePort = await freePort();
  deadPort = await freePort();
  origin = `http://127.0.0.1:${String(sitePort)}`;

  site = createServer((request, response) => {
    const url = request.url ?? '/';
    if (url === '/redirect') {
      // Same site, other name: reachable, and outside the allow-list above.
      response.writeHead(302, { location: `http://localhost:${String(sitePort)}/` });
      response.end();
      return;
    }
    if (url === '/api/missing') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('no');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': 'session=server-side; Path=/; HttpOnly',
    });
    response.end(pageHtml(deadPort));
  });
  await new Promise<void>((resolve) => site?.listen(sitePort, '127.0.0.1', resolve));

  cdpPort = await freePort();
  profileDir = await mkdtemp(join(tmpdir(), 'artemis-browser-test-'));
  chromium = spawn(
    CHROMIUM,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${String(cdpPort)}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  await until('the browser to answer on its DevTools port', async () => {
    const response = await fetch(`http://127.0.0.1:${String(cdpPort)}/json/version`);
    return response.ok;
  });
}, 60_000);

afterAll(async () => {
  /*
   * `SIGTERM` and then, only if it will not go, `SIGKILL`.
   *
   * Not an over-careful two-step: a Chromium killed outright leaves its zygote
   * and its renderers behind, reparented and running, because the pipe they
   * watch for the browser process's death is never closed. `SIGTERM` gives the
   * browser process the chance to take its own children down, which is the
   * difference between a test run that cleans up after itself and one that
   * leaves half a gigabyte on the machine.
   */
  if (chromium !== null) {
    const process_ = chromium;
    const ended = new Promise<void>((resolve) => process_.once('exit', () => resolve()));
    process_.kill('SIGTERM');
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    process_.kill('SIGKILL');
  }
  await new Promise<void>((resolve) => {
    if (site === null) {
      resolve();
      return;
    }
    site.close(() => resolve());
  });
  if (profileDir !== null) await rm(profileDir, { recursive: true, force: true });
});

const when = CHROMIUM === null ? describe.skip : describe;

if (CHROMIUM === null) {
  // Said once, loudly, rather than as forty skipped names with no reason.
  console.warn(
    'Skipping the server-browser integration tests: no Chromium found. ' +
      `Set ARTEMIS_CHROMIUM to one, or install Playwright's (${CACHED_CHROMIUM}).`,
  );
}

/* -------------------------------------------------------------------------- */
/* Every verb, against a page that really exists                              */
/* -------------------------------------------------------------------------- */

when('every verb against a real Chromium', () => {
  let browser: ServerBrowser;
  let driver: PageDriver;

  beforeAll(async () => {
    browser = build();
    driver = browser.driver();
    await value(driver.open(`${origin}/`));
  }, 60_000);

  afterAll(async () => {
    await browser.dispose();
  });

  it('opens the page and reports where it is', async () => {
    const at = await value(driver.navigate(`${origin}/`));
    expect(at).toEqual({ url: `${origin}/`, title: 'Orders' });
  });

  it('reads the page’s text rather than its markup', async () => {
    const page = await value(driver.read());
    expect(page.text).toContain('Orders');
    expect(page.text).toContain('Nothing here yet.');
    // `innerText` omits what the reader cannot see, which is the same answer a
    // screenshot would give.
    expect(page.text).not.toContain('you cannot click me');
    expect(page.text).not.toContain('<h1>');
  });

  it('takes a JPEG small enough to put in a transcript', async () => {
    const image = await value(driver.screenshot());
    expect(image.mimeType).toBe('image/jpeg');
    const bytes = Buffer.from(image.data, 'base64');
    // A JPEG starts FF D8 FF, and a 1280x800 page of text is tens of
    // kilobytes rather than the hundreds a PNG would be.
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect(bytes.length).toBeGreaterThan(1_000);
    expect(bytes.length).toBeLessThan(400_000);
  });

  it('types into a field so the application sees the change', async () => {
    await value(driver.type('#email', 'someone@example.com'));
    const seen = await value(driver.evaluate('window.seenEvents()'));
    // The point of `Input.insertText` over setting `.value`: React, Vue and
    // everything else listen for `input`, and `change` is what a plain
    // `onchange` handler waits for.
    expect(seen).toBe('input,change');
    expect(await value(driver.evaluate('document.getElementById("email").value'))).toBe(
      'someone@example.com',
    );
  });

  it('replaces what was there rather than appending to it', async () => {
    await value(driver.type('#email', 'first@example.com'));
    await value(driver.type('#email', 'second@example.com'));
    expect(await value(driver.evaluate('document.getElementById("email").value'))).toBe(
      'second@example.com',
    );
  });

  it('clears a field, which an empty insert could not', async () => {
    await value(driver.type('#email', ''));
    expect(await value(driver.evaluate('document.getElementById("email").value'))).toBe('');
  });

  it('types into a contenteditable as well as an input', async () => {
    await value(driver.type('#note', 'rewritten'));
    expect(await value(driver.evaluate('document.getElementById("note").textContent'))).toBe(
      'rewritten',
    );
  });

  it('clicks where a person would click', async () => {
    await value(driver.type('#email', 'clicked@example.com'));
    await value(driver.click('#save'));
    expect(await value(driver.evaluate('document.getElementById("result").textContent'))).toBe(
      'saved clicked@example.com',
    );
  });

  it('refuses a selector that matches nothing, in a sentence', async () => {
    expect(await refusal(driver.click('.absent'))).toBe('Nothing matches .absent on this page.');
  });

  it('refuses an element that is there but not visible', async () => {
    const said = await refusal(driver.click('#hidden'));
    expect(said).toContain('#hidden');
    expect(said.toLowerCase()).toMatch(/not visible|no box/u);
  });

  it('reports the console, including an error nobody caught', async () => {
    const fresh = browser.driver();
    await value(fresh.open(`${origin}/`));
    // The page logs on load; give the uncaught error its turn of the event
    // loop before asking.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lines = await value(fresh.console());
    const text = lines.map((one) => `${one.level} ${one.text}`).join('\n');
    expect(text).toContain('page is up');
    expect(text).toContain('a warning');
    // The level the embedded driver cannot produce, because Electron reports an
    // uncaught error as an ordinary `error` line.
    expect(lines.some((one) => one.level === 'exception' && one.text.includes('the page broke'))).toBe(
      true,
    );
    await fresh.close();
  });

  it('reports the requests the page made, and which of them failed', async () => {
    const fresh = browser.driver();
    await value(fresh.open(`${origin}/`));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const failed = await value(fresh.network({ failedOnly: true }));
    const urls = failed.map((one) => one.url);
    expect(urls.some((one) => one.endsWith('/api/missing'))).toBe(true);
    expect(urls.some((one) => one.includes('nothing-listening'))).toBe(true);

    const missing = failed.find((one) => one.url.endsWith('/api/missing'));
    expect(missing?.status).toBe(404);
    const refused = failed.find((one) => one.url.includes('nothing-listening'));
    // A connection nothing answered has no status at all — the distinction the
    // contract's optional `status` exists for.
    expect(refused?.status).toBeUndefined();
    expect(refused?.failure).toBeTruthy();
    await fresh.close();
  });

  it('answers what is new, so a second call after nothing is empty', async () => {
    await value(driver.console());
    expect(await value(driver.console())).toEqual([]);
  });

  it('reports the cookies the page would send, including the httpOnly one', async () => {
    await value(driver.navigate(`${origin}/`));
    const cookies = await value(driver.cookies());
    const names = cookies.map((one) => one.name);
    expect(names).toContain('visited');
    expect(names).toContain('session');
    const server = cookies.find((one) => one.name === 'session');
    // This browser is signed in to nothing, so a value here is test data the
    // agent or its application put there.
    expect(server?.value).toBe('server-side');
    expect(server?.httpOnly).toBe(true);
  });

  it('reads local and session storage for the origin', async () => {
    const stored = await value(driver.storage());
    expect(stored.origin).toBe(origin);
    expect(stored.local['token']).toBe('abc123');
    expect(stored.session['draft']).toBe('yes');
  });

  it('runs an expression and hands back a value JSON can hold', async () => {
    expect(await value(driver.evaluate('1 + 1'))).toBe(2);
    expect(await value(driver.evaluate('({ a: [1, 2] })'))).toEqual({ a: [1, 2] });
    expect(await value(driver.evaluate('Promise.resolve("awaited")'))).toBe('awaited');
  });

  it('says what the page threw rather than answering nothing', async () => {
    expect(await refusal(driver.evaluate('missingThing.go()'))).toContain('ReferenceError');
  });

  it('says so when a value cannot cross the protocol', async () => {
    // Chromium refuses these at the protocol level rather than answering with
    // something unserialisable, so what the agent gets is the browser's own
    // words — which name the shape better than anything written here would.
    expect(await refusal(driver.evaluate('Symbol("x")'))).toContain(
      "couldn't be returned by value",
    );
    expect(await refusal(driver.evaluate('(() => { const a = {}; a.self = a; return a; })()'))).toContain(
      'Object reference chain is too long',
    );
  });

  it('answers a DOM node as the empty object the protocol makes of it', async () => {
    // Not a refusal, and the measurement is why: under `returnByValue`
    // Chromium sends `{type: 'object', value: {}}` with no subtype, so there
    // is nothing here that could tell a node from an empty object. Inventing a
    // refusal would mean refusing `{}` as well.
    expect(await value(driver.evaluate('document.body'))).toEqual({});
  });

  it('gives its cookies and storage back when the run closes it', async () => {
    const one = browser.driver();
    await value(one.open(`${origin}/`));
    await value(one.evaluate('localStorage.setItem("mine", "1")'));
    await one.close();

    // A new run gets a new context: separate cookies and storage, so two
    // agents testing the same app never share a login.
    const two = browser.driver();
    await value(two.open(`${origin}/`));
    const stored = await value(two.storage());
    expect(stored.local['mine']).toBeUndefined();
    await two.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Where it may go                                                            */
/* -------------------------------------------------------------------------- */

when('the navigation policy against a real redirect', () => {
  let browser: ServerBrowser;

  beforeAll(() => {
    browser = build();
  });
  afterAll(async () => {
    await browser.dispose();
  });

  it('refuses an address outside the allow-list before opening anything', async () => {
    const said = await refusal(browser.driver().open(`http://localhost:${String(sitePort)}/`));
    expect(said).toContain('inside the operator’s own network');
  });

  it('catches a real 302 into a refused address and leaves the tab blank', async () => {
    const driver = browser.driver();
    await value(driver.open(`${origin}/`));
    const said = await refusal(driver.navigate(`${origin}/redirect`));
    expect(said).toContain('redirected to');
    expect(said).toContain('The tab is now blank.');
    // And it really is blank, rather than loaded with the agent merely told
    // not to look at it.
    const at = await value(driver.open());
    expect(at.url).toBe('about:blank');
    await driver.close();
  });

  it('refuses a cloud metadata address whatever the allow-list says', async () => {
    const allowing = createServerBrowser({
      endpoint: `http://127.0.0.1:${String(cdpPort)}`,
      timers,
      limits: { allowHosts: ['127.0.0.1', '169.254.169.254'] },
    });
    try {
      const said = await refusal(allowing.driver().open('http://169.254.169.254/latest/meta-data/'));
      expect(said).toContain('cloud metadata address');
    } finally {
      await allowing.dispose();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Nothing outlives its use, against a browser that really holds memory       */
/* -------------------------------------------------------------------------- */

when('the lifecycle rules against a real Chromium', () => {
  /** What the browser has open, asked of its own HTTP endpoint. */
  async function pageTargets(): Promise<{ id: string; url: string }[]> {
    const response = await fetch(`http://127.0.0.1:${String(cdpPort)}/json/list`);
    const list = (await response.json()) as { id: string; url: string; type: string }[];
    return list.filter((one) => one.type === 'page').map(({ id, url }) => ({ id, url }));
  }

  it('closes every target it does not own when it connects', async () => {
    // A tab a crashed predecessor left behind, made through the browser's own
    // HTTP endpoint so that nothing in this server ever knew about it.
    const made = await fetch(`http://127.0.0.1:${String(cdpPort)}/json/new?about:blank`, {
      method: 'PUT',
    });
    expect(made.ok).toBe(true);
    expect((await pageTargets()).length).toBeGreaterThan(0);

    const browser = build();
    try {
      const driver = browser.driver();
      await value(driver.open(`${origin}/`));
      const open = await pageTargets();
      expect(open).toHaveLength(1);
      expect(open[0]?.url).toBe(`${origin}/`);
    } finally {
      await browser.dispose();
    }
  }, 30_000);

  it('closes a tab nobody has used, and tells the run why', async () => {
    const browser = build({ idleMinutes: 10 });
    try {
      const driver = browser.driver();
      await value(driver.open(`${origin}/`));
      timers.advanceMinutes(11);
      await browser.maintain();

      expect(await pageTargets()).toHaveLength(0);
      const said = await refusal(driver.read());
      expect(said).toContain('closed after 10 minutes');
      // And the remedy works without repeating the notice.
      expect((await driver.open(`${origin}/`)).ok).toBe(true);
      await driver.close();
    } finally {
      await browser.dispose();
    }
  }, 30_000);

  it('refuses a third conversation rather than opening a third context', async () => {
    const browser = build({ maxContexts: 2 });
    try {
      const first = browser.driver();
      const second = browser.driver();
      await value(first.open(`${origin}/`));
      await value(second.open(`${origin}/`));
      const said = await refusal(browser.driver().open(`${origin}/`));
      expect(said).toContain('already open for 2 other conversations');
      expect(await pageTargets()).toHaveLength(2);
    } finally {
      await browser.dispose();
    }
  }, 30_000);

  it('closes a tab that grew past the ceiling, and says how much it held', async () => {
    // Ten megabytes is under what a page holds the moment it allocates
    // anything real, and far above the two or so a blank page starts at — so
    // the tab is closed for having grown rather than for existing.
    const browser = build({ tabMemoryMb: 10 });
    try {
      const driver = browser.driver();
      await value(driver.open(`${origin}/`));
      // Untouched, the page is under the ceiling.
      await browser.maintain();
      expect(await pageTargets()).toHaveLength(1);

      await value(driver.evaluate('(() => { window.big = new Array(5e6).fill(1); return window.big.length; })()'));
      await browser.maintain();

      expect(await pageTargets()).toHaveLength(0);
      const said = await refusal(driver.read());
      expect(said).toContain('past the 10 MB');
      expect(said).toContain('browser_open starts a new one');
    } finally {
      await browser.dispose();
    }
  }, 30_000);

  it('leaves the browser running when it shuts down, and takes its own tabs with it', async () => {
    const browser = build();
    const driver = browser.driver();
    await value(driver.open(`${origin}/`));
    await browser.dispose();

    expect(await pageTargets()).toHaveLength(0);
    // A server shutting down is not a reason to end a browser the container's
    // own lifecycle governs — and the next test in this file needs it alive.
    const response = await fetch(`http://127.0.0.1:${String(cdpPort)}/json/version`);
    expect(response.ok).toBe(true);
  }, 30_000);
});
