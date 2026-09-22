/**
 * @vitest-environment jsdom
 *
 * The browser choice, and how it rides a run's input.
 *
 * One window-level choice of four — the dock browser, the user's Chrome
 * through the Artemis extension, their Chrome through Claude's own bridge, or
 * their default browser opened at — becomes at most one field on `RunInput`,
 * and everything downstream (the adapter's `--chrome` flag, main's tool-server
 * decision table) keys off those fields. What is worth pinning here is the
 * wiring's sharp edges:
 *
 *  - **Absent, not false.** A run on the dock browser must carry *no* browser
 *    field: the protocol treats an absent flag as "off", and a run started
 *    before these options existed has to look byte-identical to one started
 *    after.
 *  - **At most one.** The picker is single-valued, so the renderer cannot ask
 *    for two browsers at once. Precedence still lives in main's decision
 *    table, because a run input can arrive from a server — but no longer
 *    because this end sends a contradiction.
 *  - **The reach setting reaches the run input.** "Each conversation chooses"
 *    holds the paired Chrome back from a conversation that has not asked;
 *    "always on" hands it over. That distinction is the setting's entire
 *    content, and it is only observable here.
 *
 * The rules themselves — the migration, which option is unavailable and why,
 * how a pane override folds into the window's default — are in
 * `browserChoice.test.ts`, against the pure functions. This file is about the
 * wiring reaching `runs.start`.
 *
 * Same caveat as the neighbours: `renderer/tsconfig.json` excludes test
 * files, so the assertions are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import {
  focusedPane,
  setBrowserMode,
  setExtensionReach,
  setPaneBrowserMode,
  submitPrompt,
  useApp,
} from './store';
import { setPaneState } from './pane';

/** A bridge state with one browser paired and awake. */
const ONE_BROWSER_CONNECTED = {
  listening: { kind: 'listening' as const, port: 47_615 },
  browsers: [
    {
      browserId: 'b1',
      browserName: 'Chrome on Linux',
      pairedAt: 1,
      connected: true,
    },
  ],
  pairing: null,
  policy: {
    devSites: [],
    blockedSites: [],
    unblockedSites: [],
    evaluateEverywhere: false,
    deepReadEverywhere: false,
  },
  bundledVersion: null,
};

/** Every `runs.start` input main was handed, keyed by what this suite pins. */
let started: { chromeBrowser?: boolean; extensionBrowser?: boolean; externalBrowser?: boolean }[] =
  [];

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    send: async () => ({ ok: true, value: { runId: 'r1', deliveredImmediately: true } }),
    start: async ({
      input,
    }: {
      input: {
        runId: string;
        chromeBrowser?: boolean;
        extensionBrowser?: boolean;
        externalBrowser?: boolean;
      };
    }) => {
      // Key presence, not value: the contract is that an unset preference is
      // an *absent* field, and a fake that normalised the two would pass a
      // wiring that sends `chromeBrowser: false` to every run.
      started.push({
        ...('chromeBrowser' in input ? { chromeBrowser: input.chromeBrowser } : {}),
        ...('extensionBrowser' in input ? { extensionBrowser: input.extensionBrowser } : {}),
        ...('externalBrowser' in input ? { externalBrowser: input.externalBrowser } : {}),
      });
      return {
        ok: true,
        value: {
          run: {
            runId: input.runId,
            status: 'running',
            capabilities: NO_CAPABILITIES,
            startedAt: 1,
            sessionId: 'sess-new',
          },
        },
      };
    },
    list: async () => ({ ok: true, value: { runs: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: { listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }) },
  providers: { models: async () => ({ ok: true, value: { models: [], live: false } }) },
};

