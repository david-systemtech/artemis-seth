/**
 * The user's own Chrome as a driver: the verb mapping and the three refusals.
 *
 * Against a fake {@link ExtensionDriverHost} rather than a socket, for the
 * reason `browserTools.test.ts` states about Electron: what is under test here
 * is the decisions, and standing up a real WebSocket to assert that `read`
 * sends `{ verb: 'read' }` would test `ws`. The socket itself has its own
 * suite, in `extensionBridge.test.ts`, against a fake extension.
 *
 * Three things are worth pinning and they are all about what the model reads:
 *
 *  - **Every verb crosses as its own shape.** The contract's `BridgeVerb` is
 *    what the extension switches on, so a `network` that forgot `failedOnly`
 *    or a `type` that sent its text as `value` would be a tool that silently
 *    does the wrong thing in a browser full of the user's logins.
 *  - **Three failures, three sentences.** Unpaired, disconnected and timed out
 *    have different remedies, and the agent is the only party who will tell
 *    the user which one they are in.
 *  - **A refusal the extension wrote is passed through whole.** The browser is
 *    where the page policy is enforced, so its "no" is the authoritative one.
 */

import { describe, expect, it } from 'vitest';

import type { BridgeVerb, RunId } from '@rx-artemis/protocol';

import {
  extensionPageDriver,
  type BridgeCallOutcome,
  type ExtensionDriverHost,
  type PairedBrowserRef,
} from './extensionPageDriver';

const RUN = 'run-42' as RunId;

/** One call as the fake host saw it. */
interface Seen {
  readonly runKey: string;
  readonly id: string;
  readonly verb: BridgeVerb;
  readonly timeoutMs: number;
  readonly browserId: string | undefined;
}

/** Two paired browsers, both awake, which is the case the naming exists for. */
const WORK: PairedBrowserRef = { browserId: 'b-work', browserName: 'Work', connected: true };
const PERSONAL: PairedBrowserRef = {
  browserId: 'b-personal',
  browserName: 'Personal',
  connected: true,
};

function fakeHost(
  answer: BridgeCallOutcome,
  browsers: readonly PairedBrowserRef[] = [WORK],
): { host: ExtensionDriverHost; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    host: {
      call: async (runKey, id, verb, timeoutMs, browserId) => {
        seen.push({ runKey, id, verb, timeoutMs, browserId });
        return answer;
      },
      browsers: () => browsers,
    },
  };
}

/** A host that answers every verb with the same harmless value. */
function answering(): { host: ExtensionDriverHost; seen: Seen[] } {
  return fakeHost({ status: 'answered', result: { ok: true, value: { url: '', title: '' } } });
}

describe('every verb crosses as the shape the extension switches on', () => {
  it('sends open with no address when none was given', async () => {
    const { host, seen } = answering();

    await extensionPageDriver(RUN, host).open();

    expect(seen[0]?.verb).toEqual({ verb: 'open' });
  });

  it('sends open with the address when there is one', async () => {
    const { host, seen } = answering();

    await extensionPageDriver(RUN, host).open('https://example.com');

    expect(seen[0]?.verb).toEqual({ verb: 'open', url: 'https://example.com' });
  });

  it('sends navigate, click and type with their arguments', async () => {
    const { host, seen } = answering();
    const driver = extensionPageDriver(RUN, host);

    await driver.navigate('https://example.com/a');
    await driver.click('button[type="submit"]');
    await driver.type('#q', 'hello');

    expect(seen.map((one) => one.verb)).toEqual([
      { verb: 'navigate', url: 'https://example.com/a' },
      { verb: 'click', selector: 'button[type="submit"]' },
      { verb: 'type', selector: '#q', text: 'hello' },
    ]);
  });

  it('sends the plain verbs with nothing else on them', async () => {
    const { host, seen } = answering();
    const driver = extensionPageDriver(RUN, host);

    await driver.read();
    await driver.screenshot();
    await driver.console();
    await driver.cookies();
    await driver.storage();

    expect(seen.map((one) => one.verb)).toEqual([
      { verb: 'read' },
      { verb: 'screenshot' },
      { verb: 'console' },
      { verb: 'cookies' },
      { verb: 'storage' },
    ]);
  });

  it('spells the network filter out rather than leaving it absent', async () => {
    // Absent and `false` would mean the same thing to a careful extension and
    // different things to a careless one. Saying it removes the question.
    const { host, seen } = answering();
    const driver = extensionPageDriver(RUN, host);

    await driver.network();
    await driver.network({ failedOnly: true });

    expect(seen.map((one) => one.verb)).toEqual([
      { verb: 'network', failedOnly: false },
      { verb: 'network', failedOnly: true },
    ]);
  });

  it('sends the expression evaluate was asked for', async () => {
    const { host, seen } = answering();

    await extensionPageDriver(RUN, host).evaluate('document.title');

    expect(seen[0]?.verb).toEqual({ verb: 'evaluate', expression: 'document.title' });
  });

  it('closes the run’s tab, unlike the dock driver which only lets go', async () => {
    // A tab the extension opened lives in a tab group Artemis put there. The
    // dock's tab belongs to the user's own strip, which is why that driver
    // deliberately does not close.
    const { host, seen } = answering();

    await extensionPageDriver(RUN, host).close();

    expect(seen[0]?.verb).toEqual({ verb: 'close' });
  });
});

