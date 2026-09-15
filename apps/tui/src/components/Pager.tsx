/**
 * The whole conversation, unfolded, with a way to look for a word in it.
 *
 * Every terminal agent has this key and Artemis did not: Ctrl+O in Claude
 * Code, Gemini and Copilot, Ctrl+T in Codex. The reason they all grew one is
 * that a live transcript has to cut things — a tool result at three lines, an
 * edit at twenty, a run's calls into a count — and the moment someone wants
 * the line that was cut, a scrollback that only ever held the preview cannot
 * give it to them. This is that view: the same rows drawn by the same
 * components with {@link RowView.expanded} set, in a box the size of the
 * terminal, driven by the keys a pager has had since `less`.
 *
 * ## Position is a line, not a row
 *
 * The transcript viewport scrolls by line for a reason spelled out over it —
 * a single row can be taller than the screen — and this inherits the
 * mechanism: the content column is pushed up by a negative top margin inside a
 * clipped box of fixed height. What a pager needs on top of that is the
 * opposite direction: given a row, which line does it start on? So each row is
 * wrapped in a box with a ref, and after every layout their heights are
 * measured and accumulated into {@link Measured.tops}. A jump — a search hit,
 * a user turn, the end — is a lookup in that array.
 *
 * Three limits come with it, and they are the honest cost of exact offsets:
 *
 *  - **Every row is rendered.** There is no window as in the viewport, because
 *    a row that is not laid out has no height and so no offset, and a search
 *    that can only find what is already on screen is not a search. A very long
 *    conversation therefore pays a full Ink layout per keypress. The rows are
 *    memoised so React skips the subtrees; Yoga still measures them.
 *  - **The numbers are one frame behind.** They are read in an effect after
 *    the commit, exactly as the viewport reads its extent. The first frame
 *    after opening has no offsets at all, which is why the initial position is
 *    set from the measurement rather than at mount.
 *  - **A resize keeps the line, not the row.** Reflowing changes every offset;
 *    the stored position is a line number, so after a resize the reader is
 *    near where they were rather than exactly on it.
 *
 * ## Searching the model, not the screen
 *
 * `searchTranscript` walks the transcript model — see the note at the head of
 * `packages/transcript/src/search.ts`. The desktop does the same, for the
 * reason that matters here too: a phrase inside a folded call is in the model
 * whether or not anything drew it, and matching on rendered text would find
 * only what was already unfolded. Each match names the row it is in, which is
 * the thing there is an offset for.
 *
 * A match inside a run's group of calls lands on the group's first line rather
 * than on the call itself: a group is one row and one offset. Unfolded, that
 * group is a summary line with its calls under it, so the call is usually on
 * screen; in a run of forty it may not be.
 *
 * ## Where it opens
 *
 * At the end, because the thing someone pressed Ctrl+O to see the whole of is
 * the thing that just went past — unless the caller names a row. `/timeline`
 * does: the reader has already picked a turn out of the ledger, and being put
 * back at the foot of the conversation would undo the choice. A named row
 * lands a line below the top edge, by the same rule and for the same reason a
 * search hit does.
 *
 * The id a turn carries (`Turn.userItemId`, in `src/timeline.ts`) is the id of
 * the user item that opened it, and that is also the item's row id, so nothing
 * has to translate between the two: only `kind: 'tool'` items count as
 * machinery in `rebuildRows` (`packages/transcript/src/transcript.ts`), and
 * everything else — a user message included — is pushed as a row of itself. A
 * user row is therefore never folded into a `g:` group, and an id from the
 * ledger can be looked up in `tops` as it stands.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, measureElement, useInput, type DOMElement } from 'ink';

import { searchTranscript, type TranscriptMatch, type TranscriptModel } from '@rx-artemis/transcript';

import { transcriptToMarkdown } from '../exportTranscript.js';
import { LiveRow, inOrderOfStart, rowContentColumns, type RowView } from './Transcript.js';

/** The title line above the conversation and the legend line below it. */
const HEAD_ROWS = 1;
const FOOT_ROWS = 1;

/**
 * Lines of what came before kept above a search hit.
 *
 * One. A match at the very top of the screen reads as though the transcript
 * begins there; a line of the row above says it does not.
 */
const CONTEXT = 1;

const LEGEND = '/ search · n N · { } turns · g G · q close';

interface Measured {
  /** The first line of each row in `shown`, cumulative, as of the last layout. */
  readonly tops: readonly number[];
  /** Every line there is. */
  readonly height: number;
}

const UNMEASURED: Measured = { tops: [], height: 0 };

