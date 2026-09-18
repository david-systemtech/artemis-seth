/**
 * @vitest-environment jsdom
 *
 * Routines, as the pane makes them, and the one property that has to hold: a
 * routine goes to the place it runs. A *Local* routine is created through the
 * desktop's own `routines` bridge; a *Server* routine through that server's
 * `serverRoutines` bridge — and sending one to the wrong bridge is a routine
 * that fires on the wrong machine, or not at all.
 *
 * The Local path is exercised through the real form (its inputs are plain
 * fields and its default is Local, so no menu-driving is needed). The Server
 * routing is exercised through `useRoutines` directly, because the load-bearing
 * fact there is *which bridge a server location reaches*, not the Radix select
 * that picks it — the same reason the other component tests reach for the hook
 * when a menu would only add flake.
 *
 * `renderer/tsconfig.json` excludes this file, so the assertions are behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

/** What the fake bridge captured, reset per test. */
let localCreated: Record<string, unknown>[] = [];
let serverCreated: { profileId: string; draft: Record<string, unknown> }[] = [];

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const ok = (value: unknown) => ({ ok: true as const, value });

vi.stubGlobal('artemis', {
  version: 'test',
  platform: 'darwin',
  profiles: { list: async () => ok({ profiles: [] }) },
  auth: { status: async () => ok({ status: { loggedIn: true } }) },
  sessions: { list: async () => ok({ sessions: [] }) },
  providers: { models: async () => ok({ models: [], live: false }) },
  serverAccounts: {
    list: async () =>
      ok({
        manageProfiles: true,
        accounts: [
          {
            id: 'served-1',
            slug: 'work',
            label: 'Served Work',
            provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
            available: true,
            disabled: false,
            live: true,
            capabilities: {},
            models: [{ id: 'opus', label: 'Opus', thinkingLevels: [] }],
          },
        ],
      }),
  },
  routines: {
    list: async () => ok({ state: { routines: [] } }),
    onChange: () => () => undefined,
    create: async ({ draft }: { draft: Record<string, unknown> }) => {
      localCreated.push(draft);
      return ok({ state: { routines: [] } });
    },
    update: async () => ok({ state: { routines: [] } }),
    remove: async () => ok({ state: { routines: [] } }),
    runNow: async () => ok({ state: { routines: [] } }),
  },
  serverRoutines: {
    list: async () => ok({ routines: [] }),
    create: async ({ profileId, draft }: { profileId: string; draft: Record<string, unknown> }) => {
      serverCreated.push({ profileId, draft });
      return ok({
        routine: {
          id: 'server-routine-1',
          name: draft['name'],
          instructions: draft['instructions'],
          cwd: '/srv',
          profileId: draft['profileId'],
          providerId: draft['providerId'],
          schedule: draft['schedule'],
          paused: false,
          createdAt: 0,
          scope: 'dir:/srv',
          connectionId: 'c1',
          running: false,
          history: [],
        },
      });
    },
    update: async () => ok({ routine: {} }),
    delete: async () => ok({ removed: true }),
    runNow: async () => ok({ routine: {} }),
  },
});

const { RoutinesSection } = await import('@/components/settings/RoutinesSection');
const { useRoutines } = await import('@/hooks/useRoutines');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { seedApp } = await import('@/state/testkit');

const LOCAL_PROFILE = {
  id: 'p-local',
  label: 'Local Claude',
  providerId: 'claude',
  configDir: '/home/u/.claude',
};
const SERVER_PROFILE = {
  id: 'p-server',
  label: 'Kronos',
  providerId: 'artemis',
  configDir: '/home/u/.artemis',
};

function seed(profiles: Record<string, unknown>[]): void {
  seedApp({
    providers: [
      { id: 'claude', label: 'Claude', kind: 'hosted', available: true, capabilities: {} },
      { id: 'artemis', label: 'Artemis Server', kind: 'local', available: true, capabilities: {} },
    ],
    profiles,
    activeProviderId: 'claude',
    activeProfileId: 'p-local',
    platform: 'darwin',
    sessions: [],
    banners: [],
  });
}

beforeEach(() => {
  localCreated = [];
  serverCreated = [];
});
afterEach(cleanup);

describe('the routines pane', () => {
  it('submits a Local routine to the local bridge', async () => {
    seed([LOCAL_PROFILE]);
    render(
      <TooltipProvider delayDuration={0}>
        <RoutinesSection />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /New routine/i }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nightly digest' } });
    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Summarise the day.' },
    });
    fireEvent.change(screen.getByLabelText('Directory'), {
      target: { value: '/Users/me/project' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create routine' }));

    await waitFor(() => expect(localCreated).toHaveLength(1));
    expect(localCreated[0]).toMatchObject({
      name: 'Nightly digest',
      instructions: 'Summarise the day.',
      cwd: '/Users/me/project',
      profileId: 'p-local',
      permissionMode: 'bypassPermissions',
    });
    // A local routine never reaches the server bridge.
    expect(serverCreated).toHaveLength(0);
  });

  it('routes a Server routine to that server\'s remote bridge', async () => {
    seed([LOCAL_PROFILE, SERVER_PROFILE]);
    const { result } = renderHook(() => useRoutines());

    await act(async () => {
      result.current.create(
        { kind: 'server', profileId: 'p-server', profileLabel: 'Kronos' },
        {
          name: 'Server sweep',
          instructions: 'Sweep the server.',
          profileId: 'served-1',
          providerId: 'claude',
          permissionMode: 'bypassPermissions',
          schedule: { kind: 'daily', at: '09:00' },
        },
      );
    });

    await waitFor(() => expect(serverCreated).toHaveLength(1));
    expect(serverCreated[0]?.profileId).toBe('p-server');
    expect(serverCreated[0]?.draft).toMatchObject({ name: 'Server sweep', profileId: 'served-1' });
    // A server routine never reaches the local bridge.
    expect(localCreated).toHaveLength(0);
  });
});
