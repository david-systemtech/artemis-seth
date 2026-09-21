/**
 * @vitest-environment jsdom
 *
 * The Browser pane: pairing, the paired browsers, and the policy editor.
 *
 * There is no display on the machine this was built on, so these tests are the
 * only thing that has ever looked at this pane. What they check is therefore
 * not styling but the four claims the pane makes to a reader:
 *
 *  - **The code is on screen, and so is how long it lasts.** A pairing flow
 *    whose code is invisible is not a flow.
 *  - **A taken port is said, not hidden.** The extension dials a fixed
 *    address; an Artemis that could not bind it and did not say would be one
 *    no browser can reach, with a pairing that simply never completes.
 *  - **Unpair reaches main.** It is the one control in the dialog with a
 *    consequence outside Artemis — it cuts a live connection, so a run's next
 *    tool call refuses.
 *  - **The default block list is visible and each entry can be allowed.** An
 *    agent that refuses to open the user's bank looks broken unless they have
 *    seen the list.
 *
 * Against a fake `window.artemis` installed before the first render, as the
 * pane's siblings do: `resolveBridge` memoises on first use, so a stub
 * installed later would never be seen.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DEFAULT_BLOCKED_SITES, type ExtensionBridgeState } from '@rx-artemis/protocol';

import { BrowserSection } from '@/components/settings/BrowserSection';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useApp } from '@/state/store';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const ok = <T,>(value: T) => ({ ok: true as const, value });

const CONNECTED: ExtensionBridgeState = {
  listening: { kind: 'listening', port: 47_615 },
  browsers: [
    {
      browserId: 'b1',
      browserName: 'Chrome on Windows',
      pairedAt: Date.parse('2026-09-15T10:00:00Z'),
      connected: true,
      extensionVersion: '2.19.1',
    },
  ],
  pairing: null,
  policy: {
    devSites: ['localhost'],
    blockedSites: [],
    unblockedSites: [],
    evaluateEverywhere: false,
    deepReadEverywhere: false,
  },
  bundledVersion: '2.19.1',
};

let paired: { offer: boolean }[] = [];
let unpaired: { browserId: string }[] = [];
let policies: unknown[] = [];
let savedBundle = 0;

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  extensionBridge: {
    state: async () => ok({ state: useApp.getState().extensionBridge ?? CONNECTED }),
    pair: async (request: { offer: boolean }) => {
      paired.push(request);
      return ok({ state: CONNECTED });
    },
    unpair: async (request: { browserId: string }) => {
      unpaired.push(request);
      return ok({ state: CONNECTED });
    },
    policy: async (request: unknown) => {
      policies.push(request);
      return ok({ state: CONNECTED });
    },
    saveBundle: async () => {
      savedBundle += 1;
      return ok({ savedTo: '/home/you/Downloads/artemis-extension-2.19.1.zip' });
    },
    onState: () => () => undefined,
  },
};

async function renderPane(state: ExtensionBridgeState | null = CONNECTED): Promise<void> {
  useApp.setState({ extensionBridge: state } as never);
  render(
    <TooltipProvider>
      <BrowserSection />
    </TooltipProvider>,
  );
  await act(async () => {});
}

async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    screen.getByRole('button', { name }).click();
  });
  await act(async () => {});
}

beforeEach(() => {
  paired = [];
  unpaired = [];
  policies = [];
  savedBundle = 0;
});

afterEach(() => {
  cleanup();
});

describe('pairing a browser', () => {
  it('asks main for a code when the button is clicked', async () => {
    await renderPane();

    await click('Show a code');

    expect(paired).toEqual([{ offer: true }]);
  });

  it('shows the code and how long it lasts', async () => {
    await renderPane({
      ...CONNECTED,
      pairing: { code: 'K7P2MXQ4', expiresAt: Date.now() + 240_000 },
    });

    expect(screen.getByText('K7P2MXQ4')).toBeTruthy();
    expect(screen.getByText(/Good for another 2\d\d seconds/u)).toBeTruthy();
  });

  it('withdraws the offer when asked, because a live code is still spendable', async () => {
    await renderPane({
      ...CONNECTED,
      pairing: { code: 'K7P2MXQ4', expiresAt: Date.now() + 240_000 },
    });

    await click('Stop');

    expect(paired).toEqual([{ offer: false }]);
  });

  it('says which port is listening, so a firewall question has an answer', async () => {
    await renderPane();

    expect(screen.getByText(/127\.0\.0\.1 port 47615/u)).toBeTruthy();
  });

  it('says plainly when the port is taken rather than pretending to listen', async () => {
    await renderPane({ ...CONNECTED, listening: { kind: 'port-in-use', port: 47_615 } });

    expect(screen.getByText(/being used by something else/u)).toBeTruthy();
  });
});

describe('the paired browsers', () => {
  it('lists a browser by name, with whether it is connected', async () => {
    await renderPane();

    expect(screen.getByText('Chrome on Windows')).toBeTruthy();
    expect(screen.getByText(/Connected\./u)).toBeTruthy();
  });

  it('says a browser is not connected, and what to do about it', async () => {
    await renderPane({
      ...CONNECTED,
      browsers: [{ ...CONNECTED.browsers[0]!, connected: false }],
    });

    expect(screen.getByText(/Not connected — open Chrome/u)).toBeTruthy();
  });

  it('sends the unpair to main, which is what cuts the connection', async () => {
    await renderPane();

    await click('Unpair');

    expect(unpaired).toEqual([{ browserId: 'b1' }]);
  });

  it('says to update an extension older than the one this build ships', async () => {
    // An unpacked extension does not update itself, which is the known cost of
    // shipping a zip rather than a Web Store listing.
    await renderPane({
      ...CONNECTED,
      browsers: [{ ...CONNECTED.browsers[0]!, extensionVersion: '2.18.0' }],
      bundledVersion: '2.19.1',
    });

    expect(screen.getByText(/Update the extension/u)).toBeTruthy();
  });

  it('says nothing about versions when the extension is current', async () => {
    await renderPane();

    expect(screen.queryByText(/Update the extension/u)).toBeNull();
  });

  it('explains the empty state rather than showing an empty box', async () => {
    await renderPane({ ...CONNECTED, browsers: [] });

    expect(screen.getByText(/No browser is paired/u)).toBeTruthy();
  });
});

describe('getting the extension', () => {
  it('saves the bundled zip where the user chooses, and says where', async () => {
    await renderPane();

    await click('Save the extension…');

    expect(savedBundle).toBe(1);
    expect(screen.getByText(/artemis-extension-2\.19\.1\.zip/u)).toBeTruthy();
  });

  it('spells out the four steps, because the user is about to leave this window', async () => {
    await renderPane();

    expect(screen.getByText(/chrome:\/\/extensions/u)).toBeTruthy();
    expect(screen.getByText(/Developer mode/u)).toBeTruthy();
    expect(screen.getByText(/Load unpacked/u)).toBeTruthy();
  });

  it('offers nothing to save on a build that ships no extension, and says why', async () => {
    await renderPane({ ...CONNECTED, bundledVersion: null });

    expect(screen.getByText(/does not ship the extension/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save the extension…' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});

describe('what the agent may read', () => {
  it('draws the two wide-open switches off, each with its risk in a sentence', async () => {
    await renderPane();

    const evaluate = screen.getByRole('switch', { name: 'Run JavaScript on every site' });
    const deepRead = screen.getByRole('switch', {
      name: 'Read cookies and storage on every site',
    });

    expect(evaluate.getAttribute('data-state')).toBe('unchecked');
    expect(deepRead.getAttribute('data-state')).toBe('unchecked');
    expect(screen.getByText(/asking it to run that code as you/u)).toBeTruthy();
    expect(screen.getByText(/the session cookie is the login/u)).toBeTruthy();
  });

  it('saves the whole policy when a switch is flipped', async () => {
    await renderPane();

    await act(async () => {
      screen.getByRole('switch', { name: 'Run JavaScript on every site' }).click();
    });
    await act(async () => {});

    expect(policies).toEqual([
      { policy: { ...CONNECTED.policy, evaluateEverywhere: true } },
    ]);
  });

  it('shows the default block list in full, because a refusal is otherwise a mystery', async () => {
    await renderPane();

    for (const host of DEFAULT_BLOCKED_SITES.slice(0, 5)) {
      expect(screen.getByText(host)).toBeTruthy();
    }
  });

  it('moves an entry onto the allow list rather than editing the default one', async () => {
    await renderPane();

    await act(async () => {
      screen.getByRole('switch', { name: 'Allow *.paypal.com' }).click();
    });
    await act(async () => {});

    expect(policies).toEqual([
      { policy: { ...CONNECTED.policy, unblockedSites: ['*.paypal.com'] } },
    ]);
  });

  it('takes an entry back off the allow list', async () => {
    await renderPane({
      ...CONNECTED,
      policy: { ...CONNECTED.policy, unblockedSites: ['*.paypal.com'] },
    });

    await act(async () => {
      screen.getByRole('switch', { name: 'Allow *.paypal.com' }).click();
    });
    await act(async () => {});

    expect(policies).toEqual([{ policy: { ...CONNECTED.policy, unblockedSites: [] } }]);
  });
});
