/**
 * @vitest-environment jsdom
 *
 * A conversation's own browser, in the run navigator's footer.
 *
 * This control exists because of a default that was otherwise unreachable.
 * "Each conversation chooses" is what Artemis ships with — David's decision of
 * 2026-09-21 — and until this row there was nowhere to choose: the window's
 * picker set a default, the reach setting held the paired Chrome back from
 * conversations that had not asked, and no conversation could ask. The setting
 * meant "nobody gets it".
 *
 * What is worth pinning is therefore not that a menu renders:
 *
 *  - **Five rows, always.** The four the window offers plus "follow the window
 *    default", which is the absence of a choice rather than a fifth browser —
 *    a conversation following the default moves when the window changes and
 *    one that picked the same browser does not.
 *  - **An option that cannot work is shown, disabled, with the reason.** A
 *    user who cannot find "My Chrome" concludes Artemis does not have it.
 *  - **The trigger says the *effective* browser.** Under `per-conversation`
 *    reach a window set to My Chrome still resolves to the built-in browser,
 *    and a row that echoed the stored value would show the opposite of what
 *    the next prompt will do.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ExtensionBridgeState } from '@rx-artemis/protocol';

import { BrowserRow } from '@/components/RunNavigator';
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu';
import { focusedPane, useApp } from '@/state/store';
import { PaneProvider } from '@/state/paneContext';
import { setPaneState } from '@/state/pane';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const PAIRED_AND_AWAKE: ExtensionBridgeState = {
  listening: { kind: 'listening', port: 47_615 },
  browsers: [{ browserId: 'b1', browserName: 'Chrome on Linux', pairedAt: 1, connected: true }],
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

/**
 * Mount the row inside an open menu.
 *
 * `DropdownMenuSub` needs a menu around it, and an open one so the submenu
 * trigger exists at all. Everything else about the navigator — the columns,
 * the four stores behind them — is not what this asks about.
 */
async function renderRow(options: {
  readonly windowMode?: string;
  readonly reach?: string;
  readonly paneMode?: string | null;
  readonly paneBrowserId?: string | null;
  readonly providerId?: string;
  readonly bridge?: ExtensionBridgeState | null;
} = {}): Promise<void> {
  useApp.setState({
    browserMode: options.windowMode ?? 'embedded',
    extensionReach: options.reach ?? 'per-conversation',
    extensionBridge: options.bridge === undefined ? PAIRED_AND_AWAKE : options.bridge,
  } as never);
  setPaneState(focusedPane(), {
    activeProviderId: options.providerId ?? 'claude',
    browserMode: options.paneMode ?? null,
    browserExtensionId: options.paneBrowserId ?? null,
  } as never);

  render(
    <PaneProvider pane={focusedPane()}>
      <DropdownMenu open>
        <DropdownMenuContent>
          <BrowserRow />
        </DropdownMenuContent>
      </DropdownMenu>
    </PaneProvider>,
  );
  await act(async () => {});
}

