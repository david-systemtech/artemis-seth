/**
 * The chrome's decisions.
 *
 * Every one of them is about a person who is not looking at the screen, which
 * is why they are worth pinning: nobody watching a test run would ever notice
 * the title saying "ready" over a conversation that had stopped to ask
 * something, or a welcome-back line reporting news from before they left.
 */

import { describe, expect, it } from 'vitest';

import { awayRecap, noticeFor, titleStateOf, type ConversationActivity, type RecapSubject, type RunEnded } from './attention.js';
import { titleFor } from './terminal.js';

const idle: ConversationActivity = { status: 'idle', pendingPermissions: [] };
const running: ConversationActivity = { status: 'running', pendingPermissions: [] };
const starting: ConversationActivity = { status: 'starting', pendingPermissions: [] };
const asking: ConversationActivity = { status: 'awaiting_permission', pendingPermissions: [{}] };

describe('titleStateOf', () => {
  it('is ready when nothing is alive, and for no conversations at all', () => {
    expect(titleStateOf([])).toEqual({ state: 'ready', needing: 0 });
    expect(titleStateOf([idle, idle])).toEqual({ state: 'ready', needing: 0 });
  });

  it('is working while any conversation has a turn in flight', () => {
    // Including the gap between Enter and the provider's first event, which
    // is plainly working to the person who pressed it.
    expect(titleStateOf([idle, running])).toEqual({ state: 'working', needing: 0 });
    expect(titleStateOf([starting])).toEqual({ state: 'working', needing: 0 });
  });

  it('lets a question outrank work in flight, wherever either one is', () => {
    // A parked conversation that has stopped to ask is the one state the
    // person cannot get out of by waiting, so it is what the title says —
    // even when the conversation on screen is busy and fine.
    expect(titleStateOf([running, asking])).toEqual({ state: 'needs-you', needing: 1 });
    expect(titleStateOf([asking, running])).toEqual({ state: 'needs-you', needing: 1 });
  });

  it('counts the conversations waiting, so the title can say how many', () => {
    expect(titleStateOf([asking, asking, asking, running, idle])).toEqual({ state: 'needs-you', needing: 3 });
    expect(titleFor({ ...titleStateOf([asking, asking]), folder: 'artemis' })).toContain('2 need you');
  });

  it('counts a conversation that is both running and asking once, as asking', () => {
    // The run is parked on the question; reporting it as work in flight as
    // well would put the same conversation in two states.
    const both: ConversationActivity = { status: 'running', pendingPermissions: [{}] };
    expect(titleStateOf([both])).toEqual({ state: 'needs-you', needing: 1 });
  });

  it('never reports a count in a state that is not about waiting', () => {
    // `ready · 3 need you` is a title that contradicts itself.
    expect(titleStateOf([running]).needing).toBe(0);
    expect(titleStateOf([idle]).needing).toBe(0);
  });
});

describe('noticeFor', () => {
  it('names the conversation in the title and the tool in the body', () => {
    expect(noticeFor('needs-you', { conversation: 'Rework the parser', tool: 'Bash' })).toEqual({
      kind: 'needs-you',
      title: 'Rework the parser',
      body: 'Bash is waiting for permission',
    });
  });

  it('says something useful with no conversation and no tool', () => {
    // A bell that rang is worth explaining even when nothing has a name yet;
    // an empty body is a notification that wasted the interruption.
    const notice = noticeFor('needs-you');
    expect(notice.title).toBe('Artemis');
    expect(notice.body).toBe('Waiting for permission');
  });

  it('carries the first line of the reply for a finished turn', () => {
    const notice = noticeFor('finished', {
      conversation: 'Rework the parser',
      reply: '\n\nFixed the redirect loop.\n\nIt was the trailing slash.',
    });
    expect(notice.title).toBe('Rework the parser');
    expect(notice.body).toBe('Fixed the redirect loop.');
  });

  it('skips blank leading lines rather than reporting one', () => {
    expect(noticeFor('finished', { reply: '   \n\t\nDone.' }).body).toBe('Done.');
  });

  it('falls back when the turn produced no words at all', () => {
    expect(noticeFor('finished', { reply: '' }).body).toBe('The turn has finished');
    expect(noticeFor('finished', { reply: '\n \n' }).body).toBe('The turn has finished');
    expect(noticeFor('finished').body).toBe('The turn has finished');
  });

  it('treats a blank conversation name as no name', () => {
    expect(noticeFor('finished', { conversation: '   ' }).title).toBe('Artemis');
  });
});

