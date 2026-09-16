/**
 * The popup under the composer.
 *
 * A list of rows, one of them highlighted, that the composer draws while it has
 * something to suggest — slash commands today. It owns no keys: `useInput` here
 * would mean two components deciding what ↑ does while both are on screen, and
 * the composer is the one that knows whether the arrow belongs to the text, to
 * the list or to the conversation behind it (see app.tsx's "Who has the keys").
 * So the selection arrives as a prop and every keystroke stays in one handler.
 *
 * `selected` can be null, which is the case that makes this a menu rather than a
 * guess: when nothing was matched with any confidence, no row is highlighted,
 * and the composer's Enter goes back to meaning "send what I typed". A row is
 * marked by the `❯` in the accent and nothing else — no inverse bar, no second
 * colour — because bold is already spoken for: it marks the characters the
 * needle matched, which is the other half of telling someone why a row is here.
 *
 * The rest is the picker's furniture for the same reasons: a window around the
 * selection rather than the whole list, counted above and below, so a provider
 * with fifty skills cannot push the conversation off the screen.
 */

import { Box, Text } from 'ink';

import { ACCENT } from '../theme.js';
import { pickerWindow } from './Picker.js';

/** Rows drawn at once. Fewer than the picker's: this sits under a full screen. */
const DEFAULT_MAX_ROWS = 8;

const DEFAULT_HINT = '↑↓ move · Tab complete · Enter run';

export interface CompletionItem {
  readonly key: string;
  /** The thing that would be typed: `/mode`, `/attach <path>`. */
  readonly label: string;
  /** Shown dimmed in a column after the label. */
  readonly detail?: string;
  /** Offsets in `label` to draw bold — the characters that were matched. */
  readonly indices?: readonly number[];
}

export interface CompletionsProps {
  readonly items: readonly CompletionItem[];
  /** Null when nothing is highlighted, which is what a typo looks like. */
  readonly selected: number | null;
  readonly maxRows?: number;
  readonly hint?: string;
}

export function Completions({
  items,
  selected,
  maxRows = DEFAULT_MAX_ROWS,
  hint,
}: CompletionsProps): React.JSX.Element | null {
  if (items.length === 0) return null;
  /*
   * Wide enough for the longest row on offer, so the details line up: a bridged
   * `/marketplace:command` is far longer than `/help`, and a fixed column put
   * the two halves of those rows flush against each other.
   */
  const widest = items.reduce((width, item) => Math.max(width, item.label.length), 0);
  const { top, size } = pickerWindow(selected ?? 0, items.length, maxRows);
  const hiddenBelow = items.length - top - size;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {top > 0 && <Text dimColor>{`  ↑ ${String(top)} more`}</Text>}
      {items.slice(top, top + size).map((item, offset) => {
        const index = top + offset;
        const isSelected = index === selected;
        return (
          <Text key={item.key} wrap="truncate-end">
            <Text color={isSelected ? ACCENT : undefined} bold={isSelected}>
              {isSelected ? '❯ ' : '  '}
            </Text>
            {runs(item.label, item.indices ?? []).map((run) => (
              <Text key={run.at} bold={run.matched}>
                {run.text}
              </Text>
            ))}
            {item.detail !== undefined && (
              <Text dimColor>
                {' '.repeat(widest - item.label.length + 2)}
                {item.detail}
              </Text>
            )}
          </Text>
        );
      })}
      {hiddenBelow > 0 && <Text dimColor>{`  ↓ ${String(hiddenBelow)} more`}</Text>}
      <Text dimColor>{hint ?? DEFAULT_HINT}</Text>
    </Box>
  );
}

/**
 * The label cut into stretches of matched and unmatched characters, so the
 * matched ones can be drawn bold. Runs rather than one node per character,
 * because each node is an escape sequence in the frame either way and a row is
 * usually two or three of them.
 */
function runs(
  label: string,
  indices: readonly number[],
): readonly { readonly at: number; readonly text: string; readonly matched: boolean }[] {
  const matched = new Set(indices);
  const out: { at: number; text: string; matched: boolean }[] = [];
  for (let at = 0; at < label.length; at += 1) {
    const isMatched = matched.has(at);
    const last = out.at(-1);
    if (last !== undefined && last.matched === isMatched) last.text += label.charAt(at);
    else out.push({ at, text: label.charAt(at), matched: isMatched });
  }
  return out;
}
