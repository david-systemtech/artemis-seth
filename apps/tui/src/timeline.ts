/**
 * The turn ledger — one line per thing you asked for.
 * ============================================================================
 *
 * An hour of conversation is a column of text with no index. The terminal can
 * scroll it, the pager can search it and `{` / `}` walk between the prompts,
 * but nothing anywhere says *what the turns were*: how long the third one took,
 * what it cost, which files it left changed, which one you stopped halfway. The
 * facts exist — every run closes with a card carrying its duration, its usage
 * and why it stopped, and every edit is in the arguments of a tool call — they
 * are simply scattered down the same column that is too long to read.
 *
 * So this gathers them into a row per turn. OpenCode has a timeline you can
 * jump from; what nobody has is the cost and the files on it, which are exactly
 * the two things a person asks about a turn they are trying to find again
 * ("the expensive one", "the one that touched the parser").
 *
 * Pure over a {@link TranscriptModel}, in the same spirit as
 * `exportTranscript.ts`: the transcript is a model, not a screen, and deciding
 * what a line *says* is the part worth testing. Nothing here reads a clock,
 * touches the store or knows what a picker is.
 *
 * ## A turn is not a run
 *
 * A turn here is a prompt and everything under it until the next prompt. A run
 * is one cycle of the provider working. They coincide most of the time, and
 * come apart in both directions:
 *
 *  - **A steer splits a run across two turns.** The user types again while the
 *    agent is working; the second message opens a second turn, and the single
 *    `run.end` lands at the foot of it. The earlier turn then has no figures of
 *    its own, which is honest — nothing measured that stretch separately.
 *  - **Two runs can land in one turn.** A run that fails at the door gets a
 *    local run-end and the retry runs under the same prompt. Duration, tokens
 *    and cost are therefore *summed* over every run-end inside the turn, and
 *    the outcome is the last one's, which is how the turn actually finished.
 *
 * The prompt is the boundary rather than the run because the prompt is what the
 * reader remembers and what they want to be taken back to. Anything before the
 * first prompt — a replayed assistant preamble, a notice — belongs to no turn
 * and is dropped rather than attributed to the turn after it.
 *
 * ## Whose numbers these are
 *
 * The run-end's own, formatted with the shared formatters. Not recomputed: the
 * card that closes the run is directly above the rows the ledger summarises,
 * and a line that disagreed with the card would be worse than no line. `tok` is
 * {@link totalInputTokens} — billable input, cached and uncached — because that
 * is what `tok` means everywhere else in this app, on the run-end card and in
 * the status bar.
 *
 * Files and counts are the transcript's, since nothing else records them:
 *
 *  - **Files come from {@link detectFileEdits}**, which reads argument shape
 *    rather than tool names, so it survives a provider we have not written yet.
 *    Only calls that came back `ok` count — a write that errored or was denied
 *    did not touch the file, and a ledger claiming otherwise would send someone
 *    looking for a change that is not there. Same rule as the change ledger in
 *    `changes.ts`, for the same reason.
 *  - **Paths are deduplicated, first appearance first.** A turn that edits one
 *    file eight times touched one file. `edits` keeps the eight: "1 file · 8
 *    edits" is a different afternoon from "8 files · 8 edits".
 *  - **Commands and reads count every call**, failed ones included. They
 *    measure what the agent *did*, not what it achieved, and a shell command
 *    that exited 1 still ran.
 *
 * ## Five outcomes
 *
 * A reader scanning for the turn that went wrong needs `interrupted` and
 * `error` apart from each other and from a turn that simply finished, and needs
 * to see that a turn produced nothing at all rather than reading `0 tok` as a
 * shrug — the argument {@link RunEndItem.silent} already makes. The provider's
 * seven reasons fold into that: a stop the person caused (they interrupted, they
 * denied a call, the pane went away) reads as `interrupted`, and a stop the run
 * ran into (an error, a turn ceiling, a budget) reads as `error`.
 *
 * `running` is inferred, because a transcript does not know whether a provider
 * is still thinking: it is the open turn — the last prompt — with no run-end
 * under it yet. Replayed history has no run-ends at all (a stored session
 * records what was said, never where a run stopped), so a turn read out of a
 * file is never called running no matter how it ends.
 */

