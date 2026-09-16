/*
 * The offer at the moment the plan runs out.
 *
 * Three things are worth pinning, and they are the three that would fail
 * quietly. That the offer appears for the right reason and — much more
 * importantly — *disappears on its own* when the window rolls, because a line
 * that keeps offering a move after the limit has cleared is a line people stop
 * reading. That no account is ever dropped from the list: a blocked one keeps
 * its row and gains a sentence, which is the desktop's rule and the one a
 * filter would silently break. And that every word on the line is the word the
 * status bar actually prints, since the bar itself is colours and boxes.
 */

import { describe, expect, it } from 'vitest';

import type { PlanUsage, PlanUsageWindow, ProfileMetadata, ServerProfile } from '@rx-artemis/protocol';
import { NO_CAPABILITIES, PLAN_USAGE_MAX_AGE_MS } from '@rx-artemis/protocol';

import {
  bestFailoverCandidate,
  failoverCandidates,
  failoverLine,
  failoverReason,
  failoverTitle,
  handoverBrief,
  resetClock,
  type FailoverCandidate,
} from './failover.js';

/*
 * Half past two on a Thursday, built in local time so the clock this renders
 * to is `14:30` wherever the suite runs.
 */
const NOW = new Date(2026, 8, 10, 12, 0).getTime();
const HALF_TWO = new Date(2026, 8, 10, 14, 30).getTime();

const window = (patch: Partial<PlanUsageWindow> & Pick<PlanUsageWindow, 'id'>): PlanUsageWindow => ({
  label: patch.id,
  utilization: null,
  resetsAt: null,
  ...patch,
});

const usage = (windows: readonly PlanUsageWindow[], fetchedAt = NOW): PlanUsage => ({
  available: true,
  windows,
  fetchedAt,
});

const fiveHour = (utilization: number | null, patch: Partial<PlanUsageWindow> = {}): PlanUsageWindow =>
  window({ id: 'five_hour', label: '5 hours', utilization, ...patch });

const week = (utilization: number | null, patch: Partial<PlanUsageWindow> = {}): PlanUsageWindow =>
  window({ id: 'seven_day', label: '7 days', utilization, ...patch });

describe('failoverReason', () => {
  it('says nothing at all while the plan has room', () => {
    // The commonest answer by far, and the one that keeps the line a status
    // line rather than a standing advertisement.
    expect(failoverReason(usage([fiveHour(12), week(40)]), NOW)).toBeNull();
  });

  it('is nothing on a plan that has no limits to run out of', () => {
    expect(failoverReason({ available: false, windows: [], fetchedAt: NOW }, NOW)).toBeNull();
    expect(failoverReason(null, NOW)).toBeNull();
  });

  it("reports the provider's own refusal, under both of the window's names", () => {
    const reason = failoverReason(usage([fiveHour(97, { status: 'rejected', resetsAt: HALF_TWO }), week(40)]), NOW);
    expect(reason).toEqual({
      kind: 'rejected',
      // `5hr` is what the meter draws two lines up; `5-hour` is what a
      // sentence needs. Two surfaces naming one window differently is how a
      // person comes to believe there are four limits.
      window: '5hr',
      windowInWords: '5-hour',
      utilization: 97,
      resetsAt: HALF_TWO,
    });
  });

  it('trusts a refusal however old the reading is', () => {
    // A percentage goes stale; "I am refusing your requests" does not. The
    // same asymmetry `bindingWindow` is written under.
    const old = usage([fiveHour(97, { status: 'rejected' })], NOW - PLAN_USAGE_MAX_AGE_MS - 1);
    expect(failoverReason(old, NOW)?.kind).toBe('rejected');
  });

  it('fires the threshold before the wall, on a fresh reading', () => {
    // 90% of the 5-hour window is `DEFAULT_HANDOFF_THRESHOLDS`, unchanged, so
    // the terminal hands off at the moment the desktop does.
    const reason = failoverReason(usage([fiveHour(94), week(40)]), NOW);
    expect(reason).toEqual({ kind: 'near', window: '5hr', windowInWords: '5-hour', utilization: 94 });
    expect(failoverReason(usage([fiveHour(89.4), week(40)]), NOW)).toBeNull();
  });

  it('will not forecast from a reading nobody has refreshed', () => {
    // Six minutes is the desktop's bar: an account named on numbers that old
    // may have been drained since by another machine.
    const stale = usage([fiveHour(94)], NOW - PLAN_USAGE_MAX_AGE_MS - 1);
    expect(failoverReason(stale, NOW)).toBeNull();
    expect(failoverReason(usage([fiveHour(94)], NOW - PLAN_USAGE_MAX_AGE_MS), NOW)?.kind).toBe('near');
  });

  it('goes away by itself when the window rolls', () => {
    // Nothing switches the offer off — it simply stops being true, which is
    // the whole of "never automatic" on the way back out.
    const out = usage([fiveHour(100, { status: 'rejected' })]);
    expect(failoverReason(out, NOW)).not.toBeNull();
    expect(failoverReason(usage([fiveHour(3)]), NOW)).toBeNull();
  });

  it('names the weekly window in its own words when that is what is spent', () => {
    const reason = failoverReason(usage([fiveHour(20), week(99)]), NOW);
    expect(reason?.window).toBe('Week');
    expect(reason?.windowInWords).toBe('weekly');
  });
});

