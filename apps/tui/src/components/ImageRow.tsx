/**
 * One picture, under the row that produced it.
 *
 * `render/images.ts` makes the bytes and does nothing with them; its header
 * lists the three things a row has to do that a string cannot — reserve the
 * lines the terminal is about to paint over, send the sequence again every
 * time the row is drawn, and put the bytes on stdout rather than through a
 * `<Text>` that would escape them. This is that row, and everything below is
 * one of those three or a consequence of one.
 *
 * What it draws is two things stacked: a box of `rows` blank lines, sized by
 * `fitCells` so the picture lands on it at its own aspect ratio, and a dim
 * caption under it naming the file and its pixel size. The caption is not
 * decoration. Every one of these protocols is silent about failure — `q=2` is
 * on the kitty sequences precisely so the terminal does not answer, and iTerm2
 * has nothing to answer with — so a terminal that claims kitty's protocol and
 * does not implement it leaves an empty box and no explanation. The caption is
 * what is left when the picture never arrives.
 *
 * ## Three ways to get a chip instead
 *
 * `[image 1200×800 · 84 KB]`, one line, no reservation and nothing written:
 *
 *  - the terminal has no protocol (`imageProtocol()` said `'none'`), which is
 *    most terminals and every tmux that has not been forced;
 *  - the bytes are not a PNG, since `pngDimensions` is the only reader here
 *    and a JPEG's size sits behind a parser rather than at a fixed offset. The
 *    protocols would both take the file; nothing could work out how many cells
 *    to give it, and a picture sized by guess is worse than a line of text;
 *  - the file is over {@link MAX_INLINE_BYTES}. A 6 MB screenshot is 8 MB of
 *    base64 through a pipe on every redraw of that row, which is a frame rate
 *    nobody gets back.
 *
 * ## Where the picture goes
 *
 * Both protocols draw at the cursor, and the cursor after Ink writes a frame
 * is at the foot of it — so the sequence is wrapped in a move to the row's own
 * top-left, with a DEC save and restore around that so Ink's next write starts
 * where Ink left off.
 *
 * Ink 7 is what makes working out that top-left possible: `measureElement`
 * returns `x` and `y` as well as a size, by walking the yoga tree to the root
 * and adding up each ancestor's computed offset. ({@link placementOf} does the
 * same walk rather than calling it, because it needs each ancestor's *box* on
 * the way up to answer the clipping question below, and two walks could
 * disagree.) Earlier Ink returned a size and no position at all, which is why
 * `images.ts` treats placement as the row's unsolved problem.
 *
 * What the walk produces is a position inside *Ink's frame*, and Ink never
 * says where the frame itself is: `logUpdate` erases the previous frame's
 * lines and rewrites from wherever the cursor happens to be, using relative
 * moves throughout. So there is one assumption, and it is about the app rather
 * than about this row: `main.tsx` mounts with `alternateScreen: true` and the
 * app's root box is the full `width × height` of the terminal, so the frame
 * fills the screen from its first line and frame row 0 is screen row 1. A
 * mount without the alternate screen, or a root that does not fill the screen,
 * puts every picture at the wrong height — and there is no way from in here to
 * notice, because nothing in the component tree can see the frame's own origin.
 *
 * ## …and when it goes nowhere at all
 *
 * A position on its own is not enough, because Ink clips and the terminal does
 * not. The transcript viewport is an `overflow: hidden` box with the
 * conversation scrolled inside it: Yoga gives a row that has been scrolled out
 * of the pane a perfectly good position, Ink simply declines to draw it, and a
 * picture sent to that position would be painted over the composer — on every
 * render, for every image row in the forty-row window. Ink's own clipping is
 * invisible to the terminal, so this row has to do it: any ancestor that clips
 * — plus the root, which stands for the screen — must contain the whole
 * reserved box, or nothing is written.
 *
 * The cost is small and stated: a picture that is half scrolled off is not
 * drawn until it is whole again, and a row whose layout has not run yet writes
 * nothing this frame and draws on the next. The caption and the reservation
 * are in the frame either way, which is the point of having a caption.
 *
 * ## Why not `useStdout().write`
 *
 * Because it is not a write. Ink's `write` clears the whole frame, puts the
 * data on the screen where the frame was, and then paints the frame back — it
 * exists to let `console.log` scroll past above a live UI. Handing it a
 * positioned image sequence means erasing the screen, drawing onto the hole
 * and redrawing everything on top, once per row per render. The raw
 * `useStdout().stdout` is what the images header means by "outside Ink's
 * frame", so that is what is used, and `write` is a prop so a test can hold
 * the bytes instead.
 *
 * ## What a test here cannot prove
 *
 * The same limit `images.ts` states — a passing test is not a picture — plus
 * two this file adds:
 *
 *  - **The frame may lose a race.** Ink throttles its frame write to `maxFps`
 *    (30, so about 33 ms); this effect writes the moment React commits. The
 *    picture can therefore reach the terminal *before* the frame that reserved
 *    its lines, and a frame that clears the screen — Ink does that when the
 *    output shrinks — would take it straight back off. Whether that is visible
 *    as a flicker, as a missing image, or not at all needs a real terminal.
 *  - **A redraw that is not a re-render does not re-emit.** The sequence goes
 *    out whenever this component renders, which is what "re-emit on every
 *    redraw" can mean from inside React. Ink rewrites the whole frame whenever
 *    anything anywhere commits, and a row that did not change does not render
 *    for it. If a text rewrite over those cells removes the placement, the
 *    picture goes until something touches the row. kitty keeps placements
 *    across an erase and iTerm2's pixels live in the cells, so the two are
 *    expected to behave differently here, and neither is confirmed.
 */

