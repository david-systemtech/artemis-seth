/**
 * The driver against a fake browser.
 *
 * The end-to-end suite drives a real Chromium and is the proof that the verbs
 * work. What is here is the part that a real browser makes *hard* to prove: the
 * page that moves somewhere blocked between one verb and the next. Arranging
 * that in Chrome takes a redirect and a race; arranging it here is one line, so
 * the rule that matters most gets the test that is easiest to trust.
 */

import { DEFAULT_PAGE_POLICY, type BridgeCall, type CookieEntry, type PagePolicy } from '@rx-artemis/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { PageRunner } from './driver.js';
import type { PageEvent, PageHost } from './host.js';

/** A browser that answers CDP from a script, and remembers what it was asked. */
class FakeBrowser implements PageHost {
  url = 'about:blank';
  title = '';
  nextTabId = 100;
  readonly opened: string[] = [];
  readonly closed: number[] = [];
  readonly detached: number[] = [];
  readonly grouped: { tabId: number; groupId: number | null }[] = [];
  readonly commands: { tabId: number; method: string; params?: Record<string, unknown> }[] = [];
  readonly answers = new Map<string, unknown>();
  #events: ((event: PageEvent) => void) | null = null;

  async openTab(url: string): Promise<number> {
    this.opened.push(url);
    this.url = url;
    return this.nextTabId++;
  }

  async closeTab(tabId: number): Promise<void> {
    this.closed.push(tabId);
  }

  async groupTab(tabId: number, groupId: number | null): Promise<number | null> {
    this.grouped.push({ tabId, groupId });
    return groupId ?? 7;
  }

  async attach(): Promise<void> {}

  async detach(tabId: number): Promise<void> {
    this.detached.push(tabId);
  }

  async send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ tabId, method, ...(params === undefined ? {} : { params }) });
    if (method === 'Target.getTargetInfo') return { targetInfo: { url: this.url, title: this.title } };
    if (method === 'Page.navigate') {
      this.url = String(params?.['url'] ?? '');
      // Report the load as finished, so nothing waits for a real browser.
      queueMicrotask(() => this.#events?.({ tabId, method: 'Page.loadEventFired', params: {} }));
      return { loaderId: 'loader-1' };
    }
    if (method === 'Runtime.evaluate') {
      const expression = String(params?.['expression'] ?? '');
      if (expression === 'document.readyState') return { result: { type: 'string', value: 'complete' } };
      for (const [needle, value] of this.answers) {
        if (expression.includes(needle)) return { result: { value } };
      }
      return { result: { type: 'undefined' } };
    }
    return this.answers.get(method) ?? {};
  }

  onEvent(listener: (event: PageEvent) => void): void {
    this.#events = listener;
  }
  onDetached(): void {}
  onTabClosed(): void {}

  /** Move the page without asking, which is what a redirect or a script does. */
  driftTo(url: string): void {
    this.url = url;
  }

  wentTo(url: string): boolean {
    return this.commands.some((command) => command.method === 'Page.navigate' && command.params?.['url'] === url);
  }
}

const call = (verb: BridgeCall['verb'], extra: Record<string, unknown> = {}, runKey = 'run-a'): BridgeCall =>
  ({ type: 'call', id: '1', runKey, verb, ...extra }) as BridgeCall;

const policy = (over: Partial<PagePolicy> = {}): PagePolicy => ({ ...DEFAULT_PAGE_POLICY, ...over });

let browser: FakeBrowser;
let runner: PageRunner;

beforeEach(() => {
  browser = new FakeBrowser();
  runner = new PageRunner({ host: browser, now: () => 1_000 });
  runner.policy = policy();
});

describe('before Artemis has said anything', () => {
  it('refuses every verb until a policy has arrived, because there is nothing to decide with', async () => {
    runner.policy = null;
    await expect(runner.run(call('open', { url: 'http://localhost:3000/' }))).resolves.toEqual({
      ok: false,
      reason: 'Artemis has not sent this browser a policy yet, so nothing may be run in it.',
    });
    expect(browser.opened).toEqual([]);
  });
});