export interface PagerProps {
  readonly transcript: TranscriptModel;
  /** The terminal's width; the pager fills it. */
  readonly columns: number;
  /** The terminal's height; the pager fills it. */
  readonly rows: number;
  /** `q`, `Esc` with the search row closed, and Ctrl+O. */
  readonly onClose: () => void;
  /**
   * `v`. The conversation as the markdown `/export` writes — reasoning and
   * all, because the pager is the view in which nothing is hidden, and an
   * editor copy that quietly dropped half of it would not be the same
   * document. See `src/exportTranscript.ts`.
   */
  readonly onOpenInEditor?: (markdown: string) => void;
  /** Off while something in front of the pager owns the keyboard. */
  readonly isActive?: boolean;
  /**
   * The row to open on, instead of the end — the turn a reader picked in
   * `/timeline`. See "Where it opens" above for why a turn's id needs no
   * translating, and why the view lands a line below the row's top.
   *
   * An id that is in no row — a turn from a conversation that has since been
   * reset, say — opens at the end, which is where the pager opens anyway.
   */
  readonly initialRowId?: string;
  /**
   * A phrase to open the search row with, already typed.
   *
   * Typed, not run: `Enter` runs it, exactly as for a phrase entered by hand,
   * and `Esc` throws the row away without the view having moved. Running it on
   * the way in would jump to the first match — somewhere nobody chose, and not
   * where {@link initialRowId} asked to be — and would leave no chance to
   * finish or correct a phrase the caller could only guess at.
   */
  readonly initialQuery?: string;
}

