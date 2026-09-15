/**
 * A file edit, drawn as lines.
 *
 * `detectFileEdit` in `@rx-artemis/transcript` has already done the work — it
 * recognised the edit by its argument shape, diffed it, numbered every row
 * against the old and the new file, collapsed the unchanged middle into gaps
 * and capped the cost. This turns those rows into strings a terminal can show.
 *
 * Capped a second time here, tighter, because a transcript is a stream and one
 * five-hundred-line rewrite should not push the conversation off the top of
 * the screen. The cap says how much it left out.
 *
 * ## The gutter, and why one column of numbers rather than two
 *
 * A diff without line numbers tells you *what* changed and not *where*, which
 * leaves the reader scrolling their editor hunting for the line they just
 * approved. The reason this file used to omit them is still true, though: on a
 * narrow terminal a gutter is several columns stolen from the code, so
 * `numbers: 'auto'` turns them on only from {@link NUMBER_COLUMNS} up, and a
 * call that does not say how wide the terminal is gets no gutter at all — the
 * old shape, unchanged, for the callers that have not been taught to measure.
 *
 * One column, not two. A side-by-side old/new gutter costs twice the width and
 * the second number is only ever different on the handful of rows that changed,
 * where it is also the least useful: what a reader wants from a number is
 * "where do I put my cursor in the file I am about to open". For a context line
 * or an addition that file is the new one, and for a deletion — a line that no
 * longer exists — the only number that means anything is the old one. So the
 * column shows the new number for `+` and context, the old for `-`, and nothing
 * for a gap. This is what Codex shows and it is right for the same reason.
 *
 * ## Colour
 *
 * Two modes. `ansi` is the historical one: green and red *foreground*, which
 * works on any terminal and any background. `truecolor` tints the whole row —
 * gutter, sign and text — with a dark background and leaves the foreground to
 * the terminal, so the reader's own syntax colours and contrast survive and the
 * change reads as a band rather than as recoloured text.
 *
 * The tints are Codex's, and like Codex's they **assume a dark terminal**:
 * there is no light/dark detection anywhere in Artemis, and no single solid
 * colour has usable contrast against both a near-white and a near-black
 * foreground, so a pair that "reads on both" does not exist to be picked. The
 * escape hatch is explicit rather than guessed — `color: 'ansi'` forces the
 * foreground-only rendering, which is legible on any background — and `auto`
 * only reaches for the tints when `COLORTERM` says the terminal can show them.
 */

import type { DiffRow, FileEdit } from '@rx-artemis/transcript';

import { DIM, FG_OFF, GREEN, RED, RESET } from './ansi.js';

/**
 * 24-bit background tints, and the code that turns a background back off.
 *
 * These belong in `ansi.ts` alongside the other SGR constants; they are local
 * here only because this file is the sole user today.
 */
const ESC = '\u001b';
const BG_ADD = `${ESC}[48;2;33;58;43m`; // #213A2B
const BG_DEL = `${ESC}[48;2;74;34;29m`; // #4A221D
const BG_OFF = `${ESC}[49m`;

export const MAX_DIFF_LINES = 40;

/**
 * Terminal width from which `numbers: 'auto'` shows the gutter.
 *
 * Below this the gutter is competing with the code for the same few columns
 * and the code wins; at 100 there is room for both.
 */
export const NUMBER_COLUMNS = 100;

export interface DiffOptions {
  /** Terminal width. Rows are cut to it; `auto` modes need it to decide. */
  readonly columns?: number;
  /** `auto` follows {@link NUMBER_COLUMNS}, and is off when `columns` is unknown. */
  readonly numbers?: 'auto' | 'on' | 'off';
  /** `auto` reads `COLORTERM`. */
  readonly color?: 'ansi' | 'truecolor' | 'auto';
  /** Taken as an option, not read from the process, so tests are deterministic. */
  readonly env?: NodeJS.ProcessEnv;
}

export function renderDiff(
  edit: FileEdit,
  maxLines = MAX_DIFF_LINES,
  options: DiffOptions = {},
): readonly string[] {
  const { columns, numbers = 'auto', color = 'auto', env = process.env } = options;

  const wantNumbers =
    numbers === 'on' ||
    (numbers === 'auto' && columns !== undefined && columns >= NUMBER_COLUMNS);
  const tint = color === 'truecolor' || (color === 'auto' && supportsTruecolor(env));

  // Only the rows that survive the cap get a say in the gutter width: a
  // four-digit line number in the part that was clipped would indent every
  // visible row for nothing.
  const rows = edit.rows.slice(0, Math.max(0, maxLines));
  const gutter = wantNumbers ? gutterWidth(rows) : 0;

  const out: string[] = [header(edit, columns)];

  for (const row of rows) {
    const prefix = prefixOf(row, gutter);
    const room = columns === undefined ? undefined : columns - prefix.length;
    const body = prefix + cut(row.kind === 'gap' ? gapText(row) : row.text, room);
    switch (row.kind) {
      case 'add':
        out.push(tint ? `${BG_ADD}${fill(body, columns)}${BG_OFF}` : `${GREEN}${body}${FG_OFF}`);
        break;
      case 'del':
        out.push(tint ? `${BG_DEL}${fill(body, columns)}${BG_OFF}` : `${RED}${body}${FG_OFF}`);
        break;
      default:
        out.push(`${DIM}${body}${RESET}`);
        break;
    }
  }

  if (edit.rows.length > rows.length) {
    const remaining = edit.rows.length - rows.length;
    out.push(note(gutter, `⋯ ${String(remaining)} more line${remaining === 1 ? '' : 's'}`));
    return out;
  }
  if (edit.truncated) out.push(note(gutter, '⋯ diff truncated'));
  return out;
}

