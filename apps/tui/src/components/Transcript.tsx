/**
 * The conversation, drawn.
 *
 * Every transcript row has one face here — user turns, streamed assistant
 * text rendered from markdown, tool calls with their diffs, permission
 * outcomes, notices, run ends — and the same faces serve three surfaces: the
 * live viewport, a replayed subagent transcript, and a resumed conversation.
 *
 * Live rows subscribe to their own id and are redrawn on the transcript
 * model's flush, so a token touches one row. The viewport bounds how many rows
 * exist at once (see `WINDOW_ROWS`), which is what keeps a long conversation
 * cheap in a layout that is redrawn whole.
 *
 * Pending permission rows draw nothing here; the card that answers them is a
 * separate live component, and drawing the request twice would be worse than
 * either once.
 *
 * ## The fold has an unfold
 *
 * A row is a preview: a tool result is cut to three lines, an edit to twenty,
 * a written file to six, and a run's finished calls collapse into one count.
 * That is right for a stream someone is watching go past and wrong the moment
 * they want the line that was cut — and until now the terminal had no way to
 * ask for it, which is why the thinking row carries a note about a fold with
 * nothing behind it.
 *
 * So every row takes a {@link RowView}. `expanded` is the same rows with
 * nothing held back — every result line, every diff line, each call in a group
 * as its own row under a dim summary, a permission's note in full, and the
 * clock time at the right of what was said — and it is what `Pager.tsx` draws
 * over the whole conversation when Ctrl+O is pressed. `columns` is how wide a
 * row's content is, which only the diff renderer needs: it earns a line-number
 * gutter from {@link NUMBER_COLUMNS} up, and a renderer that is not told the
 * width cannot know whether it has the room.
 *
 * `live` and `planDeltaFor` are the other two, and both are about the surface
 * rather than the fold: whether the conversation is in flight, which is what a
 * cue on a call that has gone quiet has to be true of, and where a finished
 * turn's cost against the plan is looked up. Only the viewport sets either.
 *
 * Collapsed is unchanged but for one thing: a cut result now shows its head
 * *and* its tail. The end of a command's output is where the error is, and
 * three lines from the top of a stack trace is three lines of nothing. How
 * much a preview keeps is in `rowVerbs.ts`, next to the verb that reveals the
 * rest, so that the two cannot come to disagree about whether there is a rest.
 *
 * ## A cursor over the rows
 *
 * The viewport takes a `cursor` — a row id — and the row it names draws a `❯`
 * in a one-column gutter to the left of its marker, with the marker itself in
 * the accent. The column is *reserved on every row* whenever the prop is
 * passed at all, `null` included, so that arriving in the transcript and
 * leaving it again does not shift the whole conversation one column sideways
 * and redraw it.
 *
 * Two things come with it. `onCursorRows` reports the ids currently drawn, in
 * the order they are drawn, because the app is what steps the cursor and only
 * this component knows which rows exist and in what order — and it fires when
 * that list changes rather than on every render, since the list is a new array
 * each time and the app would otherwise be told a hundred times a second that
 * nothing had happened. `expandedRows` unfolds named rows in an otherwise
 * collapsed viewport, which is what `Enter` on the cursor toggles: the whole
 * conversation unfolding because one row was asked about is the pager's job,
 * not this one's.
 *
 * The viewport keeps the cursor row in view by adjusting its own line offset
 * when the row is clipped — see {@link TranscriptViewport}, which also says
 * what happens to a row that is taller than the screen.
 *
 * ## An offer is not a tool card
 *
 * One tool call in the stream is not the agent doing something: it is the agent
 * offering the reader a piece of follow-up work — ADR 0005, and the reason the
 * model keeps such a call out of the activity fold. Drawn as a tool row it read
 * as `mcp__artemisTasks__suggest_task(…)`, a machine name for a question, with
 * the sentence its handler echoes back hanging underneath. So a well-formed
 * offer is drawn instead as a row of chips — `1. Add tests for the parser   2.
 * Update the README` — and the numbers on them are the keys that take one. See
 * {@link SuggestionRow}, `suggestions.ts` for which offers are still answerable,
 * and {@link RowView.suggestionDigits} for why the numbers come and go.
 *
 * A call the agent got *wrong* — no prompt, no title — keeps the ordinary tool
 * row, which is the desktop's rule as well: a chip with no words on it is a
 * control that says nothing and does something, and the mistake is worth
 * seeing.
 *
 * ## Pictures, and the one row that has any
 *
 * Images live on a *user* item and nowhere else. `UserItem.attachments` holds
 * the prompt's attachments whole — the same base64 that was sent to the model,
 * kept for as long as the transcript keeps the turn — so a turn with a
 * screenshot in it draws one {@link ImageRow} per image attachment under its
 * text, and everything about how those bytes reach the terminal is that
 * component's problem and `render/images.ts`'s. What is this file's problem is
 * only that the base64 is decoded once per attachment rather than once per
 * render, and that the protocol arrives as {@link RowView.images} — `'none'` by
 * default, which is a chip, so every surface that has not been told what the
 * terminal speaks reads exactly as it did before.
 *
 * Nothing else in the transcript has a picture to draw, and that is a shape of
 * the model rather than a decision taken here: a `ToolItem` carries `result`,
 * `resultText` and `error` — JSON, text and a message — and has no field for
 * the bytes of an image. So a browser screenshot the agent took arrives as
 * whatever the tool said about it in words. Drawing it would mean a field on
 * the item first, and a mapper filling it; until that exists there is nothing
 * here to render, which is why this file draws images on one row kind only.
 *
 * The rows are drawn in the shape of the provider CLIs' own transcripts — a
 * marker in the gutter, content hanging under it, results on a connector —
 * because that is the shape their users already read fluently. See the note
 * over the rows for the one layout rule that keeps the viewport honest.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, measureElement, type DOMElement } from 'ink';

import type { AgentError, AgentEvent, Attachment, ImageAttachment } from '@rx-artemis/protocol';
import { isImageAttachment } from '@rx-artemis/protocol';
import {
  TranscriptModel,
  classifyTool,
  describeActivity,
  detectFileEdit,
  formatDuration,
  formatTokens,
  formatUsd,
  isGroupId,
  oneLine,
  summarizeToolInput,
  syncScheduler,
  totalInputTokens,
  type ActivityGroup,
  type ToolCategory,
  type TranscriptItem,
} from '@rx-artemis/transcript';

import { ACCENT } from '../theme.js';
import type { PlanDelta } from '../conversation.js';
import { useNow } from '../hooks/useNow.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { renderDiff } from '../render/diff.js';
import type { ImageProtocol } from '../render/images.js';
import { renderMarkdownLines } from '../render/markdown.js';
import { EDIT_LINES, RESULT_HEAD, RESULT_TAIL, WRITE_LINES, resultPreviewLines } from '../rowVerbs.js';
import { SUGGESTION_DIGITS, offerDrawnBy, type Suggestion } from '../suggestions.js';
import { ImageRow } from './ImageRow.js';

/* -------------------------------------------------------------------------- */
/* Settling                                                                   */
/* -------------------------------------------------------------------------- */

