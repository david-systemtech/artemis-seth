/**
 * One list, one choice.
 *
 * Every switcher in the TUI — account, model, effort, permission mode, and the
 * "are you sure" that guards two of them — is this component with different
 * rows. Up/Down or j/k move, Enter picks, Esc leaves without picking. Rows can
 * be disabled with a reason, and a disabled row is still *shown*: the profile
 * screen's rule that an account you cannot use is greyed with its reason, not
 * hidden, because a row you cannot see cannot tell you what to fix.
 *
 * The initial selection is the caller's to set. For a destructive choice that
 * means the safe row, so that Enter pressed once too often does nothing worse
 * than nothing.
 *
 * A list longer than the window scrolls rather than growing: the folder
 * browser can offer a directory with hundreds of entries, and a list of
 * conversations grows without limit, either of which would otherwise push the
 * top of the picker — its title — off the screen. The selection is kept
 * roughly centred and what is out of sight is counted above and below, so the
 * list never silently ends.
 *
 * A list long enough to scroll is also a list nobody wants to walk. So
 * `filterable` turns every printable key into a query: the conversation
 * switcher's case, where the row you want is three letters of its title away
 * rather than forty presses of Down. Typing claims the letters, which is why
 * `j` and `k` stop being movement there and the arrows become the only way to
 * walk — a picker *without* a filter keeps them, because a list of five
 * permission modes is walked and never typed at. Esc clears a query before it
 * closes the picker: the first press undoes the typing, which is what someone
 * who mistyped means by it, and the second leaves.
 *
 * Matching is a subsequence over the label, its detail and its note, so `bfx`
 * finds `bugfix` and the branch a conversation ran on finds the conversation.
 * An unbroken run of the query ranks above a scattered one — somebody typing
 * `api` means the word before they mean the three letters — and the matched
 * characters are drawn bold, which is the row saying why it is in the list.
 *
 * Space, Ctrl+R and the caller's own keys are what a list can do *to* a row
 * without leaving it: preview, rename, and the rail's archive, delete and pin.
 * None of them are decided here. This reports the row and the key, and the
 * hint line names only what the caller actually passed, so a picker with no
 * preview never advertises one.
 */

