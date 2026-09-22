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
} from './extensionPageDriver';

const RUN = 'run-42' as RunId;

/** One call as the fake host saw it. */
interface Seen {
  readonly runKey: string;
  readonly id: string;
  readonly verb: BridgeVerb;
  readonly timeoutMs: number;
}

function fakeHost(answer: BridgeCallOutcome): { host: ExtensionDriverHost; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    host: {
      call: async (runKey, id, verb, timeoutMs) => {
        seen.push({ runKey, id, verb, timeoutMs });
        return answer;
      },
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