import type { RunEndReason } from '@rx-artemis/protocol';
import {
  classifyTool,
  detectFileEdits,
  formatDuration,
  formatTokens,
  formatUsd,
  oneLine,
  totalInputTokens,
  type RunEndItem,
  type ToolItem,
  type TranscriptItem,
  type TranscriptModel,
  type UserItem,
} from '@rx-artemis/transcript';

/* -------------------------------------------------------------------------- */
/* The ledger                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How a turn ended.
 *
 * `silent` is a completed run that produced nothing — no answer, no call, no
 * reasoning. See the file header for how the provider's reasons fold into
 * `interrupted` and `error`, and for why `running` is a guess.
 */
export type TurnOutcome = 'completed' | 'interrupted' | 'error' | 'running' | 'silent';

/** One prompt and everything that happened under it. */
export interface Turn {
  /** 1-based, in screen order — the number the line shows. */
  readonly index: number;
  /** The user row this turn opens at. What Enter jumps to. */
  readonly userItemId: string;
  /** The run the prompt was sent under, when the transcript knows it. */
  readonly runId?: string;
  /** When the prompt was sent. */
  readonly ts: number;
  /** The first line of what was asked, clipped to something a row can hold. */
  readonly prompt: string;
  /** Summed over the turn's run-ends. Absent until one has landed. */
  readonly durationMs?: number;
  /** Billable input tokens, cached and uncached — see the file header. */
  readonly tokens?: number;
  readonly costUsd?: number;
  /** Distinct paths the turn edited, in the order it first named them. */
  readonly files: readonly string[];
  /** File edits made, which is more than {@link files} when one file is edited twice. */
  readonly edits: number;
  readonly commands: number;
  readonly reads: number;
  readonly outcome: TurnOutcome;
  /** The run-end's error message, when it carried one. */
  readonly error?: string;
}

/** Longest prompt a turn carries. The line clips it again to the column width. */
const MAX_PROMPT = 200;

/**
 * The conversation as turns, in screen order.
 *
 * Segmented in the model's own order — "the next user item" is a statement
 * about the list — and then sorted by timestamp, which is the order the
 * transcript draws (see `inOrderOfStart` in `exportTranscript.ts`). The sort is
 * stable, so two prompts in the same millisecond keep the model's order.
 *
 * Never throws. A transcript is whatever a provider sent, and a ledger that
 * failed on a malformed row would fail at the moment someone was lost in a long
 * conversation and looking for a way back.
 */
export function turnsOf(model: TranscriptModel): readonly Turn[] {
  const drafts: Draft[] = [];
  let open: Draft | undefined;

  for (const id of model.getListSnapshot()) {
    const item = model.getItem(id);
    if (item === undefined) continue;
    if (item.kind === 'user') {
      open = draftOf(item);
      drafts.push(open);
      continue;
    }
    // Before the first prompt nothing is under anything: no turn to attribute
    // it to, and inventing one would head the ledger with a row nobody typed.
    if (open !== undefined) absorb(open, item);
  }

  return drafts
    .map((draft, position) => ({ draft, position }))
    .sort((a, b) => a.draft.user.ts - b.draft.user.ts || a.position - b.position)
    .map(({ draft }, index) => finish(draft, index + 1, draft === open));
}

/** A turn being accumulated. The only mutable thing in this file. */
interface Draft {
  readonly user: UserItem;
  readonly files: string[];
  edits: number;
  commands: number;
  reads: number;
  durationMs?: number;
  tokens?: number;
  costUsd?: number;
  /** The last run-end inside the turn — the one that says how it finished. */
  end?: RunEndItem;
}

function draftOf(user: UserItem): Draft {
  return { user, files: [], edits: 0, commands: 0, reads: 0 };
}

/** Fold one row of the turn into it. Everything else in a turn is prose. */
function absorb(draft: Draft, item: TranscriptItem): void {
  if (item.kind === 'tool') absorbCall(draft, item);
  else if (item.kind === 'run-end') absorbEnd(draft, item);
}

function absorbCall(draft: Draft, call: ToolItem): void {
  const category = classifyTool(call.name);
  if (category === 'command') draft.commands += 1;
  else if (category === 'read') draft.reads += 1;

  if (call.status !== 'ok') return;
  for (const edit of detectFileEdits(call.name, call.input)) {
    draft.edits += 1;
    if (!draft.files.includes(edit.path)) draft.files.push(edit.path);
  }
}

