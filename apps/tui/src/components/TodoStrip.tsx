/**
 * The agent's checklist, on screen.
 * ============================================================================
 *
 *     Todo  2/5 · » run the migration                              Ctrl+T
 *     ✓ read the schema
 *     ✓ write the migration
 *     » run the migration
 *     ☐ rerun the e2e suite
 *     ☐ open the pull request
 *
 * Every provider writes a to-do list mid-turn and Artemis has never drawn one.
 * The calls went into the fold as "updated the plan 3 times" — a count of the
 * agent announcing its intentions, with the intentions removed. That is the
 * one thing on the screen that answers "does it understand the job", and
 * answering it early is what lets someone stop a turn that is about to spend
 * ten minutes on the wrong thing.
 *
 * `parseTodos` in `@rx-artemis/transcript` does the reading; this draws it, in
 * the shape Gemini's CLI settled on: one line above the composer, expandable
 * to the list. That shape is right because the collapsed state is the honest
 * cost of the feature — a checklist is context, not the conversation, and
 * context that helps itself to five rows of a thirty-row terminal has stopped
 * helping. The count and the current item are what a glance is for; the list
 * is what the key is for.
 *
 * ## When it is not there at all
 *
 * Nothing pending, collapsed: hidden. A finished checklist is a record of a
 * finished turn, and the transcript is where records go — leaving `5/5` parked
 * above the composer for the rest of the session would make the strip a place
 * where nothing means anything in particular, which is the same argument
 * `Delegated` makes for dropping settled tasks. Expanded, it stays: someone who
 * pressed the key asked to see the list, and answering with an empty screen is
 * not an answer. This is Gemini's rule and it is the right one.
 *
 * ## Bounded, like its siblings
 *
 * At most {@link MAX_ROWS} items and one overflow line. A twenty-step plan is a
 * real thing an agent writes, and the strip spends the conversation's own
 * vertical space. The window is the head of the list rather than anything
 * cleverer because the header already carries the item being worked on — so
 * the one row that must be visible is visible whatever the window does.
 *
 * Like `Delegated` and `QueuedStrip`: a pure function turns the items into
 * exact lines, the component only draws them, and `null` comes back when there
 * is nothing to say so a conversation without a checklist is laid out exactly
 * as it was before this existed.
 */