describe('opening a page', () => {
  it('makes one tab for a conversation, puts it in the Artemis group, and reuses it', async () => {
    await runner.run(call('open', { url: 'http://localhost:3000/' }));
    // Created blank and then navigated, deliberately: see `#open`.
    expect(browser.opened).toEqual(['about:blank']);
    expect(browser.wentTo('http://localhost:3000/')).toBe(true);
    expect(browser.grouped).toEqual([{ tabId: 100, groupId: null }]);

    await runner.run(call('open', { url: 'http://localhost:3000/cart' }));
    expect(browser.opened).toHaveLength(1);
    expect(browser.wentTo('http://localhost:3000/cart')).toBe(true);
    expect(runner.book.size).toBe(1);
  });

  it('gives each conversation its own tab in the same group', async () => {
    await runner.run(call('open', { url: 'http://localhost:3000/' }, 'run-a'));
    await runner.run(call('open', { url: 'http://localhost:3000/' }, 'run-b'));
    expect(runner.book.tabFor('run-a')).not.toBe(runner.book.tabFor('run-b'));
    expect(browser.grouped.map((entry) => entry.groupId)).toEqual([null, 7]);
  });

  it('will not open a blocked site, and does not make a tab for it either', async () => {
    const result = await runner.run(call('open', { url: 'https://www.paypal.com/signin' }));
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain('do not try another route to it');
    expect(browser.opened).toEqual([]);
  });

  it('refuses an address that is not a web page', async () => {
    for (const url of ['chrome://settings', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(await runner.run(call('open', { url })), url).toMatchObject({ ok: false });
    }
    expect(browser.opened).toEqual([]);
  });
});

describe('a page that moves somewhere it may not be', () => {
  beforeEach(async () => {
    await runner.run(call('open', { url: 'http://localhost:3000/' }));
  });

  it('is sent to about:blank and the verb is refused with the reason', async () => {
    browser.driftTo('https://www.chase.com/accounts');
    const result = await runner.run(call('read'));
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain('www.chase.com');
    expect(browser.wentTo('about:blank')).toBe(true);
  });

  it('is checked again after a navigation, so a redirect onto a blocked site does not land', async () => {
    // The fake browser's `Page.navigate` puts the tab wherever it was told; the
    // drift afterwards is the 302 the server answered with.
    const navigation = runner.run(call('navigate', { url: 'http://localhost:3000/go' }));
    browser.driftTo('https://vault.bitwarden.com/');
    const result = await navigation;
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain('vault.bitwarden.com');
    expect(browser.wentTo('about:blank')).toBe(true);
  });

  it('is checked before every verb, not only after a load', async () => {
    for (const verb of ['read', 'screenshot', 'cookies', 'storage', 'click', 'type', 'console', 'network'] as const) {
      // Each verb gets its own drift, because the refusal before it left the
      // tab on about:blank — which is the point of the refusal.
      browser.driftTo('https://www.paypal.com/');
      expect(await runner.run(call(verb, { selector: '#a', text: 'x' })), verb).toMatchObject({ ok: false });
      expect(browser.url, verb).toBe('about:blank');
    }
  });

  it('answers console and network on a tab that has been sent home, because that is where the evidence is', async () => {
    browser.driftTo('https://www.paypal.com/');
    await runner.run(call('read'));
    await expect(runner.run(call('console'))).resolves.toMatchObject({ ok: true });
    await expect(runner.run(call('network'))).resolves.toMatchObject({ ok: true });
  });
});

describe('what may be read where', () => {
  it('gives cookie values on the machine’s own addresses', async () => {
    browser.answers.set('Network.getCookies', {
      cookies: [{ name: 'sid', value: 'secret', domain: 'localhost', path: '/', httpOnly: true, secure: false }],
    });
    await runner.run(call('open', { url: 'http://localhost:3000/' }));
    const result = await runner.run(call('cookies'));
    expect(result.ok && (result.value as CookieEntry[])[0]).toMatchObject({ name: 'sid', value: 'secret' });
    expect(result.ok && result.notice).toBeUndefined();
  });

  it('gives cookie names without values anywhere else, and says why', async () => {
    browser.answers.set('Network.getCookies', {
      cookies: [{ name: 'sid', value: 'secret', domain: 'shop.example', path: '/', httpOnly: true, secure: true }],
    });
    await runner.run(call('open', { url: 'https://shop.example/' }));
    const result = await runner.run(call('cookies'));
    expect(result.ok && (result.value as CookieEntry[])[0]).toEqual({ name: 'sid', domain: 'shop.example', path: '/', httpOnly: true, secure: true });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.ok && result.notice).toContain('Artemis settings → dev sites');
  });

  it('refuses storage and evaluate off a dev site, naming the setting that would change it', async () => {
    await runner.run(call('open', { url: 'https://shop.example/' }));
    const storage = await runner.run(call('storage'));
    const evaluate = await runner.run(call('evaluate', { expression: 'document.cookie' }));
    expect(storage.ok === false && storage.reason).toContain('dev sites');
    expect(evaluate.ok === false && evaluate.reason).toContain('Use click, type and read instead');
  });

  it('allows evaluate everywhere once the user has said so, and still not on a blocked site', async () => {
    runner.policy = policy({ evaluateEverywhere: true });
    browser.answers.set('1 + 1', 2);
    await runner.run(call('open', { url: 'https://shop.example/' }));
    await expect(runner.run(call('evaluate', { expression: '1 + 1' }))).resolves.toEqual({ ok: true, value: 2 });

    browser.driftTo('https://www.chase.com/');
    expect(await runner.run(call('evaluate', { expression: '1 + 1' }))).toMatchObject({ ok: false });
  });

  it('caps the page text and says that it did', async () => {
    browser.answers.set('body.innerText', { title: 'Long', text: 'x'.repeat(50_000) });
    await runner.run(call('open', { url: 'http://localhost:3000/' }));
    const result = await runner.run(call('read'));
    expect(result.ok && result.value).toMatchObject({ truncated: true });
    expect(result.ok && (result.value as { text: string }).text).toHaveLength(40_000);
  });
});

