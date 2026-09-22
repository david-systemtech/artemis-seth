/**
 * @vitest-environment jsdom
 *
 * The Browser picker, in Permissions & access: four options, and the ones that
 * cannot work say why.
 *
 * This replaced two independent switches whose four combinations were three
 * answers. What is worth pinning is not that a radio group renders but the
 * three things a person reads off it:
 *
 *  - **Every option is always listed.** An option that vanished when it could
 *    not be used would leave the user unable to find out that Artemis has the
 *    feature at all — which is the state "My Chrome" is in on a fresh install,
 *    when nothing is paired yet.
 *  - **A disabled option carries its reason.** Without one, a dimmed row is a
 *    dead end: the user can see Artemis will not give them the thing and has
 *    nothing to act on. Each reason names the fix.
 *  - **The two questions are separate.** Which browser, and how conversations
 *    come by the paired one. The second has its own group because it is only
 *    about one of the four.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files,
 * so `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NO_CAPABILITIES, type ExtensionBridgeState } from '@rx-artemis/protocol';

import { PermissionsSection } from '@/components/settings/PermissionsSection';
import { TooltipProvider } from '@/components/ui/tooltip';
import { focusedPane, useApp } from '@/state/store';
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
  browsers: [
    { browserId: 'b1', browserName: 'Chrome on Linux', pairedAt: 1, connected: true },
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

/** Three profiles paired, one of them shut: the case the names exist for. */
const TWO_PAIRED: ExtensionBridgeState = {
  ...PAIRED_AND_AWAKE,
  browsers: [
    { browserId: 'b-work', browserName: 'Work', pairedAt: 1, connected: true },
    { browserId: 'b-personal', browserName: 'Personal', pairedAt: 2, connected: true },
    { browserId: 'b-laptop', browserName: 'Laptop', pairedAt: 3, connected: false },
  ],
};

async function renderPane(options: {
  readonly providerId?: string;
  readonly bridge?: ExtensionBridgeState | null;
} = {}): Promise<void> {
  useApp.setState({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: { ...NO_CAPABILITIES, permissionModes: ['default', 'plan'] },
        models: [],
      },
      {
        id: 'codex',
        label: 'Codex',
        capabilities: { ...NO_CAPABILITIES, permissionModes: ['default'] },
        models: [],
      },
    ],
    browserMode: 'embedded',
    extensionReach: 'per-conversation',
    extensionBridge: options.bridge === undefined ? PAIRED_AND_AWAKE : options.bridge,
  } as never);
  setPaneState(focusedPane(), {
    activeProviderId: options.providerId ?? 'claude',
    permissionMode: 'default',
  } as never);

  render(
    <TooltipProvider>
      <PermissionsSection />
    </TooltipProvider>,
  );
  await act(async () => {});
}

/** The radio for one option, by its visible label. */
function option(name: string): HTMLElement {
  return screen.getByRole('radio', { name: new RegExp(name, 'u') });
}

/**
 * The sentence attached to a disabled option.
 *
 * `ChoiceList` hangs it off `WithReason`, which is a tooltip: the words are
 * not in the document until the wrapper is hovered or focused. So the reason
 * is read by opening it, which is also what a person does. Radix renders the
 * content into a portal, hence the search from `document.body`.
 */
async function reasonFor(name: string): Promise<string> {
  const wrapper = option(name).closest('[data-slot="reason-wrapper"]');
  if (wrapper === null) throw new Error(`“${name}” carries no reason`);
  await act(async () => {
    fireEvent.focus(wrapper);
  });
  await act(async () => {});
  return within(document.body).getAllByRole('tooltip')[0]?.textContent ?? '';
}

afterEach(() => {
  cleanup();
});

describe('the four options', () => {
  it('lists all four, whatever the machine can do', async () => {
    await renderPane({ providerId: 'codex', bridge: null });

    expect(option('Artemis’s built-in browser')).toBeTruthy();
    expect(option('My Chrome \\(Artemis extension\\)')).toBeTruthy();
    expect(option('Claude in Chrome')).toBeTruthy();
    expect(option('Open in my browser')).toBeTruthy();
  });

  it('starts on the built-in browser, which grants nothing', async () => {
    await renderPane();

    expect(option('Artemis’s built-in browser').getAttribute('data-state')).toBe('checked');
  });

  it('says what each option does in a sentence', async () => {
    await renderPane();

    expect(screen.getByText(/Signed in to nothing/u)).toBeTruthy();
    expect(screen.getByText(/Your real Chrome, with your logins/u)).toBeTruthy();
    expect(screen.getByText(/The agent cannot read them/u)).toBeTruthy();
  });
});

