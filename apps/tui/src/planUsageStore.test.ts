/**
 * One plan reading per account, for a terminal that holds several
 * conversations.
 *
 * The gauge under the composer is a fact about the *account*, and this process
 * can have more than one conversation spending it: a second tab on the same
 * profile, a conversation parked in the rail, the failover picker probing every
 * account it could move to. Each `Conversation` used to hold its own copy,
 * written only by whatever it happened to read or fold itself — so one tab
 * could sit at the figure from before a 5-hour window reset while the tab beside
 * it showed the figure after.
 *
 * What is asserted here is the sharing and the ordering: a reading taken
 * anywhere is visible everywhere, and nothing can write an account's gauge
 * backwards on its way in.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  Capabilities,
  PlanUsage,
  RunHandle,
  RunId,
  RunInput,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';
import { syncScheduler } from '@rx-artemis/transcript';

import { Conversation, type ConversationSettings, type RunDriver } from './conversation.js';
import { createPlanUsageStore, seedablePlanUsage } from './planUsageStore.js';

const CLAUDE: Capabilities = { ...NO_CAPABILITIES, resumeSession: true };

const settingsFor = (profileId: string): ConversationSettings => ({
  profileId: profileId as never,
  providerId: 'claude',
  profileLabel: 'work',
  providerLabel: 'Claude',
  cwd: '/repo',
  permissionMode: 'default',
});

/** The least driver a conversation will accept, plus a way to feed it events. */
function fakeDriver() {
  const listeners = new Set<(event: AgentEvent) => void>();
  const driver: RunDriver & { emit(event: Omit<AgentEvent, 'seq' | 'ts'> & { ts: number }): void } = {
    start: vi.fn(
      async (input: RunInput): Promise<RunHandle> => ({
        runId: input.runId as RunId,
        providerId: input.providerId,
        profileId: input.profileId,
        cwd: input.cwd,
        status: 'running',
        capabilities: CLAUDE,
        startedAt: 0,
        promptCount: 1,
      }),
    ),
    send: vi.fn(async () => ({ deliveredImmediately: false })),
    interrupt: vi.fn(async () => ({})),
    respondToPermission: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => undefined),
    isActive: () => true,
    get: () => undefined,
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener({ seq: 1, ...event } as AgentEvent);
    },
  } as never;
  return driver;
}

/** A window with its own observation time, which is what the merge orders on. */
const window_ = (id: string, utilization: number, at: number): PlanUsage['windows'][number] => ({
  id,
  label: id,
  utilization,
  resetsAt: null,
  at,
});

const snapshot = (windows: PlanUsage['windows'], fetchedAt: number): PlanUsage => ({
  available: true,
  subscriptionType: 'max',
  windows,
  fetchedAt,
});

/** A conversation on `profileId`, sharing `store`. */
function conversationOn(profileId: string, store: ReturnType<typeof createPlanUsageStore>) {
  return new Conversation({
    driver: fakeDriver(),
    settings: settingsFor(profileId),
    capabilitiesFor: () => CLAUDE,
    scheduler: syncScheduler,
    planUsage: store,
  });
}

const fiveHourOf = (conversation: Conversation): number | null | undefined =>
  conversation.getState().planUsage?.windows.find((w) => w.id === 'five_hour')?.utilization;