import { useMemo, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';

/** Rows on screen at once before the list starts scrolling. */
const DEFAULT_MAX_ROWS = 12;

const DEFAULT_HINT = '↑↓ move · Enter choose · Esc back';

export interface PickerItem<K extends string = string> {
  readonly key: K;
  readonly label: string;
  /** Shown dimmed after the label. */
  readonly detail?: string;
  /** A second, dimmer line under the row. */
  readonly note?: string;
  readonly disabled?: boolean;
  /** Why it is disabled; replaces `detail` when set. */
  readonly reason?: string;
  /** Paint the label in the danger colour. */
  readonly danger?: boolean;
}

/** An extra key the list offers over the highlighted row. */
export interface PickerAction<K extends string = string> {
  /**
   * The chord that runs it: `ctrl+a`, or a bare character for a picker that is
   * not filterable. A bare character is ignored while a filter is on, because
   * there it is a character somebody is typing.
   */
  readonly key: string;
  /** One word for the hint line: `archive`, `delete`, `pin`. */
  readonly label: string;
  readonly run: (item: PickerItem<K>) => void;
}

export interface PickerProps<K extends string = string> {
  readonly title: string;
  readonly items: readonly PickerItem<K>[];
  readonly initialKey?: K;
  readonly onSelect: (item: PickerItem<K>) => void;
  readonly onCancel: () => void;
  /** Shown under the list; defaults to the key legend. */
  readonly hint?: string;
  /** Rows visible at once; the rest scroll. */
  readonly maxRows?: number;
  readonly isActive?: boolean;
  /** Let the list be typed at. See the note above on what that costs. */
  readonly filterable?: boolean;
  /** Space, when there is something to show about a row without opening it. */
  readonly onPreview?: (item: PickerItem<K>) => void;
  /** Ctrl+R. */
  readonly onRename?: (item: PickerItem<K>) => void;
  /** Anything else the caller wants a key for. */
  readonly onSecondary?: readonly PickerAction<K>[];
}

/** An item that survived the filter, and where the query landed in its label. */
export interface PickerMatch<K extends string = string> {
  readonly item: PickerItem<K>;
  /**
   * Offsets into `item.label` to draw bold. Empty when there was no query, and
   * empty when the query matched only the detail or the note — the row is in
   * the list on their account, and marking characters in the label that had
   * nothing to do with it would be a lie about why.
   */
  readonly indices: readonly number[];
}

const NO_INDICES: readonly number[] = [];

/**
 * The slice of a list to draw so that `index` is visible and, where the list
 * is long enough, roughly centred.
 *
 * Derived rather than remembered: a scroll offset held in state can disagree
 * with the selection — after the items change under it, which is exactly what
 * the folder browser does on every step into a directory.
 */
export function pickerWindow(index: number, count: number, maxRows: number): { readonly top: number; readonly size: number } {
  const size = Math.max(1, Math.min(maxRows, count));
  const top = Math.max(0, Math.min(index - Math.floor(size / 2), count - size));
  return { top, size };
}

/*
 * The scorer. Two grades, far enough apart that no amount of tie-breaking
 * inside one can reach the other: an unbroken run of the query beats every
 * scattered match, because the person typing `api` means the word.
 */
const RUN = 1000;
const SCATTER = 100;
/** Landing at the start of the text or just after a space or a separator. */
const BONUS_BOUNDARY = 40;
/** Each pair of matched characters that ended up next to each other. */
const BONUS_ADJACENT = 4;
/** How far into the text a match may be before its lateness stops counting. */
const POSITION_CAP = 60;

const BOUNDARIES: ReadonlySet<string> = new Set([' ', '/', '\\', '-', '_', '.', ':', '·']);

/**
 * `text` folded for comparison, one character per character, so an offset into
 * the result is an offset into the original. A handful of characters lower-case
 * to two (`İ`), which would slide every later index along and mark the wrong
 * characters bold; those are left as they are. Same rule as `fileIndex.ts`.
 */
function fold(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    const folded = character.toLowerCase();
    out += folded.length === character.length ? folded : character;
  }
  return out;
}

/**
 * Where `query` occurs in `text`, and what that occurrence is worth, or `null`
 * if the characters are not there in order.
 *
 * Case-insensitive, and greedy from the left for the scattered case: the first
 * place each character can go. A cleverer walk would find a tighter run
 * somewhere further along, and it is not worth it here — these are titles and
 * branch names, not paths, and the leftmost match is the one a reader's eye
 * finds too.
 */
export function matchQuery(query: string, text: string): { readonly score: number; readonly indices: readonly number[] } | null {
  const needle = fold(query.trim());
  if (needle.length === 0) return { score: 0, indices: NO_INDICES };
  const haystack = fold(text);

  const run = haystack.indexOf(needle);
  if (run >= 0) {
    const indices = Array.from({ length: needle.length }, (_unused, offset) => run + offset);
    return { score: RUN + boundaryBonus(haystack, run) - Math.min(run, POSITION_CAP), indices };
  }

  const indices: number[] = [];
  let at = 0;
  for (let index = 0; index < haystack.length && at < needle.length; index += 1) {
    if (haystack.charAt(index) === needle.charAt(at)) {
      indices.push(index);
      at += 1;
    }
  }
  if (at < needle.length) return null;

  let adjacent = 0;
  for (let i = 1; i < indices.length; i += 1) {
    if ((indices[i] ?? 0) - (indices[i - 1] ?? 0) === 1) adjacent += 1;
  }
  const first = indices[0] ?? 0;
  return {
    score: SCATTER + boundaryBonus(haystack, first) + adjacent * BONUS_ADJACENT - Math.min(first, POSITION_CAP),
    indices,
  };
}

function boundaryBonus(haystack: string, at: number): number {
  if (at === 0) return BONUS_BOUNDARY;
  return BOUNDARIES.has(haystack.charAt(at - 1)) ? BONUS_BOUNDARY : 0;
}