function absorbEnd(draft: Draft, end: RunEndItem): void {
  draft.end = end;
  draft.durationMs = add(draft.durationMs, end.durationMs);
  draft.tokens = add(draft.tokens, totalInputTokens(end.usage?.tokens));
  draft.costUsd = add(draft.costUsd, end.usage?.costUsd);
}

/** A running total that stays absent until something is actually known. */
function add(total: number | undefined, part: number | undefined): number | undefined {
  return part === undefined ? total : (total ?? 0) + part;
}

function finish(draft: Draft, index: number, isOpen: boolean): Turn {
  const runId = runIdOf(draft.user);
  const error = draft.end?.error?.message;
  return {
    index,
    userItemId: draft.user.id,
    ts: draft.user.ts,
    prompt: oneLine(firstLine(draft.user.text), MAX_PROMPT),
    files: draft.files,
    edits: draft.edits,
    commands: draft.commands,
    reads: draft.reads,
    outcome: outcomeOf(draft.end, isOpen, draft.user.replay === true),
    ...(runId === undefined ? {} : { runId }),
    ...(draft.durationMs === undefined ? {} : { durationMs: draft.durationMs }),
    ...(draft.tokens === undefined ? {} : { tokens: draft.tokens }),
    ...(draft.costUsd === undefined ? {} : { costUsd: draft.costUsd }),
    ...(error === undefined ? {} : { error: oneLine(error, 300) }),
  };
}

function outcomeOf(end: RunEndItem | undefined, isOpen: boolean, replayed: boolean): TurnOutcome {
  if (end === undefined) return isOpen && !replayed ? 'running' : 'completed';
  if (end.reason === 'completed') return end.silent ? 'silent' : 'completed';
  return stoppedBy(end.reason);
}

/**
 * Which of the two unhappy endings a provider's reason is.
 *
 * Exhaustive so that a new reason is a compile error here rather than something
 * quietly reading as a failure when the person pressed Esc, or the other way
 * round. A denial that ended the run is the person stopping it, which is why it
 * sits with `interrupted` and not with the walls a run runs into.
 */
function stoppedBy(reason: Exclude<RunEndReason, 'completed'>): 'interrupted' | 'error' {
  switch (reason) {
    case 'interrupted':
    case 'disposed':
    case 'permission_denied':
      return 'interrupted';
    case 'error':
    case 'max_turns':
    case 'budget_exceeded':
      return 'error';
    default: {
      const unhandled: never = reason;
      void unhandled;
      return 'error';
    }
  }
}

/** The first line with something on it. Prompts often open with a blank one. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) return line;
  }
  return '';
}

/** How the registry names a prompt: `${runId}:prompt:${n}`. */
const PROMPT_MARK = ':prompt:';

/**
 * The run a prompt was sent under, when the transcript knows it.
 *
 * No item carries a run id — a transcript records what was said, and the run is
 * a fact about the machinery — so the only trace of one is the identity the
 * registry files a prompt under and the composer claims the moment Enter is
 * pressed (see `promptMessageId` and {@link UserItem.messageId}). Replayed
 * history carries the provider's own uuid there instead, which is not a run id;
 * requiring the ordinal to be digits is what keeps one from being read as one.
 */
function runIdOf(user: UserItem): string | undefined {
  const messageId = user.messageId;
  if (messageId === undefined) return undefined;
  const at = messageId.lastIndexOf(PROMPT_MARK);
  if (at <= 0) return undefined;
  return /^\d+$/.test(messageId.slice(at + PROMPT_MARK.length)) ? messageId.slice(0, at) : undefined;
}

/* -------------------------------------------------------------------------- */
/* The lines                                                                  */
/* -------------------------------------------------------------------------- */

/** One row of the picker: `#3 · 14:02 · Fix the failing test…` and its figures. */
export interface TimelineLine {
  /** The turn's user row, which is what the caller jumps the viewport to. */
  readonly id: string;
  readonly text: string;
  /** Shown dimmed after the text. Empty when nothing is known about the turn. */
  readonly detail: string;
}

/** Spaces between a line and its detail, as the picker draws the pair. */
const GAP = 2;

