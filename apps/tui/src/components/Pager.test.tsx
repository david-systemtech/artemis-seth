/**
 * The unfold, driven by its keys.
 *
 * Real bytes through `stdin`, because the thing under test is a key map: `G`
 * is an escape-free capital, `{` is a plain character, Ctrl+U is a control
 * byte, and a test that called the handlers directly would pass while the
 * terminal sent something else. The frames are read as text for the same
 * reason — where the reader ends up is what the pager is for.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { AgentEvent } from '@rx-artemis/protocol';
import { TranscriptModel, syncScheduler } from '@rx-artemis/transcript';

import { Pager } from './Pager.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/** Envelope filler; timestamps rise with position, which is what row order rests on. */
function stream(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): AgentEvent[] {
  return drafts.map((draft, index) => ({ ...draft, runId: 'run_1', seq: index, ts: 1000 + index })) as AgentEvent[];
}

const APPLES = [
  'Apples are a fruit.',
  'A kumquat is smaller.',
  'The kumquat ripens late.',
  ...Array.from({ length: 7 }, (_, i) => `Apple note ${String(i + 1)}.`),
].join('\n');

const BANANAS = Array.from({ length: 20 }, (_, i) => `Banana note ${String(i + 1)}.`).join('\n');

/**
 * Two turns, a run of calls between them, and more lines than any of the
 * screens below can hold — which is the only state in which scrolling, jumping
 * and searching mean anything.
 */
