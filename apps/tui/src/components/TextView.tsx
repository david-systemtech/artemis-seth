/**
 * A wall of text, in a box, with the keys a pager has.
 *
 * `/diff` has an answer that is neither a list nor a transcript row: a few
 * hundred lines of `git diff`, or the rendered edits of one file. The picker
 * cannot hold it, the transcript should not — a diff written into the
 * conversation is a diff that scrolls away again, and this is the thing
 * someone opened *because* it scrolled away — and the pager is bound to the
 * transcript model. So: this, the smallest possible reader.
 *
 * Deliberately not `Pager`. That one measures every row after every layout
 * because a transcript row can be any height and a search has to find an
 * offset for it. Here a line is a line: the caller has already cut the text to
 * the width, every row is drawn `truncate`, and the position is an index into
 * an array. No refs, no measuring, no frame of lag — and `renderDiff`'s output
 * survives, because ANSI colour through Ink's truncate is left alone where a
 * re-wrap would break it apart.
 *
 * The keys are the ones `less` has and the pager already uses, so there is one
 * set to learn: `↑↓ j k` a line, `PgUp PgDn` a screen, `g G` the ends, `q` or
 * Esc to close. Nothing else is answered, and nothing here decides anything
 * else: what the text *is* belongs to the caller.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { ACCENT } from '../theme.js';

/** The title line, the legend line, and the box's own two borders. */
const CHROME_ROWS = 4;

const LEGEND = '↑↓ j k · PgUp PgDn · g G · q close';

export interface TextViewProps {
  readonly title: string;
  /** Already split, and already cut to the width the caller asked for. */
  readonly lines: readonly string[];
  /** The columns the box may fill, borders included. */
  readonly columns: number;
  /** The rows the box may fill, borders and legend included. */
  readonly rows: number;
  readonly onClose: () => void;
  /** Off while something in front of this owns the keyboard. */
  readonly isActive?: boolean;
}

/**
 * How many lines of text the box has room for.
 *
 * At least one, however small the terminal: a reader with no rows at all is a
 * border round nothing, and a terminal that cannot afford the chrome should
 * still show the first line of the answer.
 */
export function bodyRowsFor(rows: number): number {
  return Math.max(1, Math.floor(rows) - CHROME_ROWS);
}

/**
 * Where the window may start, given what there is and what fits.
 *
 * Clamped rather than remembered, for the reason every scroll position in here
 * is derived: the text can be replaced and the terminal resized under a stored
 * offset, and an offset past the end is a reader looking at blank rows with no
 * key that gets them back.
 */
export function clampTop(top: number, total: number, height: number): number {
  return Math.max(0, Math.min(Math.floor(top), Math.max(0, total - height)));
}

export function TextView({ title, lines, columns, rows, onClose, isActive = true }: TextViewProps): React.JSX.Element {
  const [top, setTop] = useState(0);

  const height = bodyRowsFor(rows);
  const at = clampTop(top, lines.length, height);
  const maxTop = Math.max(0, lines.length - height);

  const move = (delta: number): void => {
    setTop((current) => clampTop(current + delta, lines.length, height));
  };

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') {
        onClose();
        return;
      }
      if (key.upArrow || input === 'k') return move(-1);
      if (key.downArrow || input === 'j') return move(1);
      if (key.pageUp || (key.ctrl && input === 'u')) return move(-height);
      if (key.pageDown || (key.ctrl && input === 'd')) return move(height);
      if (input === 'g' || key.home) return setTop(0);
      if (input === 'G' || key.end) return setTop(maxTop);
    },
    { isActive },
  );

  // The share read, not the share drawn: a reader at the bottom of a text that
  // fits on one screen has seen all of it, and 100% is what says so.
  const percent = maxTop === 0 ? 100 : Math.round((at / maxTop) * 100);
  const shown = lines.slice(at, at + height);

  return (
    <Box flexDirection="column" width={columns} borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Box flexShrink={0}>
        <Text color={ACCENT} bold wrap="truncate">
          {title}
        </Text>
      </Box>

      {/* A fixed height whatever the text does, so the layout below this does
          not jump as the reader scrolls into a shorter tail of the file. */}
      <Box flexDirection="column" flexShrink={0} height={height} overflowY="hidden">
        {lines.length === 0 && <Text dimColor>Nothing to show.</Text>}
        {/* Keyed by line number and not by content: a diff repeats lines
            verbatim, and two identical `+` rows are two rows. */}
        {shown.map((line, index) => (
          <Text key={at + index} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>

      <Box flexDirection="row" flexShrink={0}>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate">
            {LEGEND}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{`  ${String(lines.length)} line${lines.length === 1 ? '' : 's'} · ${String(percent)}%`}</Text>
        </Box>
      </Box>
    </Box>
  );
}