describe('failoverLine', () => {
  const out = failoverReason(usage([fiveHour(100, { status: 'rejected', resetsAt: HALF_TWO })]), NOW);
  const candidate = (patch: Partial<FailoverCandidate> = {}): FailoverCandidate => ({
    id: 'p2',
    label: 'work',
    providerLabel: 'Claude',
    block: null,
    load: 12,
    ...patch,
  });

  it('is the whole offer in one line, with the key that answers it', () => {
    expect(failoverLine(out!, candidate(), NOW)).toBe(
      '5hr window out · resets 14:30 · hand off to work (12%) · Alt+H or /handoff',
    );
  });

  it('says plainly when there is nowhere to go', () => {
    // A dead-ended offer is worse than none; this at least names something a
    // person can act on by signing an account in.
    expect(failoverLine(out!, null, NOW)).toBe(
      '5hr window out · resets 14:30 · no other account can take this · Alt+H or /handoff',
    );
  });

  it('leaves the reset off a window that is merely full', () => {
    // On a spent window the reset is the alternative to moving. On one at 94%
    // nothing is being waited for yet, and the picker's title carries it
    // anyway — one keystroke from here.
    const near = failoverReason(usage([fiveHour(94, { resetsAt: HALF_TWO })]), NOW);
    expect(failoverLine(near!, candidate(), NOW)).toBe('5hr window at 94% · hand off to work (12%) · Alt+H or /handoff');
  });

  it('drops a reset that has already gone by', () => {
    // The window has rolled and the verdict is the last thing the provider
    // said rather than what it would say now; `resets 14:30` read at three
    // o'clock is the sort of wrong that costs a line its credibility.
    const past = failoverReason(usage([fiveHour(100, { status: 'rejected', resetsAt: NOW - 60_000 })]), NOW);
    expect(failoverLine(past!, null, NOW)).toBe('5hr window out · no other account can take this · Alt+H or /handoff');
  });

  it('names an account with no reading without inventing a number for it', () => {
    const noNumber = candidate({ label: 'metered', load: undefined });
    expect(failoverLine(out!, noNumber, NOW)).toContain('hand off to metered · Alt+H or /handoff');
  });
});

describe('failoverTitle', () => {
  it('asks the question with the reason over it', () => {
    const out = failoverReason(usage([fiveHour(100, { status: 'rejected', resetsAt: HALF_TWO })]), NOW);
    expect(failoverTitle(out!, NOW)).toBe(
      'The 5-hour window is out; it resets at 14:30. Where should this conversation go?',
    );
  });

  it('carries the reset the line left off a near miss', () => {
    const near = failoverReason(usage([fiveHour(94, { resetsAt: HALF_TWO })]), NOW);
    expect(failoverTitle(near!, NOW)).toBe(
      'The 5-hour window is at 94%; it resets at 14:30. Where should this conversation go?',
    );
  });

  it('says what happened even when the provider names no reset', () => {
    const out = failoverReason(usage([fiveHour(100, { status: 'rejected' })]), NOW);
    expect(failoverTitle(out!, NOW)).toBe('The 5-hour window is out. Where should this conversation go?');
  });
});

describe('resetClock', () => {
  it('leads with the clock, on a 24-hour face', () => {
    // "in 4h" needs arithmetic before anyone can decide whether to wait.
    expect(resetClock(HALF_TWO)).toBe('14:30');
    expect(resetClock(new Date(2026, 8, 10, 0, 5).getTime())).toBe('00:05');
  });
});

