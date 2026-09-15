/*
 * What Space over a rail row is allowed to claim.
 *
 * The box draws a listing entry and nothing else, so these are as much about
 * what it does *not* do — invent a last line the summary never carried, print
 * an empty ` · · ` where a provider recorded no branch — as about the layout.
 * The lines are checked as data and then once through a real render, because
 * the wrapping is the part that would quietly push a box wider than the rail.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { ProfileId, SessionId, SessionSummary } from '@rx-artemis/protocol';

import { previewLines, SessionPreview } from './SessionPreview.js';

/** A SessionSummary with only the fields the preview reads. */
function session(over: Partial<SessionSummary> & { id: string; cwd: string; updatedAt: number }): SessionSummary {
  return {
    providerId: 'claude',
    profileId: 'prof_personal' as ProfileId,
    title: over.id,
    ...over,
    id: over.id as SessionId,
  } as SessionSummary;
}

const HOME = '/home/ada';
const minute = 60_000;

const full = session({
  id: 's1',
  title: 'Rail filtering',
  cwd: '/home/ada/code/api',
  updatedAt: Date.now() - minute,
  gitBranch: 'tui/overhaul',
  model: 'opus',
  messageCount: 42,
  firstPrompt: 'Make the rail searchable, then show me what a row is before I open it.',
});

const texts = (lines: readonly { readonly text: string }[]): readonly string[] => lines.map((line) => line.text);

describe('previewLines', () => {
  it('leads with the title and puts the facts under it', () => {
    const lines = previewLines(full, 60, HOME);

    expect(lines[0]).toEqual({ kind: 'title', text: 'Rail filtering' });
    expect(lines[1]?.text).toBe('1m ago · tui/overhaul · opus · 42 messages');
    expect(texts(lines)).toContain('~/code/api');
  });

  it('leaves out what the provider never recorded, rather than printing a gap', () => {
    const bare = session({ id: 's2', title: 'Bare', cwd: '/tmp/work', updatedAt: Date.now() - minute });
    const lines = previewLines(bare, 60, HOME);

    expect(texts(lines)).toEqual(['Bare', '1m ago', '/tmp/work', 'no opening prompt stored']);
    expect(texts(lines).some((text) => text.includes(' ·  · '))).toBe(false);
  });

  it('shows the opening prompt, which is the only text a listing carries', () => {
    const lines = previewLines(full, 60, HOME);
    const body = lines.filter((line) => line.kind === 'body').map((line) => line.text);

    expect(texts(lines)).toContain('first prompt');
    expect(body.join(' ')).toContain('Make the rail searchable');
  });

  it('wraps the prompt to the width it was given, keeping the words whole', () => {
    const lines = previewLines(full, 24, HOME);
    const body = lines.filter((line) => line.kind === 'body').map((line) => line.text);

    expect(body.length).toBeGreaterThan(1);
    expect(body.length).toBeLessThanOrEqual(4);
    for (const line of body) expect(line.length).toBeLessThanOrEqual(20);
    expect(body[0]?.startsWith('Make the rail')).toBe(true);
    expect(body.join(' ')).toContain('show me what a row is');
  });

  it('stops a prompt that would fill the screen, and says that it stopped', () => {
    const chatty = session({
      ...full,
      id: 's5',
      firstPrompt: `${full.firstPrompt ?? ''} ${'And another thing entirely. '.repeat(20)}`,
    });
    const body = previewLines(chatty, 24, HOME)
      .filter((line) => line.kind === 'body')
      .map((line) => line.text);

    expect(body).toHaveLength(4);
    expect(body.at(-1)?.endsWith('…')).toBe(true);
  });

  it('keeps every line inside the box, however long the title is', () => {
    const long = session({
      id: 's3',
      title: 'A title that goes on and on and on past anything a narrow rail could hold',
      cwd: '/home/ada/code/some/deep/and/tiresome/directory/somewhere',
      updatedAt: Date.now() - minute,
    });

    for (const line of previewLines(long, 30, HOME)) expect(line.text.length).toBeLessThanOrEqual(26);
  });
});

describe('SessionPreview', () => {
  it('draws the title, the facts, the folder and the prompt', () => {
    const { lastFrame } = render(<SessionPreview session={full} columns={60} home={HOME} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Rail filtering');
    expect(frame).toContain('tui/overhaul');
    expect(frame).toContain('~/code/api');
    expect(frame).toContain('first prompt');
    expect(frame).toContain('Make the rail searchable');
  });

  it('stays inside the width it was given', () => {
    const { lastFrame } = render(<SessionPreview session={full} columns={30} home={HOME} />);

    for (const line of (lastFrame() ?? '').split('\n')) expect(line.length).toBeLessThanOrEqual(30);
  });

  it('says plainly that a conversation with no stored prompt has none', () => {
    const bare = session({ id: 's4', title: 'Bare', cwd: '/tmp/work', updatedAt: Date.now() - minute });
    const { lastFrame } = render(<SessionPreview session={bare} columns={40} home={HOME} />);

    expect(lastFrame()).toContain('no opening prompt stored');
  });
});
