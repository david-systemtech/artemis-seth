/**
 * The browser tools, against a browser that is only a record of what was asked.
 *
 * The tools used to be inseparable from Electron, so the only way to pin what
 * they decide was to fake a `webContents`. They are now written against
 * {@link PageDriver}, which means the interesting things can be asserted
 * directly:
 *
 *  - **A refusal is the driver's sentence, unedited.** Whatever a driver says
 *    no with — a selector that matched nothing, a blocked site, a tab closed
 *    for being idle — reaches the model as written, marked as an error and not
 *    thrown. Nothing here paraphrases a driver.
 *  - **What is offered is what the driver can do.** `abilities` decides which
 *    tools exist at all, because a tool registered in order to refuse spends
 *    context teaching a model a verb it must not use.
 *  - **The wording says whose browser it is.** Three browsers now answer to one
 *    tool name, and a model that thinks the user's Chrome is a sandbox will
 *    treat their signed-in session as one.
 *  - **Nothing is unbounded.** A page can produce arbitrarily much of anything,
 *    and a tool result that eats the context is a tool result the agent cannot
 *    act on.
 */

import { describe, expect, it } from 'vitest';

import type {
  BrowserDriverKind,
  ConsoleEntry,
  CookieEntry,
  DriverResult,
  NetworkEntry,
  PageDriver,
  PageDriverAbilities,
  PageLocation,
} from '@rx-artemis/protocol';

import { pageToolInstructions, pageTools } from './pageTools.js';

const AT: PageLocation = { url: 'https://example.com/orders', title: 'Orders' };

const NOTHING: PageDriverAbilities = {
  console: false,
  network: false,
  cookies: false,
  storage: false,
  evaluate: false,
};

const EVERYTHING: PageDriverAbilities = {
  console: true,
  network: true,
  cookies: true,
  storage: true,
  evaluate: true,
};

function yes<T>(value: T): Promise<DriverResult<T>> {
  return Promise.resolve({ ok: true, value });
}

function nope<T>(reason: string): Promise<DriverResult<T>> {
  return Promise.resolve({ ok: false, reason });
}

/** A driver that answers, and remembers what it was asked. */
function fakeDriver(over: Partial<PageDriver> = {}): PageDriver {
  return {
    kind: 'embedded',
    abilities: NOTHING,
    open: async () => yes(AT),
    navigate: async () => yes(AT),
    read: async () => yes({ ...AT, text: 'the page text', truncated: false }),
    screenshot: async () => yes({ mimeType: 'image/png' as const, data: 'aGk=' }),
    click: async () => yes(AT),
    type: async () => yes(AT),
    console: async () => yes<readonly ConsoleEntry[]>([]),
    network: async () => yes<readonly NetworkEntry[]>([]),
    cookies: async () => yes<readonly CookieEntry[]>([]),
    storage: async () => yes({ origin: 'https://example.com', local: {}, session: {} }),
    evaluate: async () => yes<unknown>(null),
    close: async () => undefined,
    ...over,
  };
}

interface ToolResult {
  readonly isError?: true;
  readonly content: { readonly type: string; readonly text?: string; readonly data?: string }[];
}