/** `COLORTERM` is the out-of-band way anything modern advertises 24-bit colour. */
function supportsTruecolor(env: NodeJS.ProcessEnv): boolean {
  const flag = env['COLORTERM']?.toLowerCase();
  return flag === 'truecolor' || flag === '24bit';
}

/** The one number a row is worth showing: new for `+` and context, old for `-`. */
function lineNumber(row: DiffRow): number | undefined {
  if (row.kind === 'gap') return undefined;
  return row.kind === 'del' ? (row.oldNo ?? row.newNo) : (row.newNo ?? row.oldNo);
}

function gutterWidth(rows: readonly DiffRow[]): number {
  let widest = 0;
  for (const row of rows) {
    const value = lineNumber(row);
    if (value !== undefined) widest = Math.max(widest, String(value).length);
  }
  return widest;
}

/**
 * Everything left of the text: the right-aligned number, then the sign.
 *
 * With no gutter this is the historical `"+ "` / `"- "` / `"  "`, so an
 * un-measured call renders exactly what it always did. With a gutter it is
 * Codex's shape — `"  12 +text"` — where the sign sits tight against the text
 * and the space between the two columns is what separates them.
 */
function prefixOf(row: DiffRow, gutter: number): string {
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
  if (gutter === 0) return row.kind === 'gap' ? '' : `${sign} `;
  const value = lineNumber(row);
  // A gap has no number and no sign; its own glyph takes the sign column.
  return `${(value === undefined ? '' : String(value)).padStart(gutter)} ${row.kind === 'gap' ? '' : sign}`;
}

/**
 * A gap row's text.
 *
 * `⋮` rather than `⋯`, which is kept for output this renderer clipped: a
 * vertical ellipsis says "the file continues here", a horizontal one says "this
 * line goes on", and a reader should not have to work out which they are
 * looking at. `skipped` is absent — or zero, on the oversized-payload row that
 * the diff bails out with — when the count is not a count of hidden lines, so
 * the row's own words stand in for it.
 */
function gapText(row: DiffRow): string {
  if (row.skipped !== undefined && row.skipped > 0) return `⋮ ${String(row.skipped)} unchanged`;
  return row.text.length > 0 ? `⋮ ${row.text}` : '⋮';
}

/** The cap and truncation lines, aligned with the sign column. */
function note(gutter: number, text: string): string {
  return `${DIM}${gutter === 0 ? '  ' : `${' '.repeat(gutter)} `}${text}${RESET}`;
}

/**
 * `path  +N -M`.
 *
 * `FileEdit` carries one path and `detectFileEdit` has no rename shape to
 * detect, so there is no `old → new` to render; when a rename can be expressed
 * upstream this is where it goes.
 *
 * The path is elided from the left when it will not fit, rather than the whole
 * line being cut from the right: the counts are the half worth keeping, and a
 * path identifies a file by its tail.
 */
function header(edit: FileEdit, columns: number | undefined): string {
  const counts = ` +${String(edit.added)} -${String(edit.removed)}`;
  const room = columns === undefined ? undefined : columns - counts.length - 1;
  const path = elide(edit.path, room);
  return `${DIM}${path}${RESET}  ${GREEN}+${String(edit.added)}${FG_OFF} ${RED}-${String(edit.removed)}${FG_OFF}`;
}

function elide(path: string, room: number | undefined): string {
  if (room === undefined || path.length <= room) return path;
  if (room <= 1) return path.slice(path.length - Math.max(0, room));
  return `…${path.slice(path.length - (room - 1))}`;
}

/**
 * Cut, never wrap.
 *
 * A wrapped diff line loses its gutter and its sign on the continuation, which
 * is worse than losing the tail of a long line — and both callers already hand
 * these strings to Ink with `wrap="truncate"`. Measured in code units, so a
 * line of wide characters is cut short; there is no width table in this app's
 * dependency set and a diff is overwhelmingly source code.
 */
function cut(text: string, room: number | undefined): string {
  if (room === undefined || text.length <= room) return text;
  return text.slice(0, Math.max(0, room));
}

/** Run a tinted row's background out to the edge, so it reads as a band. */
function fill(body: string, columns: number | undefined): string {
  if (columns === undefined || body.length >= columns) return body;
  return body.padEnd(columns);
}
