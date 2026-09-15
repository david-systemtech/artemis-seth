/**
 * The plan windows, drawn as bars.
 *
 * A bar is read at a glance where three percentages have to be compared, so
 * it has to be honest at both ends: a window someone has started on must not
 * look untouched, and a window that is not yet full must not look full.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Capabilities } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { ConversationState } from '../conversation.js';
import { elapsedClock, meterBar, meterCells, meterTone, workingLine } from './StatusBar.js';

describe('meterBar', () => {
  it('fills in proportion', () => {
    expect(meterBar(0, 8)).toBe('░░░░░░░░');
    expect(meterBar(50, 8)).toBe('████░░░░');
    expect(meterBar(100, 8)).toBe('████████');
  });

  it('lights the first cell for any use at all', () => {
    // 1% of eight cells rounds to nothing; a window being used must not read
    // as a window untouched.
    expect(meterBar(1, 8)).toBe('█░░░░░░░');
    expect(meterBar(0.4, 8)).toBe('█░░░░░░░');
  });

  it('holds the last cell back until the window really is full', () => {
    // Otherwise 97% and 100% are the same picture, and the one that matters
    // is the one that stops you working.
    expect(meterBar(97, 8)).toBe('███████░');
    expect(meterBar(99.6, 8)).toBe('███████░');
    expect(meterBar(100, 8)).toBe('████████');
    expect(meterBar(140, 8)).toBe('████████');
  });
});

describe('meterCells', () => {
  it('gives up the bars before it squeezes the line beside them', () => {
    // The readings sit in a box that does not shrink; every cell is a column
    // taken from the account and model line, which truncates. Eight cells
    // each cost "BYPASS PERMISSIONS" its tail on a 140-column terminal.
    // The width given is this bar's own — the terminal less the rail.
    expect(meterCells(120)).toBe(5);
    expect(meterCells(100)).toBe(4);
    expect(meterCells(80)).toBe(0);
  });
});

/*
 * Colour by pressure, as the desktop colours its rings — and the same
 * thresholds, so an account is never amber in one app and red in the other.
 * Below the warning bands the bar was dim grey, which read as a meter that
 * was switched off rather than one that was fine.
 */
describe('meterTone', () => {
  it('is green while there is room, yellow at 75 and red at 90', () => {
    expect(meterTone(0)).toBe('green');
    expect(meterTone(74.9)).toBe('green');
    expect(meterTone(75)).toBe('yellow');
    expect(meterTone(89.9)).toBe('yellow');
    expect(meterTone(90)).toBe('red');
  });

  it('is red whatever the number says once the provider is rejecting', () => {
    // A stale 40% on a window the provider has shut is the far end of the
    // scale, not the middle.
    expect(meterTone(40, 'rejected')).toBe('red');
  });

  it('has no tone for a window with no reading', () => {
    expect(meterTone(null)).toBeUndefined();
  });
});

/*
 * The working line.
 *
 * `workingLine` is where the second line's meaning lives, so it is where the
 * second line is tested: the component around it is colours and boxes. Every
 * case here is a shape a real turn passes through — nothing said yet, a
 * thought, a tool, a thought that has gone quiet, a question to answer.
 */
describe('elapsedClock', () => {
  it('pads the seconds so the column does not shuffle as it ticks', () => {
    // `1m 4s` is a character narrower than `1m 14s`, and everything to the
    // right of a field that changes width moves with it — twice a minute,
    // for the whole turn, on a line that redraws every second.
    expect(elapsedClock(64_000)).toBe('1m 04s');
    expect(elapsedClock(74_000)).toBe('1m 14s');
    expect(elapsedClock(3_722_000)).toBe('1h 02m');
  });

  it('keeps to whole seconds, which is all a once-a-second clock knows', () => {
    expect(elapsedClock(0)).toBe('0s');
    expect(elapsedClock(450)).toBe('0s');
    expect(elapsedClock(4_900)).toBe('4s');
    expect(elapsedClock(59_999)).toBe('59s');
    expect(elapsedClock(60_000)).toBe('1m 00s');
  });

  it('does not go backwards when the clock does', () => {
    // A tick read before the turn's own timestamp — a clock adjustment, or a
    // turn adopted a moment after it started — must not print `-1s`.
    expect(elapsedClock(-5_000)).toBe('0s');
  });
});

const CAPABLE: Capabilities = { ...NO_CAPABILITIES, midRunSteering: true };