import { useEffect, useMemo, useRef } from 'react';
import { Box, Text, useStdout, type DOMElement } from 'ink';

import { deleteKitty, encodeIterm2, encodeKitty, fitCells, pngDimensions, type ImageProtocol } from '../render/images.js';

/**
 * The most PNG that is worth putting down a pipe on every redraw.
 *
 * Two mebibytes of file is about 2.8 MB of base64 per emission, and a row
 * emits every time it renders. Over this the row is a chip: the picture is
 * still in the transcript and still went to the model, it is only not drawn.
 */
export const MAX_INLINE_BYTES = 2 * 1024 * 1024;

/**
 * How tall a picture may be, in lines, when the caller does not say.
 *
 * A terminal is short of rows long before it is short of columns, and a
 * screenshot given its natural share of a 50-line pane pushes the whole
 * conversation off the top. Twelve lines is a picture someone can see and
 * still have the turn around it.
 */
export const DEFAULT_IMAGE_ROWS = 12;

export interface ImageRowProps {
  /** The file, as bytes. Only a PNG is drawn; see the header. */
  readonly png: Uint8Array;
  /** What it was called, when it had a name. Pasted images have none. */
  readonly name?: string;
  /** Columns the row's content has — the widest the picture may be. */
  readonly columns: number;
  /** What this terminal speaks, from `imageProtocol()`. `'none'` is a chip. */
  readonly protocol: ImageProtocol;
  /** The tallest the picture may be, in lines. {@link DEFAULT_IMAGE_ROWS}. */
  readonly maxRows?: number;
  /**
   * Where the bytes go. Defaults to the raw stdout Ink is rendering on — see
   * the header on why not Ink's own `write` — and is a prop so that a test can
   * assert the sequence without a terminal in it.
   */
  readonly write?: (data: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Placement ids                                                              */
/* -------------------------------------------------------------------------- */

/**
 * kitty needs a name for a placement to delete it by, and two rows sharing one
 * would delete each other's pictures. A module-level counter is the whole of
 * what is needed: the ids only have to be distinct among the rows alive at
 * once, and a terminal session does not outlive 2^32 of them. Zero is kitty's
 * "unset", so the first handed out is 1.
 */
let placements = 0;

const MAX_PLACEMENT_ID = 4_294_967_295;

function nextPlacement(): number {
  placements = (placements % MAX_PLACEMENT_ID) + 1;
  return placements;
}

/* -------------------------------------------------------------------------- */
/* Where the row is                                                           */
/* -------------------------------------------------------------------------- */

const ESC = '\u001b';
/** DEC save/restore cursor. Older and more widely honoured than `CSI s`/`CSI u`. */
const SAVE_CURSOR = `${ESC}7`;
const RESTORE_CURSOR = `${ESC}8`;

/** A cell of Ink's frame, counting from zero at its top-left. */
export interface FrameCell {
  readonly row: number;
  readonly column: number;
}

/**
 * A node that cuts its children off at its own edges.
 *
 * The root counts as one because the screen does: a frame the app has sized to
 * the terminal has nothing below its last line, and a sequence aimed past it
 * would scroll the alternate screen rather than draw anything.
 */
function clips(node: DOMElement): boolean {
  return node.nodeName === 'ink-root' || node.style.overflowX === 'hidden' || node.style.overflowY === 'hidden';
}

/**
 * Where this box's top-left is inside Ink's frame — or null, meaning there is
 * nowhere the picture may be put.
 *
 * Null covers two different situations and deliberately does not distinguish
 * them, because the answer is the same: a layout that has not run yet (a box
 * with no size; the reservation is never legitimately zero), and a box some
 * clipping ancestor does not wholly contain. See the header.
 */
export function placementOf(node: DOMElement | null): FrameCell | null {
  if (node === null) return null;
  const layout = node.yogaNode;
  if (layout === undefined) return null;
  const width = layout.getComputedWidth();
  const height = layout.getComputedHeight();
  if (!(width > 0) || !(height > 0)) return null;

  let row = layout.getComputedTop();
  let column = layout.getComputedLeft();
  for (let at: DOMElement | undefined = node.parentNode; at !== undefined; at = at.parentNode) {
    const box = at.yogaNode;
    if (box === undefined) return null;
    // At the head of each step `row`/`column` are the offset inside `at`, which
    // is the frame of reference `at`'s own edges are in.
    if (clips(at) && !contains(box.getComputedWidth(), box.getComputedHeight(), { row, column }, { width, height })) return null;
    row += box.getComputedTop();
    column += box.getComputedLeft();
  }
  return Number.isFinite(row) && Number.isFinite(column) && row >= 0 && column >= 0 ? { row, column } : null;
}

function contains(outerWidth: number, outerHeight: number, at: FrameCell, size: { readonly width: number; readonly height: number }): boolean {
  return at.row >= 0 && at.column >= 0 && at.row + size.height <= outerHeight && at.column + size.width <= outerWidth;
}

/**
 * The sequence, moved to the row and put back afterwards — or nothing at all,
 * which is what `''` means to a stdout write.
 *
 * The alternate screen's first cell is 1,1 and the frame starts there, so a
 * frame row of zero is a `CUP` of one.
 */
export function positioned(at: FrameCell | null, sequence: string): string {
  if (at === null || sequence.length === 0) return '';
  return `${SAVE_CURSOR}${ESC}[${String(at.row + 1)};${String(at.column + 1)}H${sequence}${RESTORE_CURSOR}`;
}

/* -------------------------------------------------------------------------- */
/* Words for a picture                                                        */
/* -------------------------------------------------------------------------- */

/** Round numbers, because the point is the order of magnitude and not the byte. */
function readableBytes(count: number): string {
  if (count < 1024) return `${String(count)} B`;
  if (count < 1024 * 1024) return `${String(Math.round(count / 1024))} KB`;
  return `${(count / 1024 / 1024).toFixed(1)} MB`;
}

const pixels = (width: number, height: number): string => `${String(width)}×${String(height)}`;

/** The line under a picture that was drawn: what it is called, and how big it is. */
export function imageCaption(name: string | undefined, size: { readonly width: number; readonly height: number }): string {
  const measurement = pixels(size.width, size.height);
  return name === undefined ? measurement : `${name} · ${measurement}`;
}

/** The line a terminal that cannot draw gets instead. */
export function imageChip(png: Uint8Array, name?: string): string {
  // Asked before the size, because past the ceiling the size is not the point:
  // the row is saying why there is no picture, and `1200×800` alongside would
  // read as a boast about the one it is refusing to draw.
  if (png.byteLength > MAX_INLINE_BYTES) return '[image · too large to draw inline]';
  const size = pngDimensions(png);
  const head = ['image', name, size === null ? undefined : pixels(size.width, size.height)].filter((part): part is string => part !== undefined);
  return `[${head.join(' ')} · ${readableBytes(png.byteLength)}]`;
}

/* -------------------------------------------------------------------------- */
/* The row                                                                    */
/* -------------------------------------------------------------------------- */

export function ImageRow({ png, name, columns, protocol, maxRows = DEFAULT_IMAGE_ROWS, write }: ImageRowProps): React.JSX.Element {
  const { stdout } = useStdout();
  const node = useRef<DOMElement>(null);

  // Minted once per mounted row, lazily, because a `useRef(nextPlacement())`
  // would burn an id on every render to keep the first.
  const placement = useRef(0);
  if (placement.current === 0) placement.current = nextPlacement();

  const size = useMemo(() => pngDimensions(png), [png]);
  const box = useMemo(
    () => (size === null ? null : fitCells(size.width, size.height, columns, maxRows)),
    [size, columns, maxRows],
  );
  const drawn = protocol !== 'none' && box !== null && png.byteLength <= MAX_INLINE_BYTES;
  const emit = write ?? ((data: string): void => void stdout.write(data));

  /*
   * No dependency list: the sequence has to go out again every time this row
   * is drawn, which is the second of the three things `images.ts` asks of a
   * row. The cleanup is the same effect's, so a render does a delete before
   * its redraw — and an unmount does a delete with no redraw after it, which
   * is a row scrolling out of the window taking its picture with it. Nothing
   * is deleted that was not placed: an id kitty has never seen deletes
   * nothing, but saying so on every render of every clipped row is a steady
   * trickle of bytes for no effect. iTerm2 has no placement ids and so nothing
   * to take back; its pixels live in the cells.
   */
  useEffect(() => {
    if (!drawn || box === null) return undefined;
    const id = placement.current;
    const sequence =
      protocol === 'kitty'
        ? deleteKitty(id) + encodeKitty(png, { columns: box.columns, rows: box.rows, id })
        : encodeIterm2(png, { columns: box.columns, rows: box.rows, ...(name === undefined ? {} : { name }) });
    const bytes = positioned(placementOf(node.current), sequence);
    if (bytes.length === 0) return undefined;
    emit(bytes);
    return protocol === 'kitty' ? (): void => emit(deleteKitty(id)) : undefined;
  });

  if (!drawn || box === null || size === null) {
    return (
      <Box flexShrink={0}>
        <Text dimColor>{imageChip(png, name)}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* The reservation. Empty on purpose: the terminal paints these lines,
          and anything drawn in them would be under the picture on a terminal
          that draws it and stranded text on one that does not. */}
      <Box ref={node} width={box.columns} height={box.rows} flexShrink={0} />
      <Text dimColor>{imageCaption(name, size)}</Text>
    </Box>
  );
}
