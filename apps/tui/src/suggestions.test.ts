/**
 * Which offers a digit can still take, and which row draws which chips.
 *
 * Built from events through the model rather than from hand-written items, so
 * what is under test is the shape a provider actually produces: an offer is a
 * `tool.start` / `tool.end` pair on one tool name, and a turn is a user message
 * with everything that came of it.
 *
 * Two rules are worth more than the rest and both are pinned here. An offer
 * three turns back is not answerable — the conversation has moved under it — and
 * the number a chip shows is counted over the *turn*, so the row the app is
 * about to fire and the row the reader pressed a key for are the same row.
 */

import { describe, expect, it } from 'vitest';
import { SUGGESTED_TASK_TOOL, type AgentEvent } from '@rx-artemis/protocol';
import { TranscriptModel, syncScheduler } from '@rx-artemis/transcript';

import { offerDrawnBy, suggestionsOf } from './suggestions.js';

/** Envelope filler; timestamps rise with position. */
function stream(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): AgentEvent[] {
  return drafts.map((draft, index) => ({ ...draft, runId: 'run_1', seq: index, ts: 1000 + index })) as AgentEvent[];
}

function model(events: readonly AgentEvent[]): TranscriptModel {
  const transcript = new TranscriptModel(syncScheduler);
  for (const event of events) transcript.apply(event);
  transcript.flush();
  return transcript;
}

/** The call an agent offers work with, and the sentence its handler echoes back. */
const offer = (
  id: string,
  task: { readonly title: string; readonly prompt?: string; readonly tldr?: string },
): Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>> => [
  { type: 'tool.start', toolCallId: id, name: SUGGESTED_TASK_TOOL, input: { ...task } },
  { type: 'tool.end', toolCallId: id, status: 'ok', resultText: 'Suggested.' },
];

const said = (id: string, text: string): Omit<AgentEvent, 'runId' | 'seq' | 'ts'> => ({
  type: 'text.complete',
  messageId: id,
  role: 'user',
  text,
});

const answered = (id: string, text: string): Omit<AgentEvent, 'runId' | 'seq' | 'ts'> => ({
  type: 'text.delta',
  messageId: id,
  blockIndex: 0,
  text,
});

describe('the offers a digit can take', () => {
  it('numbers the latest answer in the order it offered, with the prompts', () => {
    const transcript = model(
      stream(
        said('u1', 'clean this up'),
        answered('m1', 'Done. Two things I noticed:'),
        ...offer('s1', { title: 'Add tests for the parser', tldr: 'Nothing covers it.', prompt: 'Write tests for the parser.' }),
        ...offer('s2', { title: 'Update the README', prompt: 'Document the new flags.' }),
        { type: 'run.end', reason: 'completed' },
      ),
    );

    expect(suggestionsOf(transcript)).toEqual([
      { id: 's1', index: 1, title: 'Add tests for the parser', tldr: 'Nothing covers it.', prompt: 'Write tests for the parser.', itemId: 't:s1' },
      { id: 's2', index: 2, title: 'Update the README', tldr: '', prompt: 'Document the new flags.', itemId: 't:s2' },
    ]);
  });

  it('forgets the older offer once a new turn has happened', () => {
    // The files it named have been edited by now and the reason it was offered
    // was probably what the last turn did. A digit that fires the wrong one of
    // six stale offers is worse than a digit that does nothing.
    const transcript = model(
      stream(
        said('u1', 'clean this up'),
        ...offer('s1', { title: 'Add tests for the parser', prompt: 'Write tests for the parser.' }),
        { type: 'run.end', reason: 'completed' },
        said('u2', 'now the docs'),
        ...offer('s2', { title: 'Update the README', prompt: 'Document the new flags.' }),
        { type: 'run.end', reason: 'completed' },
      ),
    );

    expect(suggestionsOf(transcript).map((suggestion) => [suggestion.index, suggestion.title])).toEqual([
      [1, 'Update the README'],
    ]);
  });

  it('offers nothing while the turn that would offer is still running', () => {
    const transcript = model(
      stream(
        said('u1', 'clean this up'),
        ...offer('s1', { title: 'Add tests for the parser', prompt: 'Write tests for the parser.' }),
        { type: 'run.end', reason: 'completed' },
        said('u2', 'now the docs'),
        answered('m2', 'Reading them.'),
      ),
    );

    expect(suggestionsOf(transcript)).toEqual([]);
  });

  it('leaves out a call the agent got wrong', () => {
    // A prompt is what a chip *does*; without one there is nothing to accept,
    // and a numbered chip that starts nothing is worse than no chip.
    const transcript = model(
      stream(
        said('u1', 'clean this up'),
        ...offer('s1', { title: 'Add tests for the parser' }),
        ...offer('s2', { title: 'Update the README', prompt: 'Document the new flags.' }),
      ),
    );

    expect(suggestionsOf(transcript).map((suggestion) => [suggestion.index, suggestion.title])).toEqual([
      [1, 'Update the README'],
    ]);
  });

  it('has nothing to offer for a conversation that made none', () => {
    expect(suggestionsOf(model(stream(said('u1', 'hello'), answered('m1', 'Hi.'))))).toEqual([]);
    expect(suggestionsOf(model([]))).toEqual([]);
  });
});

describe('the chips one row draws', () => {
  it('gives a burst to its first row and nothing to the rest', () => {
    // Three rows each carrying one chip reads as three things the agent did.
    // One row of three chips reads as one question with three answers.
    const transcript = model(
      stream(
        said('u1', 'clean this up'),
        ...offer('s1', { title: 'Add tests for the parser', prompt: 'Write the tests.' }),
        ...offer('s2', { title: 'Update the README', prompt: 'Document the flags.' }),
      ),
    );

    expect(offerDrawnBy(transcript, 't:s1')?.map((chip) => [chip.index, chip.title])).toEqual([
      [1, 'Add tests for the parser'],
      [2, 'Update the README'],
    ]);
    expect(offerDrawnBy(transcript, 't:s2')).toEqual([]);
  });

  it('keeps the numbering of the turn when a sentence splits the offers', () => {
    const transcript = model(
      stream(
        said('u1', 'clean this up'),
        ...offer('s1', { title: 'Add tests for the parser', prompt: 'Write the tests.' }),
        answered('m1', 'And one more thing.'),
        ...offer('s2', { title: 'Update the README', prompt: 'Document the flags.' }),
      ),
    );

    // Two rows of one chip each, because that is where the agent put them — but
    // the second still says `2`, which is the digit the app has bound to it.
    expect(offerDrawnBy(transcript, 't:s1')?.map((chip) => chip.index)).toEqual([1]);
    expect(offerDrawnBy(transcript, 't:s2')?.map((chip) => chip.index)).toEqual([2]);
  });

  it('answers for nothing that is not a well-formed offer', () => {
    const transcript = model(
      stream(
        said('u1', 'clean this up'),
        { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
        ...offer('s1', { title: 'Add tests for the parser' }),
      ),
    );

    // An ordinary call, a malformed offer, and a row that is not there at all.
    // All three fall back to whatever the renderer drew before.
    expect(offerDrawnBy(transcript, 't:c1')).toBeNull();
    expect(offerDrawnBy(transcript, 't:s1')).toBeNull();
    expect(offerDrawnBy(transcript, 'g:t:c1')).toBeNull();
  });
});