function itemSettled(item: TranscriptItem | undefined): boolean {
  if (item === undefined) return true;
  switch (item.kind) {
    case 'user':
      return !item.pending;
    case 'assistant':
    case 'thinking':
      return !item.streaming;
    case 'tool':
      return item.status !== 'running';
    case 'permission':
      return item.state !== 'pending';
    default:
      return true;
  }
}

interface Snapshot {
  readonly key: string;
  readonly item?: TranscriptItem;
  readonly group?: ActivityGroup;
  readonly members?: readonly TranscriptItem[];
  /**
   * The offers this row draws as chips, for the one row kind that is a question
   * rather than a report. Present only on an offer row: `offerDrawnBy` answers
   * an empty list for the second call of a burst, which is a row that draws
   * nothing at all, and `undefined` — the field left off — for every other row
   * in the conversation. See {@link SuggestionRow}.
   */
  readonly chips?: readonly Suggestion[];
}

function snapshotRow(id: string, transcript: TranscriptModel, key: string): Snapshot | null {
  if (isGroupId(id)) {
    const group = transcript.getGroup(id);
    if (group === undefined) return null;
    const members = group.ids.map((memberId) => transcript.getItem(memberId)).filter((m): m is TranscriptItem => m !== undefined);
    return { key, group, members };
  }
  const item = transcript.getItem(id);
  if (item === undefined) return null;
  /*
   * Asked of the offer rows and of nothing else. Working out which chips a row
   * carries means a walk over the model's list, and a conversation has hundreds
   * of rows and at most a handful of offers; the test in front of it is a string
   * comparison on a tool name.
   */
  const chips = item.kind === 'tool' ? offerDrawnBy(transcript, id) : null;
  return chips === null ? { key, item } : { key, item, chips };
}

function rowSettled(id: string, transcript: TranscriptModel): boolean {
  if (isGroupId(id)) {
    const group = transcript.getGroup(id);
    if (group === undefined) return true;
    return group.running === 0 && group.ids.every((memberId) => itemSettled(transcript.getItem(memberId)));
  }
  return itemSettled(transcript.getItem(id));
}


/* -------------------------------------------------------------------------- */
/* How much of a row to draw                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The one thing every row is told about the surface it is being drawn on.
 *
 * Passed down rather than read from a context: there are four levels between
 * the viewport and a diff line, the value is two fields wide, and a prop that
 * appears in every signature is a prop a reader can follow.
 */
export interface RowView {
  /**
   * Nothing is folded. Every line a call returned, every line of a diff, each
   * call in a run as its own row under its summary, a permission's note whole,
   * and `hh:mm` at the right of what was said. The pager's view.
   */
  readonly expanded?: boolean;
  /**
   * Columns a row's *content* has — the pane less the padding and the gutter,
   * see {@link rowContentColumns}. Only the diff renderer uses it, and only to
   * decide whether there is room for line numbers. Undefined means "not
   * measured", which is the old, gutterless rendering.
   */
  readonly columns?: number;
  /**
   * The surface is showing a conversation that is in flight.
   *
   * Only the live viewport sets it, and it gates the cue on a call that has
   * gone quiet (see {@link TOOL_STUCK_MS}). A stored transcript can end with a
   * call still marked running — an interrupted subagent's does — and "no
   * output for 47000m · x stops it" under a replay is wrong twice over:
   * nothing is running, and `x` stops nothing.
   */
  readonly live?: boolean;
  /**
   * What a finished turn took out of the plan, asked for by the run-end row
   * that prints it. `Conversation.planDeltaForRow`, passed down because a row
   * cannot reach the conversation and the transcript model has nowhere to keep
   * the reading. Absent everywhere it is not wired, and the row simply omits
   * the figure.
   */
  readonly planDeltaFor?: (runEnd: { readonly ts: number }) => readonly PlanDelta[] | undefined;
  /**
   * Keep a column to the left of the marker for the cursor.
   *
   * On every row at once or on none of them, and true whenever the viewport
   * has been given a cursor at all — including a cursor of `null`. A gutter
   * that appeared only under the row being pointed at would move that row's
   * text one column right of every other row's, which reads as the row
   * jittering as the cursor passes over it.
   */
  readonly gutter?: boolean;
  /**
   * This row is the one under the cursor: it draws the `❯` in the gutter and
   * its marker in the accent. Set by the viewport on exactly one row.
   */
  readonly cursor?: boolean;
  /**
   * What this terminal can draw a picture with, from `imageProtocol()`.
   *
   * `'none'` — the default, and what every surface that does not set it gets —
   * is a row of chips rather than pictures, which is the right answer for most
   * terminals and for every place a transcript is drawn that is not the live
   * viewport. Nothing but a user row with image attachments reads it.
   */
  readonly images?: ImageProtocol;
  /**
   * The offer on the screen can be taken with a digit, so its chips wear one.
   *
   * A number on a chip is a promise about the keyboard, and the keyboard is the
   * app's: the digits are bound only while the newest answer's offers are the
   * ones on screen, the box is empty and nothing is running — press `2` with a
   * half-typed message in the composer and what should happen is a `2`. So the
   * app sets this exactly when it has the keys free, every other surface leaves
   * it off, and a chip in the pager or in a replayed subagent transcript reads
   * as what it is: an offer that was made, not one that can be taken from here.
   *
   * Off, the chips are the same chips without their numbers — the titles are
   * still the record of what was offered. See `suggestionsOf`, which is where
   * the app gets the offers these numbers are counted over.
   */
  readonly suggestionDigits?: boolean;
}

const COLLAPSED: RowView = {};

/**
 * The columns left for a row's content inside a pane that wide.
 *
 * A row is a two-column marker with content hanging off it, and what a call
 * returned hangs off a three-column connector under that; the viewport pads a
 * column either side. Five columns of furniture plus two of padding is what
 * the content does not have.
 */
export function rowContentColumns(pane: number): number {
  return Math.max(20, pane - 2 - 5);
}

/**
 * What a picture gets when the surface never said how wide a row is.
 *
 * Only a caller that renders a row outside the viewport and the pager leaves
 * {@link RowView.columns} unset, and a picture has to be given *some* box: it
 * is scaled to whatever it is handed rather than drawn at a natural size that
 * no number of pixels here could work out. Narrow on purpose — too small is a
 * picture someone squints at, too wide is one that has overwritten the rest of
 * the conversation.
 */
const UNMEASURED_IMAGE_COLUMNS = 40;

/**
 * The attachment's bytes, decoded once and kept for as long as the turn is.
 *
 * The transcript holds an image as the base64 it was sent as, and a row that
 * called `Buffer.from` on every render would turn a two-megabyte screenshot
 * into a megabyte and a half of garbage per token that arrives in the
 * conversation below it. Keyed on the attachment object, which the model
 * carries through its own updates unchanged, and weak so that the bytes are
 * collected when the turn holding them is.
 */
const decodedBytes = new WeakMap<ImageAttachment, Uint8Array>();