beforeEach(() => {
  started = [];
  const pane = focusedPane();
  pane.transcript.reset();
  setPaneState(pane, {
    activeProfileId: 'p1',
    activeProviderId: 'claude',
    cwd: '/repo',
    run: null,
    permissionQueue: [],
    promptHistory: [],
  } as never);
  useApp.setState({
    providers: [
      { id: 'claude', label: 'Claude', capabilities: NO_CAPABILITIES, models: [] },
      { id: 'codex', label: 'Codex', capabilities: NO_CAPABILITIES, models: [] },
      { id: 'artemis', label: 'Artemis Server', capabilities: NO_CAPABILITIES, models: [] },
    ] as never,
    profiles: [
      { id: 'p1', label: 'Personal', providerId: 'claude' },
      { id: 'p2', label: 'Other', providerId: 'codex' },
      { id: 'p3', label: 'A server', providerId: 'artemis' },
    ] as never,
    // Reset explicitly rather than trusting the module-scope defaults: under
    // `--localstorage-file`, a prefs blob written by an earlier local run
    // survives into this one and seeds the store before any test runs.
    browserMode: 'embedded',
    extensionReach: 'per-conversation',
    extensionBridge: ONE_BROWSER_CONNECTED,
    banners: [],
  } as never);
  setPaneState(focusedPane(), { browserMode: null } as never);
});

describe('what rides the run input', () => {
  it('carries no browser field at all on the dock browser', async () => {
    await submitPrompt('hello');

    expect(started).toEqual([{}]);
  });

  it('asks Claude for the Chrome bridge when Claude in Chrome is chosen', async () => {
    setBrowserMode('chrome');

    await submitPrompt('hello');

    expect(started).toEqual([{ chromeBrowser: true }]);
  });

  it('falls back to the dock browser on a provider Claude in Chrome cannot reach', async () => {
    // It used to send nothing at all, which left the run with no browser tools
    // and nobody saying so. The picker already draws the option as disabled
    // here; this is the same answer, arrived at the same way.
    setBrowserMode('chrome');
    setPaneState(focusedPane(), { activeProviderId: 'codex', activeProfileId: 'p2' } as never);

    await submitPrompt('hello');

    expect(started).toEqual([{}]);
  });

  it('marks external opens for every provider alike', async () => {
    // `externalBrowser` describes the host's own tools, so — unlike the
    // Chrome flag — it is not Claude's question.
    setBrowserMode('external');
    setPaneState(focusedPane(), { activeProviderId: 'codex', activeProfileId: 'p2' } as never);

    await submitPrompt('hello');

    expect(started).toEqual([{ externalBrowser: true }]);
  });

  it('asks for the Artemis extension on a provider that has never heard of Chrome', async () => {
    // The whole reason the flag exists: one browser, every provider.
    setBrowserMode('extension');
    setExtensionReach('always-on');
    setPaneState(focusedPane(), { activeProviderId: 'codex', activeProfileId: 'p2' } as never);

    await submitPrompt('hello');

    expect(started).toEqual([{ extensionBrowser: true }]);
  });

  it('never sends two browsers, because the picker cannot say two', async () => {
    setBrowserMode('extension');
    setExtensionReach('always-on');

    await submitPrompt('hello');

    expect(started).toEqual([{ extensionBrowser: true }]);
  });
});

