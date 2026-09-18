/**
 * What the window chrome should say, worked out from what the pool is doing.
 *
 * `terminal.ts` knows how to write a title, light a taskbar and ring a bell,
 * and deliberately knows nothing about when. This is the when: pure functions
 * that turn the state of several conversations into the one line a taskbar
 * button shows, the two sentences a notification carries, and the sentence
 * that greets somebody who has been away from the keyboard.
 *
 * They live here rather than in `app.tsx` because they are the only part of
 * the chrome that can be wrong in a way a test would catch. Everything else up
 * there is an effect firing on a tuple; these are decisions — which of three
 * words a window full of parked conversations deserves, and what a bell that
 * rings while nobody is looking should say when they come back. There is no
 * app-level harness, so logic that can be got wrong goes in a module that has
 * one.
 *
 * None of them touches the clock, the environment or a stream.
 */

import { formatDuration, formatUsd } from '@rx-artemis/transcript';

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

/* -------------------------------------------------------------------------- */
/* What happened while nobody was here                                        */
/* -------------------------------------------------------------------------- */

/** A turn that ended, in the parts worth reporting afterwards. */
export interface RunEnded {
  /** Host clock when the run ended. */
  readonly at: number;
  /** Wall-clock length of the run, where the provider reported one. */
  readonly durationMs?: number | undefined;
  /** What the run cost, where the provider reported it. */
  readonly costUsd?: number | undefined;
  /** It ended in an error rather than in an answer. */
  readonly failed?: boolean | undefined;
}

/** One pooled conversation, as the recap needs to read it. */
export interface RecapSubject {
  /** Its name, when the store has given it one. */
  readonly title?: string | undefined;
  readonly status: ConversationStatus;
  readonly pendingPermissions: readonly unknown[];
  /** Its last finished turn, whenever that was. */
  readonly lastRun?: RunEnded | undefined;
  /** Host clock when it stopped to ask. Stale once the question is answered. */
  readonly askedAt?: number | undefined;
}

/** How many things the line names before it starts counting them instead. */
export const RECAP_CLAUSES = 2;

/** What the recap calls a conversation the store has not named yet. */
const UNNAMED = 'a conversation';

/**
 * What changed across the pool while the keyboard was untouched.
 *
 * The one line somebody sees on the keystroke that brings them back, so it is
 * written for a person who has lost the thread rather than for one who is
 * following it: names first, then the two numbers that decide whether the
 * answer was worth what it cost. Everything in it is news — `since` is the
 * moment of the last keypress, and a turn that ended or a question that was
 * asked *before* that was watched happening. Nothing changed, nothing is said:
 * a line that appears on every return is furniture, and furniture is ignored.
 *
 * Two clauses and then a count, because this is a flash and not a report. The
 * third thing that happened is real but it is not what the eye has time for,
 * and `+2 more` is an honest promise that the rail can be read for the rest —
 * where the same facts are already drawn, per row, with no cap at all.
 *
 * The caller's order is kept rather than sorted by urgency. The caller passes
 * the pool in rail order, so the line reads down the same list the eye is
 * about to travel; a recap that ranked its clauses would name conversations in
 * an order that matches nothing else on the screen. Which one to *go* to is a
 * different question and `needsYou` answers it.
 */
export function awayRecap(states: readonly RecapSubject[], since: number): string | undefined {
  const clauses = states.map((state) => recapClause(state, since)).filter((clause): clause is string => clause !== undefined);
  if (clauses.length === 0) return undefined;
  const named = clauses.slice(0, RECAP_CLAUSES);
  const rest = clauses.length - named.length;
  return `while you were away: ${named.join(' · ')}${rest > 0 ? ` · +${String(rest)} more` : ''}`;
}

/**
 * One conversation's news, or nothing at all.
 *
 * A question outranks a finished turn for the reason it does everywhere else
 * here: it is the state that stays until a person deals with it. The parenthesis
 * is dropped rather than padded when the provider reported neither a duration
 * nor a cost — `finished (—, —)` is three characters of apology where the
 * sentence was already complete.
 */
function recapClause(state: RecapSubject, since: number): string | undefined {
  const name = oneWord(state.title) ?? UNNAMED;
  if (state.pendingPermissions.length > 0) {
    return state.askedAt !== undefined && state.askedAt > since ? `${name} is waiting on a permission` : undefined;
  }
  const run = state.lastRun;
  // Still working: whatever it finished before this turn is not the news, and
  // saying it finished would be a line the rail's own glyph contradicts.
  if (run === undefined || run.at <= since || state.status !== 'idle') return undefined;
  if (run.failed === true) return `${name} stopped with an error`;
  const spent = [
    run.durationMs === undefined ? undefined : formatDuration(run.durationMs),
    run.costUsd === undefined ? undefined : formatUsd(run.costUsd),
  ].filter((part): part is string => part !== undefined);
  return spent.length === 0 ? `${name} finished` : `${name} finished (${spent.join(', ')})`;
}
