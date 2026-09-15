/**
 * What has been sent and not yet read.
 * ============================================================================
 *
 *     Queued · ↑ takes the newest back
 *     ↳ also check the migration script            next tool break
 *     ↳ and then rerun the e2e suite               next tool break
 *       +1 more
 *
 * The strip exists because `working · 2 queued` on the status line is a number
 * standing in for words. A steer the provider accepted mid-turn is folded in at
 * its next tool break, which can be a minute of tool calls away, and the two
 * things a person wants during that minute are *which* messages are waiting and
 * the chance to take the last one back. A tally answers neither. Nor does the
 * message's own transcript row: it scrolls away with everything else, and a row
 * cannot say whether it has been read — which is the whole question.
 *
 * It is the delegated strip's twin and is built the same way: a pure function
 * turns state into rows and the component only draws them, so the bounding and
 * the truncation are tested rather than eyeballed, and the empty case returns
 * `null` rather than an empty box so a conversation that never steers is laid
 * out exactly as it was before this existed.
 *
 * ## Bounded, and oldest first
 *
 * At most {@link MAX_ROWS} rows and one overflow line, for the same reason
 * `Delegated` is bounded: the strip spends the transcript's own vertical space,
 * and someone who types six follow-ups while the agent works must not lose the
 * screen to the list of them.
 *
 * Oldest first, because that is the order the provider will read them in — the
 * strip answers "what is the agent about to be told", and the answer has an
 * order. So when the queue is deeper than three, the rows are the next three to
 * be read and the overflow counts the rest, which can include the very message
 * `↑` would take back. That trade is deliberate: taking one back puts its words
 * in the composer, where they are readable in full, so nothing is lost by the
 * row not being on screen — whereas re-sorting to show the newest would mean
 * the three most useful rows were the three the agent will get to last.
 *
 * ## The label, and what goes first when the terminal is narrow
 *
 * Each row says when it expects to be read, because the two kinds are not the
 * same promise: `next tool break` is with the provider already and `after this
 * turn` is still with us (see `QueuedDelivery` — nothing emits that one yet).
 * It is dim, and on the right, and it is the first thing surrendered below
 * {@link TERSE_BELOW}: fifteen cells of label on a fifty-column terminal is a
 * third of the row spent on the part the header has already implied, and every
 * one of them is a cell taken off the words the person typed. The same trade
 * `Delegated` makes when it gives up everything but the elapsed time.
 */

import { Box, Text } from 'ink';

import { oneLine } from '@rx-artemis/transcript';

import { ACCENT } from '../theme.js';
import type { QueuedDelivery, QueuedMessage } from '../conversation.js';

/** How many waiting messages the strip draws before it just counts them. */
export const MAX_ROWS = 3;

/**
 * The width below which the rows keep only the text.
 *
 * Narrow enough that the label survives on any terminal wide enough to read a
 * sentence next to it, and no wider: the label is furniture, and the sentence
 * is the reason the strip exists.
 */
export const TERSE_BELOW = 60;

/** Both labels are this wide; the column does not shrink, so it is a constant. */
const LABEL_CHARS = 15;

/** Cells a row spends on something other than the text: `↳ `, the gap, the padding. */
const ROW_FURNITURE = 5;

/** The longest text a row will carry when nobody said how wide the strip is. */
const TEXT_CAP = 120;

/** Below this there is no point truncating further; Ink's `truncate` takes over. */
const MIN_TEXT = 12;

const LABELS: Readonly<Record<QueuedDelivery, string>> = {
  'next-tool-break': 'next tool break',
  'after-turn': 'after this turn',
};

/** One line of the strip, already in words. */
export interface QueuedRow {
  /** The message's own identity, which is also its React key. */
  readonly id: string;
  /** The message, flattened to one line and cut to the width given. */
  readonly text: string;
  /** When it expects to be read. Empty on a narrow terminal. */
  readonly label: string;
}

export interface Queued {
  readonly rows: readonly QueuedRow[];
  /** Waiting messages past {@link MAX_ROWS}, which the overflow line counts. */
  readonly hidden: number;
}

/**
 * The strip's contents, as text.
 *
 * Pure and exported because the whole of the logic is here: a list of messages
 * and a width in, the exact lines out. Taking the width as an argument rather
 * than reading a terminal is what lets the truncation be asserted at all.
 */
export function queuedRows(
  messages: readonly QueuedMessage[],
  /**
   * The width the strip has — the terminal less the rail, not the terminal.
   * Handing it the whole screen is the mistake the status bar's own `columns`
   * exists to prevent.
   */
  columns = Number.POSITIVE_INFINITY,
): Queued {
  const terse = columns < TERSE_BELOW;
  const room = columns - ROW_FURNITURE - (terse ? 0 : LABEL_CHARS);
  const max = Math.max(MIN_TEXT, Math.min(TEXT_CAP, room));
  return {
    rows: messages.slice(0, MAX_ROWS).map((message) => ({
      id: message.id,
      // `oneLine` and not a `slice`: a pasted message arrives with its newlines
      // in it, and a row is one line whatever was typed.
      text: oneLine(message.text, max),
      label: terse ? '' : LABELS[message.delivery],
    })),
    hidden: Math.max(0, messages.length - MAX_ROWS),
  };
}

export interface QueuedStripProps {
  readonly messages: readonly QueuedMessage[];
  /** The width the strip has. See {@link queuedRows}. */
  readonly columns?: number;
}

/** The strip, or nothing at all when nothing is waiting. */
export function QueuedStrip({ messages, columns }: QueuedStripProps): React.JSX.Element | null {
  const { rows, hidden } = queuedRows(messages, columns);
  if (rows.length === 0) return null;

  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1}>
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate">
          Queued · ↑ takes the newest back
        </Text>
      </Box>
      {rows.map((row) => (
        <Box key={row.id} flexDirection="row" justifyContent="space-between" flexShrink={0}>
          <Box flexShrink={1} minWidth={0}>
            <Text wrap="truncate">
              <Text color={ACCENT}>↳ </Text>
              {row.text}
            </Text>
          </Box>
          {row.label.length > 0 && (
            <Box flexShrink={0} marginLeft={1}>
              <Text dimColor>{row.label}</Text>
            </Box>
          )}
        </Box>
      ))}
      {hidden > 0 && (
        <Box flexShrink={0}>
          <Text dimColor>{`  +${String(hidden)} more`}</Text>
        </Box>
      )}
    </Box>
  );
}
