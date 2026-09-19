/**
 * @vitest-environment jsdom
 *
 * The rings stay on screen however narrow the column is.
 *
 * Reported on 2026-09-19: shrink the window and the context ring goes off the
 * right edge. Every chip on the status line is a `Button`, whose base classes
 * carry `shrink-0`, so the meter was the one item on the row able to shrink.
 * It shrank, and its rings ran past the pane's clipped edge — measured in
 * Chromium before the fix: Ctx cut at a 760px pane, Fable and Ctx gone at
 * 680px, every ring gone at 560px, and the `bypass` chip clipped from 440px
 * down.
 *
 * jsdom does no layout, so what these pin is the contract that measurement
 * showed is load-bearing: the rings never shrink, the profile and model chips
 * do, the mode chip keeps its word, and the row wraps the rings onto a line of
 * their own rather than letting anything run off the edge. The same row was
 * measured after the fix at every width from 360px to 900px, with all four
 * rings and their labels inside the pane each time.
 *
 * `renderer/tsconfig.json` excludes this file, so the assertions are
 * behavioural.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { StatusLine } from '@/components/StatusLine';
import { ALL_CAPABILITIES, seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  usagePlan: {
    cached: async () => ({ ok: true, value: { usage: null } }),
    refresh: async () => ({ ok: true, value: { usage: null } }),
  },
};

const CAPABILITIES = {
  ...ALL_CAPABILITIES,
  planUsageReporting: true,
  contextReporting: true,
  permissionModes: ['default', 'bypassPermissions'],
};

function seed(): void {
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: CAPABILITIES,
        models: [{ id: 'opus-5', label: 'Opus 5' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [
      { id: 'p1', label: 'Artemis Server — work max', providerId: 'claude', configDir: '/x' },
    ],
    activeProfileId: 'p1',
    permissionMode: 'bypassPermissions',
    model: 'opus-5',
    cwd: '/code/api',
    workspace: null,
    run: {
      runId: 'run-1',
      status: 'ended',
      providerId: 'claude',
      profileId: 'p1',
      cwd: '/code/api',
      capabilities: CAPABILITIES,
      startedAt: 1,
      model: 'opus-5',
      usage: { scope: 'cumulative', tokens: {}, contextTokens: 12_300, contextWindow: 32_768 },
    },
    sessions: [],
    permissionQueue: [],
    banners: [],
    planUsageByProfile: {},
  } as never);
}

function mount(): void {
  seed();
  render(
    <TooltipProvider delayDuration={0}>
      <StatusLine />
    </TooltipProvider>,
  );
}

/** Whole class tokens, so `shrink` is not found inside `shrink-0`. */
function classes(element: Element | null): readonly string[] {
  return (element?.getAttribute('class') ?? '').split(/\s+/);
}

function rings(): HTMLElement {
  return screen.getByRole('button', { name: /Plan usage/ });
}

afterEach(cleanup);

describe('the status line on a narrow column', () => {
  it('never shrinks the rings', () => {
    mount();

    expect(classes(rings().parentElement)).toContain('shrink-0');
    // All four of them, the context ring included.
    expect(rings().textContent ?? '').toContain('Ctx');
  });

  it('lets the profile and model chips give way instead', () => {
    mount();

    const profile = screen.getByRole('button', { name: 'Profile' });
    const model = screen.getByRole('button', { name: 'Model' });

    // The `Button` base says `shrink-0`; the chips must override it, or the
    // rings are the only thing on the row that can yield.
    expect(classes(profile)).not.toContain('shrink-0');
    expect(classes(model)).not.toContain('shrink-0');
    // The profile yields fastest: it is the widest, and its first words
    // already say which account it is.
    expect(classes(profile)).toContain('shrink-2');
    expect(classes(model)).toContain('shrink');
    // Squeezed past its icon, a chip clips itself rather than painting over
    // its neighbour.
    expect(classes(profile)).toContain('overflow-hidden');
    expect(classes(model)).toContain('overflow-hidden');
  });

  it('keeps the permission mode whole', () => {
    mount();

    expect(classes(screen.getByRole('button', { name: 'Permission mode' }))).toContain('shrink-0');
  });

  it('wraps the rings onto a line of their own rather than off the edge', () => {
    mount();

    const row = rings().parentElement?.parentElement ?? null;
    expect(classes(row)).toContain('flex-wrap');

    // The chips are measured at 22rem when the row decides whether the rings
    // still fit beside them, and they take whatever the rings leave.
    const chips = screen.getByRole('button', { name: 'Profile' }).parentElement;
    expect(chips?.parentElement).toBe(row);
    expect(classes(chips)).toEqual(expect.arrayContaining(['basis-88', 'grow', 'min-w-0']));
  });

  it('keeps the run state with the chips, so the rings are one width whatever the run does', () => {
    mount();

    const state = screen.getByText('ended');
    const chips = screen.getByRole('button', { name: 'Profile' }).parentElement;
    expect(chips?.contains(state)).toBe(true);
    expect(rings().parentElement?.contains(state)).toBe(false);
  });
});
