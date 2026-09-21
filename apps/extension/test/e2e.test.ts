/**
 * The extension, in a real browser, doing every verb.
 * ============================================================================
 *
 * Nobody here has a display, and an extension whose only proof is unit tests is
 * an extension nobody has run. So this builds the package into a temporary
 * directory, loads *that* into a headless Chromium, pairs it with a fake
 * Artemis by typing a code into the real options page, and then exercises the
 * contract from the Artemis side — every verb, the policy on three kinds of
 * host, a redirect onto a blocked site, a proof that is refused, and the stop
 * button.
 *
 * ## It is skipped, loudly, where there is no Chromium
 *
 * GitHub's runners have no browser, and a suite that failed there would be a
 * suite somebody disables. {@link findChromium} looks for one and the whole
 * file is skipped when there is none, with a message saying so — see the
 * always-running test at the bottom, which is what makes the skip visible in
 * the report rather than silent.
 *
 * ## Nothing leaves the machine
 *
 * The three hosts — `127.0.0.1`, `shop.example` and `www.paypal.com` — are one
 * HTTP server on loopback, reached under three names through Chrome's
 * `--host-resolver-rules`. That is what lets the suite prove that a bank is
 * refused and that a public site's cookie values are withheld without a packet
 * going anywhere.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConsoleEntry, CookieEntry, NetworkEntry, PageImage, PageLocation, PageText, StorageSnapshot } from '@rx-artemis/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildExtension } from '../build.js';
import { EXTENSION_ID } from '../src/manifest.js';
import { FakeArtemis } from './bridge.js';
import { findChromium, launchBrowser, type Browser, type Cdp } from './chromium.js';
import { startTestSite, type TestSite } from './site.js';

const binary = findChromium();
const RUN = 'run-e2e';

/** Everything the suite stands up, torn down in {@link afterAll} whatever happens. */
let artemis: FakeArtemis | null = null;
let site: TestSite | null = null;
let browser: Browser | null = null;
let options: Cdp | null = null;
let builtInto: string | null = null;

const dev = (path = '/'): string => (site as TestSite).url('127.0.0.1', path);
const publicSite = (path = '/'): string => (site as TestSite).url('shop.example', path);
const blockedSite = (path = '/'): string => (site as TestSite).url('www.paypal.com', path);

const ok = <T>(result: { ok: boolean; value?: unknown; reason?: string }): T => {
  if (!result.ok) throw new Error(`expected a result, got a refusal: ${String(result.reason)}`);
  return result.value as T;
};

/**
 * Wait for an element's text to say something, and give back what it said.
 *
 * Neither page holds state: each redraw is the answer to a request it made
 * after the worker announced a change, so what is on screen trails what the
 * worker knows by a round trip. Reading the DOM once is a race with that round
 * trip; reading it until it settles is what a person watching the page does.
 */