function conversation(): TranscriptModel {
  const model = new TranscriptModel(syncScheduler);
  const events = stream(
    { type: 'text.complete', messageId: 'u1', role: 'user', text: 'First question about apples' },
    { type: 'text.delta', messageId: 'a1', blockIndex: 0, text: APPLES },
    { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta' },
    { type: 'tool.start', toolCallId: 'c2', name: 'Grep', input: { pattern: 'fruit' } },
    { type: 'tool.end', toolCallId: 'c2', status: 'ok', resultText: 'notes.txt: a kumquat, ripe' },
    { type: 'run.end', reason: 'completed', durationMs: 900 },
    { type: 'text.complete', messageId: 'u2', role: 'user', text: 'Second question about bananas' },
    { type: 'text.delta', messageId: 'a2', blockIndex: 0, text: BANANAS },
    { type: 'run.end', reason: 'completed', durationMs: 900 },
  );
  for (const event of events) model.apply(event);
  model.flush();
  return model;
}

function open(props: Partial<React.ComponentProps<typeof Pager>> = {}): ReturnType<typeof render> {
  return render(
    <Pager transcript={conversation()} columns={80} rows={16} onClose={() => undefined} {...props} />,
  );
}

describe('the pager', () => {
  it('draws the conversation with nothing folded, opened at the end', async () => {
    const { lastFrame } = open();
    await tick();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Transcript');
    expect(frame).toContain('/ search · n N · { } turns · g G · q close');
    // The end is where the thing someone pressed Ctrl+O to see just went past.
    expect(frame).toContain('Banana note 20.');
    expect(frame).toContain('100%');
  });

  it('unfolds the run that the viewport draws as a count', async () => {
    // Top, then a page down, which is where the run sits in this conversation.
    const { lastFrame, stdin } = open();
    await tick();
    stdin.write('g');
    await tick();
    stdin.write(' ');
    await tick();
    const frame = lastFrame() ?? '';

    // Collapsed, a finished call is a number and its output is nowhere; here
    // the count is a dim heading over the calls it stands for, in full.
    expect(frame).toMatch(/Ran a command/);
    expect(frame).toContain('Bash(ls)');
    expect(frame).toContain('zeta');
  });

  it('g goes to the top and G reaches the end', async () => {
    const { lastFrame, stdin } = open();
    await tick();

    stdin.write('g');
    await tick();
    expect(lastFrame() ?? '').toContain('First question about apples');
    expect(lastFrame() ?? '').not.toContain('Banana note 20.');
    expect(lastFrame() ?? '').toContain('0%');

    stdin.write('G');
    await tick();
    expect(lastFrame() ?? '').toContain('Banana note 20.');
    expect(lastFrame() ?? '').not.toContain('First question about apples');
  });

  it('moves a line with j and half a screen with Ctrl+D, and back with Ctrl+U', async () => {
    const { lastFrame, stdin } = open();
    await tick();
    stdin.write('g');
    await tick();
    expect(lastFrame() ?? '').toContain('First question about apples');

    stdin.write('j');
    await tick();
    // One line: the turn was on the second one, so it is still on screen.
    expect(lastFrame() ?? '').toContain('First question about apples');

    stdin.write('\u0004');
    await tick();
    expect(lastFrame() ?? '').not.toContain('First question about apples');

    stdin.write('\u0015');
    await tick();
    expect(lastFrame() ?? '').toContain('First question about apples');
  });

  it('{ walks back through the turns', async () => {
    const { lastFrame, stdin } = open();
    await tick();
    expect(lastFrame() ?? '').not.toContain('Second question about bananas');

    stdin.write('{');
    await tick();
    expect(lastFrame() ?? '').toContain('Second question about bananas');

    stdin.write('{');
    await tick();
    expect(lastFrame() ?? '').toContain('First question about apples');
  });

  it('finds a phrase through the model and n cycles the matches', async () => {
    const { lastFrame, stdin } = open();
    await tick();

    stdin.write('/');
    await tick();
    stdin.write('kumquat');
    await tick();
    // The row is open and shows what is being typed.
    expect(lastFrame() ?? '').toContain('/kumquat');

    stdin.write('\r');
    await tick();
    let frame = lastFrame() ?? '';
    expect(frame).toContain('kumquat  1/3');
    expect(frame).toContain('A kumquat is smaller.');

    stdin.write('n');
    await tick();
    expect(lastFrame() ?? '').toContain('kumquat  2/3');

    // The third is inside a call whose result the live viewport never draws:
    // the search is over the transcript model, not over what is on screen.
    stdin.write('n');
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('kumquat  3/3');
    expect(frame).toContain('notes.txt: a kumquat, ripe');
  });

  it('says so when a phrase is nowhere in the conversation', async () => {
    const { lastFrame, stdin } = open();
    await tick();
    stdin.write('/');
    await tick();
    stdin.write('durian');
    await tick();
    stdin.write('\r');
    await tick();

    expect(lastFrame() ?? '').toContain('durian  no matches');
  });

  it('Esc closes the search row without closing the pager', async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = open({ onClose });
    await tick();
    stdin.write('/');
    await tick();
    stdin.write('\u001b');
    await tick();

    expect(onClose).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').not.toContain('/kumquat');

    // With the row closed, Esc is the way out.
    stdin.write('\u001b');
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('q closes it', async () => {
    const onClose = vi.fn();
    const { stdin } = open({ onClose });
    await tick();
    stdin.write('q');
    await tick();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+O closes it, the same key that opened it', async () => {
    const onClose = vi.fn();
    const { stdin } = open({ onClose });
    await tick();
    stdin.write('\u000f');
    await tick();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('v hands the conversation to the editor as text', async () => {
    const onOpenInEditor = vi.fn();
    const { stdin } = open({ onOpenInEditor });
    await tick();
    stdin.write('v');
    await tick();

    expect(onOpenInEditor).toHaveBeenCalledTimes(1);
    const text = onOpenInEditor.mock.calls[0]?.[0] as string;
    expect(text).toContain('First question about apples');
    expect(text).toContain('Banana note 20.');
    // Every item, not every row: a call folded into a count still happened.
    expect(text).toContain('notes.txt: a kumquat, ripe');
  });

  /**
   * The rows the turns open at, which is what `/timeline` hands over. Read off
   * the model rather than written down, because the point of the prop is that
   * a user item's id *is* its row id — nothing translates it.
   */
  function turnRows(model: TranscriptModel): readonly string[] {
    return model.getRowsSnapshot().filter((id) => model.getItem(id)?.kind === 'user');
  }

  it('opens on the row it was given, a line of context above it', async () => {
    const transcript = conversation();
    const second = turnRows(transcript)[1];
    const { lastFrame } = open({ transcript, initialRowId: second });
    await tick();
    const lines = (lastFrame() ?? '').split('\n');

    // Line 0 is the title, so the body starts at 1 — and the turn is not on
    // it. The tail of the row above, the card that closed the first run, is
    // the line of context that says the conversation did not start here.
    expect(lines[1] ?? '').toContain('900ms');
    expect(lines.findIndex((line) => line.includes('Second question about bananas'))).toBeGreaterThan(1);
    // Opened at that turn, which is not where it would have opened alone.
    expect(lines.join('\n')).not.toContain('Banana note 20.');
  });

  it('opens at the end when the row it was given is in no row', async () => {
    const { lastFrame } = open({ initialRowId: 'u:nowhere' });
    await tick();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Banana note 20.');
    expect(frame).toContain('100%');
  });

  it('counts the position it opened at in the foot, not the end', async () => {
    const transcript = conversation();
    const second = turnRows(transcript)[1];
    const { lastFrame } = open({ transcript, initialRowId: second });
    await tick();
    const frame = lastFrame() ?? '';

    const percent = Number(/(\d+)%/.exec(frame)?.[1] ?? '-1');
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThan(100);
  });

  it('opens with a phrase already in the search row, and does not run it', async () => {
    const { lastFrame, stdin } = open({ initialQuery: 'kumquat' });
    await tick();
    let frame = lastFrame() ?? '';

    // Typed, not searched: the row shows it, the foot has no count, and the
    // view is still at the end where the pager opens.
    expect(frame).toContain('/kumquat');
    expect(frame).not.toContain('1/3');
    expect(frame).toContain('Banana note 20.');

    // Enter runs it, as it would for anything typed by hand.
    stdin.write('\r');
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('kumquat  1/3');
    expect(frame).toContain('A kumquat is smaller.');
  });
});