/** A match in the label is worth more than one in the detail, and that than one in the note. */
const FIELD_LABEL = 4000;
const FIELD_DETAIL = 2000;
const FIELD_NOTE = 0;

/**
 * The items `query` selects, best first.
 *
 * An empty query is not a match of nothing — it is the state before typing,
 * and the answer there is the list exactly as it came. Ties keep the caller's
 * order, which is what stops the list reshuffling under a keystroke that did
 * not change the ranking.
 */
export function filterItems<K extends string = string>(
  items: readonly PickerItem<K>[],
  query: string,
): readonly PickerMatch<K>[] {
  if (query.trim().length === 0) return items.map((item) => ({ item, indices: NO_INDICES }));

  const scored: { readonly match: PickerMatch<K>; readonly score: number }[] = [];
  for (const item of items) {
    const label = matchQuery(query, item.label);
    const detail = item.detail === undefined ? null : matchQuery(query, item.detail);
    const note = item.note === undefined ? null : matchQuery(query, item.note);
    const best = Math.max(
      label === null ? -Infinity : label.score + FIELD_LABEL,
      detail === null ? -Infinity : detail.score + FIELD_DETAIL,
      note === null ? -Infinity : note.score + FIELD_NOTE,
    );
    if (best === -Infinity) continue;
    scored.push({ match: { item, indices: label?.indices ?? NO_INDICES }, score: best });
  }
  // Sort is stable, so equal scores come out in the order they went in.
  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.match);
}

/**
 * Whether a keypress is a character somebody typed rather than a key they
 * pressed.
 *
 * Exported because the rail asks the same question of the same keystrokes —
 * see `app.tsx`, which is where the rail's keys are answered — and two
 * readings of "is this typing" would part company on the first control
 * character one of them forgot.
 */
