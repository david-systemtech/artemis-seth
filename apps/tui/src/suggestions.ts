/**
 * The follow-up work on offer, and which digit answers it.
 *
 * An agent offers a task by calling one tool — `mcp__artemisTasks__suggest_task`
 * — and that call is the whole storage: see ADR 0005 and
 * `@rx-artemis/protocol`'s `suggestedTasks`. Nothing here keeps a list, files
 * anything, or is told when an offer is made; every question is answered by
 * reading the transcript that is already on the screen, which is why a reopened
 * conversation's chips come back without a line of code to restore them.
 *
 * Two questions are asked of it, and they are different questions:
 *
 *  - **Which offers can be accepted right now** — {@link suggestionsOf}, for
 *    the app, which binds `1`–`4` to them. Only the *latest* answer's, because
 *    an offer made three turns ago has had the conversation move under it: the
 *    files it named have been edited, the reason it was offered was probably
 *    what the last two turns did, and a digit that fires the wrong one of six
 *    stale offers is worse than a digit that does nothing.
 *  - **What one row draws** — {@link offerDrawnBy}, for `Transcript.tsx`. A
 *    suggestion is one call and therefore one row, but an answer usually makes
 *    two or three in a burst, and three rows each carrying one chip reads as
 *    three things the agent did rather than one question with three answers. So
 *    the first row of an adjacent burst draws the whole row of chips and the
 *    rest draw nothing, which is what {@link offerDrawnBy} returning an empty
 *    list means.
 *
 * Both number the chips the same way, and that is the point of computing them
 * here rather than in the renderer: the number the reader sees and the digit the
 * app binds are one calculation, so a chip cannot come to advertise a key that
 * starts a different task. Numbering runs over the *turn*, not over the burst,
 * so an answer that offers one task, says a sentence, then offers another still
 * counts `1` then `2`.
 *
 * Pure, and free of Ink: the model goes in, plain data comes out.
 */

import { parseSuggestedTask } from '@rx-artemis/protocol';
import { isSuggestedTaskCall, type TranscriptModel } from '@rx-artemis/transcript';

/**
 * One offered task, as a chip and as a key.
 *
 * `id` is the provider's own call id and survives a reload, which makes it the
 * right thing to remember a choice against; `itemId` is the transcript row the
 * chip is drawn on, which is what the viewport's `cursor` and `expandedRows`
 * are in terms of. They differ by a prefix today and that is an implementation
 * detail of the model rather than a promise either way.
 *
 * `tldr` rides along although nothing but the expanded chip draws it: the
 * alternative is the row parsing the call's arguments a second time to find the
 * sentence that belongs to the title it was just handed, and two parses of one
 * call are two chances to disagree about what the offer said.
 */
export interface Suggestion {
  /** The call the offer was made by, as the provider filed it. */
  readonly id: string;
  /** Its place in the answer, from 1. The digit that chooses it. */
  readonly index: number;
  /** A few words naming the work. What the chip reads. */
  readonly title: string;
  /** The sentence behind the title; `''` when the agent left it out. */
  readonly tldr: string;
  /** What goes in the composer. */
  readonly prompt: string;
  /** The transcript row this offer is drawn on. */
  readonly itemId: string;
}

/**
 * How many offers a keyboard can answer.
 *
 * `1`–`4`, because the digits are the whole of the interaction and there are no
 * more of them a hand finds without looking. An answer that offers a fifth task
 * still shows it — it is in the transcript and the transcript is the record —
 * but the chip wears no number, because a number on it would name a key that
 * does nothing. Four is also the desktop's count of *targets*, which is a
 * coincidence and not a shared constant.
 */
export const SUGGESTION_DIGITS = 4;

/**
 * The offers of the most recent answer, in the order they were made.
 *
 * Empty whenever the latest turn made none, which includes the ordinary case of
 * a turn that is still running: the offer arrives at the end of the work, and
 * until then there is nothing to accept. The app is expected to bind the first
 * {@link SUGGESTION_DIGITS} of these and to stop offering the keys the moment
 * the conversation moves — this function says what is on offer, never whether
 * the keyboard is free to take it.
 */