import { useMemo, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';

import { latestTodos, oneLine, type TodoItem, type TodoStatus, type TranscriptModel } from '@rx-artemis/transcript';

import { ACCENT } from '../theme.js';

/** How many items the expanded strip draws before it just counts them. */
export const MAX_ROWS = 8;

/** The key that opens and closes it, as the hint spells it. */
export const HINT = 'Ctrl+T';

/**
 * The width below which the hint is dropped.
 *
 * Six cells of furniture on a forty-column terminal is six cells taken off the
 * item the header exists to show, and someone on a terminal that narrow has
 * met the strip before. The same trade `QueuedStrip` makes with its labels.
 */
export const HINT_BELOW = 48;

/** Is there room for the hint? Shared, so the header's arithmetic cannot disagree with the draw. */
export function showsHint(columns: number): boolean {
  return columns >= HINT_BELOW;
}

/**
 * One glyph per state.
 *
 * `»` for the live item rather than a spinner: this strip redraws when the
 * *plan* changes, and an animated mark on a line that is otherwise static
 * would promise a liveness it does not have. `☐` and `✓` are the two everyone
 * already reads as a checkbox, and `✗` says dropped rather than failed.
 */
const GLYPHS: Readonly<Record<TodoStatus, string>> = {
  completed: '✓',
  in_progress: '»',
  pending: '☐',
  cancelled: '✗',
};

/** How a row is drawn, keyed by the glyph that opens it — the glyph *is* the state. */
interface RowStyle {
  readonly color?: string;
  readonly dimColor?: boolean;
  readonly strikethrough?: boolean;
}

const ROW_STYLES: Readonly<Record<string, RowStyle>> = {
  // Done is dim: still there to be counted, no longer there to be read.
  '✓': { dimColor: true },
  '»': { color: ACCENT },
  '☐': {},
  // Struck through as well as dim, because "cancelled" and "done" are opposite
  // facts and dimness alone would say the same thing about both.
  '✗': { dimColor: true, strikethrough: true },
};

/** Anything without a glyph — the overflow line — is furniture. */
const FURNITURE: RowStyle = { dimColor: true };

/** Cells a row spends on something other than the words: the padding, the glyph, its gap. */
const ROW_FURNITURE = 4;

/** Cells the header spends before the item: the padding, and the hint's column. */
const HEADER_FURNITURE = 2;

/** The longest text a line will carry when nobody said how wide the strip is. */
const TEXT_CAP = 120;

/** Below this there is no point truncating further; Ink's `truncate` takes over. */
const MIN_TEXT = 12;

const NO_ROWS: readonly string[] = [];
const NO_ITEMS: readonly TodoItem[] = [];

/** The strip's contents, as text. */
export interface TodoLines {
  /** `Todo  2/5 · » run the migration`, cut to the width. Always present. */
  readonly header: string;
  /** One line per item, then `+n more`. Empty when collapsed. */
  readonly rows: readonly string[];
}

/**
 * The strip's contents, as text.
 *
 * Pure and exported because every decision the strip makes is here: which item
 * is "current", what the count counts, what survives a narrow terminal. Taking
 * the width as an argument rather than reading a terminal is what lets the
 * truncation be asserted at all.
 *
 * The header is one string rather than pieces the component styles because the
 * point of the seam is that the pure function owns every printed cell — a test
 * asserting the exact line is worth more than a coloured `»`.
 */
export function todoRows(
  items: readonly TodoItem[],
  expanded: boolean,
  /**
   * The width the strip has — the terminal less the rail, not the terminal.
   * Handing it the whole screen is the mistake the status bar's own `columns`
   * exists to prevent.
   */
  columns = Number.POSITIVE_INFINITY,
): TodoLines {
  const hintCells = showsHint(columns) ? HINT.length + 1 : 0;
  const header = headerLine(items, columns - HEADER_FURNITURE - hintCells);
  if (!expanded) return { header, rows: NO_ROWS };

  const room = fit(columns - ROW_FURNITURE);
  const rows = items
    .slice(0, MAX_ROWS)
    .map((item) => `${GLYPHS[item.status]} ${oneLine(item.text, room)}`);
  const hidden = Math.max(0, items.length - MAX_ROWS);
  return { header, rows: hidden > 0 ? [...rows, `  +${String(hidden)} more`] : rows };
}

/**
 * `Todo  2/5 · » run the migration`.
 *
 * The count is of finished work against all of it — the question a glance
 * asks is "how far along", and `2/5` answers it in four cells. What follows is
 * the item being worked on, or the next one waiting when the agent has not said
 * which, because a plan with nothing in progress still has a next thing. Only
 * that part is cut: the count is the cheapest useful thing on the line and must
 * not be the first casualty of a narrow terminal.
 */
function headerLine(items: readonly TodoItem[], room: number): string {
  const done = items.filter((item) => item.status === 'completed').length;
  const prefix = `Todo  ${String(done)}/${String(items.length)} · `;
  const current = currentOf(items);
  // Only ever seen expanded: collapsed, a checklist with nothing left is not
  // drawn at all. See the component.
  if (current === null) return `${prefix}all done`;
  return `${prefix}» ${oneLine(current.text, fit(room - prefix.length - 2))}`;
}

/** What the agent is on: what it said it was on, else what is next. */
function currentOf(items: readonly TodoItem[]): TodoItem | null {
  return (
    items.find((item) => item.status === 'in_progress') ??
    items.find((item) => item.status === 'pending') ??
    null
  );
}

/** Still to do — the test for whether the strip has anything live to say. */
function isOpen(item: TodoItem): boolean {
  return item.status === 'pending' || item.status === 'in_progress';
}

/** A width clamped to something worth printing. */
function fit(room: number): number {
  return Math.max(MIN_TEXT, Math.min(TEXT_CAP, room));
}

export interface TodoStripProps {
  /** The conversation's transcript. The checklist is read back out of it. */
  readonly transcript: TranscriptModel;
  /** Whether the list is open. Owned by the app, which holds the key. */
  readonly expanded?: boolean;
  /** The width the strip has. See {@link todoRows}. */
  readonly columns?: number;
}

/**
 * The strip, or nothing at all.
 *
 * Subscribed to the transcript's list rather than handed a plan as a prop,
 * because a todo call is an ordinary tool call in the same stream as every
 * other one — there is no plan in app state to pass, and inventing one would
 * mean a second copy of a thing the transcript already holds. The subscription
 * is to the *list* and not to an item: the checklist moves when a new call
 * lands, which is exactly when the list changes identity, and never on a token.
 */
export function TodoStrip({ transcript, expanded = false, columns }: TodoStripProps): React.JSX.Element | null {
  const ids = useSyncExternalStore(transcript.subscribeList, transcript.getListSnapshot);
  // Keyed on the list's identity, which the model only changes when an item is
  // added or removed. `latestTodos` builds a fresh object every call, so it
  // cannot be the snapshot `useSyncExternalStore` compares — it has to be
  // memoised on this side of the subscription.
  const latest = useMemo(() => latestTodos(transcript), [transcript, ids]);
  const items = latest?.items ?? NO_ITEMS;

  const width = columns ?? Number.POSITIVE_INFINITY;
  const { header, rows } = todoRows(items, expanded, width);
  if (items.length === 0) return null;
  // Nothing left to do: a record, and records live in the transcript — unless
  // someone has asked for the list, in which case they get it.
  if (!expanded && !items.some(isOpen)) return null;

  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <Box flexShrink={1} minWidth={0}>
          <Text wrap="truncate">{header}</Text>
        </Box>
        {showsHint(width) && (
          <Box flexShrink={0} marginLeft={1}>
            <Text dimColor>{HINT}</Text>
          </Box>
        )}
      </Box>
      {rows.map((row, index) => (
        <Box key={`${String(index)}:${row}`} flexShrink={0}>
          <Text wrap="truncate" {...(ROW_STYLES[row.slice(0, 1)] ?? FURNITURE)}>
            {row}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
