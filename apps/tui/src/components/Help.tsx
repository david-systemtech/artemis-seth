/**
 * One screen that says what every key does.
 *
 * `/help` printed eleven slash commands into the transcript and said nothing
 * about Ctrl+W, `{`, `a` on a conversation row, or the three ways to get a
 * newline — those were in the prose at the head of the files that implement
 * them, which is to say nowhere a person would look while holding a keyboard.
 * This is the other half: `keymap.ts` holds the map as data and this draws it,
 * whole, over whatever was on screen.
 *
 * It is a reader and nothing else. It changes no setting, runs no command and
 * answers exactly five keys — the four that close it and the ones that scroll —
 * because a help screen that can do something is a help screen someone is
 * afraid to open.
 *
 * ## Two columns, or one
 *
 * Seventy-odd rows do not fit on a terminal of twenty-four lines, so either the
 * map scrolls or it uses the width. Past a hundred columns it does both: the
 * rows run down the left half and continue down the right, newspaper fashion,
 * which halves the scrolling on the wide terminal most people have and costs
 * nothing on the narrow one, where it simply is not done. The rows themselves
 * are identical either way — only the arrangement changes — which is why the
 * width goes into {@link helpLines} rather than into the component's state.
 *
 * `helpLines` is the pure half, and it is exported for two readers. The tests
 * are one. The other is `/help`, which should print these same rows into the
 * transcript rather than growing a second, poorer description of the keyboard:
 * that divergence is the whole problem being fixed here, and the cure is that
 * there is only one function that turns the map into lines.
 *
 * ## Why the descriptions are cut
 *
 * A column forty characters wide cannot hold every sentence, and wrapping a
 * description onto a second line breaks the one thing a keymap has going for
 * it: that the eye can run down the key column. So `helpLines` truncates to fit
 * the column it was asked about, with an ellipsis that says it did. The map's
 * own rule — keep `does` short — is what keeps that from happening often.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { KEYMAP } from '../keymap.js';
import { ACCENT } from '../theme.js';

/** Past this many columns the rows run down two halves instead of one. */
const TWO_COLUMN_MIN = 100;

/** Border and padding, both sides. */
const CHROME = 4;

/** Between the two columns, and between a key and what it does. */
const GAP = 2;

/** The box's own two lines, top and bottom. */
const BORDER_ROWS = 2;

/** The title line and the legend under it, which never scroll. */
const FURNITURE = 2;

/** Narrow enough to be useless, but a column has to have some width. */
const MIN_INNER = 24;
const MIN_DOES = 16;

/** What a binding nobody has wired yet is marked with. */
const SOON = ' (soon)';

const TITLE = 'Keys';
const SUBTITLE = 'everything the terminal answers';

export interface HelpLine {
  /** The presses, joined: `Shift+Enter Ctrl+J`. */
  readonly key: string;
  /** What it does, cut to the column it was asked for. */
  readonly does: string;
  /** The group this row opens, on the first row of each. */
  readonly group?: string;
  /** Decided, not yet wired. */
  readonly planned?: boolean;
}

/** The widest key column there will ever be; the map is a constant. */
const KEY_WIDTH = KEYMAP.reduce(
  (widest, group) => group.keys.reduce((inner, binding) => Math.max(inner, joinKeys(binding.keys).length), widest),
  0,
);

function joinKeys(keys: readonly string[]): string {
  return keys.join(' ');
}

/** How wide one column of rows is at this terminal width. */
function columnWidth(columns: number): number {
  const inner = Math.max(MIN_INNER, columns - CHROME);
  return columns >= TWO_COLUMN_MIN ? Math.max(MIN_INNER, Math.floor((inner - GAP) / 2)) : inner;
}

/** `text`, or as much of it as `room` holds with an ellipsis owning up to it. */
function fit(text: string, room: number): string {
  if (room < 2) return text.slice(0, Math.max(0, room));
  return text.length <= room ? text : `${text.slice(0, room - 1)}…`;
}

/**
 * The whole map as rows, sized for a terminal `columns` wide.
 *
 * One row per binding, in the map's order, the first of each group carrying its
 * title. Pure: the same width gives the same rows, which is what lets `/help`
 * print exactly what the overlay draws.
 */
export function helpLines(columns: number): readonly HelpLine[] {
  const room = Math.max(MIN_DOES, columnWidth(columns) - KEY_WIDTH - GAP);
  const lines: HelpLine[] = [];
  for (const group of KEYMAP) {
    group.keys.forEach((binding, index) => {
      const planned = binding.planned === true;
      lines.push({
        key: joinKeys(binding.keys),
        does: fit(binding.does, planned ? room - SOON.length : room),
        ...(index === 0 ? { group: group.title } : {}),
        ...(planned ? { planned: true } : {}),
      });
    });
  }
  return lines;
}

