/**
 * The plan windows, drawn as bars.
 *
 * A bar is read at a glance where three percentages have to be compared, so
 * it has to be honest at both ends: a window someone has started on must not
 * look untouched, and a window that is not yet full must not look full.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Capabilities } from '@rx-artemis/protocol';
import { NO_CAPABILITIES, PERMISSION_MODES } from '@rx-artemis/protocol';

import type { ConversationState } from '../conversation.js';
import { ACCENT } from '../theme.js';
import { changedSummary, elapsedClock, meterBar, meterCells, meterTone, modeBadge, needYouLabel, workingLine } from './StatusBar.js';

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

/*
 * The mode, as a badge.
 *
 * The word on its own left the one reading on this line that is a *warning*
 * looking like the ones that are merely settings, and made "will this ask me
 * first" a thing to read rather than a thing to see. The glyph answers that
 * before the word is read: `⏵⏵` goes through, `⏸` stops. So what is tested is
 * the pairing and the paint, which is the whole of what the component does
 * with this.
 */
describe('modeBadge', () => {
  it('says whether anything stops before it says which mode it is', () => {
    expect(modeBadge('default').text).toBe('⏸ ask');
    expect(modeBadge('plan').text).toBe('⏸ plan');
    // The provider decides, and asks when it judges the risk real — which is a
    // mode that stops, whatever it usually does.
    expect(modeBadge('auto').text).toBe('⏸ auto');
    expect(modeBadge('acceptEdits').text).toBe('⏵⏵ accept edits');
    expect(modeBadge('dontAsk').text).toBe("⏵⏵ don't ask");
    // Its shout, not its tail: six characters survive a narrow terminal.
    expect(modeBadge('bypassPermissions').text).toBe('⏵⏵ BYPASS');
  });

  it('leaves ask plain, paints plan in the accent and the two that do not ask green', () => {
    expect(modeBadge('default').color).toBeUndefined();
    expect(modeBadge('plan').color).toBe(ACCENT);
    expect(modeBadge('acceptEdits').color).toBe('green');
    expect(modeBadge('dontAsk').color).toBe('green');
  });

  it('keeps bypass red and bold, and nothing else bold', () => {
    // The one mode where this line is a warning, and it must never be able to
    // be mistaken for the others.
    expect(modeBadge('bypassPermissions').color).toBe('red');
    expect(modeBadge('bypassPermissions').bold).toBe(true);
    for (const mode of PERMISSION_MODES) {
      if (mode !== 'bypassPermissions') expect(modeBadge(mode).bold).not.toBe(true);
    }
  });

  it('has a badge for every mode the protocol knows', () => {
    // A mode added to the protocol and not to this record would draw nothing
    // at all where the line says what the next turn goes out as.
    for (const mode of PERMISSION_MODES) expect(modeBadge(mode).text.trim()).not.toBe('');
  });
});

/*
 * What the conversation has done to the files.
 *
 * The one reading on this line that is not about the turn: tokens and cost say
 * what was spent, this says what came of it. The rule that matters is when it
 * says nothing at all — a bar reading `0 files` spends columns reporting that
 * nothing happened.
 */
describe('changedSummary', () => {
  it('splits the count from the churn, so each can be painted', () => {
    expect(changedSummary({ files: 3, added: 42, removed: 7 })).toEqual({
      files: '3 files',
      added: '+42',
      // The true minus sign, as the desktop's churn counts use: a hyphen
      // beside a `+` reads as punctuation rather than as its opposite.
      removed: '−7',
    });
  });

  it('says "1 file" for one', () => {
    expect(changedSummary({ files: 1, added: 2, removed: 0 })?.files).toBe('1 file');
  });

  it('is nothing at all until something has been edited', () => {
    expect(changedSummary(undefined)).toBeUndefined();
    // A ledger folded to zero files — every change undone — is the same
    // nothing, and must not leave `0 files +0 −0` on the bar.
    expect(changedSummary({ files: 0, added: 0, removed: 0 })).toBeUndefined();
  });

  it('keeps a file that was only added to, or only cut from', () => {
    // `+0` is worth drawing: it is what a pure deletion looks like, and
    // leaving it out would make the pair read as a single number.
    expect(changedSummary({ files: 1, added: 0, removed: 12 })).toEqual({ files: '1 file', added: '+0', removed: '−12' });
    expect(changedSummary({ files: 2, added: 9, removed: 0 })).toEqual({ files: '2 files', added: '+9', removed: '−0' });
  });
});

/*
 * The one reading on this line that is about the other conversations.
 *
 * The rail has a glyph per row and the window title has the same sentence for
 * a taskbar nobody can see from inside the app; this is the count at eye
 * level, and what is worth pinning is the silence at zero.
 */
describe('needYouLabel', () => {
  it('says how many are waiting, in the words the window title uses', () => {
    expect(needYouLabel(2)).toBe('2 need you');
    // Ungrammatical for one, and deliberately the same as `titleFor`'s: two
    // surfaces reporting one number in two different sentences reads worse
    // than one wrong verb in both.
    expect(needYouLabel(1)).toBe('1 need you');
  });

  it('says nothing when nothing is waiting', () => {
    // `0 need you` is columns spent saying that nothing is wrong.
    expect(needYouLabel(0)).toBeUndefined();
    expect(needYouLabel(-1)).toBeUndefined();
  });
});