/** Never clip the prompt below this: four letters of it identify nothing. */
const MIN_PROMPT = 16;

/** What a turn sent without words is called, so the line is not left headless. */
const NO_PROMPT = '(no prompt)';

/**
 * The turns as rows to choose between.
 *
 * `columns` is the width one row has to fit in, after whatever the list draws
 * around it (a selection marker, its own padding). Only the prompt is clipped:
 * the figures are the reason the ledger exists and a clipped `$0.0` is worse
 * than a shorter sentence. Every row is measured against the *widest* detail
 * rather than its own, so the column of prompts ends in one place instead of
 * jittering row by row — the same rule the completions popup follows.
 */
export function timelineLines(turns: readonly Turn[], columns: number): readonly TimelineLine[] {
  const details = turns.map(detailOf);
  const widest = details.reduce((width, detail) => Math.max(width, detail.length), 0);
  const room = columns - widest - GAP;

  return turns.map((turn, index) => {
    const head = `#${String(turn.index)} · ${clock(turn.ts)} · `;
    const prompt = turn.prompt.length === 0 ? NO_PROMPT : turn.prompt;
    return {
      id: turn.userItemId,
      text: head + oneLine(prompt, Math.max(MIN_PROMPT, room - head.length)),
      detail: details[index] ?? '',
    };
  });
}

/**
 * How a turn ends up reading, and what it cost.
 *
 * Absent figures are left out rather than dashed: a turn still running has no
 * duration, and `— · — · —` is three characters of nothing where a word would
 * do. The outcome is the last clause when there is one to make, because it is
 * the one a reader is scanning the column for.
 */
function detailOf(turn: Turn): string {
  const parts: string[] = [];
  if (turn.durationMs !== undefined) parts.push(formatDuration(turn.durationMs));
  if (turn.tokens !== undefined) parts.push(`${formatTokens(turn.tokens)} tok`);
  if (turn.costUsd !== undefined) parts.push(formatUsd(turn.costUsd));
  if (turn.files.length > 0) parts.push(count(turn.files.length, 'file'));
  const mark = MARKS[turn.outcome];
  if (mark !== undefined) parts.push(mark);
  return parts.join(' · ');
}

/**
 * What each outcome says, where it says anything.
 *
 * A turn that simply finished says nothing: a column in which every other row
 * reads "completed" is a column of the word "completed", and the rows worth
 * finding are the four that are not it.
 */
const MARKS: Readonly<Partial<Record<TurnOutcome, string>>> = {
  interrupted: 'interrupted',
  error: 'error',
  running: 'running',
  silent: 'no reply',
};

/**
 * The whole ledger in one line: `7 turns · 9m 12s · 84k tok · $0.31 · 5 files`.
 *
 * For the title above the list, where it answers the question the list is
 * usually opened with — what has this conversation actually cost. Files are
 * deduplicated across turns, so a file edited in three of them is one file.
 */
export function timelineSummary(turns: readonly Turn[]): string {
  if (turns.length === 0) return 'No turns yet';

  const files = new Set<string>();
  let durationMs: number | undefined;
  let tokens: number | undefined;
  let costUsd: number | undefined;
  for (const turn of turns) {
    durationMs = add(durationMs, turn.durationMs);
    tokens = add(tokens, turn.tokens);
    costUsd = add(costUsd, turn.costUsd);
    for (const file of turn.files) files.add(file);
  }

  const parts = [count(turns.length, 'turn')];
  if (durationMs !== undefined) parts.push(formatDuration(durationMs));
  if (tokens !== undefined) parts.push(`${formatTokens(tokens)} tok`);
  if (costUsd !== undefined) parts.push(formatUsd(costUsd));
  if (files.size > 0) parts.push(count(files.size, 'file'));
  return parts.join(' · ');
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * `14:02`, in the reader's own timezone.
 *
 * Hand-assembled from the local parts rather than taken from
 * `toLocaleTimeString`, which is the same choice the export's date line makes:
 * the format is fixed at two columns of digits, so every row is the same width
 * and no locale can decide otherwise. Seconds are dropped — `formatClock` keeps
 * them for a transcript gutter, where two rows can share a minute; a ledger row
 * stands for minutes of work.
 */
function clock(ts: number): string {
  const at = new Date(ts);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
