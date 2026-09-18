/**
 * The rings follow the poll — and every ring follows every refresh.
 *
 * @vitest-environment jsdom
 *
 * Artemis held "how full is this account" in two places, and for a while they
 * were not connected:
 *
 *  - the meter's **own state**, filled on mount, on a profile change, and when
 *    the popover opens;
 *  - **`planUsageByProfile`** in the app store, which the main process's poll
 *    pushes into every few minutes for every account.
 *
 * The rings rendered the first and never read the second, so the three numbers
 * on the status bar were frozen at whatever the last load returned. Sit on one
 * account while an agent works through a long job and the 5-hour ring would not
 * move — though the true figure was in the store the whole time. Reloading the
 * window fixed it, because that remounts the meter, which is exactly the "I have
 * to refresh to see changes" this was reported as (#146).
 *
 * Reading both was the first half of the answer and left the second half open:
 * a meter's own state is *per mounted meter*, so a refresh in one pane wrote a
 * number only that pane could see, and the pane beside it — and the navigator's
 * footer, the profile menu, the handoff picker — kept the older one until the
 * next poll cycle. The same account showing two numbers on one screen is what
 * was reported the second time.
 *
 * So there is no meter-local copy any more: the store holds one reading per
 * account, every meter reads it, and a refresh writes into it. The ordering that
 * used to live in the component lives in the store's own merge, where it can
 * apply to every writer instead of one — which is what the last two cases here
 * are about.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PlanUsage } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { StatusLine } from '@/components/StatusLine';
import { seedApp } from '@/state/testkit';
import { acceptPlanUsage, useApp } from '@/state/store';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

/** What the meter's own `cached`/`refresh` calls answer. */
let answer: PlanUsage | null = null;

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  usagePlan: {
    cached: async () => ({ ok: true, value: { usage: answer } }),
    refresh: async () => ({ ok: true, value: { usage: answer } }),
  },
};

const CAPABILITIES = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
};

/** A reading of the 5-hour window, stamped so the two sources can be ordered. */
function reading(utilization: number, fetchedAt: number): PlanUsage {
  return {
    available: true,
    subscriptionType: 'max',
    fetchedAt,
    windows: [{ id: 'five_hour', label: '5 hours', utilization, resetsAt: null }],
  };
}

function seed(planUsageByProfile: Record<string, PlanUsage> = {}): void {
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: CAPABILITIES,
        models: [],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [
      { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/home/u/.claude' },
      { id: 'p2', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' },
    ],
    activeProfileId: 'p1',
    cwd: '/code/api',
    workspace: null,
    run: null,
    sessions: [],
    permissionQueue: [],
    banners: [],
    planUsageByProfile,
  });
}

function mount(copies = 1): void {
  render(
    <TooltipProvider delayDuration={0}>
      {Array.from({ length: copies }, (_, index) => (
        <StatusLine key={index} />
      ))}
    </TooltipProvider>,
  );
}

/** The trigger, whose accessible name spells out every ring's number. */
function meter(): HTMLElement {
  return meters()[0]!;
}

/** Every mounted meter's trigger, for the two-pane case. */
function meters(): HTMLElement[] {
  return screen.getAllByRole('button', { name: /Plan usage/ });
}

afterEach(() => {
  cleanup();
  answer = null;
});

describe('a reading pushed by the poll', () => {
  it('reaches the rings without anything being clicked', async () => {
    // The whole bug. Nothing here opens the popover, switches account or
    // reloads; the poll simply pushes, and the number has to move.
    answer = null;
    seed();
    mount();

    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('—'));

    act(() => {
      useApp.setState({ planUsageByProfile: { p1: reading(61, 5_000) } });
    });

    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('61'));
  });

  it('keeps moving as the account fills up', async () => {
    // A long session on one account: several cycles land while the user does
    // nothing. Each has to be visible, not just the first.
    seed({ p1: reading(20, 1_000) });
    mount();
    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('20'));

    for (const [utilization, at] of [
      [45, 2_000],
      [72, 3_000],
      [91, 4_000],
    ] as const) {
      act(() => {
        useApp.setState({ planUsageByProfile: { p1: reading(utilization, at) } });
      });
      await waitFor(() =>
        expect(meter().getAttribute('aria-label')).toContain(String(utilization)),
      );
    }
  });

  it('is ignored when it is older than what the account already reads', async () => {
    /*
      The other direction, and the reason the store merges rather than taking
      whatever lands last. The manual refresh button under these rings now
      writes into the same map the poll pushes into, so a stale cycle arriving
      afterwards has to be refused *there* — the meter has no copy of its own
      left to protect it.
    */
    answer = reading(88, 9_000);
    seed();
    mount();

    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('88'));

    act(() => {
      acceptPlanUsage('p1' as never, reading(12, 1_000));
    });

    // Still the newer figure, a tick later.
    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('88'));
    expect(meter().getAttribute('aria-label')).not.toContain('12');
  });

  it('reaches a second meter that nobody refreshed', async () => {
    /*
      The reported bug, in the smallest shape that shows it: two meters on one
      account, a refresh in one of them. With a reading held per mounted meter,
      the one that was clicked moved and the other did not — "one session
      reports it near zero while this session reported it as 100%".

      Both mount on the cached 100, the popover on the first is opened (which is
      what fires a refresh), and the fresh 2 has to appear under both.
    */
    answer = reading(100, 1_000);
    seed();
    mount(2);

    await waitFor(() => {
      for (const one of meters()) expect(one.getAttribute('aria-label')).toContain('100');
    });

    answer = reading(2, 2_000);
    fireEvent.click(meters()[0]!);

    await waitFor(() => {
      for (const one of meters()) expect(one.getAttribute('aria-label')).toContain('5hr 2%');
    });
    expect(meters()).toHaveLength(2);
  });

  it('is used when the meter has nothing of its own', async () => {
    // The first cycle after launch, before the popover has ever been opened.
    answer = null;
    seed({ p1: reading(33, 5_000) });
    mount();

    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('33'));
  });

  it('is read for the account in front of the user, not some other one', async () => {
    // The map holds every profile. Selecting the wrong entry would put another
    // account's limits under this account's name — the mislabelling the
    // in-flight guard beside this already exists to prevent.
    seed({ p1: reading(15, 5_000), p2: reading(97, 6_000) });
    mount();

    await waitFor(() => expect(meter().getAttribute('aria-label')).toContain('15'));
    expect(meter().getAttribute('aria-label')).not.toContain('97');
  });
});