/**
 * A row as drawn: either a group's heading or a binding. Headings are lines of
 * their own so that scrolling counts what is on screen rather than what is in
 * the data — off by one heading is off by one line.
 */
type Display = { readonly kind: 'heading'; readonly title: string } | { readonly kind: 'binding'; readonly line: HelpLine };

function display(lines: readonly HelpLine[]): readonly Display[] {
  return lines.flatMap((line) => [
    ...(line.group === undefined ? [] : [{ kind: 'heading', title: line.group } as const]),
    { kind: 'binding', line } as const,
  ]);
}

function draw(items: readonly Display[]): readonly React.JSX.Element[] {
  return items.map((item, index) =>
    item.kind === 'heading' ? (
      <Text key={index} bold>
        {item.title}
      </Text>
    ) : (
      <Text key={index} wrap="truncate-end">
        <Text color={ACCENT} dimColor={item.line.planned === true}>
          {item.line.key.padEnd(KEY_WIDTH)}
        </Text>
        {' '.repeat(GAP)}
        <Text dimColor>
          {item.line.does}
          {item.line.planned === true ? SOON : ''}
        </Text>
      </Text>
    ),
  );
}

/**
 * How many of the visible rows go in the first column.
 *
 * Half of them, except when that would leave a group's heading alone at the
 * foot of the left column with every one of its rows in the right — a heading
 * is a promise of what is under it, and there has to be something under it. One
 * row over is enough to fix that, and it is only taken when the right column
 * has the line to spare.
 */
function split(items: readonly Display[], top: number, visible: number, two: boolean, bodyRows: number): number {
  const half = Math.max(1, two ? Math.ceil(visible / 2) : visible);
  if (!two || half <= 1) return half;
  const orphan = items[top + half - 1]?.kind === 'heading';
  return orphan && visible - (half - 1) <= bodyRows ? half - 1 : half;
}

export interface HelpProps {
  readonly columns: number;
  readonly rows: number;
  /** `?`, `Esc`, `q` and `Enter` all mean "I have read it". */
  readonly onClose: () => void;
  readonly isActive?: boolean;
}

export function Help({ columns, rows, onClose, isActive = true }: HelpProps): React.JSX.Element {
  const [wanted, setWanted] = useState(0);

  const two = columns >= TWO_COLUMN_MIN;
  const width = columnWidth(columns);
  const items = display(helpLines(columns));

  const bodyRows = Math.max(1, rows - BORDER_ROWS - FURNITURE);
  const capacity = two ? bodyRows * 2 : bodyRows;
  /*
   * Clamped here rather than kept in step in the handler: the terminal can be
   * resized under a position, and a top past the end is a screen with nothing
   * on it and no key that obviously gets you back.
   */
  const maxTop = Math.max(0, items.length - capacity);
  const top = Math.max(0, Math.min(wanted, maxTop));
  const visible = Math.min(items.length - top, capacity);
  const perColumn = split(items, top, visible, two, bodyRows);
  const left = items.slice(top, top + perColumn);
  const right = two ? items.slice(top + perColumn, top + visible) : [];
  const below = items.length - top - visible;

  /*
   * Moved from whatever the position is now rather than from what was last
   * drawn: a held key arrives as a burst of presses inside one frame, and a
   * step taken from the rendered `top` would spend all of them on one line.
   */
  const step = (by: number): void => {
    setWanted((current) => Math.max(0, Math.min(maxTop, Math.max(0, Math.min(current, maxTop)) + by)));
  };

  useInput(
    (input, key) => {
      if (key.escape || key.return || input === 'q' || input === '?') {
        onClose();
        return;
      }
      if (key.upArrow || input === 'k') {
        step(-1);
        return;
      }
      if (key.downArrow || input === 'j') {
        step(1);
        return;
      }
      if (key.pageUp) {
        step(-capacity);
        return;
      }
      if (key.pageDown) {
        step(capacity);
      }
    },
    { isActive },
  );

  const legend = [
    ...(maxTop > 0 ? ['↑↓ PgUp PgDn scroll'] : []),
    '? Esc q close',
    ...(below > 0 ? [`${String(below)} more below`] : []),
  ].join(' · ');

  return (
    <Box flexDirection="column" width={columns} borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text bold>
        {TITLE}
        <Text dimColor>{`  ${SUBTITLE}`}</Text>
      </Text>
      <Box flexDirection="row">
        <Box flexDirection="column" width={width}>
          {draw(left)}
        </Box>
        {two && (
          <Box flexDirection="column" width={width} marginLeft={GAP}>
            {draw(right)}
          </Box>
        )}
      </Box>
      <Text dimColor>{legend}</Text>
    </Box>
  );
}
