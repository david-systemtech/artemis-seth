/**
 * The chrome's two decisions.
 *
 * Both are about a person who is not looking at the screen, which is why they
 * are worth pinning: nobody watching a test run would ever notice the title
 * saying "ready" over a conversation that had stopped to ask something.
 */

import { describe, expect, it } from 'vitest';

import { noticeFor, titleStateOf, type ConversationActivity } from './attention.js';
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