describe('an option that cannot work is disabled, with the reason on screen', () => {
  it('disables Claude in Chrome on a provider that has never heard of it', async () => {
    await renderPane({ providerId: 'codex' });

    expect(option('Claude in Chrome').hasAttribute('disabled')).toBe(true);
    expect(await reasonFor('Claude in Chrome')).toContain('Only Claude conversations can use');
  });

  it('leaves Claude in Chrome available on Claude', async () => {
    await renderPane({ providerId: 'claude' });

    expect(option('Claude in Chrome').hasAttribute('disabled')).toBe(false);
  });

  it('disables the Artemis extension when no browser is paired, and points at the pane', async () => {
    await renderPane({ bridge: { ...PAIRED_AND_AWAKE, browsers: [] } });

    expect(option('My Chrome \\(Artemis extension\\)').hasAttribute('disabled')).toBe(true);
    const reason = await reasonFor('My Chrome \\(Artemis extension\\)');
    expect(reason).toContain('No browser is paired yet');
    expect(reason).toContain('Settings → Browser');
  });

  it('disables it when the paired browser is not connected, and says to open Chrome', async () => {
    await renderPane({
      bridge: {
        ...PAIRED_AND_AWAKE,
        browsers: [{ ...PAIRED_AND_AWAKE.browsers[0]!, connected: false }],
      },
    });

    expect(option('My Chrome \\(Artemis extension\\)').hasAttribute('disabled')).toBe(true);
    expect(await reasonFor('My Chrome \\(Artemis extension\\)')).toContain(
      'paired browser is not connected',
    );
  });

  it('treats a window that has not heard from main as having nothing paired', async () => {
    // The safe way round: `null` is "not asked yet", and offering an option
    // that may not exist would be a control that fails at the run.
    await renderPane({ bridge: null });

    expect(option('My Chrome \\(Artemis extension\\)').hasAttribute('disabled')).toBe(true);
  });

  it('leaves it available once a paired browser is awake, on any provider', async () => {
    await renderPane({ providerId: 'codex' });

    expect(option('My Chrome \\(Artemis extension\\)').hasAttribute('disabled')).toBe(false);
  });
});

describe('choosing one', () => {
  it('records the choice, so the next run carries it', async () => {
    await renderPane();

    await act(async () => {
      option('Open in my browser').click();
    });

    expect(useApp.getState().browserMode).toBe('external');
    expect(useApp.getState().browserExtensionId).toBeNull();
  });

  it('records which browser, when a named row is the one chosen', async () => {
    // A person may want every new conversation on their work profile by
    // default, and a window setting that could only say "my Chrome" would
    // leave that to whichever Chrome connected first.
    await renderPane({ bridge: TWO_PAIRED });

    await act(async () => {
      option('My Chrome: Personal').click();
    });

    expect(useApp.getState().browserMode).toBe('extension');
    expect(useApp.getState().browserExtensionId).toBe('b-personal');
  });

  it('clears the browser again when the plain row is chosen', async () => {
    // The plain row means whichever is open, which is a different setting from
    // whichever was last named — and leaving a stale id behind would make the
    // two indistinguishable.
    await renderPane({ bridge: TWO_PAIRED });

    await act(async () => {
      option('My Chrome: Personal').click();
    });
    await act(async () => {
      option('My Chrome \\(Artemis extension\\)').click();
    });

    expect(useApp.getState().browserExtensionId).toBeNull();
  });

  it('draws a row per paired browser, and disables the one that is shut', async () => {
    await renderPane({ bridge: TWO_PAIRED });

    expect(option('My Chrome: Work').hasAttribute('disabled')).toBe(false);
    expect(option('My Chrome: Personal').hasAttribute('disabled')).toBe(false);
    expect(option('My Chrome: Laptop').hasAttribute('disabled')).toBe(true);
    expect(await reasonFor('My Chrome: Laptop')).toContain('Laptop is not connected');
  });
});

describe('how conversations get the paired Chrome', () => {
  it('offers the two reaches, starting on “each conversation chooses”', async () => {
    await renderPane();

    expect(screen.getByRole('radio', { name: /Each conversation chooses/u }).getAttribute('data-state')).toBe(
      'checked',
    );
    expect(screen.getByRole('radio', { name: /Always on/u })).toBeTruthy();
  });

  it('records always-on when it is chosen', async () => {
    await renderPane();

    await act(async () => {
      screen.getByRole('radio', { name: /Always on/u }).click();
    });

    expect(useApp.getState().extensionReach).toBe('always-on');
  });
});