/* -------------------------------------------------------------------------- */

const profile = (id: string, patch: Partial<ServerProfile> = {}): ServerProfile => ({
  id,
  slug: id,
  label: id,
  provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
  available: true,
  disabled: false,
  live: true,
  capabilities: NO_CAPABILITIES,
  models: [],
  ...patch,
});

const meta = (id: string, patch: Partial<ProfileMetadata> = {}): ProfileMetadata => ({
  id,
  label: id,
  providerId: 'claude',
  configDir: `/u/.${id}`,
  ...patch,
});

describe('failoverCandidates', () => {
  const CATALOGUE = [profile('here'), profile('work'), profile('spare')];
  const METADATA = [meta('here'), meta('work'), meta('spare')];
  const readings = new Map<string, PlanUsage | null>([
    ['work', usage([fiveHour(12), week(40)])],
    ['spare', usage([fiveHour(60), week(70)])],
  ]);
  const everywhere = (): boolean => true;

  it('leaves the account in use out of its own offer', () => {
    const ids = failoverCandidates(CATALOGUE, METADATA, readings, 'here', everywhere, NOW).map((c) => c.id);
    expect(ids).not.toContain('here');
  });

  it('puts the emptiest chooseable account first, with every window it is metered on', () => {
    const rows = failoverCandidates(CATALOGUE, METADATA, readings, 'here', everywhere, NOW);
    expect(rows.map((row) => row.id)).toEqual(['work', 'spare']);
    // The meter's own vocabulary, so the row and the bar cannot disagree about
    // which window a number belongs to.
    expect(rows[0]?.pressure).toBe('5hr 12% · Week 40%');
    /*
     * The *binding* window and not the friendliest one. An account at 12% of
     * its five hours and 40% of its week has 60% of room, not 88%, and a line
     * that named the 12 would be recommending on the number that is not going
     * to stop you.
     */
    expect(rows[0]?.load).toBe(40);
    expect(rows[1]?.load).toBe(70);
    expect(bestFailoverCandidate(rows)?.label).toBe('work');
  });

  it('never hides a blocked account, and says which fact stopped it', () => {
    const catalogue = [
      profile('here'),
      profile('hidden', { disabled: true }),
      profile('missing', { available: false }),
      profile('loggedOut', { auth: { loggedIn: false } }),
      profile('spent'),
      profile('unread'),
    ];
    const metadata = [meta('here'), meta('hidden'), meta('missing'), meta('loggedOut'), meta('spent'), meta('unread')];
    const usageByProfile = new Map<string, PlanUsage | null>([
      ['spent', usage([fiveHour(100, { status: 'rejected' })])],
      ['unread', usage([fiveHour(10)], NOW - PLAN_USAGE_MAX_AGE_MS - 1)],
    ]);
    const rows = failoverCandidates(catalogue, metadata, usageByProfile, 'here', everywhere, NOW);
    // Every one of them is still on the list. A row that vanishes at the
    // moment it is needed is an account the user concludes was taken away.
    expect(rows.map((row) => row.id).sort()).toEqual(['hidden', 'loggedOut', 'missing', 'spent', 'unread']);
    const blocks = new Map(rows.map((row) => [row.id, row.block]));
    expect(blocks.get('hidden')).toBe('unavailable');
    expect(blocks.get('missing')).toBe('unavailable');
    expect(blocks.get('loggedOut')).toBe('signed out');
    expect(blocks.get('spent')).toBe('rejected');
    expect(blocks.get('unread')).toBe('stale reading');
    expect(bestFailoverCandidate(rows)).toBeNull();
  });

  it('blocks an account whose key only the desktop can read', () => {
    const rows = failoverCandidates(
      [profile('here'), profile('keyed')],
      [meta('here'), meta('keyed', { hasApiKey: true })],
      new Map([['keyed', usage([fiveHour(3)])]]),
      'here',
      everywhere,
      NOW,
    );
    expect(rows[0]?.block).toBe('unavailable');
  });

  it('marks an account that cannot read this conversation, rather than dropping it', () => {
    // The row is what the "start fresh on …" offer hangs off: an account that
    // cannot be handed the conversation can still be handed the work.
    const rows = failoverCandidates(CATALOGUE, METADATA, readings, 'here', (id) => id === 'work', NOW);
    const blocks = new Map(rows.map((row) => [row.id, row.block]));
    expect(blocks.get('work')).toBeNull();
    expect(blocks.get('spare')).toBe('cannot reach this conversation');
  });

  it('prefers the sentence about being spent to the one about being out of reach', () => {
    // An account that is itself out must never be offered a fresh start it
    // could not serve either.
    const rows = failoverCandidates(
      [profile('here'), profile('spent')],
      [meta('here'), meta('spent')],
      new Map([['spent', usage([fiveHour(100, { status: 'rejected' })])]]),
      'here',
      () => false,
      NOW,
    );
    expect(rows[0]?.block).toBe('rejected');
  });

  it('prefers the sentence about reach to the one about a stale reading', () => {
    // Withholding the seeded start over a reading that is merely old would
    // close the one door left at a provider boundary.
    const rows = failoverCandidates(
      [profile('here'), profile('far')],
      [meta('here'), meta('far')],
      new Map([['far', usage([fiveHour(10)], NOW - PLAN_USAGE_MAX_AGE_MS - 1)]]),
      'here',
      () => false,
      NOW,
    );
    expect(rows[0]?.block).toBe('cannot reach this conversation');
  });

  it('lets an account with no plan limits at all be chosen', () => {
    // `available: false` is a successful reading saying limits do not apply —
    // an API key, Bedrock, Vertex. The safest place in the list to send work,
    // and the freshness bar must not shut it out for having no percentage.
    const rows = failoverCandidates(
      [profile('here'), profile('metered')],
      [meta('here'), meta('metered')],
      new Map<string, PlanUsage | null>([['metered', { available: false, windows: [], fetchedAt: 0 }]]),
      'here',
      everywhere,
      NOW,
    );
    expect(rows[0]?.block).toBeNull();
    expect(rows[0]?.pressure).toBeUndefined();
  });

  it('sorts an account with no number behind every account with one', () => {
    const rows = failoverCandidates(
      [profile('here'), profile('metered'), profile('busy')],
      [meta('here'), meta('metered'), meta('busy')],
      new Map<string, PlanUsage | null>([
        ['metered', { available: false, windows: [], fetchedAt: 0 }],
        ['busy', usage([fiveHour(80)])],
      ]),
      'here',
      everywhere,
      NOW,
    );
    expect(rows.map((row) => row.id)).toEqual(['busy', 'metered']);
  });

  it('shows a rejected window as out rather than as a stale percentage', () => {
    const rows = failoverCandidates(
      [profile('here'), profile('spent')],
      [meta('here'), meta('spent')],
      new Map([['spent', usage([fiveHour(97, { status: 'rejected' }), week(20)])]]),
      'here',
      everywhere,
      NOW,
    );
    expect(rows[0]?.pressure).toBe('5hr out · Week 20%');
    expect(rows[0]?.load).toBe(100);
  });
});

