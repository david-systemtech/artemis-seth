import { describe, expect, it } from 'vitest';

import { BoundedLog, BUFFER_LIMIT, droppedNotice } from './buffer.js';

describe('BoundedLog', () => {
  it('hands back everything since the last drain, then starts empty', () => {
    const log = new BoundedLog<number>(10);
    log.push(1);
    log.push(2);
    expect(log.drain()).toEqual({ entries: [1, 2], dropped: 0 });
    expect(log.drain()).toEqual({ entries: [], dropped: 0 });
  });

  it('keeps the newest entries and counts the ones it threw away', () => {
    const log = new BoundedLog<number>(3);
    for (const n of [1, 2, 3, 4, 5]) log.push(n);
    expect(log.drain()).toEqual({ entries: [3, 4, 5], dropped: 2 });
  });

  it('forgets the count of dropped entries once it has reported it, so it is not reported twice', () => {
    const log = new BoundedLog<number>(1);
    log.push(1);
    log.push(2);
    expect(log.drain().dropped).toBe(1);
    log.push(3);
    expect(log.drain()).toEqual({ entries: [3], dropped: 0 });
  });

  it('survives a round trip through storage with its entries and its losses', () => {
    const log = new BoundedLog<string>(2);
    for (const entry of ['a', 'b', 'c']) log.push(entry);
    const revived = BoundedLog.fromSnapshot(JSON.parse(JSON.stringify(log.toSnapshot())) as { entries: string[]; dropped: number }, 2);
    expect(revived.drain()).toEqual({ entries: ['b', 'c'], dropped: 1 });
  });

  it('starts empty when there is no snapshot, which is a browser that was just restarted', () => {
    expect(BoundedLog.fromSnapshot<string>(undefined).drain()).toEqual({ entries: [], dropped: 0 });
  });
});

describe('droppedNotice', () => {
  it('says nothing when nothing was lost', () => {
    expect(droppedNotice(0, 'console')).toBeUndefined();
    expect(droppedNotice(-1, 'console')).toBeUndefined();
  });

  it('tells the agent what it is not being shown, and how much the buffer holds', () => {
    expect(droppedNotice(12, 'console')).toBe(`12 older console entries were dropped: this page's buffer holds ${String(BUFFER_LIMIT)}.`);
    expect(droppedNotice(1, 'network')).toContain('1 older network entry was dropped');
  });
});