function imageBytes(attachment: ImageAttachment): Uint8Array {
  const known = decodedBytes.get(attachment);
  if (known !== undefined) return known;
  // A `Buffer` is a `Uint8Array`; copying it into a plain one would double the
  // memory for a screenshot to no end.
  const bytes = Buffer.from(attachment.data, 'base64');
  decodedBytes.set(attachment, bytes);
  return bytes;
}

/** The images among a turn's attachments; a PDF or a CSV is not one. */
function imagesAmong(attachments: readonly Attachment[] | undefined): readonly ImageAttachment[] {
  return attachments === undefined ? [] : attachments.filter(isImageAttachment);
}

/** `hh:mm`, local, for the right of a row once the pager has unfolded it. */
function clock(ts: number): string {
  const at = new Date(ts);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

/*
 * The shape every row shares is the provider CLIs' own, because that is the
 * shape people already read: a marker in a two-column gutter and content that
 * wraps under itself, never under the marker. Under a tool call, a `⎿`
 * connector hangs what it returned. A blank line separates blocks, and the
 * colour of a tool's marker is its status: green for a call that returned,
 * red for one that failed, cyan while it runs.
 *
 * Four voices, four faces, because they were reported as looking alike:
 *
 *  - `▌` in the accent, text bold — **what the person said**. It was `>` with
 *    the text *dimmed*, which made someone's own words the faintest thing on
 *    a screen they are scanning to find them. They are the landmarks in a
 *    long transcript and they are now the brightest rows on it.
 *  - `●` — **what the agent said**. The CLIs draw this as `⏺`, which many
 *    terminal fonts render as a wide emoji glyph that swallows the gap before
 *    the text; see `SPEECH_MARKER`.
 *  - `◆` — **a tool the agent reached for**. It shared the agent's mark, so
 *    the agent speaking and the agent running a command were the same row at
 *    a glance. Speech is what someone is reading for, so speech kept the
 *    circle and the machinery took a new one.
 *  - `∴`, dim and italic — **thought**, unchanged; it was already distinct.
 *
 * Text is otherwise left in the terminal's foreground; dim is for what is
 * secondary, never for what is being said.
 *
 * Every row is `flexShrink={0}`, and this is not a nicety. Ink gives a Box
 * `flexShrink: 1` by default, and the viewport below is a column of fixed
 * height: a conversation taller than the screen had every row squeezed to a
 * fraction of its height while its text kept its full size and spilled over
 * the rows beneath — which read as the transcript overwriting itself. Rows
 * keep their size; the viewport clips.
 */

/** What the row under the cursor wears, one column left of its marker. */
const CURSOR_MARKER = '❯';

/** A marker in the gutter and content that wraps under itself. */
function Block({
  marker,
  color,
  dim,
  spaced = true,
  right,
  view = COLLAPSED,
  children,
}: {
  readonly marker: string;
  readonly color?: string;
  readonly dim?: boolean;
  /** A blank line above. Off for a line that belongs to the block before it. */
  readonly spaced?: boolean;
  /**
   * Dim text pushed to the right edge, level with the block's first line —
   * the clock time, and only in the pager. It is a sibling of the content
   * column rather than part of it so that it never joins the wrap.
   */
  readonly right?: string;
  /**
   * The surface, for the two fields a block draws itself from: whether the
   * cursor's column is reserved, and whether this block is the one under it.
   * The rest of the view is the rows' business rather than the frame's.
   */
  readonly view?: RowView;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const under = view.cursor === true;
  return (
    <Box flexDirection="row" marginTop={spaced ? 1 : 0} flexShrink={0}>
      {view.gutter === true && (
        <Box width={1} flexShrink={0}>
          {/* A space, not an empty Text: the column has to be held open on the
              rows the cursor is not on, or they would all shift when it is. */}
          <Text color={ACCENT} bold>
            {under ? CURSOR_MARKER : ' '}
          </Text>
        </Box>
      )}
      <Box width={2} flexShrink={0}>
        {/* Under the cursor the marker takes the accent, whatever it meant
            before. A row's colour is its status and the cursor is somewhere
            else entirely, so one of the two has to give way for the press of
            a key; the status is still on the row, in its words. */}
        <Text color={under ? ACCENT : color} dimColor={under ? false : dim}>
          {marker}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
      {right !== undefined && (
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor>{right}</Text>
        </Box>
      )}
    </Box>
  );
}

/** What a call returned, hung under it on a connector. */
function Returned({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="row" flexShrink={0}>
      <Box width={3} flexShrink={0}>
        <Text dimColor>⎿ </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * The agent's voice. A plain circle, U+25CF, and not the CLIs' `⏺` (U+23FA):
 * that one has an emoji presentation in many terminal fonts — a rounded
 * square with a hollow circle — drawn two cells wide while the layout allots
 * one, so the mark ran straight into the text with no gap. U+25CF is one cell
 * everywhere a terminal runs.
 */
const SPEECH_MARKER = '●';
/** Every tool row and tool group, distinct from the mark the agent speaks with. */
const TOOL_MARKER = '◆';

const TOOL_MARK: Record<string, { color?: string; dim?: boolean }> = {
  running: { color: 'cyan' },
  ok: { color: 'green' },
  error: { color: 'red' },
  denied: { color: 'yellow' },
  cancelled: { dim: true },
};

/** What a call that has gone quiet wears instead. Amber, not red: nothing has failed yet. */
const STUCK_MARK: { color?: string; dim?: boolean } = { color: 'yellow' };

/*
 * How much of a result and how much of a diff a collapsed row shows —
 * `RESULT_HEAD`, `RESULT_TAIL`, `EDIT_LINES`, `WRITE_LINES` — is in
 * `rowVerbs.ts`, imported above. It lives there because `Enter unfold` is
 * offered on exactly the rows these numbers hold something back from.
 *
 * What a call returned is a preview, and a preview is one line per line: a
 * diff row or a result line longer than the screen is cut, not wrapped,
 * because a wrapped line of code reads as two lines of code.
 */

/**
 * How long a running call may say nothing before the row starts to worry.
 *
 * A tool call is the one row that can sit there for minutes looking exactly
 * like a tool call that is working — a `pnpm test` that is running and a
 * `pnpm test` whose process is wedged are the same line — and the terminal's
 * only other clue, the spinner, says "waiting" either way. Three minutes is
 * longer than almost any real call (a full test suite, a big build) and short
 * enough that nobody sits through ten of them wondering.
 *
 * It is a cue, not a verdict: the row goes amber and names the silence, and
 * the person decides. Exported because it is the number the cue is about.
 */
export const TOOL_STUCK_MS = 3 * 60_000;

function ToolRow({
  item,
  view = COLLAPSED,
}: {
  readonly item: Extract<TranscriptItem, { kind: 'tool' }>;
  readonly view?: RowView;
}): React.JSX.Element {
  /*
   * The clock runs only while this call does, and only on a live surface: a
   * settled row wakes nothing up, and a screen of finished calls has no timer
   * on it at all. See `useNow`.
   */
  const running = item.status === 'running';
  const now = useNow(running && view.live === true);
  const silentFor = running && view.live === true ? now - item.ts : 0;
  const stuck = silentFor >= TOOL_STUCK_MS;
  const mark = stuck ? STUCK_MARK : TOOL_MARK[item.status] ?? TOOL_MARK['ok'];
  const summary = summarizeToolInput(item.input);
  const edit = detectFileEdit(item.name, item.input);
  const resultLines = resultPreviewLines(item, edit);
  /*
   * Head, count, tail — or, unfolded, the whole of it and no count.
   *
   * Cut only where cutting pays for itself: two lines, a count and a last line
   * is four rows, so a four-line result folds into exactly as much space as it
   * occupied, with one line replaced by a note about that line. Below the
   * threshold the lines are simply shown.
   */
  const cut = view.expanded !== true && resultLines.length > RESULT_HEAD + RESULT_TAIL + 1;
  const head = cut ? resultLines.slice(0, RESULT_HEAD) : resultLines;
  const tail = cut ? resultLines.slice(-RESULT_TAIL) : [];
  const hidden = cut ? resultLines.length - RESULT_HEAD - RESULT_TAIL : 0;
  return (
    <Block marker={TOOL_MARKER} color={mark?.color} dim={mark?.dim} view={view}>
      <Text color={stuck ? 'yellow' : undefined}>
        {item.title !== undefined ? (
          <Text bold>{oneLine(item.title, 160)}</Text>
        ) : (
          <>
            <Text bold>{item.name}</Text>
            {summary.length > 0 && <Text dimColor>({oneLine(summary, 140)})</Text>}
          </>
        )}
        {item.durationMs !== undefined && item.durationMs >= 1_000 && <Text dimColor>{`  ${formatDuration(item.durationMs)}`}</Text>}
        {/*
         * Whole minutes. `no output for 3m 6s` is a precision the reading has
         * not earned — the point is that it has been quiet for a while, not
         * how long exactly — and a second that moves every tick draws the eye
         * back to a row nothing is happening on.
         */}
        {stuck && <Text>{` · no output for ${String(Math.floor(silentFor / 60_000))}m · x stops it`}</Text>}
      </Text>
      {edit !== null && (
        <Returned>
          {renderDiff(
            edit,
            view.expanded === true ? edit.rows.length : edit.removed === 0 ? WRITE_LINES : EDIT_LINES,
            { columns: view.columns },
          ).map((line, i) => (
            <Text key={i} wrap="truncate">
              {line}
            </Text>
          ))}
        </Returned>
      )}
      {resultLines.length > 0 && (
        <Returned>
          {head.map((line, i) => (
            <Text key={`head-${String(i)}`} dimColor wrap="truncate">
              {oneLine(line, 160)}
            </Text>
          ))}
          {hidden > 0 && <Text dimColor>{`… +${String(hidden)} line${hidden === 1 ? '' : 's'} · Ctrl+O`}</Text>}
          {tail.map((line, i) => (
            <Text key={`tail-${String(i)}`} dimColor wrap="truncate">
              {oneLine(line, 160)}
            </Text>
          ))}
        </Returned>
      )}
      {item.status === 'denied' && (
        <Returned>
          <Text color="yellow">Denied</Text>
        </Returned>
      )}
      {item.status === 'cancelled' && (
        <Returned>
          <Text dimColor>Cancelled</Text>
        </Returned>
      )}
      {item.error !== undefined && (
        <Returned>
          <Text color="red">Error: {oneLine(item.error.message, 300)}</Text>
        </Returned>
      )}
    </Block>
  );
}

/** The mark an offer of work wears. See {@link SuggestionRow}. */
const OFFER_MARKER = '◇';

/** What separates two chips on one line. Wide enough to read as a gap, not a space. */
const CHIP_GAP = '   ';

/** The shortest title worth drawing: fewer columns than this and nobody recognises the offer. */
const MIN_CHIP_COLUMNS = 14;

/**
 * How many columns one chip's title may take when they share a line.
 *
 * The truncate on the row would already stop an overflow; what it would not
 * stop is one long title spending the whole line and leaving `2.` and nothing
 * after it. So the width is shared out, less the gaps and the numbers, and
 * floored at {@link MIN_CHIP_COLUMNS} — below that, cutting further only costs
 * the reader the chance of telling which offer this is.
 */
function chipColumns(columns: number | undefined, count: number): number {
  const room = (columns ?? 80) - (CHIP_GAP.length + 3) * (count - 1) - 3;
  return Math.max(MIN_CHIP_COLUMNS, Math.floor(room / count));
}

/**
 * An offer, as a row of chips.
 *
 * `◇` rather than the tool marker it would otherwise wear: the same shape,
 * because this *is* a tool call, and hollow, because nothing was done. The
 * filled diamonds down a transcript are the work; this one is a question.
 *
 * Numbers, not `①②③④`. The enclosed digits are the prettier answer and they are
 * the same trap `⏺` was — see {@link SPEECH_MARKER}: many terminal fonts give
 * U+2460 an emoji presentation two cells wide while the layout allots one, and
 * the ones that lack the glyph draw a replacement box. `1.` is one cell per
 * character in every font a terminal has ever shipped with, and it has the
 * property the pretty version does not: what is printed is exactly the key to
 * press.
 *
 * One line while the conversation is being followed — the chips side by side,
 * titles cut to a fair share of the width so that a wordy first offer cannot
 * push the second one off the screen — and one chip per line with the sentence
 * behind it once nothing is folded. A row of chips with no chips on it draws
 * nothing: that is the second call of a burst, whose chip the row above is
 * already carrying.
 */
function SuggestionRow({
  chips,
  view = COLLAPSED,
}: {
  readonly chips: readonly Suggestion[];
  readonly view?: RowView;
}): React.JSX.Element | null {
  if (chips.length === 0) return null;
  const numbered = view.suggestionDigits === true;
  /* The digit is a key, so it is drawn in the colour the app's keys are drawn
     in, and only as far as there are keys — a fifth offer is still shown, and
     showing it a `5.` would name a press that does nothing. */
  const digit = (chip: Suggestion): React.JSX.Element | null =>
    numbered && chip.index <= SUGGESTION_DIGITS ? <Text color={ACCENT}>{`${String(chip.index)}. `}</Text> : null;

  if (view.expanded === true) {
    return (
      <Block marker={OFFER_MARKER} view={view}>
        {chips.map((chip) => (
          <Box key={chip.id} flexDirection="column" flexShrink={0}>
            <Text wrap="truncate">
              {digit(chip)}
              <Text bold>{oneLine(chip.title, 160)}</Text>
            </Text>
            {chip.tldr.length > 0 && (
              // Indented under the title rather than level with it: level, a
              // second line of prose reads as a second chip that lost its number.
              <Text dimColor wrap="truncate">{`  ${oneLine(chip.tldr, 300)}`}</Text>
            )}
          </Box>
        ))}
      </Block>
    );
  }
  const room = chipColumns(view.columns, chips.length);
  return (
    <Block marker={OFFER_MARKER} view={view}>
      <Text wrap="truncate">
        {chips.map((chip, index) => (
          <Text key={chip.id}>
            {index === 0 ? '' : CHIP_GAP}
            {digit(chip)}
            <Text bold>{oneLine(chip.title, room)}</Text>
          </Text>
        ))}
      </Text>
    </Block>
  );
}

function ItemRow({ item, view = COLLAPSED }: { readonly item: TranscriptItem; readonly view?: RowView }): React.JSX.Element | null {
  /*
   * The clock, and only on the two rows that are a *turn*. Every item carries
   * a `ts`, so this could go on all of them; what that produces is a column of
   * times down the side of a burst of tool calls, which is noise around the
   * two questions a time answers — when did I ask, when did it answer.
   */
  const stamp = view.expanded === true ? clock(item.ts) : undefined;
  switch (item.kind) {
    case 'user': {
      /*
       * Under the words, because the words are what was asked and the picture
       * is what it was asked about — and because a caption belongs under the
       * thing it captions, which is the shape `ImageRow` draws.
       */
      const images = imagesAmong(item.attachments);
      return (
        <Block marker="▌" color={ACCENT} right={stamp} view={view}>
          <Text bold dimColor={item.pending}>
            {item.text}
          </Text>
          {images.map((image) => (
            <ImageRow
              key={image.id}
              png={imageBytes(image)}
              columns={view.columns ?? UNMEASURED_IMAGE_COLUMNS}
              protocol={view.images ?? 'none'}
              {...(image.name === undefined ? {} : { name: image.name })}
            />
          ))}
        </Block>
      );
    }
    case 'assistant':
      if (item.text.length === 0) return null;
      return (
        <Block marker={SPEECH_MARKER} right={stamp} view={view}>
          {renderMarkdownLines(item.text).map((line, i) =>
            line.hang === 0 ? (
              // An empty Text has no height; a blank line needs one space to be a line.
              <Text key={i} dimColor={item.synthetic === true}>
                {line.body.length === 0 ? ' ' : line.body}
              </Text>
            ) : (
              <Box key={i} flexDirection="row" flexShrink={0}>
                <Box width={line.hang} flexShrink={0}>
                  <Text>{line.prefix}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text dimColor={item.synthetic === true}>{line.body.length === 0 ? ' ' : line.body}</Text>
                </Box>
              </Box>
            ),
          )}
        </Block>
      );
    case 'thinking':
      return (
        <Block marker="∴" dim spaced view={view}>
          {/*
           * Whole, and in the paragraphs it was written in. It used to be
           * `oneLine(text, 200)`, which flattened the reasoning into a single
           * line and then cut its tail off — and unlike the desktop, where a
           * long block folds open on demand, a terminal row offered no way to
           * ask for the rest, so the end of a thought was simply unreadable.
           */}
          {(item.redacted ? ['Thinking (redacted)'] : item.text.split('\n')).map((line, i) => (
            // An empty Text has no height; a blank line needs one space to be a line.
            <Text key={i} dimColor italic>
              {line.length === 0 ? ' ' : line}
            </Text>
          ))}
        </Block>
      );
    case 'tool':
      return <ToolRow item={item} view={view} />;
    case 'permission': {
      if (item.state === 'pending') return null;
      // The note is the reason someone gave for the answer, and a reason cut
      // at 120 columns is half a reason; unfolded it keeps its own lines.
      const note = item.note;
      const wholeNote = view.expanded === true && note !== undefined && note.length > 0;
      return (
        <Block marker="⚿" dim spaced={false} view={view}>
          <Text dimColor>
            {item.request.toolName} — {item.state}
            {note !== undefined && !wholeNote ? `: ${oneLine(note, 120)}` : ''}
          </Text>
          {wholeNote &&
            note.split('\n').map((line, i) => (
              <Text key={i} dimColor>
                {line.length === 0 ? ' ' : line}
              </Text>
            ))}
        </Block>
      );
    }
    case 'notice': {
      const color = item.level === 'error' ? 'red' : item.level === 'warn' ? 'yellow' : undefined;
      return (
        <Block marker={item.level === 'error' ? '✗' : item.level === 'warn' ? '!' : 'ℹ'} color={color} dim={item.level === 'info'} view={view}>
          <Text color={color} dimColor={item.level === 'info'}>
            {item.text}
          </Text>
          {item.detail?.split('\n').map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Block>
      );
    }
    case 'command': {
      /*
       * `!git status` is not a slash command, and drawing it with a slash said
       * it was — a row reading `/ git status` names a command the app does not
       * have. The shell's own prompt character says where it ran, and the
       * colour keeps it from reading as one more dim machinery line.
       */
      const shell = item.source === 'shell';
      return (
        <Block marker={shell ? '$' : '/'} color={shell ? 'cyan' : undefined} dim={!shell} view={view}>
          <Text dimColor>
            {item.name}
            {item.args !== undefined ? ` ${item.args}` : ''}
          </Text>
          {item.output !== undefined && item.output.length > 0 && (
            <Text color={item.failed === true ? 'red' : undefined} dimColor={item.failed !== true}>
              {item.output}
            </Text>
          )}
        </Block>
      );
    }
    case 'run-end': {
      const tokens = totalInputTokens(item.usage?.tokens);
      const parts = [
        item.durationMs !== undefined ? formatDuration(item.durationMs) : undefined,
        tokens !== undefined ? `${formatTokens(tokens)} tok` : undefined,
        item.usage?.costUsd !== undefined ? formatUsd(item.usage.costUsd) : undefined,
      ].filter((part): part is string => part !== undefined);
      /*
       * And what it cost the plan. `$0.04` is the wrong unit for someone on a
       * subscription — they are not billed it, and they cannot spend it — so
       * the same turn is also priced in the thing that does run out: a share
       * of the 5-hour window, a share of the week. Dim on both endings,
       * because it is a footnote to the reading before it rather than part of
       * the verdict, and absent whenever no window moved far enough to name.
       */
      const plan = (view.planDeltaFor?.(item) ?? []).map((window) => `${window.pct.toFixed(1)}% of ${window.label}`);
      if (item.reason === 'completed') {
        /*
         * A turn that produced nothing is named rather than left as a bare
         * duration. `52ms · 0 tok` under a message reads as the agent
         * shrugging; what it usually means is that the provider had nothing
         * to send — a message that was queued rather than answered, say. The
         * two are indistinguishable unless one of them says so.
         */
        return (
          <Block marker="" dim spaced={false} view={view}>
            <Text dimColor>{[...(item.silent ? ['no reply'] : []), ...parts, ...plan].join(' · ')}</Text>
          </Block>
        );
      }
      return (
        <Block marker="✗" color={item.reason === 'error' ? 'red' : 'yellow'} spaced={false} view={view}>
          <Text color={item.reason === 'error' ? 'red' : 'yellow'}>
            {item.reason === 'interrupted' ? 'Interrupted' : item.reason.replace(/_/g, ' ')}
            {parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}
            {plan.length > 0 && <Text dimColor>{` · ${plan.join(' · ')}`}</Text>}
          </Text>
          {item.error !== undefined && <Text color="red">{oneLine(item.error.message, 300)}</Text>}
        </Block>
      );
    }
    default:
      return null;
  }
}

type ToolRowItem = Extract<TranscriptItem, { kind: 'tool' }>;

/**
 * A run's calls, folded as the desktop folds them.
 *
 * What has finished is one line — "Ran 12 commands, read 3 files" — and what
 * is still running is drawn in full beneath it, so the eye has one place to
 * look for what the agent is doing now and one number for how much it has
 * done. A call folds into the count the moment it settles. A call that
 * failed or was refused stays out, in full, with its error: the desktop's
 * rule too, because the one call worth reading in a burst of forty is the
 * one that went wrong.
 *
 * Unfolded, the count is what it has always been — a sentence naming what the
 * run did — but it goes dim and every call it stands for is drawn under it in
 * order. The summary stays because forty rows with no heading is a list
 * nobody can hold in their head.
 */
function GroupRow({
  members,
  view = COLLAPSED,
}: {
  readonly group: ActivityGroup;
  readonly members: readonly TranscriptItem[];
  readonly view?: RowView;
}): React.JSX.Element {
  const calls = members.filter((member): member is ToolRowItem => member.kind === 'tool');
  const expanded = view.expanded === true;
  const folded = calls.filter((call) => call.status === 'ok' || call.status === 'cancelled');
  const shown = expanded ? calls : calls.filter((call) => call.status !== 'ok' && call.status !== 'cancelled');
  const counts: Partial<Record<ToolCategory, number>> = {};
  for (const call of folded) {
    const category = classifyTool(call.name);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  const summary = describeActivity(counts);
  /*
   * A group is several blocks and one row, so the cursor marks its first block
   * and no other — a caret down the side of every call in a run would say the
   * cursor was on all of them. That is the summary when there is one, and the
   * first call still standing when there is not: a run whose every call is
   * running has nothing folded yet and so no count to head it with.
   */
  const heading = summary.length > 0;
  const memberView = view.cursor === true ? { ...view, cursor: false } : view;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {heading && (
        <Block marker={TOOL_MARKER} color={expanded ? undefined : 'green'} dim={expanded} view={view}>
          <Text dimColor={expanded}>{summary}</Text>
        </Block>
      )}
      {shown.map((call, index) => (
        <ToolRow key={call.id} item={call} view={!heading && index === 0 ? view : memberView} />
      ))}
    </Box>
  );
}

function RowContent({ snapshot, view = COLLAPSED }: { readonly snapshot: Snapshot; readonly view?: RowView }): React.JSX.Element | null {
  if (snapshot.group !== undefined) return <GroupRow group={snapshot.group} members={snapshot.members ?? []} view={view} />;
  // Before the item, because an offer *is* an item and the chips are the whole
  // of what it draws; `snapshotRow` has already decided which rows have any.
  if (snapshot.chips !== undefined) return <SuggestionRow chips={snapshot.chips} view={view} />;
  if (snapshot.item !== undefined) return <ItemRow item={snapshot.item} view={view} />;
  return null;
}

/**
 * A row still subject to change: subscribed to its own id, redrawn on flush.
 *
 * Exported for the pager, which draws the same rows with `expanded` set and
 * wants them live for the same reason the viewport does — a conversation can
 * still be streaming while someone is reading back through it.
 */
export function LiveRow({
  id,
  transcript,
  view = COLLAPSED,
}: {
  readonly id: string;
  readonly transcript: TranscriptModel;
  readonly view?: RowView;
}): React.JSX.Element | null {
  const group = isGroupId(id);
  const snapshot = useSyncExternalStore(
    (onChange) => (group ? transcript.subscribeGroup(id, onChange) : transcript.subscribeItem(id, onChange)),
    () => (group ? transcript.getGroup(id) : transcript.getItem(id)),
  );
  if (snapshot === undefined) return null;
  const built = snapshotRow(id, transcript, id);
  return built === null ? null : <RowContent snapshot={built} view={view} />;
}

/* -------------------------------------------------------------------------- */
/* The viewport                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Rows in the order they began.
 *
 * The model files a run's calls under one group and parks that group at the
 * foot of the run — the desktop's marker, which sits below the prose. Read
 * top to bottom in a terminal, that puts "Ran 3 commands" after the answer
 * the commands produced. Every row carries when it started, and ordering on
 * that puts the fold where the first call was made: after the thought that
 * led to it, before the text that came of it — with what is running now
 * directly under the count. A stable sort, so rows that began together keep
 * the model's order.
 *
 * Exported because the pager draws the same rows in the same order, and two
 * orderings of one conversation would be two conversations.
 */
export function inOrderOfStart(ids: readonly string[], transcript: TranscriptModel): readonly string[] {
  const startOf = (id: string): number => (isGroupId(id) ? transcript.getGroup(id)?.ts : transcript.getItem(id)?.ts) ?? 0;
  return ids
    .map((id, index) => ({ id, index, ts: startOf(id) }))
    .sort((a, b) => a.ts - b.ts || a.index - b.index)
    .map((entry) => entry.id);
}

/**
 * How many rows are handed to Ink at once while following the conversation.
 *
 * A screen shows a few dozen lines; a conversation has hundreds of rows. Only
 * the tail is rendered, so a token arriving in a long conversation costs a
 * bounded amount of work rather than a walk over everything that was ever
 * said. Scrolling back extends the window by this much at a time, as far up
 * as the person goes, and following again lets it go.
 */
const WINDOW_ROWS = 40;

export interface TranscriptViewportProps {
  readonly transcript: TranscriptModel;
  /** A run is in flight. */
  readonly live: boolean;
  /** Lines scrolled back from the end. `0` follows the conversation. */
  readonly offset: number;
  /** How far back it is possible to scroll, in lines, as of the last layout. */
  readonly onExtent?: (extent: { readonly maxOffset: number; readonly viewportLines: number }) => void;
  /**
   * The width of the pane this viewport is in, which is the terminal less the
   * sidebar when there is one. Defaults to the terminal width, which is right
   * when the conversation has the screen to itself and generous by the width
   * of the rail when it does not — the cost of being wrong is a diff that
   * earns a line-number gutter slightly before it has the room for it.
   */
  readonly columns?: number;
  /**
   * Draw the rows with nothing folded. The viewport itself has no key for
   * this; the pager sets it. Kept here so that one flag is the difference
   * between the two views rather than two renderers being kept in step.
   */
  readonly expanded?: boolean;
  /**
   * What each finished turn cost the plan, for the run-end rows to print —
   * `Conversation.planDeltaForRow`. See {@link RowView.planDeltaFor}.
   */
  readonly planDeltaFor?: RowView['planDeltaFor'];
  /**
   * The row the cursor is on, by id. `null` for a cursor that exists but is
   * nowhere yet; leave it off entirely and there is no cursor at all.
   *
   * The difference matters to the layout and not only to the drawing: the
   * gutter the caret goes in is reserved as soon as the prop is *present*, so
   * an app that passes `null` while the focus is elsewhere gets a transcript
   * that does not shift sideways when the focus arrives.
   */
  readonly cursor?: string | null;
  /**
   * The ids currently drawn, in the order they appear on screen, reported
   * whenever that list changes.
   *
   * The cursor is the app's state — it is the app that reads the keys — and
   * the app cannot know which rows exist: the model's list is ordered by when
   * a row was *filed* and holds far more than the window draws. So the list
   * comes from here, already ordered and already windowed, and stepping the
   * cursor is an index into it.
   */
  readonly onCursorRows?: (ids: readonly string[]) => void;
  /**
   * Rows to draw unfolded even though the viewport is not.
   *
   * What `Enter` on the cursor toggles. A set rather than one id because a
   * reader unfolding a diff to compare it with the one three rows down should
   * not have the first close behind them.
   */
  readonly expandedRows?: ReadonlySet<string>;
  /**
   * What this terminal can draw a picture with — `imageProtocol()` from
   * `render/images.ts`, which reads the environment and never asks the
   * terminal anything.
   *
   * Left off, a turn's images are chips, which is what they have always been
   * and what most terminals will go on getting. The app passes it because the
   * app is what knows which terminal it was started in; the viewport only
   * hands it down. See {@link RowView.images}.
   */
  readonly imageProtocol?: ImageProtocol;
  /**
   * The digits are bound to the newest answer's offers, so its chips wear them.
   *
   * The app's to decide and nobody else's, because the app owns the keyboard —
   * and a boolean rather than the list of offers, because a row works out its
   * own numbers from the model it is already drawing and two numberings of one
   * offer is the one bug this feature can have. See
   * {@link RowView.suggestionDigits}, and `suggestionsOf` for the list the app
   * binds the keys to.
   */
  readonly suggestionDigits?: boolean;
}

/** Where the cursor row sits in the content column, in lines from its top. */
export interface CursorBox {
  readonly id: string;
  readonly top: number;
  readonly height: number;
}

function sameBox(a: CursorBox | null, b: CursorBox | null): boolean {
  if (a === null || b === null) return a === b;
  return a.id === b.id && a.top === b.top && a.height === b.height;
}

/**
 * Where the cursor row is, asked of the layout Ink has just done.
 *
 * `measureElement` gives a height and no position, so the top comes from the
 * node's own layout, which is relative to the parent — and the parent is the
 * content column, which is the coordinate system the offset is in. Null
 * whenever there is no cursor or the row it names is not on the screen: both
 * are ordinary, and both mean there is nothing to scroll to.
 */
function measureCursorRow(node: DOMElement | null, id: string | null): CursorBox | null {
  if (node === null || id === null) return null;
  const layout = node.yogaNode;
  if (layout === undefined) return null;
  return { id, top: layout.getComputedTop(), height: measureElement(node).height };
}

/**
 * The offset that would show this row, or null if it is already shown.
 *
 * The visible band is the last `viewport` lines of the content once the offset
 * has pushed `offset` lines of it below the clip. A row below that band is
 * brought up by its foot, a row above it by its head — and a row too tall to
 * fit is shown by its head as well, which is also what stops the two
 * corrections from taking turns to undo one another for ever.
 */
export function offsetShowing(
  box: CursorBox,
  measured: { readonly content: number; readonly viewport: number },
  offset: number,
): number | null {
  const bottom = measured.content - offset;
  const top = bottom - measured.viewport;
  const below = box.top + box.height > bottom;
  const above = box.top < top;
  if (!below && !above) return null;
  if (above || box.height >= measured.viewport) return measured.content - measured.viewport - box.top;
  return measured.content - box.top - box.height;
}

/**
 * The conversation in a fixed-height box, anchored to the bottom.
 *
 * Bottom-anchored by layout — `justifyContent: flex-end` inside an
 * `overflow: hidden` box — so the newest content is always visible and older
 * content is clipped off the top, which is what a chat pane does. The box
 * takes whatever height the column has left after the composer, the status
 * line and any open card: it grows to fill and shrinks to nothing, never the
 * other way round, so a tall permission card pushes the conversation up
 * rather than the composer off the screen.
 *
 * Scrolling is by *line*, not by row. A row can be a whole run's worth of
 * tool calls — taller than the screen — and scrolling by rows meant the top
 * of such a row could never be looked at: the pane always showed its foot.
 * So the content column is pushed down by the offset with a negative bottom
 * margin, the clip does the rest, and the column's measured height says how
 * far up there is to go. Rows beyond the rendered window are brought in as
 * the offset approaches the top of what is drawn.
 *
 * ## Keeping the cursor in view
 *
 * The app owns the cursor but not the layout, so the scrolling that follows it
 * happens here: when the cursor lands on a row the clip has cut off, the
 * viewport takes the offset over from the app and holds it until the app
 * scrolls of its own accord or the cursor is put away. Only on a *move*, never
 * continuously, or PgUp with a cursor set would snap straight back to the row
 * it was on and scrolling would be impossible.
 *
 * A row taller than the screen cannot be shown whole, and the choice is its
 * head: the head carries the marker, the caret and the line naming what the
 * row is, and a person who cannot see which row the cursor is on cannot use
 * the keys that act on it. The foot of such a row is reached with the ordinary
 * scroll keys, or with Ctrl+O, which is the view that exists for exactly this.
 */
export function TranscriptViewport({
  transcript,
  live,
  offset,
  onExtent,
  columns,
  expanded,
  planDeltaFor,
  cursor,
  onCursorRows,
  expandedRows,
  imageProtocol,
  suggestionDigits,
}: TranscriptViewportProps): React.JSX.Element {
  const rows = useSyncExternalStore(transcript.subscribeList, transcript.getRowsSnapshot);
  const terminal = useTerminalSize();
  // The caret's column comes out of the content's, not out of the padding: a
  // row that measured itself a column wider than it is drawn would decide it
  // has room for a diff gutter that then overflows.
  const gutter = cursor !== undefined;
  const view = useMemo<RowView>(
    () => ({
      expanded: expanded === true,
      live,
      columns: rowContentColumns((columns ?? terminal.columns) - (gutter ? 1 : 0)),
      planDeltaFor,
      gutter,
      images: imageProtocol ?? 'none',
      suggestionDigits: suggestionDigits === true,
    }),
    [expanded, live, columns, terminal.columns, planDeltaFor, gutter, imageProtocol, suggestionDigits],
  );
  /*
   * Four views for a viewport, not one per row: a row is either under the
   * cursor or not and either unfolded or not, so there are four objects to
   * hand out however many rows are on the screen. Rebuilding them per row
   * would hand every row a new object on every token that arrives.
   */
  const viewFor = useMemo(() => {
    const unfolded: RowView = view.expanded === true ? view : { ...view, expanded: true };
    const marked: RowView = { ...view, cursor: true };
    const markedUnfolded: RowView = { ...unfolded, cursor: true };
    return (id: string): RowView => {
      const open = expandedRows?.has(id) === true;
      if (id === cursor) return open ? markedUnfolded : marked;
      return open ? unfolded : view;
    };
  }, [view, cursor, expandedRows]);

  const [windowRows, setWindowRows] = useState(WINDOW_ROWS);
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const cursorRef = useRef<DOMElement>(null);
  const [measured, setMeasured] = useState({ content: 0, viewport: 0 });
  const [cursorBox, setCursorBox] = useState<CursorBox | null>(null);
  const [revealOffset, setRevealOffset] = useState<number | null>(null);

  // The offset actually in force. The app's, until the cursor moves onto a row
  // that is not on the screen; then this component's, until the app scrolls.
  const effective = revealOffset ?? offset;
  const following = effective === 0;
  const start = Math.max(0, rows.length - (following ? WINDOW_ROWS : windowRows));
  const shown = inOrderOfStart(rows.slice(start), transcript);

  // Measured after every render: Ink lays out on commit, so the numbers are
  // one frame behind at worst. Only a change is stored, or this would loop.
  useEffect(() => {
    const content = contentRef.current === null ? 0 : measureElement(contentRef.current).height;
    const viewport = viewportRef.current === null ? 0 : measureElement(viewportRef.current).height;
    setMeasured((current) => (current.content === content && current.viewport === viewport ? current : { content, viewport }));
    setCursorBox((current) => {
      const next = measureCursorRow(cursorRef.current, cursor ?? null);
      return sameBox(current, next) ? current : next;
    });
  });

  /*
   * The ids on the screen, reported once per change of the list rather than
   * once per render. `shown` is a fresh array every time — it is a map over a
   * slice — so an effect keyed on it would fire on every token that arrives,
   * and the app would re-run whatever it does with a list it has already seen.
   */
  const reported = useRef<string | null>(null);
  useEffect(() => {
    const key = shown.join('\0');
    if (reported.current === key) return;
    reported.current = key;
    onCursorRows?.(shown);
  });

  const maxOffset = Math.max(0, measured.content - measured.viewport);
  const clamped = Math.min(effective, maxOffset);
  const nearTop = measured.content - measured.viewport - clamped < measured.viewport;

  /*
   * A cursor that has just moved is brought into view; one that has not is
   * left where it is, however the conversation grows around it. `owed` is the
   * row still waiting for that, and it is cleared whether or not the row
   * turned out to need scrolling to — the question is asked once per move.
   */
  const owed = useRef<string | null>(null);
  useEffect(() => {
    owed.current = cursor ?? null;
  }, [cursor]);

  // The app scrolling is the app taking the offset back, and a cursor put away
  // takes the conversation back to wherever the app had it.
  useEffect(() => {
    setRevealOffset(null);
  }, [offset]);
  useEffect(() => {
    if (cursor === undefined || cursor === null) setRevealOffset(null);
  }, [cursor]);

  useEffect(() => {
    if (cursorBox === null || cursorBox.id !== cursor || owed.current !== cursor) return;
    if (measured.viewport === 0) return;
    owed.current = null;
    const wanted = offsetShowing(cursorBox, measured, clamped);
    if (wanted === null) return;
    setRevealOffset(Math.max(0, Math.min(wanted, maxOffset)));
  }, [cursorBox, cursor, measured, clamped, maxOffset]);

  useEffect(() => {
    onExtent?.({ maxOffset, viewportLines: measured.viewport });
  }, [maxOffset, measured.viewport, onExtent]);

  // More rows when the person is about to run out of what is drawn; fewer
  // again once they are back at the end.
  useEffect(() => {
    if (following) {
      if (windowRows !== WINDOW_ROWS) setWindowRows(WINDOW_ROWS);
      return;
    }
    if (nearTop && start > 0) setWindowRows((current) => current + WINDOW_ROWS);
  }, [following, nearTop, start, windowRows]);

  const above = start > 0 || clamped < maxOffset;

  // The clip and the "more below" line are siblings: a line drawn inside the
  // clip would sit on top of a content line and let its tail show through.
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} paddingX={1}>
      <Box
        ref={viewportRef}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        overflowY="hidden"
        justifyContent="flex-end"
      >
        {/*
          * What this session is stands under the composer already — the
          * account, the model, the mode, the folder in the header — so the
          * empty conversation says what to try rather than who Artemis is:
          * the four things a first message most often needs, and the key
          * that lists the rest.
          */}
        {rows.length === 0 && (
          <Box flexDirection="column" justifyContent="center" flexGrow={1} paddingLeft={1}>
            <Text dimColor>Type a message to begin, or try:</Text>
            <Text dimColor>{'  '}<Text>@</Text> names a file · <Text>/model</Text> picks the model · <Text>Shift+Tab</Text> steps the permission mode · <Text>!</Text> runs a shell line</Text>
            <Text dimColor>{'  '}<Text>?</Text> lists every key · Tab moves to the conversations · Esc interrupts a turn · Ctrl+C twice quits</Text>
          </Box>
        )}
        <Box ref={contentRef} flexDirection="column" flexShrink={0} marginBottom={-clamped}>
          {above && clamped > 0 && (
            <Box flexShrink={0}>
              <Text dimColor>{start > 0 ? '↑ earlier · keep scrolling' : '↑ earlier'}</Text>
            </Box>
          )}
          {shown.map((id) => (
            <Box
              key={id}
              ref={id === cursor ? cursorRef : undefined}
              flexDirection="column"
              flexShrink={0}
            >
              <LiveRow id={id} transcript={transcript} view={viewFor(id)} />
            </Box>
          ))}
        </Box>
      </Box>
      {clamped > 0 && (
        <Box flexShrink={0}>
          <Text color="yellow">{`↓ ${String(clamped)} more line${clamped === 1 ? '' : 's'}${live ? ' · streaming' : ''} · Esc to follow`}</Text>
        </Box>
      )}
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/* A finished transcript, drawn once                                          */
/* -------------------------------------------------------------------------- */

export interface ReplayRowsProps {
  /** Events from a store, in order. Nothing here is live. */
  readonly events: readonly AgentEvent[];
  /** Rows to show from the end; the rest is summarised in one line. */
  readonly maxRows?: number;
  /** The pane's width; see {@link TranscriptViewportProps.columns}. */
  readonly columns?: number;
  /** Nothing folded; see {@link RowView}. */
  readonly expanded?: boolean;
}

/**
 * What a delegated agent did, or any other stored stretch of events, run
 * through the same reducer as the live transcript and drawn from the tail.
 * Synchronous scheduler, so the rows exist by the time this returns.
 */
export function ReplayRows({ events, maxRows = 60, columns, expanded }: ReplayRowsProps): React.JSX.Element {
  const terminal = useTerminalSize();
  const view = useMemo<RowView>(
    () => ({ expanded: expanded === true, columns: rowContentColumns(columns ?? terminal.columns) }),
    [expanded, columns, terminal.columns],
  );
  const snapshots = useMemo(() => {
    const model = new TranscriptModel(syncScheduler);
    for (const event of events) model.apply(event);
    model.flush();
    return inOrderOfStart(model.getRowsSnapshot(), model)
      .map((id) => snapshotRow(id, model, id))
      .filter((snapshot): snapshot is Snapshot => snapshot !== null);
  }, [events]);
  const shown = snapshots.slice(-maxRows);
  return (
    <Box flexDirection="column">
      {snapshots.length === 0 && <Text dimColor>Nothing recorded.</Text>}
      {snapshots.length > shown.length && (
        <Text dimColor>⋯ {String(snapshots.length - shown.length)} earlier rows not shown</Text>
      )}
      {shown.map((snapshot) => (
        <RowContent key={snapshot.key} snapshot={snapshot} view={view} />
      ))}
    </Box>
  );
}