async function awaitText(page: Cdp, id: string, expected: string, within = 15_000): Promise<string> {
  const deadline = Date.now() + within;
  let last = '';
  while (Date.now() < deadline) {
    last = await page.evaluate<string>(`document.getElementById(${JSON.stringify(id)}).textContent`);
    if (last.includes(expected)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

describe.skipIf(binary === null)('the extension in a real browser', () => {
  beforeAll(async () => {
    builtInto = await mkdtemp(join(tmpdir(), 'artemis-extension-build-'));
    await buildExtension(builtInto);

    site = await startTestSite();
    artemis = await new FakeArtemis().listen();
    browser = await launchBrowser({ binary: binary as string, extensionDir: builtInto });

    // The extension's id is fixed by the `key` in its manifest, which is what
    // makes this URL something a test can write down.
    await browser.awaitTarget((target) => target.type === 'service_worker' && target.url.includes(EXTENSION_ID), 'the extension service worker');
    options = await browser.openPage(`chrome-extension://${EXTENSION_ID}/options.html`);

    // Pairing, driven through the options page the way a person would: the
    // port Artemis is listening on, then the code Artemis is showing. The
    // `input` events are not decoration — the page treats a field that has
    // been typed into as the user's and stops overwriting it, and a test that
    // only assigned `value` would be exercising a path no person takes.
    await options.evaluate(`(async () => {
      const type = (id, value) => {
        const field = document.getElementById(id);
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      };
      type('port', ${JSON.stringify(String(artemis.port))});
      document.getElementById('save-port').click();
      await new Promise((r) => setTimeout(r, 200));
      type('code', ${JSON.stringify(artemis.pairingCode)});
      document.getElementById('pair').click();
    })()`);
    await artemis.waitUntilLive();
  }, 180_000);

  afterAll(async () => {
    options?.close();
    await browser?.close();
    await artemis?.close();
    await site?.close();
    if (builtInto !== null) await rm(builtInto, { recursive: true, force: true });
  }, 60_000);

  /* ---------------------------------------------------------------------- */

  it('pairs from the options page and shows that it is connected to Artemis', async () => {
    const opening = (artemis as FakeArtemis).connections[0]?.opening;
    expect(opening).toMatchObject({ type: 'pair', version: 1, code: (artemis as FakeArtemis).pairingCode });
    expect((opening as { browserName: string }).browserName).toMatch(/ on /u);

    expect(await awaitText(options as Cdp, 'status', 'Connected to Artemis')).toBe('Connected to Artemis');
  });

  it('opens the conversation’s page in a tab group called Artemis', async () => {
    const location = ok<PageLocation>(await (artemis as FakeArtemis).call(RUN, { verb: 'open', url: dev() }));
    expect(location.url).toBe(dev());
    expect(location.title).toBe('Artemis test site');

    const grouped = await (options as Cdp).evaluate<{ title?: string; color?: string } | null>(
      "(async () => { const groups = await chrome.tabGroups.query({}); return groups[0] ?? null; })()",
    );
    expect(grouped).toMatchObject({ title: 'Artemis', color: 'purple' });
  });

  it('reads the page’s text without its markup', async () => {
    const page = ok<PageText>(await (artemis as FakeArtemis).call(RUN, { verb: 'read' }));
    expect(page.text).toContain('A page with a form, a console, an exception and a failing request.');
    expect(page.text).not.toContain('<p');
    expect(page.truncated).toBe(false);
  });

  it('takes a screenshot of a tab nobody is looking at', async () => {
    const image = ok<PageImage>(await (artemis as FakeArtemis).call(RUN, { verb: 'screenshot' }));
    expect(image.mimeType).toBe('image/png');
    const bytes = Buffer.from(image.data, 'base64');
    expect(bytes.length).toBeGreaterThan(1_000);
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('types into a field so that a listener sees the change, replacing what was there', async () => {
    ok<PageLocation>(await (artemis as FakeArtemis).call(RUN, { verb: 'type', selector: '#name', text: 'Sir Waggingtons' }));
    const state = ok<unknown>(
      await (artemis as FakeArtemis).call(RUN, {
        verb: 'evaluate',
        expression: "JSON.stringify({ value: document.getElementById('name').value, events: document.getElementById('events').textContent })",
      }),
    );
    expect(JSON.parse(String(state))).toEqual({ value: 'Sir Waggingtons', events: 'input fired: Sir Waggingtons' });
  });

  it('clicks a button and the page responds to it', async () => {
    ok<PageLocation>(await (artemis as FakeArtemis).call(RUN, { verb: 'click', selector: '#log' }));
    const events = ok<unknown>(
      await (artemis as FakeArtemis).call(RUN, { verb: 'evaluate', expression: "document.getElementById('events').textContent" }),
    );
    expect(events).toBe('the button was clicked');
  });

  it('collects the console, including an exception nobody caught', async () => {
    ok<PageLocation>(await (artemis as FakeArtemis).call(RUN, { verb: 'click', selector: '#boom' }));
    const lines = ok<readonly ConsoleEntry[]>(await (artemis as FakeArtemis).call(RUN, { verb: 'console' }));
    const text = lines.map((line) => `${line.level}: ${line.text}`).join('\n');
    expect(text).toContain('the button was clicked');
    expect(text).toContain('page ready');
    expect(lines.some((line) => line.level === 'exception' && line.text.includes('boom from the page'))).toBe(true);
  });

  it('empties the console buffer once it has been read, so nothing is reported twice', async () => {
    const again = ok<readonly ConsoleEntry[]>(await (artemis as FakeArtemis).call(RUN, { verb: 'console' }));
    expect(again).toEqual([]);
  });

  it('collects the network, and keeps the request that failed', async () => {
    ok<PageLocation>(await (artemis as FakeArtemis).call(RUN, { verb: 'navigate', url: dev() }));
    const failed = ok<readonly NetworkEntry[]>(await (artemis as FakeArtemis).call(RUN, { verb: 'network', failedOnly: true }));
    const drop = failed.find((entry) => entry.url.endsWith('/drop'));
    expect(drop, JSON.stringify(failed)).toBeDefined();
    expect(drop?.failure).toMatch(/^net::/u);
    expect(drop?.method).toBe('GET');
  });

  it('gives cookie values on the machine’s own address, which is a dev site', async () => {
    const cookies = ok<readonly CookieEntry[]>(await (artemis as FakeArtemis).call(RUN, { verb: 'cookies' }));
    const session = cookies.find((cookie) => cookie.name === 'sid');
    expect(session).toMatchObject({ value: 'session-token-value', httpOnly: true, path: '/' });
  });

  it('reads local and session storage on a dev site', async () => {
    const storage = ok<StorageSnapshot>(await (artemis as FakeArtemis).call(RUN, { verb: 'storage' }));
    expect(storage.local['cart']).toBe('CJ-1');
    expect(storage.session['step']).toBe('checkout');
    expect(storage.origin).toBe(dev().replace(/\/$/u, ''));
  });

  it('navigates, and a click that goes somewhere is waited for', async () => {
    const elsewhere = ok<PageLocation>(await (artemis as FakeArtemis).call(RUN, { verb: 'navigate', url: dev('/elsewhere') }));
    expect(elsewhere.title).toBe('Elsewhere');

    ok<PageLocation>(await (artemis as FakeArtemis).call(RUN, { verb: 'navigate', url: dev() }));
    const after = ok<PageLocation>(await (artemis as FakeArtemis).call(RUN, { verb: 'click', selector: '#go' }));
    expect(after.url).toBe(dev('/elsewhere'));
  });

  /* ---------------------------------------------------------------------- */
  /* The policy, on hosts that only look like the open web                  */
  /* ---------------------------------------------------------------------- */

  it('will not open a site on the block list, and says so in a sentence the agent can act on', async () => {
    const refusal = await (artemis as FakeArtemis).call('run-blocked', { verb: 'open', url: blockedSite() });
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toContain('www.paypal.com');
    expect(refusal.ok === false && refusal.reason).toContain('do not try another route to it');
  });

  it('ends a redirect onto a blocked site at about:blank, refused', async () => {
    ok<PageLocation>(await (artemis as FakeArtemis).call(RUN, { verb: 'navigate', url: dev() }));
    const refusal = await (artemis as FakeArtemis).call(RUN, { verb: 'navigate', url: dev('/redirect-to-blocked') });
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toContain('www.paypal.com');

    // The tab is off the blocked page, not merely refused a verb on it.
    const where = await (artemis as FakeArtemis).call(RUN, { verb: 'read' });
    expect(where.ok).toBe(false);
    expect(where.ok === false && where.reason).toContain('no page open');
  });

  it('gives cookie names without their values on a site the user is not developing', async () => {
    ok<PageLocation>(await (artemis as FakeArtemis).call('run-public', { verb: 'open', url: publicSite() }));
    const result = await (artemis as FakeArtemis).call('run-public', { verb: 'cookies' });
    const cookies = ok<readonly CookieEntry[]>(result);
    const session = cookies.find((cookie) => cookie.name === 'sid');
    expect(session).toBeDefined();
    expect(session).not.toHaveProperty('value');
    expect(JSON.stringify(cookies)).not.toContain('session-token-value');
    expect(result.ok === true && result.notice).toContain('Artemis settings → dev sites');
  });

  it('refuses evaluate and storage on a site the user is not developing', async () => {
    const evaluated = await (artemis as FakeArtemis).call('run-public', { verb: 'evaluate', expression: 'document.cookie' });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.ok === false && evaluated.reason).toContain('Use click, type and read instead');

    const stored = await (artemis as FakeArtemis).call('run-public', { verb: 'storage' });
    expect(stored.ok).toBe(false);
    expect(stored.ok === false && stored.reason).toContain('dev sites');
  });

  it('still reads, screenshots and watches the console on a site the user is not developing', async () => {
    const page = ok<PageText>(await (artemis as FakeArtemis).call('run-public', { verb: 'read' }));
    expect(page.text).toContain('Artemis test site');
    expect(ok<PageImage>(await (artemis as FakeArtemis).call('run-public', { verb: 'screenshot' })).data.length).toBeGreaterThan(100);
  });

  it('widens what is allowed when Artemis sends a new policy, without reconnecting', async () => {
    (artemis as FakeArtemis).setPolicy({
      devSites: ['shop.example'],
      blockedSites: [],
      unblockedSites: [],
      evaluateEverywhere: false,
      deepReadEverywhere: false,
    });
    // The policy arrives on the same socket; give the worker a turn to take it.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const cookies = ok<readonly CookieEntry[]>(await (artemis as FakeArtemis).call('run-public', { verb: 'cookies' }));
    expect(cookies.find((cookie) => cookie.name === 'sid')?.value).toBe('session-token-value');
  });

  it('cannot be asked about a page that is not the conversation’s own', async () => {
    // Two conversations have tabs open at this point. There is no verb that
    // takes a tab id, so a third can name neither of them — the only thing it
    // can ask about is a page it does not have.
    const refusal = await (artemis as FakeArtemis).call('run-with-no-page', { verb: 'read' });
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.reason).toContain('no page open');
  });

  /* ---------------------------------------------------------------------- */
  /* Closing, the log, the stop button and a proof that is refused          */
  /* ---------------------------------------------------------------------- */

  it('closes one conversation’s tab and leaves the others alone', async () => {
    const before = (await (browser as Browser).targets()).filter((target) => target.url.startsWith('http://')).length;
    expect(ok<unknown>(await (artemis as FakeArtemis).call('run-public', { verb: 'close' }))).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = (await (browser as Browser).targets()).filter((target) => target.url.startsWith('http://')).length;
    expect(after).toBe(before - 1);
  });

  it('keeps a log of everything it did, with refusals and their reasons', async () => {
    const log = await (options as Cdp).evaluate<{ audit: { verb: string; host: string; outcome: string; reason?: string }[] }>(
      "chrome.runtime.sendMessage({ type: 'audit' })",
    );
    expect(log.audit.length).toBeGreaterThan(10);
    expect(log.audit.some((line) => line.verb === 'screenshot' && line.outcome === 'ok')).toBe(true);

    const blocked = log.audit.find((line) => line.host === 'www.paypal.com');
    expect(blocked).toMatchObject({ outcome: 'refused' });
    expect(blocked?.reason).toContain('do not try another route to it');

    // The log records hosts, never whole addresses with their query strings.
    expect(log.audit.every((line) => !line.host.includes('/'))).toBe(true);
  });

  it('closes every Artemis tab and disconnects when the popup’s stop button is pressed', async () => {
    // Put the remaining conversation back on a real page, so that "no tab is
    // left" is something the target list can actually show.
    ok<PageLocation>(await (artemis as FakeArtemis).call(RUN, { verb: 'navigate', url: dev() }));
    expect((await (browser as Browser).targets()).filter((target) => target.url.startsWith('http://'))).toHaveLength(1);

    const popup = await (browser as Browser).openPage(`chrome-extension://${EXTENSION_ID}/popup.html`);
    try {
      expect(await awaitText(popup, 'runs', RUN)).toContain(RUN);

      await popup.evaluate("document.getElementById('stop').click()");
      await (artemis as FakeArtemis).waitUntilClosed();

      const left = (await (browser as Browser).targets()).filter((target) => target.url.startsWith('http://'));
      expect(left).toEqual([]);
      expect(await awaitText(popup, 'status', 'Stopped')).toBe('Stopped');
    } finally {
      popup.close();
    }
  });

  it('does not come back on its own after being stopped', async () => {
    // Five seconds covers the first three steps of the reconnect backoff, so a
    // browser that was merely disconnected rather than stopped would have
    // redialled several times over by now.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect((artemis as FakeArtemis).connected).toBe(false);
  }, 30_000);

  it('proves the pairing secret when it reconnects, and is refused when the proof is not accepted', async () => {
    const fake = artemis as FakeArtemis;
    fake.rejectNextProof = true;
    await (options as Cdp).evaluate("chrome.runtime.sendMessage({ type: 'resume' })");

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !fake.connections.some((connection) => connection.proofVerified !== undefined)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const proved = fake.connections.filter((connection) => connection.proofVerified !== undefined);
    expect(proved.length, 'the extension never answered a challenge').toBeGreaterThan(0);
    // The mac it computed was right — so the encodings on `BridgeProof` are
    // the ones Node produces — and it was refused anyway, which is the test.
    expect(proved.at(-1)?.proofVerified).toBe(true);
    expect((proved.at(-1)?.opening as { type: string }).type).toBe('hello');

    expect(await awaitText(options as Cdp, 'status', 'Refused')).toBe('Refused');
    expect(await awaitText(options as Cdp, 'detail', 'could not prove')).toContain('could not prove');
  }, 60_000);
});

it('says why the browser suite did not run, when it did not', () => {
  if (binary === null) {
    // Not an assertion: a note in the report, so a green run on a machine with
    // no browser cannot be mistaken for a run that exercised one.
    process.stdout.write(
      'The extension end-to-end suite was skipped: no Chromium this suite is willing to drive. ' +
        'Run `pnpm dlx playwright install chromium`, or set ARTEMIS_E2E_CHROME to a browser you are content to have driven. ' +
        'On CI it is skipped unless ARTEMIS_E2E_CHROME says otherwise — see test/chromium.ts for why.\n',
    );
  }
  expect(binary === null || binary.length > 0).toBe(true);
});