/*
 * The line somebody reads on the keystroke that brings them back.
 *
 * Everything worth pinning here is a judgement about a person who was not
 * watching: what counts as news, how much of it a flash can carry, and what
 * to say when the honest answer is nothing.
 */
describe('awayRecap', () => {
  const away = 1_000;
  const back = 2_000;

  const finished = (title: string, run: Partial<RunEnded> = {}): RecapSubject => ({
    title,
    status: 'idle',
    pendingPermissions: [],
    lastRun: { at: back, ...run },
  });
  const asking = (title: string, askedAt = back): RecapSubject => ({
    title,
    status: 'awaiting_permission',
    pendingPermissions: [{}],
    askedAt,
  });

  it('names what finished and what it cost, and what stopped to ask', () => {
    // The duration and the money are `formatDuration` and `formatUsd`, the
    // same pair the status line and the transcript print — which is why a
    // cost under a dollar keeps three decimals here too. A recap that rounded
    // its own way would be a second answer to "what did that turn cost".
    expect(awayRecap([finished('refactor', { durationMs: 130_000, costUsd: 0.08 }), asking('release notes')], away)).toBe(
      'while you were away: refactor finished (2m 10s, $0.080) · release notes is waiting on a permission',
    );
  });

  it('drops the parenthesis rather than apologising inside it', () => {
    // A provider that reports neither number leaves the sentence complete as
    // it stands; `finished (—, —)` would be punctuation saying "don't know".
    expect(awayRecap([finished('refactor')], away)).toBe('while you were away: refactor finished');
    expect(awayRecap([finished('refactor', { durationMs: 4_000 })], away)).toBe('while you were away: refactor finished (4.0s)');
    expect(awayRecap([finished('refactor', { costUsd: 0.5 })], away)).toBe('while you were away: refactor finished ($0.500)');
  });

  it('names two and counts the rest', () => {
    const line = awayRecap([finished('one'), finished('two'), finished('three'), finished('four')], away);
    expect(line).toBe('while you were away: one finished · two finished · +2 more');
  });

  it('says nothing at all when nothing changed', () => {
    expect(awayRecap([], away)).toBeUndefined();
    // Ended before the person stopped typing: they watched it happen.
    expect(awayRecap([finished('refactor', { at: 500 })], away)).toBeUndefined();
    // Asked before they left, and still asking: not news, just unfinished.
    expect(awayRecap([asking('release notes', 500)], away)).toBeUndefined();
    expect(awayRecap([{ status: 'idle', pendingPermissions: [] }], away)).toBeUndefined();
  });

  it('keeps quiet about a turn that is still running', () => {
    // Its last run ended while nobody was here, but a new one is in flight and
    // the rail's own glyph would contradict the word "finished".
    expect(awayRecap([{ ...finished('refactor'), status: 'running' }], away)).toBeUndefined();
  });

  it('does not call a crash an answer', () => {
    expect(awayRecap([finished('refactor', { failed: true, durationMs: 130_000 })], away)).toBe(
      'while you were away: refactor stopped with an error',
    );
  });

  it('has something to call a conversation the store has not named', () => {
    expect(awayRecap([{ ...finished('x'), title: '  ' }], away)).toBe('while you were away: a conversation finished');
  });

  it('reads down the pool in the order it was given', () => {
    // Rail order, so the line names conversations in the order the eye is
    // about to travel. Which one to *go* to is `needsYou`'s question.
    expect(awayRecap([asking('b'), finished('a')], away)).toBe(
      'while you were away: b is waiting on a permission · a finished',
    );
    expect(awayRecap([finished('a'), asking('b')], away)).toBe(
      'while you were away: a finished · b is waiting on a permission',
    );
  });
});