export function suggestionsOf(model: TranscriptModel): readonly Suggestion[] {
  const ids = model.getListSnapshot();
  return offersIn(ids.slice(turnStart(ids, model, ids.length - 1)), model);
}

/**
 * The chips this row is responsible for drawing.
 *
 * `null` for a row that is not an offer at all — including a call to the tool
 * whose arguments are not a task, which is a mistake the agent made and which
 * belongs in the ordinary tool row where it can be seen, rather than behind a
 * chip with no words on it. That is the desktop's rule in `SuggestedTask.tsx`,
 * and the terminal keeps it.
 *
 * An empty list for an offer a neighbour above is already drawing. The caller
 * draws nothing for it, so a burst of three calls is one row of three chips
 * with two blank rows' worth of nothing after it.
 */
export function offerDrawnBy(model: TranscriptModel, rowId: string): readonly Suggestion[] | null {
  // The name check first: it is a string comparison, and the walk that follows
  // it is over every item in the conversation.
  if (!isOffer(model, rowId)) return null;
  const ids = model.getListSnapshot();
  const at = ids.indexOf(rowId);
  if (at < 0) return null;
  // The row above carries this burst's chips, and one of them is this row's.
  if (isOffer(model, ids[at - 1])) return [];

  const numbered = offersIn(ids.slice(turnStart(ids, model, at), turnEnd(ids, model, at)), model);
  const burst: Suggestion[] = [];
  for (let i = at; i < ids.length && isOffer(model, ids[i]); i += 1) {
    const chip = numbered.find((candidate) => candidate.itemId === ids[i]);
    if (chip !== undefined) burst.push(chip);
  }
  return burst;
}

/** A row that is a call to the tool *and* carries a task a chip can be drawn from. */
function isOffer(model: TranscriptModel, id: string | undefined): boolean {
  if (id === undefined) return false;
  const item = model.getItem(id);
  return isSuggestedTaskCall(item) && parseSuggestedTask(item.input) !== null;
}

/**
 * The offers among these items, numbered from 1.
 *
 * Numbered over what it is given, which is why every caller hands it a whole
 * turn: a burst numbered against itself would start again at `1` after an
 * intervening sentence, and the second `1` would be the app's `2`.
 */
function offersIn(ids: readonly string[], model: TranscriptModel): readonly Suggestion[] {
  const offers: Suggestion[] = [];
  for (const id of ids) {
    const item = model.getItem(id);
    if (!isSuggestedTaskCall(item)) continue;
    const task = parseSuggestedTask(item.input);
    if (task === null) continue;
    offers.push({
      id: item.toolCallId,
      index: offers.length + 1,
      title: task.title,
      tldr: task.tldr,
      prompt: task.prompt,
      itemId: item.id,
    });
  }
  return offers;
}

/*
 * Where a turn begins and ends, in the model's own list.
 *
 * A turn is what the person said and everything that came of it, so the
 * boundary is the *user* row and nothing else. Not `run-end`: a conversation
 * read back from disk has none in it at all, and the chips of a resumed
 * conversation are the whole reason the offer is a tool call rather than a push
 * (ADR 0005). Not the run id either, which a resumed transcript's rows do not
 * carry.
 *
 * A pending user row counts, which is the behaviour that matters most: the
 * moment somebody sends something, the offers above it stop being answerable,
 * and they stop here without waiting to hear back from the provider.
 */
function turnStart(ids: readonly string[], model: TranscriptModel, from: number): number {
  for (let i = Math.min(from, ids.length - 1); i >= 0; i -= 1) {
    if (kindAt(ids, model, i) === 'user') return i;
  }
  return 0;
}

function turnEnd(ids: readonly string[], model: TranscriptModel, from: number): number {
  for (let i = from + 1; i < ids.length; i += 1) {
    if (kindAt(ids, model, i) === 'user') return i;
  }
  return ids.length;
}

function kindAt(ids: readonly string[], model: TranscriptModel, index: number): string | undefined {
  const id = ids[index];
  return id === undefined ? undefined : model.getItem(id)?.kind;
}