/** One tool's handler, by name, straight off the definitions. */
function handlerFor(driver: PageDriver, name: string): (args: never) => Promise<ToolResult> {
  const found = pageTools(driver).find((one) => one.name === name);
  if (found === undefined) throw new Error(`No tool named ${name}`);
  return found.handler as unknown as (args: never) => Promise<ToolResult>;
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

async function call(driver: PageDriver, name: string, args: unknown = {}): Promise<ToolResult> {
  return handlerFor(driver, name)(args as never);
}

function namesOf(kind: BrowserDriverKind, abilities: PageDriverAbilities): string[] {
  return pageTools(fakeDriver({ kind, abilities })).map((one) => one.name);
}

/* -------------------------------------------------------------------------- */
/* The six verbs a person could perform                                       */
/* -------------------------------------------------------------------------- */

describe('the six verbs report what happened', () => {
  it('says where the browser ended up after an open, by title and address', async () => {
    const result = await call(fakeDriver(), 'browser_open', { url: 'https://example.com/orders' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('Browser open at Orders (https://example.com/orders).');
  });

  it('falls back to “an unknown page” when the tab went before it could be described', async () => {
    // A driver answers `{ url: '', title: '' }` for a tab that closed between
    // the action and the report. Saying "Now at ." would read as a fault.
    const driver = fakeDriver({ navigate: async () => yes({ url: '', title: '' }) });
    expect(textOf(await call(driver, 'browser_navigate', { url: 'https://x.test' }))).toBe(
      'Now at an unknown page.',
    );
  });

  it('captions a page’s text with where the text came from', async () => {
    const text = textOf(await call(fakeDriver(), 'browser_read'));
    expect(text).toContain('Orders (https://example.com/orders)');
    expect(text).toContain('the page text');
  });

  it('says a page has no readable text rather than handing back a caption and a blank', async () => {
    const driver = fakeDriver({ read: async () => yes({ ...AT, text: '  \n ', truncated: false }) });
    expect(textOf(await call(driver, 'browser_read'))).toBe(
      'Orders (https://example.com/orders) has no readable text (it may still be rendering).',
    );
  });

  it('hands a screenshot back as an image block, not as text about an image', async () => {
    const result = await call(fakeDriver(), 'browser_screenshot');
    expect(result.content[0]).toEqual({ type: 'image', data: 'aGk=', mimeType: 'image/png' });
  });

  it('names the selector it clicked and where that left the page', async () => {
    expect(textOf(await call(fakeDriver(), 'browser_click', { selector: '#save' }))).toBe(
      'Clicked #save. Now at Orders (https://example.com/orders).',
    );
  });

  it('names the selector it typed into and where that left the page', async () => {
    // A framework may submit on the value it just received, so the address is
    // reported as it is for a click, and a page that moved is not read on.
    expect(textOf(await call(fakeDriver(), 'browser_type', { selector: '#q', text: 'hi' }))).toBe(
      'Typed into #q. Now at Orders (https://example.com/orders).',
    );
  });
});

describe('a refusal is the driver’s own sentence', () => {
  const REASONS: readonly [string, string, unknown][] = [
    ['browser_open', '“file:///etc/passwd” is not an http or https address.', { url: 'x' }],
    ['browser_navigate', 'bank.test is on the list of sites an agent does not open.', { url: 'x' }],
    ['browser_read', 'No browser is open for this conversation. Use browser_open first.', {}],
    ['browser_screenshot', 'The browser tab may be hidden — ask the user to bring it forward.', {}],
    ['browser_click', 'Nothing matches #missing on this page.', { selector: '#missing' }],
    ['browser_type', 'Nothing matches #missing on this page.', { selector: '#missing', text: 'x' }],
  ];

  for (const [name, reason, args] of REASONS) {
    it(`passes ${name}’s refusal through as an error result, word for word`, async () => {
      const verb = name.slice('browser_'.length) as keyof PageDriver;
      const driver = fakeDriver({ [verb]: async () => nope(reason) });

      const result = await call(driver, name, args);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(reason);
    });
  }

  it('turns a driver that throws into an answer rather than letting it end the turn', async () => {
    // Drivers are contracted to resolve a result and not to throw. "Contracted
    // not to" is not a reason to let one take a turn down.
    const driver = fakeDriver({
      read: () => {
        throw new Error('the page process is gone');
      },
    });

    const result = await call(driver, 'browser_read');

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('the page process is gone');
  });
});

/* -------------------------------------------------------------------------- */
/* Nothing is unbounded                                                       */
/* -------------------------------------------------------------------------- */

describe('a tool result is bounded, and says where it was cut', () => {
  it('cuts a very long page at the budget and marks the cut', async () => {
    const driver = fakeDriver({
      read: async () => yes({ ...AT, text: 'x'.repeat(60_000), truncated: false }),
    });

    const text = textOf(await call(driver, 'browser_read'));

    expect(text).toContain('[truncated at 40000 characters]');
    expect(text.length).toBeLessThan(41_000);
  });

  it('says so when the browser had already cut the text before Artemis saw it', async () => {
    // A driver reading a page down a socket has its own reason to clip. A
    // partial page that does not say it is partial is the one a model treats
    // as the whole.
    const driver = fakeDriver({ read: async () => yes({ ...AT, text: 'short', truncated: true }) });
    expect(textOf(await call(driver, 'browser_read'))).toContain('[truncated by the browser]');
  });

  it('drops whole requests from a listing rather than half of one, and counts them', async () => {
    const many: NetworkEntry[] = Array.from({ length: 2_000 }, (_, index) => ({
      method: 'GET',
      url: `https://example.com/${String(index)}/${'p'.repeat(200)}`,
      status: 200,
      resourceType: 'xhr',
      at: 0,
    }));
    const driver = fakeDriver({ abilities: EVERYTHING, network: async () => yes(many) });

    const text = textOf(await call(driver, 'browser_network'));

    expect(text).toContain('2000 requests since the last check.');
    expect(text).toMatch(/\[\d+ more not shown: the rest would not fit\]/u);
    // Every line that survived is a whole line: the last one ends in a URL, not
    // in the middle of one.
    expect(text).not.toContain('/pppp\n\n[');
    expect(text.length).toBeLessThan(41_000);
  });

  it('cuts an evaluated value at the budget too', async () => {
    const driver = fakeDriver({
      abilities: EVERYTHING,
      evaluate: async () => yes<unknown>('y'.repeat(60_000)),
    });

    const text = textOf(await call(driver, 'browser_evaluate', { expression: 'x' }));

    expect(text).toContain('[truncated at 40000 characters]');
  });
});

/* -------------------------------------------------------------------------- */
/* The deep verbs, where a driver has them                                    */
/* -------------------------------------------------------------------------- */

describe('what the tools offer is what the driver said it can do', () => {
  const SIX = [
    'browser_open',
    'browser_navigate',
    'browser_read',
    'browser_screenshot',
    'browser_click',
    'browser_type',
  ];

  it('offers only the six page verbs to a driver that claims nothing', () => {
    expect(namesOf('embedded', NOTHING)).toEqual(SIX);
  });

  it('offers all eleven to a driver that claims everything', () => {
    expect(namesOf('server', EVERYTHING)).toEqual([
      ...SIX,
      'browser_console',
      'browser_network',
      'browser_cookies',
      'browser_storage',
      'browser_evaluate',
    ]);
  });

  it('offers each deep verb on its own ability and no other', () => {
    expect(namesOf('embedded', { ...NOTHING, console: true })).toEqual([...SIX, 'browser_console']);
    expect(namesOf('embedded', { ...NOTHING, network: true })).toEqual([...SIX, 'browser_network']);
    expect(namesOf('extension', { ...NOTHING, cookies: true })).toEqual([...SIX, 'browser_cookies']);
    expect(namesOf('extension', { ...NOTHING, storage: true })).toEqual([...SIX, 'browser_storage']);
    expect(namesOf('server', { ...NOTHING, evaluate: true })).toEqual([...SIX, 'browser_evaluate']);
  });

  it('offers the dock browser console and network, and none of the three it declines', () => {
    // The shape the embedded driver actually claims: looking over the user's
    // shoulder, yes; reading the session they are signed in with, no.
    const dock = namesOf('embedded', {
      console: true,
      network: true,
      cookies: false,
      storage: false,
      evaluate: false,
    });
    expect(dock).toEqual([...SIX, 'browser_console', 'browser_network']);
  });
});

describe('the console reads as a log', () => {
  const ENTRIES: ConsoleEntry[] = [
    { level: 'error', text: 'Uncaught TypeError: x is not a function', source: 'app.js:14', at: 1_700_000_000_000 },
    { level: 'warn', text: 'slow', at: 1_700_000_000_500 },
  ];

  it('gives each message a time, a level and its source', async () => {
    const driver = fakeDriver({ abilities: EVERYTHING, console: async () => yes(ENTRIES) });

    const text = textOf(await call(driver, 'browser_console'));

    expect(text).toContain('2 console messages since the last check.');
    expect(text).toContain('error');
    expect(text).toContain('Uncaught TypeError: x is not a function');
    expect(text).toContain('(app.js:14)');
    // Levels are padded to one width so the column can be read down.
    expect(text).toContain('warn ');
  });

  it('says nothing was logged rather than showing an empty list', async () => {
    const driver = fakeDriver({ abilities: EVERYTHING });
    expect(textOf(await call(driver, 'browser_console'))).toBe(
      'No console messages since the last check.',
    );
  });

  it('keeps a stack trace whole by indenting its continuations', async () => {
    const driver = fakeDriver({
      abilities: EVERYTHING,
      console: async () => yes([{ level: 'error' as const, text: 'boom\n  at f\n  at g', at: 0 }]),
    });

    expect(textOf(await call(driver, 'browser_console'))).toContain('boom\n        at f');
  });
});

describe('the network log reads as a table', () => {
  const ENTRIES: NetworkEntry[] = [
    { method: 'GET', url: 'https://example.com/', status: 200, resourceType: 'mainFrame', durationMs: 118, at: 0 },
    { method: 'POST', url: 'https://example.com/api/orders', status: 500, resourceType: 'xhr', durationMs: 42, at: 1 },
    { method: 'GET', url: 'https://cdn.test/a.js', resourceType: 'script', failure: 'net::ERR_ABORTED', at: 2 },
  ];

  it('lines up status, method, type and duration against the address', async () => {
    const driver = fakeDriver({ abilities: EVERYTHING, network: async () => yes(ENTRIES) });

    const text = textOf(await call(driver, 'browser_network'));

    expect(text).toContain('3 requests since the last check.');
    expect(text).toContain('200  GET   mainFrame  118ms  https://example.com/');
    expect(text).toContain('500  POST  xhr         42ms  https://example.com/api/orders');
    // A request that never answered has no status and no duration, and says
    // what went wrong instead.
    expect(text).toContain('  —  GET   script         —  https://cdn.test/a.js  net::ERR_ABORTED');
  });

  it('passes failedOnly to the driver and says that is what it asked for', async () => {
    const asked: unknown[] = [];
    const driver = fakeDriver({
      abilities: EVERYTHING,
      network: async (options) => {
        asked.push(options);
        return yes([ENTRIES[2] as NetworkEntry]);
      },
    });

    const text = textOf(await call(driver, 'browser_network', { failedOnly: true }));

    expect(asked).toEqual([{ failedOnly: true }]);
    expect(text).toContain('1 failed request since the last check.');
  });

  it('distinguishes “nothing failed” from “nothing happened”', async () => {
    const driver = fakeDriver({ abilities: EVERYTHING });
    expect(textOf(await call(driver, 'browser_network'))).toBe(
      'No requests since the last check.',
    );
    expect(textOf(await call(driver, 'browser_network', { failedOnly: true }))).toBe(
      'No failed requests since the last check.',
    );
  });
});

describe('cookies and storage read as a developer would want them', () => {
  it('shows each cookie’s attributes, and its value where the policy allowed one', async () => {
    const driver = fakeDriver({
      abilities: EVERYTHING,
      cookies: async () =>
        yes<readonly CookieEntry[]>([
          {
            name: 'session',
            value: 'abc',
            domain: '.example.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
          { name: 'theme', value: 'dark', domain: 'example.com', path: '/', httpOnly: false, secure: false },
        ]),
    });

    const text = textOf(await call(driver, 'browser_cookies'));

    expect(text).toContain('2 cookies the current page would send.');
    expect(text).toContain('session  .example.com/  httpOnly secure SameSite=Lax  = abc');
    expect(text).toContain('theme    example.com/  session cookie  = dark');
  });

  it('says once, at the top, that values were withheld on this site', async () => {
    // Per line it would be four words repeated twenty times; whether values are
    // readable is the site's standing, not the cookie's.
    const driver = fakeDriver({
      abilities: EVERYTHING,
      cookies: async () =>
        yes<readonly CookieEntry[]>([
          { name: 'session', domain: '.bank.test', path: '/', httpOnly: true, secure: true },
        ]),
    });

    const text = textOf(await call(driver, 'browser_cookies'));

    expect(text).toContain('Values are not shown on this site: names and attributes only.');
    expect(text).not.toContain(' = ');
  });

  it('separates the two storages and says which is empty', async () => {
    const driver = fakeDriver({
      abilities: EVERYTHING,
      storage: async () =>
        yes({
          origin: 'https://example.com',
          local: { token: 'eyJ', theme: 'dark' },
          session: {},
        }),
    });

    const text = textOf(await call(driver, 'browser_storage'));

    expect(text).toContain('Storage for https://example.com');
    expect(text).toContain('localStorage — 2 keys');
    expect(text).toContain('  token = eyJ');
    expect(text).toContain('sessionStorage — empty');
  });
});

describe('an evaluated value comes back readable', () => {
  it('pretty-prints an object rather than handing over one long line', async () => {
    const driver = fakeDriver({
      abilities: EVERYTHING,
      evaluate: async () => yes<unknown>({ ok: true, items: [1, 2] }),
    });

    expect(textOf(await call(driver, 'browser_evaluate', { expression: 'x' }))).toBe(
      '{\n  "ok": true,\n  "items": [\n    1,\n    2\n  ]\n}',
    );
  });

  it('answers “undefined” rather than nothing, which would read as success with no result', async () => {
    const driver = fakeDriver({ abilities: EVERYTHING, evaluate: async () => yes<unknown>(undefined) });
    expect(textOf(await call(driver, 'browser_evaluate', { expression: 'x' }))).toBe('undefined');
  });

  it('describes a value JSON cannot hold instead of failing on it', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const driver = fakeDriver({ abilities: EVERYTHING, evaluate: async () => yes<unknown>(circular) });

    const result = await call(driver, 'browser_evaluate', { expression: 'x' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('[object Object]');
  });
});

/* -------------------------------------------------------------------------- */
/* Whose browser this is                                                      */
/* -------------------------------------------------------------------------- */

/*
 * The anti-hallucination copy is load-bearing. An agent once told a user a page
 * was open "in your Chrome" after driving the embedded dock tab, which from
 * inside the run looked like a browser like any other. With three browsers
 * answering to one tool name the claim has to be made three times, and it is a
 * different claim each time.
 */
describe('the wording says which browser these tools are driving', () => {
  function describeOf(kind: BrowserDriverKind, name: string): string {
    const found = pageTools(fakeDriver({ kind, abilities: EVERYTHING })).find(
      (one) => one.name === name,
    );
    if (found === undefined) throw new Error(`No tool named ${name}`);
    return found.description;
  }

  it('tells the dock browser’s model the tab is not the user’s browser', () => {
    expect(describeOf('embedded', 'browser_open')).toContain('not their own browser');
    expect(describeOf('embedded', 'browser_navigate')).toContain('embedded dock browser');
    expect(pageToolInstructions('embedded')).toContain('NOT the user’s');
    expect(pageToolInstructions('embedded')).toContain(
      'Never tell the user a page was opened in their browser',
    );
  });

  it('keeps the dock browser’s remedies scoped to where they actually work', () => {
    // A Codex or server-session user sent to "Browse with your Chrome" is sent
    // to a toggle that cannot help them.
    const instructions = pageToolInstructions('embedded');
    expect(instructions).toContain('Permissions & access');
    expect(instructions).toContain('Claude sessions running on this machine');
    expect(instructions).toContain('does not apply to other providers');
  });

  it('tells the server browser’s model that nobody is watching and it is signed in to nothing', () => {
    expect(describeOf('server', 'browser_open')).toContain('headless browser');
    expect(describeOf('server', 'browser_navigate')).toContain('headless browser');
    expect(describeOf('server', 'browser_screenshot')).toContain('Nobody can see this browser');
    const instructions = pageToolInstructions('server');
    expect(instructions).toContain('signed in ');
    expect(instructions).toContain('to nothing');
    expect(instructions).toContain('Never tell the user a page was opened in their browser');
  });

  it('tells the extension’s model it is acting as the user, inside a tab group of Artemis’s', () => {
    expect(describeOf('extension', 'browser_open')).toContain('user’s own Chrome');
    expect(describeOf('extension', 'browser_open')).toContain('tab group');
    expect(describeOf('extension', 'browser_navigate')).toContain('user’s own Chrome');
    const instructions = pageToolInstructions('extension');
    expect(instructions).toContain('their real ');
    expect(instructions).toContain('anything you do here is done as them');
    expect(instructions).toContain('cannot reach any other tab');
  });

  it('states the deep verbs’ rule per browser, because it is not one rule', () => {
    /*
     * These three descriptions used to be written once, for every driver, and
     * what they said was the *extension's* rule — "allowed only on the sites
     * the user is developing", "values are shown only where the site's policy
     * allows them". On the server browser that is simply untrue: it is signed
     * in to nothing and has no per-site anything. A model told a false rule
     * either works around a refusal it will never meet, or declines a call
     * that would have worked.
     */
    expect(describeOf('server', 'browser_evaluate')).toContain('signed in to nothing');
    expect(describeOf('server', 'browser_evaluate')).toContain('any page it can open');
    expect(describeOf('server', 'browser_evaluate')).not.toContain('sites the user is developing');

    for (const verb of ['browser_cookies', 'browser_storage'] as const) {
      expect(describeOf('server', verb)).toContain('signed in to nothing');
      expect(describeOf('server', verb)).not.toContain('policy');
    }
  });

  it('keeps the dev-sites rule where it is true, and says who can widen it', () => {
    expect(describeOf('extension', 'browser_evaluate')).toContain(
      'sites the user is developing',
    );
    expect(describeOf('extension', 'browser_evaluate')).toContain('Artemis settings');
    expect(describeOf('extension', 'browser_cookies')).toContain('user’s own browser');
    expect(describeOf('extension', 'browser_cookies')).toContain('Artemis settings');
    expect(describeOf('extension', 'browser_storage')).toContain('Artemis settings');
  });

  it('never describes one browser in another’s words', () => {
    expect(pageToolInstructions('server')).not.toContain('dock');
    expect(pageToolInstructions('extension')).not.toContain('dock');
    expect(describeOf('server', 'browser_open')).not.toContain('dock');
    expect(describeOf('extension', 'browser_open')).not.toContain('dock');
  });

  it('tells every browser’s model to read before it screenshots', () => {
    for (const kind of ['embedded', 'server', 'extension'] as const) {
      expect(pageToolInstructions(kind)).toContain('Prefer browser_read over browser_screenshot');
    }
  });
});
