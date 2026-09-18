/**
 * Refreshing a gauge tells every window, not just the one that asked.
 *
 * A plan reading is a fact about an *account*. The renderer holds one per
 * account and every meter, ring, footer, menu row and handoff picker reads it —
 * but the reading only gets there if main says so, and for a local provider
 * main used to say so to nobody. `IPC.usagePlanRefresh` answered the caller and
 * returned; the Artemis Server branch beside it broadcast, because its gauges
 * have no other way home. So pressing refresh in one pane moved that pane, and
 * the pane next to it kept the older number until the poll came round up to two
 * minutes later. One account, two numbers, one screen — which is what this was
 * reported as.
 *
 * What is asserted here is the wiring, because the wiring is the bug: the
 * handler goes through `broadcastPlanUsageReading`, which is the poll's own
 * push, so a refresh is indistinguishable from a poll cycle by the time it
 * reaches a window. The reply is the engine's cache rather than the read, for
 * the same reason — a caller holding something the push disagreed with would be
 * the bug again, one window smaller.
 *
 * Driven through `registerIpcHandlers` rather than the handler map, so what is
 * exercised is the channel a renderer actually invokes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC, mergePlanUsage, type PlanUsage } from '@rx-artemis/protocol';

/** Every `ipcMain.handle` registration, so a test can invoke one. */
const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
/** What each open window was sent, in order. */
let delivered: { window: number; channel: string; payload: unknown }[] = [];
/** How many windows are open. Reassigned per test. */
let windowCount = 1;

vi.mock('electron', () => {
  const windows = (): unknown[] =>
    Array.from({ length: windowCount }, (_, index) => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => {
          delivered.push({ window: index, channel, payload });
        },
      },
    }));
  return {
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, raw: unknown) => Promise<unknown>) => {
        handlers.set(channel, handler);
      },
      removeHandler: (channel: string) => {
        handlers.delete(channel);
      },
    },
    BrowserWindow: { getAllWindows: windows, fromWebContents: () => null },
    dialog: {},
    shell: {},
    app: { getPath: () => '/tmp' },
  };
});

// Every request in this file comes from Artemis's own top frame; the trust
// check itself is `security.test.ts`'s subject.
vi.mock('./security.js', () => ({ isTrustedFrame: () => true }));

const { registerIpcHandlers } = await import('./ipc.js');

/** A renderer's invoke event, as much of one as `assertTrustedSender` reads. */
const invokeEvent = (): unknown => {
  const mainFrame = { url: 'file:///app/index.html' };
  return { senderFrame: mainFrame, sender: { mainFrame } };
};

/** A window of one account's plan, stamped with when it was observed. */
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

/** Every profile whose usage the engine was asked to re-read. */
let reads: string[] = [];

/**
 * An engine that behaves as the real one does: a cache per account, merged on
 * every read, and `refreshPlanUsage` answering with the cache rather than the
 * read. That contract is what the handler's reply depends on.
 */
function engineHost(providerId: string, read: PlanUsage): { engine: never; cache: Map<string, PlanUsage> } {
  const cache = new Map<string, PlanUsage>();
  const engine = {
    ready: true,
    require: () => ({
      listProfiles: () => Promise.resolve([{ id: 'p1', providerId }]),
      cachedPlanUsage: (profileId: string) => cache.get(profileId) ?? null,
      refreshPlanUsage: ({ profileId }: { profileId: string }) => {
        reads.push(profileId);
        const merged = mergePlanUsage(cache.get(profileId) ?? null, read);
        cache.set(profileId, merged);
        return Promise.resolve(merged);
      },
      readRemotePlanUsage: () =>
        Promise.resolve([{ profileId: 'acct-a', label: 'Work', usage: read }]),
    }),
  } as never;
  return { engine, cache };
}

/** Register the layer against one engine and answer the refresh channel. */
async function refresh(engine: never): Promise<unknown> {
  const layer = registerIpcHandlers({
    engine,
    policy: {} as never,
    updater: {} as never,
    terminals: {} as never,
    browsers: {} as never,
    server: {} as never,
    routines: {} as never,
    remoteAccess: {} as never,
  });
  try {
    const handler = handlers.get(IPC.usagePlanRefresh);
    if (handler === undefined) throw new Error('the refresh channel was never registered');
    return await handler(invokeEvent(), { profileId: 'p1' });
  } finally {
    layer.dispose();
  }
}

beforeEach(() => {
  handlers.clear();
  delivered = [];
  reads = [];
  windowCount = 1;
});

afterEach(() => {
  handlers.clear();
});

describe('a local account refreshed from one window', () => {
  it('is broadcast to every open window', async () => {
    // Two windows, one refresh, two deliveries of the same payload. The second
    // window asked for nothing and is the whole point: it is the pane that used
    // to sit on the old number.
    windowCount = 2;
    const read = snapshot([window_('five_hour', 2, 1_500)], 1_500);
    const { engine } = engineHost('claude', read);

    await refresh(engine);

    expect(reads).toEqual(['p1']);
    expect(delivered.map((d) => d.window)).toEqual([0, 1]);
    expect(delivered[0]?.payload).toEqual({ profileId: 'p1', usage: read });
    expect(delivered[1]?.payload).toEqual(delivered[0]?.payload);
  });

  it('answers the caller with the cache, so the reply and the push agree', async () => {
    /*
      The cache already holds a `seven_day` verdict that arrived while this read
      was in flight. The read knows a newer `five_hour` percentage. The merged
      value has both, and it is what the window that asked is told — anything
      else and that one window is out of step with every other, which is the bug
      one pane smaller.
    */
    const read = snapshot([window_('five_hour', 2, 1_500)], 1_500);
    const { engine, cache } = engineHost('claude', read);
    cache.set(
      'p1',
      snapshot(
        [
          window_('five_hour', 100, 1_000),
          { id: 'seven_day', label: '7 days', utilization: 40, resetsAt: null, at: 2_000, status: 'warning' },
        ],
        2_000,
      ),
    );

    const reply = (await refresh(engine)) as { ok: true; value: { usage: PlanUsage } };

    expect(reply.ok).toBe(true);
    expect(reply.value.usage.windows.find((w) => w.id === 'five_hour')?.utilization).toBe(2);
    expect(reply.value.usage.windows.find((w) => w.id === 'seven_day')?.status).toBe('warning');
    // And the same object's contents went out on the push.
    expect((delivered[0]?.payload as { usage: PlanUsage }).usage).toEqual(reply.value.usage);
  });

  it('still fans an Artemis Server profile out per served account', async () => {
    // Unchanged, and worth pinning beside the branch that changed: a server's
    // gauges travel keyed by served account, and the reply carries none of them.
    const read = snapshot([window_('five_hour', 2, 1_500)], 1_500);
    const { engine } = engineHost('artemis', read);

    const reply = (await refresh(engine)) as { ok: true; value: { usage: PlanUsage | null } };

    expect(reads).toEqual([]);
    expect(reply.value.usage).toBeNull();
    expect(delivered[0]?.payload).toEqual({
      profileId: 'p1',
      usage: read,
      accountId: 'acct-a',
      accountLabel: 'Work',
    });
  });
});