describe('a verb on a conversation with no page', () => {
  it('is refused with the verb named, rather than silently opening one', async () => {
    const result = await runner.run(call('read'));
    expect(result.ok === false && result.reason).toContain('nothing to read');
    expect(browser.opened).toEqual([]);
  });

  it('is an exception for navigate, which opens the page it was going to need', async () => {
    await expect(runner.run(call('navigate', { url: 'http://localhost:3000/' }))).resolves.toMatchObject({ ok: true });
    expect(browser.opened).toEqual(['about:blank']);
    expect(browser.wentTo('http://localhost:3000/')).toBe(true);
  });
});

describe('letting go', () => {
  it('closes a conversation’s tab and detaches the debugger from it', async () => {
    await runner.run(call('open', { url: 'http://localhost:3000/' }));
    await expect(runner.run(call('close'))).resolves.toEqual({ ok: true, value: null });
    expect(browser.detached).toEqual([100]);
    expect(browser.closed).toEqual([100]);
    expect(runner.book.size).toBe(0);
  });

  it('closes a conversation that never had a page without complaining', async () => {
    await expect(runner.run(call('close'))).resolves.toEqual({ ok: true, value: null });
  });

  it('closes every tab and forgets the group when Artemis is stopped', async () => {
    await runner.run(call('open', { url: 'http://localhost:3000/' }, 'run-a'));
    await runner.run(call('open', { url: 'http://localhost:3000/' }, 'run-b'));
    await runner.stopEverything();
    expect([...browser.closed].sort()).toEqual([100, 101]);
    expect(runner.book.size).toBe(0);
    expect(runner.book.groupId).toBeNull();
  });
});

describe('across a stopped service worker', () => {
  it('comes back knowing which tab is whose', async () => {
    await runner.run(call('open', { url: 'http://localhost:3000/' }));
    const snapshot = JSON.parse(JSON.stringify(runner.snapshot())) as ReturnType<PageRunner['snapshot']>;

    const revived = new PageRunner({ host: browser, now: () => 2_000 });
    revived.policy = policy();
    revived.restore(snapshot);
    expect(revived.book.tabFor('run-a')).toBe(100);

    await revived.run(call('open'));
    expect(browser.opened).toHaveLength(1);
  });
});