export function Pager({
  transcript,
  columns,
  rows,
  onClose,
  onOpenInEditor,
  isActive = true,
  initialRowId,
  initialQuery,
}: PagerProps): React.JSX.Element {
  const rowIds = useSyncExternalStore(transcript.subscribeList, transcript.getRowsSnapshot);
  const shown = useMemo(() => inOrderOfStart(rowIds, transcript), [rowIds, transcript]);
  const view = useMemo<RowView>(() => ({ expanded: true, columns: rowContentColumns(columns) }), [columns]);

  const [line, setLine] = useState(0);
  const [measured, setMeasured] = useState<Measured>(UNMEASURED);

  // A caller's phrase arrives in the row as though it had just been typed, so
  // the state it lands in is the state typing leaves behind: row open, draft
  // filled, nothing searched yet.
  const [searching, setSearching] = useState(initialQuery !== undefined && initialQuery !== '');
  const [draft, setDraft] = useState(initialQuery ?? '');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<readonly TranscriptMatch[]>([]);
  const [at, setAt] = useState(0);

  const bodyRows = Math.max(1, rows - HEAD_ROWS - FOOT_ROWS - (searching ? 1 : 0));
  const maxLine = Math.max(0, measured.height - bodyRows);
  const top = Math.min(Math.max(0, line), maxLine);

  /*
   * One box per row, kept by id, so a row's height survives the rows around it
   * changing. Entries are removed as Ink unmounts them, which is what keeps the
   * map from holding on to a conversation that has been reset under it.
   */
  const boxes = useRef(new Map<string, DOMElement>());
  /** The opening position is applied once, on the first layout that has one. */
  const anchored = useRef(false);

  const rendered = useMemo(
    () =>
      shown.map((id) => (
        <Box
          key={id}
          ref={(element: DOMElement | null) => {
            if (element === null) boxes.current.delete(id);
            else boxes.current.set(id, element);
          }}
          flexDirection="column"
          flexShrink={0}
        >
          <LiveRow id={id} transcript={transcript} view={view} />
        </Box>
      )),
    [shown, transcript, view],
  );

  // After every layout, like the viewport: Ink lays out on commit, so the
  // numbers are one frame behind at worst, and only a change is stored or this
  // would loop. A row's box includes the blank line its block hangs off, which
  // is why the tops add up to the column's own height.
  useEffect(() => {
    const tops: number[] = [];
    let height = 0;
    for (const id of shown) {
      tops.push(height);
      const box = boxes.current.get(id);
      if (box !== undefined) height += measureElement(box).height;
    }
    setMeasured((current) => (current.height === height && sameNumbers(current.tops, tops) ? current : { tops, height }));
    /*
     * Opened at the end, the way every one of these opens: the thing someone
     * pressed Ctrl+O to see the whole of is the thing that just went past —
     * unless a row was named, in which case that row, a line down from the top
     * edge. The offsets used are the ones measured a few lines up rather than
     * the ones in state: state is still the previous frame's, and on this,
     * the first frame with any heights at all, it is empty.
     */
    if (!anchored.current && height > 0) {
      anchored.current = true;
      const end = Math.max(0, height - bodyRows);
      const index = initialRowId === undefined ? -1 : shown.indexOf(initialRowId);
      const start = index === -1 ? undefined : tops[index];
      setLine(start === undefined ? end : Math.max(0, Math.min(start - CONTEXT, end)));
    }
  });

  const topOf = (rowId: string): number | undefined => {
    const index = shown.indexOf(rowId);
    return index === -1 ? undefined : measured.tops[index];
  };

  const goto = (target: number): void => setLine(Math.max(0, Math.min(target, maxLine)));
  const move = (delta: number): void => goto(top + delta);

  /** A match, by index, wrapping in both directions; the list may be a fresh one. */
  const toMatch = (index: number, list: readonly TranscriptMatch[]): void => {
    if (list.length === 0) return;
    const wrapped = ((index % list.length) + list.length) % list.length;
    setAt(wrapped);
    const rowId = list[wrapped]?.rowId;
    const start = rowId === undefined ? undefined : topOf(rowId);
    if (start !== undefined) goto(start - CONTEXT);
  };

  const search = (text: string): void => {
    const needle = text.trim();
    setQuery(needle);
    if (needle === '') {
      setMatches([]);
      setAt(0);
      return;
    }
    const found = searchTranscript(transcript, needle).matches;
    setMatches(found);
    // From here down, then round: the same rule the browser's bar follows, so
    // a search run halfway through a conversation does not throw the reader
    // back to the top of it.
    const ahead = found.findIndex((match) => (topOf(match.rowId) ?? -1) >= top);
    toMatch(ahead === -1 ? 0 : ahead, found);
  };

  /** The rows the person spoke, which are the landmarks `{` and `}` move between. */
  const turns = useMemo(() => shown.filter((id) => transcript.getItem(id)?.kind === 'user'), [shown, transcript]);

  const toTurn = (direction: 1 | -1): void => {
    const tops = turns.map((id) => topOf(id)).filter((start): start is number => start !== undefined);
    const next =
      direction === 1 ? tops.find((start) => start > top) : [...tops].reverse().find((start) => start < top);
    goto(next ?? (direction === 1 ? maxLine : 0));
  };

  useInput(
    (input, key) => {
      if (searching) {
        if (key.escape) {
          setSearching(false);
          return;
        }
        if (key.return) {
          setSearching(false);
          search(draft);
          return;
        }
        if (key.backspace || key.delete) {
          setDraft((current) => current.slice(0, -1));
          return;
        }
        // A chord is not a letter; Ctrl+U in a search row should not half-page
        // the conversation behind it either, so it is simply ignored.
        if (key.ctrl || key.meta) return;
        const typed = input.replace(/[\u0000-\u001f]/g, '');
        if (typed.length > 0) setDraft((current) => current + typed);
        return;
      }

      if (key.escape || input === 'q' || (key.ctrl && input === 'o')) {
        onClose();
        return;
      }
      if (key.upArrow || input === 'k') return move(-1);
      if (key.downArrow || input === 'j') return move(1);
      if (key.pageUp || (key.ctrl && input === 'u')) return move(-Math.max(1, Math.floor(bodyRows / 2)));
      if (key.pageDown || (key.ctrl && input === 'd')) return move(Math.max(1, Math.floor(bodyRows / 2)));
      if (input === ' ') return move(bodyRows);
      if (input === 'b') return move(-bodyRows);
      if (input === 'g' || key.home) return goto(0);
      if (input === 'G' || key.end) return goto(maxLine);
      if (input === '}') return toTurn(1);
      if (input === '{') return toTurn(-1);
      if (input === '/') {
        setDraft('');
        setSearching(true);
        return;
      }
      if (input === 'n') return toMatch(at + 1, matches);
      if (input === 'N') return toMatch(at - 1, matches);
      if (input === 'v') onOpenInEditor?.(transcriptToMarkdown(transcript, { thinking: true }));
    },
    { isActive },
  );

  const percent = maxLine === 0 ? 100 : Math.round((top / maxLine) * 100);
  const count = matches.length === 0 ? 'no matches' : `${String(at + 1)}/${String(matches.length)}`;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexShrink={0} paddingX={1}>
        <Text bold>Transcript</Text>
        <Text dimColor>{`  ${String(shown.length)} row${shown.length === 1 ? '' : 's'} · nothing folded`}</Text>
      </Box>

      {/* The clip and the lines under it are siblings, as in the viewport: a
          line drawn inside the clip would sit on a content line. */}
      <Box flexDirection="column" flexShrink={0} height={bodyRows} overflowY="hidden" paddingX={1}>
        <Box flexDirection="column" flexShrink={0} marginTop={-top}>
          {shown.length === 0 && <Text dimColor>Nothing said yet.</Text>}
          {rendered}
        </Box>
      </Box>

      {searching && (
        <Box flexShrink={0} paddingX={1}>
          <Text>
            {`/${draft}`}
            <Text inverse> </Text>
          </Text>
        </Box>
      )}

      <Box flexDirection="row" flexShrink={0} paddingX={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate">
            {LEGEND}
          </Text>
        </Box>
        {query !== '' && (
          <Box flexShrink={0}>
            <Text color="yellow">{`${query}  ${count}`}</Text>
          </Box>
        )}
        {/* The gaps are in the strings: a margin between flex items is not
            counted when the legend beside them grows to fill the line, and the
            count ended up welded to the percentage. */}
        <Box flexShrink={0}>
          <Text dimColor>{`  ${String(percent)}%`}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