describe('handoverBrief', () => {
  it('carries the last thing asked and the last thing said', () => {
    const brief = handoverBrief({
      lastPrompt: 'Wire the failover offer into the status line',
      lastReply: 'I added the picker and the key.',
    });
    expect(brief).toBe(
      'Continuing from another account.\n\nThe last prompt was: Wire the failover offer into the status line\n\nThe agent last said: I added the picker and the key.',
    );
  });

  it('flattens the turns so the box holds a draft rather than a transcript', () => {
    const brief = handoverBrief({ lastPrompt: 'do\n\n  this\tthen that', lastReply: null });
    expect(brief).toBe('Continuing from another account.\n\nThe last prompt was: do this then that');
  });

  it('cuts a long turn short rather than filling the composer with it', () => {
    const brief = handoverBrief({ lastPrompt: 'x'.repeat(900), lastReply: null });
    expect(brief).toContain('…');
    expect(brief.length).toBeLessThan(500);
  });

  it('says the one true thing when there is nothing else to carry', () => {
    // A conversation handed over before anything was sent. Better a short
    // honest line in the box than a sentence trailing off into nothing.
    expect(handoverBrief({ lastPrompt: null, lastReply: null })).toBe('Continuing from another account.');
    expect(handoverBrief({ lastPrompt: '   ', lastReply: null })).toBe('Continuing from another account.');
  });
});
