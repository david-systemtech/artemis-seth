/**
 * @vitest-environment jsdom
 *
 * Starting the conversation that writes a bank's `BANK.md`.
 *
 * A bank with no manifest cannot say what it holds or how a new entry is
 * filed, and the answer to that is not a form — it is an agent standing in the
 * bank's own checkout. So what is pinned here is the handover: the column opens
 * *beside* the one the click came from, it is pointed at the bank rather than
 * at whatever directory the settings dialog happened to be opened over, the
 * dialog gets out of the way, and the protocol's own words go.
 *
 * The other half is the refusal to send. A served column and a column with no
 * catalogue both put the prompt in the composer instead, for the reason
 * `startSuggestedTask`'s server target gives at length: a run posted into
 * either goes out with no model behind it, and which account runs the work on
 * which model is the choice a person moves work to a server in order to make.
 *
 * Same caveat as the neighbouring files: `renderer/tsconfig.json` excludes test
 * files, so the assertions are behavioural.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A bridge that answers only what these tests reach for.
 *
 * Installed before the store is imported, because `resolveBridge` caches its
 * binding on the first call — see `lib/bridge.ts`. The background reads a new
 * column kicks off are all floating promises, so each answers a plain failure
 * rather than being left to throw into nothing.
 */
const submitted = vi.fn();

const refused = () =>
  Promise.resolve({
    ok: false as const,
    error: { code: 'transport', message: 'not wired in this test', retryable: false },
  });

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  providers: { models: refused, commands: refused },
  sessions: { list: refused, listAll: refused },
  auth: { status: refused },
  // The one call a send makes. Whether it was reached is the whole question in
  // half these tests, so it is a spy rather than an assumption.
  runs: { start: (...args: unknown[]) => (submitted(...args), refused()) },
};

const { renderDescribeBankPrompt } = await import('@rx-artemis/protocol');
const { allPanes, closePane, describeMemoryBank, focusedPane, useApp } = await import('./store');
const { paneState } = await import('./pane');
const { seedApp, ALL_CAPABILITIES } = await import('./testkit');
type Pane = import('./pane').Pane;

const pane = () => focusedPane();

/** The four facts the prompt is composed from — a bank the CLI wrote, no manifest. */
const BANK = {
  slug: 'cortex',
  name: 'Cortex',
  path: '/Users/demo/Documents/cortex',
  format: 'legacy-projects' as const,
};

const PROVIDER = {
  id: 'claude',
  label: 'Claude',
  capabilities: ALL_CAPABILITIES,
  models: [{ id: 'sonnet', label: 'Sonnet' }],
  effortLevels: [],
  available: true,
};

const LOCAL = { id: 'p1', label: 'Local', providerId: 'claude', configDir: '/c' };
const SERVER = { id: 's1', label: 'Server', providerId: 'artemis', configDir: '' };

/**
 * A column that could run something: an account, a catalogue, a directory that
 * is not the bank's. The settings dialog is open over it, because that is the
 * only place this action is reachable from.
 */
function ready(over: Record<string, unknown> = {}): void {
  useApp.setState({ banners: [], screen: 'profiles', runLocation: 'local' });
  seedApp({
    providers: [PROVIDER as never],
    profiles: [LOCAL, SERVER] as never,
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    models: [{ id: 'sonnet', label: 'Sonnet' }],
    model: null,
    cwd: '/code/kronos',
    workspace: { name: 'kronos' },
    run: null,
    resumeSessionId: null,
    draft: '',
    ...over,
  } as never);
}

/**
 * Describe the bank, and give back both columns.
 *
 * `from` is the one the click came from — captured before the call, because
 * `splitPane` focuses what it opened and `focusedPane()` is no longer it
 * afterwards. An assertion written against `focusedPane()` after the handover
 * reads the wrong column and passes or fails for the wrong reason.
 */
async function describe_(): Promise<{ from: Pane; to: Pane }> {
  const from = pane();
  await describeMemoryBank(BANK, from);
  const to = allPanes().find((p) => p.id !== from.id);
  if (to === undefined) throw new Error('no column was opened');
  return { from, to };
}

beforeEach(() => {
  submitted.mockReset();
  ready();
});

afterEach(() => {
  // `splitPane` focuses what it opened and the store is a singleton across this
  // file — a column left behind would be the one the next test's `pane()`
  // returned.
  for (const extra of allPanes().slice(1)) closePane(extra.id);
});

describe('describing a memory bank', () => {
  it('opens a column beside the one it was asked from, in the bank’s checkout', async () => {
    const { from, to } = await describe_();

    expect(paneState(to).cwd).toBe(BANK.path);
    // The column the settings dialog was opened over keeps its directory: the
    // request was to describe a bank, not to move the user's work.
    expect(paneState(from).cwd).toBe('/code/kronos');
  });

  it('closes the settings dialog it was pressed in', async () => {
    // What it was asked for is now happening in a column behind the dialog, and
    // a dialog left open over the answer is one the user has to dismiss to read
    // it.
    await describe_();
    expect(useApp.getState().screen).toBe('chat');
  });

  it('sends the protocol’s own words, in the bank’s directory', async () => {
    await describe_();

    expect(submitted).toHaveBeenCalledWith({
      input: expect.objectContaining({
        cwd: BANK.path,
        // Composed from the four facts the card handed over, so the desktop and
        // a future server-side starter say the same thing.
        prompt: renderDescribeBankPrompt(BANK),
      }),
    });
  });

  it('runs in the new column, never in the one behind the dialog', async () => {
    const { from, to } = await describe_();

    expect(paneState(to).run).not.toBeNull();
    expect(paneState(from).run).toBeNull();
  });
});

/**
 * The two columns that cannot be sent into hand the prompt over instead.
 *
 * Not politeness: a send from either posts a run with no model and comes back
 * `model_not_found`. The prompt is on screen and editable in both cases, so the
 * fallback costs one keypress and never costs the words.
 */
describe('a column that could not have sent', () => {
  it('parks the prompt in a served column rather than picking an account', async () => {
    ready({ activeProviderId: 'artemis', activeProfileId: 's1' });

    const { to } = await describe_();

    expect(submitted).not.toHaveBeenCalled();
    // The same field a restored or parked draft lands in, so it is editable and
    // recallable exactly as anything typed there would be.
    expect(paneState(to).draft).toBe(renderDescribeBankPrompt(BANK));
    expect(paneState(to).run).toBeNull();
  });

  it('parks the prompt when the catalogue has not arrived', async () => {
    ready({ models: [], providers: [{ ...PROVIDER, models: [] }] });

    const { to } = await describe_();

    expect(submitted).not.toHaveBeenCalled();
    expect(paneState(to).draft).toBe(renderDescribeBankPrompt(BANK));
  });

  it('parks the prompt when the column has no account at all', async () => {
    // A run needs credentials. Sending would have banned the prompt to a banner
    // and thrown the user back into the settings screen this just closed.
    ready({ activeProfileId: null });

    const { to } = await describe_();

    expect(submitted).not.toHaveBeenCalled();
    expect(paneState(to).draft).toBe(renderDescribeBankPrompt(BANK));
  });

  it('still points the parked column at the bank', async () => {
    ready({ activeProviderId: 'artemis', activeProfileId: 's1' });

    const { to } = await describe_();

    // The directory is the half of the handover that does not depend on the
    // send: whatever the user does with the prompt, it runs in the bank.
    expect(paneState(to).cwd).toBe(BANK.path);
  });
});
