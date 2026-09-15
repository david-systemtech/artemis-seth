/**
 * Several conversations alive, one on screen.
 *
 * The rules `app.tsx` needs from the pool, kept pure so they can be pinned
 * without a renderer: which conversations survive a switch, what the rail says
 * each one is doing, and which of them have a claim on the person.
 */

import { describe, expect, it } from 'vitest';

import { needsYou, prunePool, railActivityFor } from './pool.js';

interface Fake {
  readonly name: string;
  readonly live: boolean;
}
const fake = (name: string, live = false): Fake => ({ name, live });
const isLive = (f: Fake): boolean => f.live;

describe('prunePool', () => {
  it('drops an idle conversation on the way out, and keeps a working one', () => {
    const idle = fake('idle');
    const working = fake('working', true);
    const next = fake('next');

    expect(prunePool([idle, working], next, isLive)).toEqual({ kept: [working, next], dropped: [idle] });
  });

  it('never drops the one being switched to, live or not, and never lists it twice', () => {
    const next = fake('next');
    const other = fake('other');

    // Switching back to a parked conversation must not duplicate it.
    expect(prunePool([other, next], next, isLive)).toEqual({ kept: [next], dropped: [other] });
  });
});

describe('railActivityFor', () => {
  it('marks a turn as running from the moment it is asked for, not from when the provider answers', () => {
    // Between Enter and the provider's first event the status is `starting`;
    // the registry does not yet know the run, so "is the run active" said no
    // and the rail showed nothing for a conversation that was, to the person,
    // plainly working.
    const activity = railActivityFor([
      { sessionId: 's1', status: 'starting', pendingPermissions: [] },
      { sessionId: 's2', status: 'running', pendingPermissions: [] },
      { sessionId: 's3', status: 'awaiting_permission', pendingPermissions: [{}] },
      { sessionId: 's4', status: 'idle', pendingPermissions: [] },
      { sessionId: undefined, status: 'running', pendingPermissions: [] },
    ]);

    expect([...activity.entries()]).toEqual([
      ['s1', 'running'],
      ['s2', 'running'],
      ['s3', 'awaiting'],
    ]);
  });
});

/*
 * Who has a claim on the person, and in what order.
 *
 * The interesting cases are all about a conversation nobody is looking at:
 * the whole feature exists because a parked turn can stop on a question or
 * finish an answer with the screen showing something else entirely.
 */
describe('needsYou', () => {
  const seen = (entries: readonly (readonly [string, number])[] = []): ReadonlyMap<string, number> => new Map(entries);

  it('puts the ones that are stuck before the ones that are merely unread', () => {
    // A permission cannot be got out of without a person; a finished turn is
    // worth going back to and can wait a moment longer.
    const needing = needsYou(
      [
        { key: 'a', status: 'idle', pendingPermissions: [], finishedAt: 10 },
        { key: 'b', status: 'awaiting_permission', pendingPermissions: [{}] },
        { key: 'c', status: 'idle', pendingPermissions: [], finishedAt: 20 },
      ],
      seen(),
    );

    expect(needing).toEqual([
      { key: 'b', kind: 'awaiting' },
      { key: 'a', kind: 'finished' },
      { key: 'c', kind: 'finished' },
    ]);
  });

  it('forgets a turn that finished before it was last looked at', () => {
    const states = [{ key: 'a', status: 'idle' as const, pendingPermissions: [], finishedAt: 100 }];
    expect(needsYou(states, seen([['a', 99]]))).toEqual([{ key: 'a', kind: 'finished' }]);
    expect(needsYou(states, seen([['a', 100]]))).toEqual([]);
    expect(needsYou(states, seen([['a', 5_000]]))).toEqual([]);
  });

  it('counts a conversation nobody has ever looked at', () => {
    // No entry at all is not "seen at the dawn of time and therefore old"; it
    // is a conversation that has never been on the screen.
    expect(needsYou([{ key: 'a', status: 'idle', pendingPermissions: [], finishedAt: 1 }], seen())).toEqual([
      { key: 'a', kind: 'finished' },
    ]);
  });

  it('leaves work in flight alone', () => {
    // The rail already says it is running, and it will ask for the person
    // itself when it stops. A stale `finishedAt` from the turn before is not
    // a reason to send anybody to a screen that is still filling up.
    expect(
      needsYou(
        [
          { key: 'a', status: 'running', pendingPermissions: [], finishedAt: 1 },
          { key: 'b', status: 'starting', pendingPermissions: [] },
        ],
        seen(),
      ),
    ).toEqual([]);
  });

  it('asks once for a conversation that is both stuck and unread', () => {
    // Stopping to ask is how this turn will end; it is one claim, not two.
    expect(
      needsYou([{ key: 'a', status: 'awaiting_permission', pendingPermissions: [{}], finishedAt: 1 }], seen()),
    ).toEqual([{ key: 'a', kind: 'awaiting' }]);
  });

  it('wants nothing when nothing has happened', () => {
    expect(needsYou([], seen())).toEqual([]);
    expect(needsYou([{ key: 'a', status: 'idle', pendingPermissions: [] }], seen())).toEqual([]);
  });
});