const running = (patch: Partial<ConversationState> = {}): ConversationState => ({
  settings: {
    profileId: 'p1' as never,
    providerId: 'claude',
    profileLabel: 'work',
    providerLabel: 'Claude',
    cwd: '/repo',
    permissionMode: 'default',
  },
  status: 'running',
  capabilities: CAPABLE,
  pendingPermissions: [],
  queuedMessages: [],
  queued: 0,
  tasks: [],
  planUsage: null,
  slashCommands: [],
  turnStartedAt: 1_000,
  ...patch,
});

describe('workingLine', () => {
  it('says what the agent is doing, for how long, and what it has written', () => {
    const line = workingLine(
      running({
        activity: { kind: 'tool', text: 'Read apps/tui/src/app.tsx', since: 60_000 },
        turnTokens: 2_340,
      }),
      65_000,
    );
    // The agent's own words lead; everything else is furniture behind them.
    expect(line.activity).toBe('Read apps/tui/src/app.tsx');
    expect(line.details).toEqual(['1m 04s', '2.3k tok', 'Enter steers', 'Esc interrupts']);
    expect(line.stalled).toBe(false);
  });

  it('says `working` until the agent has said anything, and still times it', () => {
    const line = workingLine(running(), 13_000);
    expect(line.activity).toBe('working');
    // No token count at all rather than a `0` — the provider has reported
    // nothing, and a zero would read as a model that has written nothing.
    expect(line.details).toEqual(['12s', 'Enter steers', 'Esc interrupts']);
  });

  it('keeps `starting…` distinct from `working`', () => {
    // Nothing has been asked of the model yet; the process is coming up.
    expect(workingLine(running({ status: 'starting' }), 1_000).activity).toBe('starting…');
  });

  it('offers only the keys the provider actually has', () => {
    const line = workingLine(running({ capabilities: NO_CAPABILITIES }), 1_000);
    expect(line.details).toEqual(['0s', 'Esc interrupts']);
  });

  it('counts the messages the provider has taken and not yet read', () => {
    const line = workingLine(
      running({ queuedMessages: [{ id: 'm', text: 'and rerun the suite', delivery: 'next-tool-break', ts: 0 }], queued: 1 }),
      1_000,
    );
    expect(line.details).toContain('1 queued');
  });

  it('omits the clock when there is no turn to time', () => {
    // An adopted turn is timed from when we first heard of it; a turn with no
    // start at all prints no duration rather than one counted from the epoch.
    const line = workingLine(running({ turnStartedAt: undefined }), 5_000);
    expect(line.details).toEqual(['Enter steers', 'Esc interrupts']);
  });

  it('warns once a thought has held the line for 45 seconds', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const state = running({ activity: { kind: 'thinking', text: 'Weighing two designs', since: 1_000 } });
      expect(workingLine(state).stalled).toBe(false);
      vi.advanceTimersByTime(44_999);
      expect(workingLine(state).stalled).toBe(false);
      // A model that has thought the same thought this long is usually working
      // on something hard and occasionally stuck. A colour is the most the bar
      // can honestly say about which.
      vi.advanceTimersByTime(1);
      expect(workingLine(state).stalled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not warn about a tool that is taking its time', () => {
    // Tool calls are proof of progress, and a long one — a test suite, a
    // build — is the ordinary case, not a symptom.
    const state = running({ activity: { kind: 'tool', text: 'Bash pnpm test', since: 1_000 } });
    expect(workingLine(state, 600_000).stalled).toBe(false);
    expect(workingLine(running({ activity: { kind: 'writing', text: 'writing', since: 1_000 } }), 600_000).stalled).toBe(false);
  });

  it('leaves a pending permission saying exactly what it said before', () => {
    const line = workingLine(
      running({
        status: 'awaiting_permission',
        activity: { kind: 'tool', text: 'Bash rm -rf build', since: 1_000 },
        turnTokens: 900,
      }),
      99_000,
    );
    // The card above is asking a question. A clock and a token count beside it
    // would be measuring the wrong thing — the wait is the user's, not the
    // model's — and the tool's name is already on the card.
    expect(line).toEqual({ activity: 'waiting for you', details: [], stalled: false });
  });

  it('says nothing is happening when nothing is', () => {
    expect(workingLine(running({ status: 'idle' }), 1_000)).toEqual({ activity: 'ready', details: [], stalled: false });
    expect(workingLine(running({ status: 'idle', sessionId: 's1' as never }), 1_000).activity).toBe('idle');
  });
});
