/**
 * What the window chrome should say, worked out from what the pool is doing.
 *
 * `terminal.ts` knows how to write a title, light a taskbar and ring a bell,
 * and deliberately knows nothing about when. This is the when: two pure
 * functions that turn the state of several conversations into the one line a
 * taskbar button shows, and the two sentences a notification carries.
 *
 * They live here rather than in `app.tsx` because they are the only part of
 * the chrome that can be wrong in a way a test would catch. Everything else up
 * there is an effect firing on a tuple; these are decisions — which of three
 * words a window full of parked conversations deserves, and what a bell that
 * rings while nobody is looking should say when they come back. There is no
 * app-level harness, so logic that can be got wrong goes in a module that has
 * one.
 *
 * Neither function touches the clock, the environment or a stream.
 */

import type { AttentionEvent, AttentionKind, TerminalActivity } from './terminal.js';
import type { ConversationStatus } from './conversation.js';

/* -------------------------------------------------------------------------- */
/* The title's state                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What the title needs to know about one conversation.
 *
 * Structural rather than `ConversationState`, for the same reason
 * `pool.ts`'s `ActivityInput` is: the two fields are the whole of what the
 * answer depends on, and a test should be able to write a case in one line.
 */
export interface ConversationActivity {
  readonly status: ConversationStatus;
  readonly pendingPermissions: readonly unknown[];
}

export interface TitleState {
  readonly state: TerminalActivity;
  /** How many conversations are waiting on a person. Zero unless `needs-you`. */
  readonly needing: number;
}

/**
 * The whole pool, in one word.
 *
 * The title is a fact about Artemis rather than about whichever conversation
 * happens to be on screen — that is the point of it, since the person reading
 * it has tabbed away and cannot see which one is showing. So the three states
 * are reduced across every conversation that is alive, in the order a person
 * would care about them: a question waiting on them beats work in flight beats
 * nothing to do. It is the rail's own precedence (`railActivityFor`), applied
 * to the window instead of to a row.
 *
 * `needing` is a count and not a flag because one conversation waiting and
 * four waiting are different situations, and the title can say which: see
 * `titleFor`, which draws `⚿ 4 need you`. It is zero in the other two states
 * rather than left as whatever was counted, so that the reading is never
 * "ready, and three of them need you".
 */
export function titleStateOf(states: readonly ConversationActivity[]): TitleState {
  let needing = 0;
  let working = false;
  for (const state of states) {
    // A conversation that has stopped to ask is not also counted as working:
    // its run is parked on the question, which is the thing worth reporting.
    if (state.pendingPermissions.length > 0) needing += 1;
    else if (state.status !== 'idle') working = true;
  }
  if (needing > 0) return { state: 'needs-you', needing };
  return { state: working ? 'working' : 'ready', needing: 0 };
}

/* -------------------------------------------------------------------------- */
/* What a bell says                                                           */
/* -------------------------------------------------------------------------- */

/** The conversation a notification is about, in the parts it is built from. */
export interface AttentionSubject {
  /** The conversation's name, when the store has given it one. */
  readonly conversation?: string;
  /** The tool a permission request names, for `needs-you`. */
  readonly tool?: string;
  /** What the agent said, for `finished`. Only its first line is used. */
  readonly reply?: string;
}

/** What a notification says when there is nothing specific to say. */
const FALLBACK_TITLE = 'Artemis';

/**
 * The two sentences of a notification.
 *
 * The title names the conversation, because a person with three of these open
 * is being told *which* one wants them; the body says what happened, because
 * OSC 9 has one field and that field is the body. A notification with neither
 * is still worth sending — something rang, and the window it rang from is the
 * answer — so both halves fall back to words rather than to nothing.
 *
 * Only the first line of a reply is used. The whole of it would be a paragraph
 * in a desktop notification, and the first line of an agent's answer is
 * reliably the sentence that says what it did; `terminal.ts` caps and cleans
 * whatever arrives here, so this decides the meaning and not the bytes.
 */
export function noticeFor(kind: AttentionKind, subject: AttentionSubject = {}): AttentionEvent {
  const title = oneWord(subject.conversation) ?? FALLBACK_TITLE;
  if (kind === 'needs-you') {
    const tool = oneWord(subject.tool);
    return { kind, title, body: tool === undefined ? 'Waiting for permission' : `${tool} is waiting for permission` };
  }
  return { kind, title, body: firstLine(subject.reply) ?? 'The turn has finished' };
}

/** A name, or nothing at all if it is blank — `undefined` is what has a fallback. */
function oneWord(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The first line with anything on it.
 *
 * Not the first line outright: a reply routinely opens with a blank line or a
 * heading's worth of markdown punctuation, and a notification body reading `##`
 * is a notification that has said nothing.
 */
function firstLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}