describe('two conversations on one account', () => {
  it('read the same gauge, whichever of them was refreshed', () => {
    // The reported bug in the smallest shape the terminal can make it: one
    // account, two conversations, a reading taken by one of them.
    const store = createPlanUsageStore();
    const first = conversationOn('p1', store);
    const second = conversationOn('p1', store);
    try {
      first.setPlanUsage(snapshot([window_('five_hour', 2, 2_000)], 2_000));

      expect(fiveHourOf(first)).toBe(2);
      expect(fiveHourOf(second)).toBe(2);
      expect(second.getState().planUsage).toBe(first.getState().planUsage);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('wake each other up, so a parked tab is not left redrawing nothing', () => {
    const store = createPlanUsageStore();
    const first = conversationOn('p1', store);
    const second = conversationOn('p1', store);
    let woke = 0;
    const off = second.subscribe(() => {
      woke += 1;
    });
    try {
      first.setPlanUsage(snapshot([window_('five_hour', 2, 2_000)], 2_000));
      expect(woke).toBe(1);

      // The same reading again is not news, and must not redraw the screen.
      first.setPlanUsage(snapshot([window_('five_hour', 2, 1_000)], 1_000));
      expect(woke).toBe(1);
    } finally {
      off();
      first.dispose();
      second.dispose();
    }
  });

  it('keep their own accounts apart', () => {
    const store = createPlanUsageStore();
    const work = conversationOn('p1', store);
    const personal = conversationOn('p2', store);
    try {
      work.setPlanUsage(snapshot([window_('five_hour', 2, 2_000)], 2_000));

      expect(fiveHourOf(work)).toBe(2);
      expect(personal.getState().planUsage).toBeNull();
    } finally {
      work.dispose();
      personal.dispose();
    }
  });

  it('do not undo each other with an older reading', () => {
    /*
      Two conversations on one account are two readers of one gauge and two
      writers of it. A refresh in a tab that had been parked for a while would
      otherwise put that tab's older numbers back under both composers.
    */
    const store = createPlanUsageStore();
    const first = conversationOn('p1', store);
    const second = conversationOn('p1', store);
    try {
      first.setPlanUsage(snapshot([window_('five_hour', 2, 2_000)], 2_000));
      second.setPlanUsage(snapshot([window_('five_hour', 100, 1_000)], 1_000));

      expect(fiveHourOf(first)).toBe(2);
      expect(fiveHourOf(second)).toBe(2);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('keep a live verdict one of them heard, and the other\'s fresher numbers', () => {
    /*
      The reported sequence, in the terminal. A run in one conversation is told
      the weekly window is refused, which folds into the gauge and stamps it —
      and then a poll that actually saw the 5-hour window reset answers with 2.
      Ordered by snapshot the poll looks older and is thrown away, and the
      pre-reset 100 stands under both composers.
    */
    const store = createPlanUsageStore();
    const running = conversationOn('p1', store);
    const idle = conversationOn('p1', store);
    try {
      running.setPlanUsage(
        snapshot([window_('five_hour', 100, 1_000), window_('seven_day', 40, 1_000)], 1_000),
      );
      // The verdict, folded through the store by the conversation that heard it.
      store.merge(
        'p1' as never,
        snapshot(
          [
            window_('five_hour', 100, 1_000),
            { id: 'seven_day', label: 'seven_day', utilization: 40, resetsAt: null, at: 2_000, status: 'rejected' },
          ],
          2_000,
        ),
      );

      running.setPlanUsage(snapshot([window_('five_hour', 2, 1_500)], 1_500));

      for (const conversation of [running, idle]) {
        const usage = conversation.getState().planUsage;
        expect(usage?.windows.find((w) => w.id === 'five_hour')?.utilization).toBe(2);
        expect(usage?.windows.find((w) => w.id === 'seven_day')?.status).toBe('rejected');
      }
    } finally {
      running.dispose();
      idle.dispose();
    }
  });

  it('learn nothing from a read that failed', () => {
    // `null` is "could not read", which is not "no limits" and not "zero used".
    const store = createPlanUsageStore();
    const one = conversationOn('p1', store);
    try {
      one.setPlanUsage(snapshot([window_('five_hour', 2, 2_000)], 2_000));
      one.setPlanUsage(null);
      expect(fiveHourOf(one)).toBe(2);
    } finally {
      one.dispose();
    }
  });
});

describe('a reading remembered from the last launch', () => {
  const NOW = 1_700_000_000_000;
  const remembered = snapshot([window_('five_hour', 40, NOW)], NOW);

  it('is shown while the fresh read is on its way', () => {
    expect(seedablePlanUsage({ at: NOW - 60_000, value: remembered }, NOW)).toBe(remembered);
  });

  it('is not shown once the windows will have moved under it', () => {
    /*
      It was allowed to be a day old, so a launch opened on last night's
      percentages and jumped when the real reading landed a second later — two
      numbers for one account, one after the other. Past the protocol's own
      staleness bar there is nothing honest to draw: a 5-hour window may have
      rolled over twice since.
    */
    expect(seedablePlanUsage({ at: NOW - 24 * 60 * 60_000, value: remembered }, NOW)).toBeNull();
    expect(seedablePlanUsage({ at: NOW - 7 * 60_000, value: remembered }, NOW)).toBeNull();
  });

  it('is nothing at all when nothing was remembered', () => {
    expect(seedablePlanUsage(undefined, NOW)).toBeNull();
  });

  it('is aged from the oldest thing in it, not from when the file was written', () => {
    /*
      What gets written is the merged gauge, which can carry a window a live
      verdict refreshed seconds ago beside percentages nobody has re-read in an
      hour. The file's own timestamp would call all of it current.
    */
    const stale = snapshot(
      [window_('five_hour', 40, NOW - 60 * 60_000), window_('seven_day', 9, NOW)],
      NOW,
    );

    expect(seedablePlanUsage({ at: NOW, value: stale }, NOW)).toBeNull();
  });

  it('survives a clock that disagrees with itself', () => {
    // A reading stamped in the future is a clock skew, not an ancient reading.
    expect(seedablePlanUsage({ at: NOW + 60_000, value: remembered }, NOW)).toBe(remembered);
  });
});