describe('how a conversation comes by the paired Chrome', () => {
  it('holds it back from a conversation that has not asked, by default', async () => {
    setBrowserMode('extension');

    await submitPrompt('hello');

    expect(started).toEqual([{}]);
  });

  it('hands it to a conversation that asked for it', async () => {
    setBrowserMode('extension');
    setPaneBrowserMode('extension');

    await submitPrompt('hello');

    expect(started).toEqual([{ extensionBrowser: true }]);
  });

  it('hands it to every conversation once always-on is chosen', async () => {
    setBrowserMode('extension');
    setExtensionReach('always-on');

    await submitPrompt('hello');

    expect(started).toEqual([{ extensionBrowser: true }]);
  });

  it('goes back to the window default when the conversation clears its choice', async () => {
    // `setPaneBrowserMode(null)` is the follow row, and it must restore
    // *following* rather than pin whatever the window happens to say now.
    setBrowserMode('external');
    setPaneBrowserMode('extension');
    setPaneBrowserMode(null);

    await submitPrompt('hello');

    expect(started).toEqual([{ externalBrowser: true }]);
  });

  it('carries a conversation’s choice onto a run served by an Artemis Server', async () => {
    // The served path reads the same field: the adapter puts
    // `artemis.extensionBrowser` on the request, the server publishes each
    // verb back down that connection, and this desktop drives its own browser.
    setBrowserMode('embedded');
    setPaneBrowserMode('extension');
    setPaneState(focusedPane(), { activeProviderId: 'artemis', activeProfileId: 'p3' } as never);

    await submitPrompt('hello');

    expect(started).toEqual([{ extensionBrowser: true }]);
  });

  it('lets a conversation opt out of always-on', async () => {
    setBrowserMode('extension');
    setExtensionReach('always-on');
    setPaneBrowserMode('embedded');

    await submitPrompt('hello');

    expect(started).toEqual([{}]);
  });

  it('drops the window default when nothing is paired, because the picker says why', async () => {
    // A stored default must not outlive the browser it named, and nobody is
    // waiting on an answer: the picker draws the option disabled with its
    // reason beside it. The dock browser is what it offers instead.
    setBrowserMode('extension');
    setExtensionReach('always-on');
    useApp.setState({ extensionBridge: { ...ONE_BROWSER_CONNECTED, browsers: [] } } as never);

    await submitPrompt('hello');

    expect(started).toEqual([{}]);
  });

  it('keeps a conversation’s own choice when nothing is paired, and lets the run say so', async () => {
    /*
     * The other half of the rule in `browserChoice.ts`. This conversation
     * asked for the user's Chrome; handing it the dock browser would have the
     * agent browse a session signed in to nothing and report on it as though
     * it were theirs. The extension tool server is built regardless and every
     * verb of it refuses in a sentence the agent can repeat.
     */
    setBrowserMode('embedded');
    setPaneBrowserMode('extension');
    useApp.setState({ extensionBridge: { ...ONE_BROWSER_CONNECTED, browsers: [] } } as never);

    await submitPrompt('hello');

    expect(started).toEqual([{ extensionBrowser: true }]);
  });

  it('keeps it when the user has simply closed Chrome', async () => {
    setBrowserMode('embedded');
    setPaneBrowserMode('extension');
    useApp.setState({
      extensionBridge: {
        ...ONE_BROWSER_CONNECTED,
        browsers: [{ ...ONE_BROWSER_CONNECTED.browsers[0], connected: false }],
      },
    } as never);

    await submitPrompt('hello');

    expect(started).toEqual([{ extensionBrowser: true }]);
  });

  it('drops the window default when the paired browser is not connected', async () => {
    setBrowserMode('extension');
    setExtensionReach('always-on');
    useApp.setState({
      extensionBridge: {
        ...ONE_BROWSER_CONNECTED,
        browsers: [{ ...ONE_BROWSER_CONNECTED.browsers[0], connected: false }],
      },
    } as never);

    await submitPrompt('hello');

    expect(started).toEqual([{}]);
  });
});

describe('the preferences themselves', () => {
  // One setter per test, and the blob is removed first — deliberately: every
  // other setter also saves the whole state, so without both, a setter that
  // forgot to persist would hide behind whichever save ran before it.
  beforeEach(() => {
    globalThis.localStorage.removeItem('artemis.prefs.v1');
  });

  const savedBlob = (): { browserMode?: string; extensionReach?: string } =>
    JSON.parse(globalThis.localStorage.getItem('artemis.prefs.v1') ?? '{}') as {
      browserMode?: string;
      extensionReach?: string;
    };

  it('persists the browser choice, so it survives a relaunch', () => {
    setBrowserMode('extension');

    expect(savedBlob().browserMode).toBe('extension');
  });

  it('persists how conversations get the paired Chrome', () => {
    setExtensionReach('always-on');

    expect(savedBlob().extensionReach).toBe('always-on');
  });

  it('starts on “each conversation chooses”, and that is the shipped default', () => {
    // David runs always-on. The default stays per-conversation, which is his
    // decision of 2026-09-21 in issue #436 and not an oversight to tidy up.
    expect(useApp.getState().extensionReach).toBe('per-conversation');
  });
});