/** Open the submenu and let its content mount. */
async function openSubmenu(): Promise<void> {
  await act(async () => {
    screen.getByText('Browser').closest('[data-slot="dropdown-menu-sub-trigger"]')?.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true }),
    );
  });
  await act(async () => {
    const trigger = screen.getByText('Browser').closest('[role="menuitem"]') as HTMLElement;
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await act(async () => {});
}

function option(name: string | RegExp): HTMLElement {
  return screen.getByRole('menuitemradio', { name });
}

afterEach(() => {
  cleanup();
});

describe('what the row says without being opened', () => {
  it('names the browser this conversation will actually use, and marks a default', async () => {
    await renderRow();

    expect(screen.getByText('Built-in')).toBeTruthy();
    // Two panes on the built-in browser can be in different states; only the
    // one following the window moves when the window's setting does.
    expect(screen.getByText('(default)')).toBeTruthy();
  });

  it('shows the built-in browser under a window set to My Chrome, per conversation', async () => {
    // The state this control exists to let somebody out of: the window says My
    // Chrome, the reach setting holds it back, and the conversation is on the
    // built-in browser until it asks.
    await renderRow({ windowMode: 'extension', reach: 'per-conversation' });

    expect(screen.getByText('Built-in')).toBeTruthy();
  });

  it('drops the default mark once this conversation has chosen', async () => {
    await renderRow({ paneMode: 'extension' });

    expect(screen.getByText('My Chrome')).toBeTruthy();
    expect(screen.queryByText('(default)')).toBeNull();
  });
});

describe('the five rows', () => {
  it('offers the four browsers and following the window', async () => {
    await renderRow();
    await openSubmenu();

    expect(option(/Follow the window default/u)).toBeTruthy();
    // Anchored: the follow row's note names the built-in browser too, which
    // is the whole point of that note.
    expect(option(/^Artemis’s built-in browser/u)).toBeTruthy();
    expect(option(/My Chrome \(Artemis extension\)/u)).toBeTruthy();
    expect(option(/Claude in Chrome/u)).toBeTruthy();
    expect(option(/Open in my browser/u)).toBeTruthy();
  });

  it('says what following the window resolves to right now', async () => {
    // "Follow the default" answers nothing on its own, and under
    // per-conversation reach the answer is not what the window's picker says.
    await renderRow({ windowMode: 'extension', reach: 'per-conversation' });
    await openSubmenu();

    expect(option(/Currently Artemis’s built-in browser/u)).toBeTruthy();
  });

  it('checks the row this conversation is on', async () => {
    await renderRow({ paneMode: 'external' });
    await openSubmenu();

    expect(option(/Open in my browser/u).getAttribute('data-state')).toBe('checked');
  });

  it('checks the follow row when nothing has been chosen', async () => {
    await renderRow();
    await openSubmenu();

    expect(option(/Follow the window default/u).getAttribute('data-state')).toBe('checked');
  });
});

describe('an option that cannot work', () => {
  it('is disabled and carries the reason, rather than vanishing', async () => {
    await renderRow({ bridge: { ...PAIRED_AND_AWAKE, browsers: [] } });
    await openSubmenu();

    const row = option(/^My Chrome \(Artemis extension\)/u);
    expect(row.getAttribute('data-disabled')).not.toBeNull();
    expect(row.textContent).toContain('No browser is paired yet');
    expect(row.textContent).toContain('Settings → Browser');
  });

  it('says to open Chrome when the paired browser is asleep', async () => {
    await renderRow({
      bridge: {
        ...PAIRED_AND_AWAKE,
        browsers: [{ ...PAIRED_AND_AWAKE.browsers[0]!, connected: false }],
      },
    });
    await openSubmenu();

    expect(option(/^My Chrome \(Artemis extension\)/u).textContent).toContain('not connected');
    // And the row for that browser by name says which browser to open, which
    // is the sentence somebody with two of them can act on.
    expect(option(/^My Chrome: Chrome on Linux/u).textContent).toContain(
      'Chrome on Linux is not connected',
    );
  });

  it('disables Claude in Chrome on a provider that has never heard of it', async () => {
    await renderRow({ providerId: 'codex' });
    await openSubmenu();

    const row = option(/Claude in Chrome/u);
    expect(row.getAttribute('data-disabled')).not.toBeNull();
    expect(row.textContent).toContain('Only Claude conversations');
  });

  it('leaves every option live on a machine where they all work', async () => {
    await renderRow();
    await openSubmenu();

    for (const name of [
      /Follow the window default/u,
      /^My Chrome \(Artemis extension\)/u,
      /^My Chrome: Chrome on Linux/u,
      /Claude in Chrome/u,
    ]) {
      expect(option(name).getAttribute('data-disabled')).toBeNull();
    }
  });
});

describe('choosing one', () => {
  it('writes the conversation’s own choice', async () => {
    await renderRow();
    await openSubmenu();

    await act(async () => {
      option(/^My Chrome \(Artemis extension\)/u).click();
    });

    expect(focusedPane().store.getState().browserMode).toBe('extension');
    // The plain row means whichever browser is open, so it names none.
    expect(focusedPane().store.getState().browserExtensionId).toBeNull();
  });

  it('writes the browser a named row picks, not just the mode', async () => {
    // The whole of issue #443 from this end: with two Chrome profiles paired,
    // "My Chrome" is not an answer and this row is.
    await renderRow();
    await openSubmenu();

    await act(async () => {
      option(/^My Chrome: Chrome on Linux/u).click();
    });

    expect(focusedPane().store.getState().browserMode).toBe('extension');
    expect(focusedPane().store.getState().browserExtensionId).toBe('b1');
  });

  it('is one click away from the paired Chrome, which is the point of it', async () => {
    // Requirement and regression at once: the shipped default is "each
    // conversation chooses", so the distance from a fresh conversation to the
    // paired browser is what decides whether that default means anything.
    await renderRow({ windowMode: 'extension', reach: 'per-conversation' });
    await openSubmenu();

    await act(async () => {
      option(/^My Chrome \(Artemis extension\)/u).click();
    });

    expect(focusedPane().store.getState().browserMode).toBe('extension');
  });

  it('clears the choice when the conversation goes back to following the window', async () => {
    // `null`, not the window's current value: the conversation has to move
    // again when the window's setting changes.
    await renderRow({ paneMode: 'external' });
    await openSubmenu();

    await act(async () => {
      option(/Follow the window default/u).click();
    });

    expect(focusedPane().store.getState().browserMode).toBeNull();
    expect(focusedPane().store.getState().browserExtensionId).toBeNull();
  });
});

describe('two browsers paired', () => {
  const TWO: ExtensionBridgeState = {
    ...PAIRED_AND_AWAKE,
    browsers: [
      { browserId: 'b1', browserName: 'Work', pairedAt: 1, connected: true },
      { browserId: 'b2', browserName: 'Personal', pairedAt: 2, connected: true },
    ],
  };

  it('offers a row per browser, under the one that means whichever is open', async () => {
    await renderRow({ bridge: TWO });
    await openSubmenu();

    expect(option(/^My Chrome: Work/u)).toBeTruthy();
    expect(option(/^My Chrome: Personal/u)).toBeTruthy();
    expect(option(/^My Chrome \(Artemis extension\)/u).textContent).toContain(
      'Whichever of them is open',
    );
  });

  it('names the chosen browser on the trigger, which is where it is checked', async () => {
    // "My Chrome" on two panes driving two different signed-in profiles is the
    // exact ambiguity this feature removes, so the trigger has to say which.
    await renderRow({ bridge: TWO, paneMode: 'extension', paneBrowserId: 'b2' });

    expect(screen.getByText('My Chrome: Personal')).toBeTruthy();
  });
});