describe('a call names its run and nothing else', () => {
  it('carries the run id as the key the extension files the tab under', async () => {
    // Targeting is a closure, as it is for every browser: no verb takes a tab
    // id, so a model cannot name a page belonging to another conversation.
    const { host, seen } = answering();

    await extensionPageDriver(RUN, host).read();

    expect(seen[0]?.runKey).toBe('run-42');
  });

  it('gives every call an id that cannot be guessed from the last one', async () => {
    const { host, seen } = answering();
    const driver = extensionPageDriver(RUN, host);

    await driver.read();
    await driver.read();

    expect(seen[0]?.id).not.toBe(seen[1]?.id);
    expect(seen[0]?.id).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

describe('timeouts are per verb', () => {
  it('gives a load twenty seconds and a question ten', async () => {
    // One number for both would have to be the larger, and the value of a
    // refusal is that the agent gets it while the turn is worth continuing.
    const { host, seen } = answering();
    const driver = extensionPageDriver(RUN, host);

    await driver.navigate('https://example.com');
    await driver.cookies();

    expect(seen[0]?.timeoutMs).toBe(20_000);
    expect(seen[1]?.timeoutMs).toBe(10_000);
  });

  it('gives a click a load’s worth of time, because a click very often navigates', async () => {
    const { host, seen } = answering();

    await extensionPageDriver(RUN, host).click('a');

    expect(seen[0]?.timeoutMs).toBe(20_000);
  });
});

describe('the three ways there is no browser', () => {
  it('tells the agent to have the user pair one when none ever was', async () => {
    const { host } = fakeHost({ status: 'unpaired' });

    const result = await extensionPageDriver(RUN, host).read();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('no browser has been paired');
    expect(result.reason).toContain('Browser');
    // And it says not to describe a page it has not seen, which is the failure
    // this whole sentence exists to prevent.
    expect(result.reason).toContain('do not describe pages you have not seen');
  });

  it('tells the agent to have the user open Chrome when the paired one is away', async () => {
    const { host } = fakeHost({ status: 'disconnected' });

    const result = await extensionPageDriver(RUN, host).screenshot();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('The Artemis extension is not connected.');
    expect(result.reason).toContain('open Chrome');
  });

  it('suggests trying again when a connected browser did not answer', async () => {
    // Different from disconnected on purpose: a Chrome whose worker was asleep
    // answers the second call, so "try once more" is real advice here and
    // would be wrong above.
    const { host } = fakeHost({ status: 'timeout' });

    const result = await extensionPageDriver(RUN, host).navigate('https://example.com');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('did not answer within 20 seconds');
    expect(result.reason).toContain('Try once more');
  });
});

describe('what the browser said is what the model reads', () => {
  it('passes a value straight through', async () => {
    const { host } = fakeHost({
      status: 'answered',
      result: { ok: true, value: { url: 'https://example.com', title: 'Example' } },
    });

    const result = await extensionPageDriver(RUN, host).open();

    expect(result).toEqual({ ok: true, value: { url: 'https://example.com', title: 'Example' } });
  });

  it('carries a notice on a successful answer through to the tools', async () => {
    // How a driver says a successful answer is incomplete. Dropping it here
    // would be the silent partial answer the contract added it to prevent.
    const { host } = fakeHost({
      status: 'answered',
      result: { ok: true, value: [], notice: 'older console entries were dropped' },
    });

    const result = await extensionPageDriver(RUN, host).console();

    expect(result).toEqual({
      ok: true,
      value: [],
      notice: 'older console entries were dropped',
    });
  });

  it('passes a policy refusal through without rewriting it', async () => {
    // The extension is where the policy is applied, against the address the
    // tab actually has. Its sentence is the authoritative one and this file
    // has nothing to add to it.
    const reason = 'chase.com is on the list of sites an agent does not open in the user’s own browser.';
    const { host } = fakeHost({ status: 'answered', result: { ok: false, reason } });

    const result = await extensionPageDriver(RUN, host).navigate('https://chase.com');

    expect(result).toEqual({ ok: false, reason });
  });
});

describe('what this driver claims it can do', () => {
  it('claims every ability, because the browser is what says no', async () => {
    // The dock driver declines cookies, storage and evaluate outright: one
    // session, no per-site anything. This one has a per-site policy enforced
    // inside Chrome, and a tool absent here would read to the model as a
    // browser that cannot, rather than a site where it may not.
    const { host } = answering();

    const driver = extensionPageDriver(RUN, host);

    expect(driver.kind).toBe('extension');
    expect(driver.abilities).toEqual({
      console: true,
      network: true,
      cookies: true,
      storage: true,
      evaluate: true,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Which of several browsers                                                  */
/* -------------------------------------------------------------------------- */

/*
 * A person may pair a work Chrome and a personal one with one Artemis, and
 * what each of these pins is the difference between driving the browser a
 * conversation was pointed at and driving a browser that happened to be open.
 * The second is invisible from inside the run — every verb succeeds — which is
 * why the refusals are asserted by their sentences rather than by their
 * existence.
 */
describe('a run that was pointed at one browser', () => {
  it('addresses it by id, on every verb and not only the first', async () => {
    const { host, seen } = answering();
    const driver = extensionPageDriver(RUN, host, { browser: 'b-work' });

    await driver.open('https://example.com');
    await driver.read();
    await driver.close();

    expect(seen.map((one) => one.browserId)).toEqual(['b-work', 'b-work', 'b-work']);
  });

  it('addresses it by id when it was named by the user’s own word for it', async () => {
    // A served run carries back the *name* the agent was told, because a name
    // is what a person answers with. Only this machine holds the list the two
    // can be compared against.
    const { host, seen } = answering();

    await extensionPageDriver(RUN, host, { browser: 'Work' }).read();

    expect(seen[0]?.browserId).toBe('b-work');
  });

  it('matches a name the model retyped in a different case', async () => {
    const { host, seen } = fakeHost(
      { status: 'answered', result: { ok: true, value: null } },
      [WORK, PERSONAL],
    );

    await extensionPageDriver(RUN, host, { browser: '  personal ' }).read();

    expect(seen[0]?.browserId).toBe('b-personal');
  });

  it('names it when it is paired and its Chrome is shut, and says not to use another', async () => {
    // The failure this sentence prevents: with the personal profile open and
    // the work one shut, an agent told only "the browser is not connected"
    // reaches for whatever else it can see and acts as the wrong signed-in
    // person.
    const { host } = fakeHost({ status: 'browser-asleep', browserName: 'Work' });

    const result = await extensionPageDriver(RUN, host, { browser: 'b-work' }).read();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('“Work”');
    expect(result.reason).toContain('Do not use a different browser instead');
  });

  it('says the conversation’s browser is gone when nothing answers to it', async () => {
    // A different remedy from "pair a browser": other browsers may be paired
    // and working, and what is wrong is this conversation's choice.
    const { host } = fakeHost({ status: 'answered', result: { ok: true, value: null } }, []);

    const result = await extensionPageDriver(RUN, host, { browser: 'b-gone' }).read();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('no longer paired');
    expect(result.reason).toContain('choose a browser for this conversation again');
  });

  it('lists what is connected when the browser it names has gone', async () => {
    // A mistyped answer and an unpaired browser arrive at the same sentence,
    // and naming what would have worked turns the first into a second attempt.
    const { host } = answering();

    const result = await extensionPageDriver(RUN, host, { browser: 'Wrok' }).read();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Connected right now: “Work”');
  });

  it('asks again on every verb rather than resolving once', async () => {
    // A browser can be unpaired mid-run. The honest answer to the next verb is
    // a sentence about that browser, not a call sent to an id nothing answers.
    let browsers: readonly PairedBrowserRef[] = [WORK];
    const host: ExtensionDriverHost = {
      call: async () => ({ status: 'answered', result: { ok: true, value: null } }),
      browsers: () => browsers,
    };
    const driver = extensionPageDriver(RUN, host, { browser: 'b-work' });

    expect((await driver.read()).ok).toBe(true);
    browsers = [];
    const after = await driver.read();

    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.reason).toContain('no longer paired');
  });
});

describe('a run that was pointed at nothing, with several browsers open', () => {
  it('refuses the first verb with their names and how to answer', async () => {
    const { host } = fakeHost(
      { status: 'ambiguous', browserNames: ['Work', 'Personal'] },
      [WORK, PERSONAL],
    );

    const result = await extensionPageDriver(RUN, host).open();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('“Work”, “Personal”');
    expect(result.reason).toContain('AskUserQuestion');
    expect(result.reason).toContain('browser_open(browser: "Work")');
    expect(result.reason).toContain('Do not guess');
  });

  it('sends no browser id at all when nothing was named', async () => {
    // Which is what lets the bridge answer "exactly one is open, use it"
    // without this file having to know how many there are.
    const { host, seen } = answering();

    await extensionPageDriver(RUN, host).read();

    expect(seen[0]?.browserId).toBeUndefined();
  });
});

describe('the agent answering the question', () => {
  it('drives the browser it named, from the open that named it', async () => {
    const { host, seen } = fakeHost(
      { status: 'answered', result: { ok: true, value: { url: '', title: '' } } },
      [WORK, PERSONAL],
    );
    const driver = extensionPageDriver(RUN, host);

    await driver.open('https://example.com', 'Personal');

    expect(seen[0]?.browserId).toBe('b-personal');
  });

  it('keeps driving it for the rest of the run, so it is asked once', async () => {
    const { host, seen } = fakeHost(
      { status: 'answered', result: { ok: true, value: { url: '', title: '' } } },
      [WORK, PERSONAL],
    );
    const driver = extensionPageDriver(RUN, host);

    await driver.open(undefined, 'Personal');
    await driver.read();
    await driver.evaluate('1');

    expect(seen.map((one) => one.browserId)).toEqual(['b-personal', 'b-personal', 'b-personal']);
  });

  it('keeps the choice even when that open then failed', async () => {
    // A name that resolved is the user's answer to a question they were asked;
    // a page that would not load is a fact about a page. Forgetting the first
    // because of the second would ask again on the next tool call.
    const { host, seen } = fakeHost(
      { status: 'answered', result: { ok: false, reason: 'that page 404ed' } },
      [WORK, PERSONAL],
    );
    const driver = extensionPageDriver(RUN, host);

    await driver.open('https://example.com/missing', 'Personal');
    await driver.read();

    expect(seen.map((one) => one.browserId)).toEqual(['b-personal', 'b-personal']);
  });

  it('tells the composition root which browser was settled on, once', async () => {
    // Which is how the conversation's own pane learns it and the next turn
    // starts on the same browser. See `IPC_PUSH.runBrowserChoice`.
    const chosen: string[] = [];
    const { host } = fakeHost(
      { status: 'answered', result: { ok: true, value: { url: '', title: '' } } },
      [WORK, PERSONAL],
    );
    const driver = extensionPageDriver(RUN, host, {
      onChosen: (browserId) => chosen.push(browserId),
    });

    await driver.open(undefined, 'Personal');
    await driver.read();

    expect(chosen).toEqual(['b-personal']);
  });

  it('says nothing to the composition root when a run was already pointed at one', async () => {
    // The conversation already knows; a push would be Artemis telling a pane
    // what the pane had just told it.
    const chosen: string[] = [];
    const { host } = answering();

    await extensionPageDriver(RUN, host, {
      browser: 'b-work',
      onChosen: (browserId) => chosen.push(browserId),
    }).open();

    expect(chosen).toEqual([]);
  });

  it('refuses a name that matches nothing without changing the run’s browser', async () => {
    const chosen: string[] = [];
    const { host, seen } = fakeHost(
      { status: 'answered', result: { ok: true, value: { url: '', title: '' } } },
      [WORK, PERSONAL],
    );
    const driver = extensionPageDriver(RUN, host, {
      onChosen: (browserId) => chosen.push(browserId),
    });

    const result = await driver.open(undefined, 'Laptop');

    expect(result.ok).toBe(false);
    // Nothing was sent, and the run is still on "whichever is open" — which
    // means the next verb asks the question again rather than acting in a
    // browser nobody chose.
    expect(seen).toEqual([]);
    expect(chosen).toEqual([]);
  });

  it('treats an empty browser argument as not having named one', async () => {
    const { host, seen } = fakeHost(
      { status: 'answered', result: { ok: true, value: { url: '', title: '' } } },
      [WORK, PERSONAL],
    );

    await extensionPageDriver(RUN, host).open('https://example.com', '   ');

    expect(seen[0]?.browserId).toBeUndefined();
  });
});

describe('a run the user pinned to one browser', () => {
  /*
   * The `browser` argument answers a question, and a conversation somebody set
   * in the picker was never asked one. If a model could move it, a page the
   * agent is reading could get the next turn run as a different signed-in
   * person — and on the desktop the move is written back into the pane, so it
   * would outlive the turn that made it.
   */
  it('refuses to be moved onto another browser by a tool call', async () => {
    const { host, seen } = fakeHost(
      { status: 'answered', result: { ok: true, value: { url: '', title: '' } } },
      [WORK, PERSONAL],
    );
    const driver = extensionPageDriver(RUN, host, { browser: 'b-work' });

    const result = await driver.open('https://example.com', 'Personal');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('“Work”');
    expect(result.reason).toContain('“Personal”');
    expect(result.reason).toContain('Do not work around this');
    // And nothing was driven: not the browser it named, and not the one it has.
    expect(seen).toEqual([]);
  });

  it('carries on in the browser it was pinned to afterwards', async () => {
    const { host, seen } = fakeHost(
      { status: 'answered', result: { ok: true, value: { url: '', title: '' } } },
      [WORK, PERSONAL],
    );
    const driver = extensionPageDriver(RUN, host, { browser: 'b-work' });

    await driver.open(undefined, 'Personal');
    await driver.read();

    expect(seen.map((one) => one.browserId)).toEqual(['b-work']);
  });

  it('tells nobody a browser was chosen, because none was', async () => {
    // The push that moves a pane is for an answer to a question. A refused
    // move is not one, and a pane that adopted it would have been moved by the
    // model after all.
    const chosen: string[] = [];
    const { host } = fakeHost(
      { status: 'answered', result: { ok: true, value: { url: '', title: '' } } },
      [WORK, PERSONAL],
    );

    await extensionPageDriver(RUN, host, {
      browser: 'b-work',
      onChosen: (browserId) => chosen.push(browserId),
    }).open(undefined, 'Personal');

    expect(chosen).toEqual([]);
  });

  it('lets the model name the browser it is already on, by id or by name', async () => {
    // Not a move, so not a refusal: a model repeating what it was told would
    // otherwise learn that its own answer had not taken.
    const { host, seen } = fakeHost(
      { status: 'answered', result: { ok: true, value: { url: '', title: '' } } },
      [WORK, PERSONAL],
    );
    const driver = extensionPageDriver(RUN, host, { browser: 'b-work' });

    const byName = await driver.open(undefined, 'Work');
    const byId = await driver.open(undefined, 'b-work');

    expect(byName.ok).toBe(true);
    expect(byId.ok).toBe(true);
    expect(seen.map((one) => one.browserId)).toEqual(['b-work', 'b-work']);
  });

  it('refuses a second, different answer once the agent has answered once', async () => {
    const { host, seen } = fakeHost(
      { status: 'answered', result: { ok: true, value: { url: '', title: '' } } },
      [WORK, PERSONAL],
    );
    const driver = extensionPageDriver(RUN, host);

    await driver.open(undefined, 'Work');
    const again = await driver.open(undefined, 'Personal');

    expect(again.ok).toBe(false);
    expect(seen.map((one) => one.browserId)).toEqual(['b-work']);
  });

  it('says the conversation’s browser is gone rather than moving onto a live one', async () => {
    /*
     * A pinned browser that has been unpaired. The more useful of the two
     * sentences is the one about the browser this conversation lost — telling
     * the user to choose again — rather than one about the browser the model
     * happened to name.
     */
    const { host, seen } = fakeHost(
      { status: 'answered', result: { ok: true, value: { url: '', title: '' } } },
      [PERSONAL],
    );
    const driver = extensionPageDriver(RUN, host, { browser: 'b-work' });

    const result = await driver.open(undefined, 'Personal');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('no longer paired');
    expect(seen).toEqual([]);
  });
});