export function isTypable(input: string, key: Key): boolean {
  if (input.length === 0 || key.ctrl || key.meta || key.return || key.tab) return false;
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** Whether this keypress is `chord`. See {@link PickerAction.key}. */
function chordMatches(chord: string, input: string, key: Key, filterable: boolean): boolean {
  const wantsCtrl = chord.toLowerCase().startsWith('ctrl+');
  const base = wantsCtrl ? chord.slice('ctrl+'.length) : chord;
  if (base.length === 0) return false;
  if (wantsCtrl) return key.ctrl && input.toLowerCase() === base.toLowerCase();
  if (key.ctrl || key.meta) return false;
  // A bare key is a shortcut only where characters are not being typed.
  return !filterable && input === base;
}

/** `ctrl+a` as it should be read: `Ctrl+A`. */
function prettyChord(chord: string): string {
  return chord
    .split('+')
    .map((part) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('+');
}

/** The key legend, naming what this picker actually offers and nothing else. */
function keyHint<K extends string>(
  filterable: boolean,
  hasPreview: boolean,
  hasRename: boolean,
  secondary: readonly PickerAction<K>[],
): string {
  if (!filterable && !hasPreview && !hasRename && secondary.length === 0) return DEFAULT_HINT;
  const parts: string[] = [];
  if (filterable) parts.push('type to filter');
  parts.push('↑↓', 'Enter');
  if (hasPreview) parts.push('Space preview');
  if (hasRename) parts.push('Ctrl+R rename');
  for (const action of secondary) parts.push(`${prettyChord(action.key)} ${action.label}`);
  parts.push('Esc');
  return parts.join(' · ');
}

/**
 * The label cut into stretches of matched and unmatched characters, so the
 * matched ones can be drawn bold. Runs rather than one node per character:
 * each node is an escape sequence in the frame either way, and a row is
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

export function Picker<K extends string = string>({
  title,
  items,
  initialKey,
  onSelect,
  onCancel,
  hint,
  maxRows = DEFAULT_MAX_ROWS,
  isActive = true,
  filterable = false,
  onPreview,
  onRename,
  onSecondary,
}: PickerProps<K>): React.JSX.Element {
  const initial = Math.max(
    0,
    items.findIndex((item) => item.key === initialKey),
  );
  const [selected, setSelected] = useState(initial);
  const [query, setQuery] = useState('');
  const secondary = onSecondary ?? [];

  const matches = useMemo(
    () => (filterable ? filterItems(items, query) : items.map((item) => ({ item, indices: NO_INDICES }))),
    [filterable, items, query],
  );
  /*
   * Clamped rather than trusted: a picker refreshed in place can be handed a
   * shorter list than the one its cursor was last on, and a cursor past the
   * end is a selection nobody can see and an Enter that does nothing. A
   * keystroke that narrows the list does the same thing, which is why every
   * change to the query puts the cursor back on the first match.
   */
  const index = Math.max(0, Math.min(selected, matches.length - 1));
  const { top, size } = pickerWindow(index, matches.length, maxRows);
  const visible = matches.slice(top, top + size);

  useInput(
    (input, key) => {
      const current = matches[index]?.item;
      if (key.escape) {
        if (filterable && query.length > 0) {
          setQuery('');
          setSelected(0);
          return;
        }
        onCancel();
        return;
      }
      if (key.upArrow || (!filterable && input === 'k')) {
        setSelected(() => (index - 1 + matches.length) % Math.max(1, matches.length));
        return;
      }
      if (key.downArrow || (!filterable && input === 'j')) {
        setSelected(() => (index + 1) % Math.max(1, matches.length));
        return;
      }
      if (key.return) {
        const item = matches[index]?.item;
        if (item !== undefined && item.disabled !== true) onSelect(item);
        return;
      }
      if (onRename !== undefined && key.ctrl && input.toLowerCase() === 'r') {
        if (current !== undefined) onRename(current);
        return;
      }
      for (const action of secondary) {
        if (chordMatches(action.key, input, key, filterable)) {
          if (current !== undefined) action.run(current);
          return;
        }
      }
      /*
       * Space previews where a preview was offered, and is a character to type
       * where it was not. A filterable picker that also previews therefore has
       * no way to put a space in its query — which is the right trade for the
       * queries it is for, a few letters of one word.
       */
      if (onPreview !== undefined && input === ' ' && !key.ctrl && !key.meta) {
        if (current !== undefined) onPreview(current);
        return;
      }
      if (!filterable) return;
      if (key.backspace || key.delete) {
        setQuery((current) => current.slice(0, -1));
        setSelected(0);
        return;
      }
      if (isTypable(input, key)) {
        setQuery((current) => current + input);
        setSelected(0);
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Text bold>{title}</Text>
      {filterable && query.length > 0 && (
        <Text>
          <Text dimColor>/ </Text>
          <Text>{query}</Text>
        </Text>
      )}
      {items.length === 0 && <Text dimColor>Nothing to choose from.</Text>}
      {items.length > 0 && matches.length === 0 && <Text dimColor>nothing matches</Text>}
      {top > 0 && <Text dimColor>{`  ↑ ${String(top)} more`}</Text>}
      {visible.map((match, offset) => {
        const item = match.item;
        const i = top + offset;
        const selected = i === index;
        const marker = selected ? '❯' : ' ';
        const colour = item.danger === true ? 'red' : selected ? 'cyan' : undefined;
        return (
          <Box key={item.key} flexDirection="column">
            <Text>
              <Text color={selected ? 'cyan' : undefined}>{marker} </Text>
              <Text color={colour} dimColor={item.disabled === true} bold={selected}>
                {match.indices.length === 0
                  ? item.label
                  : runs(item.label, match.indices).map((run) => (
                      <Text key={run.at} bold={run.matched || selected}>
                        {run.text}
                      </Text>
                    ))}
              </Text>
              {item.disabled === true && item.reason !== undefined ? (
                <Text dimColor>{'  '}{item.reason}</Text>
              ) : item.detail !== undefined ? (
                <Text dimColor>{'  '}{item.detail}</Text>
              ) : null}
            </Text>
            {item.note !== undefined && <Text dimColor>{'    '}{item.note}</Text>}
          </Box>
        );
      })}
      {top + size < matches.length && <Text dimColor>{`  ↓ ${String(matches.length - top - size)} more`}</Text>}
      <Text dimColor>{hint ?? keyHint(filterable, onPreview !== undefined, onRename !== undefined, secondary)}</Text>
    </Box>
  );
}
