/**
 * A picture, or the line that stands in for one.
 *
 * What can be asserted here is what `images.test.ts` asserts of the encoders —
 * bytes, and the shape of the frame around them — and no more than that: a
 * passing test is not evidence a picture appeared, and the headers of
 * `render/images.ts` and `ImageRow.tsx` between them list the seven things only
 * a person with kitty, WezTerm, Ghostty or iTerm2 open can confirm.
 *
 * So these tests cover the decisions a machine can check. Which of the four
 * outcomes a row takes — drawn, or one of the three chips. That a drawn row
 * reserves exactly the lines the terminal is about to paint over, because a row
 * one line short is a row the next one is written on top of. That the delete
 * goes out before the transmission, because the other order is a picture that
 * vanishes the moment it is redrawn. And that the sequence is wrapped in a real
 * cursor move: a bare `7` and an `ESC 7` differ by one byte, and the wrong one
 * prints a digit at the reader.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';

import { deleteKitty, encodeIterm2, encodeKitty, fitCells } from '../render/images.js';
import { DEFAULT_IMAGE_ROWS, ImageRow, MAX_INLINE_BYTES, imageChip, positioned } from './ImageRow.js';

const ESC = '\u001b';
const ST = `${ESC}\\`;
const BEL = '\u0007';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function writeBe32(into: Uint8Array, at: number, value: number): void {
  into[at] = Math.floor(value / 0x1000000) & 0xff;
  into[at + 1] = (value >>> 16) & 0xff;
  into[at + 2] = (value >>> 8) & 0xff;
  into[at + 3] = value & 0xff;
}

/**
 * A file of `bytes` bytes that begins with a readable PNG header.
 *
 * The tail is deterministic filler rather than real image data: nothing in the
 * row decodes past the IHDR chunk, and a base64 payload that changed between
 * runs could not be compared with an expected sequence.
 */
function png(width: number, height: number, bytes = 33): Uint8Array {
  const file = new Uint8Array(Math.max(33, bytes));
  file.set(PNG_SIGNATURE, 0);
  writeBe32(file, 8, 13);
  for (const [index, code] of [...'IHDR'].entries()) file[12 + index] = code.charCodeAt(0);
  writeBe32(file, 16, width);
  writeBe32(file, 20, height);
  file[24] = 8; // bit depth
  file[25] = 6; // colour type: RGBA
  for (let at = 33; at < file.length; at += 1) file[at] = at % 251;
  return file;
}

/** 84 KB, which is the size the chip in the brief quotes. */
const SHOT = png(1200, 800, 84 * 1024);

/** A JPEG's first bytes. The protocols would take the file; nothing here can size it. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(60).fill(7)]);

/** A row and the bytes it wrote, with nothing reaching the fake stdout. */
function mount(element: React.JSX.Element): { readonly frame: () => string; readonly unmount: () => void } {
  const { lastFrame, unmount } = render(element);
  return { frame: () => lastFrame() ?? '', unmount };
}

/* -------------------------------------------------------------------------- */
/* Which of the four outcomes                                                 */
/* -------------------------------------------------------------------------- */

describe('the chip a row falls back to', () => {
  it('is what a terminal with no protocol gets, and nothing is written to it', async () => {
    const written: string[] = [];
    const { frame, unmount } = mount(<ImageRow png={SHOT} columns={60} protocol="none" write={(data) => written.push(data)} />);
    await tick();
    const shown = frame();
    unmount();

    // The size is in the chip because a reader who cannot see the picture can
    // still decide whether it is worth opening in something that draws it.
    expect(shown).toContain('[image 1200×800 · 84 KB]');
    expect(written).toEqual([]);
  });

  it('is what anything that is not a PNG gets, whatever the terminal speaks', async () => {
    const written: string[] = [];
    const { frame, unmount } = mount(<ImageRow png={JPEG} name="photo.jpg" columns={60} protocol="kitty" write={(data) => written.push(data)} />);
    await tick();
    const shown = frame();
    unmount();

    // No pixel size: `pngDimensions` is the only reader here, so there is no
    // number of cells to give the picture and a guess would letterbox or stretch.
    expect(shown).toContain('[image photo.jpg · 64 B]');
    expect(shown).not.toContain('×');
    expect(written).toEqual([]);
  });

  it('is what a file over the ceiling gets, and it says why rather than how big', async () => {
    const huge = png(1200, 800, MAX_INLINE_BYTES + 1);
    const written: string[] = [];
    const { frame, unmount } = mount(<ImageRow png={huge} columns={60} protocol="kitty" write={(data) => written.push(data)} />);
    await tick();
    const shown = frame();
    unmount();

    // 2.8 MB of base64 down a pipe on every render of that row is a frame rate
    // nobody gets back, so the row is a line and the picture stays in the turn.
    expect(shown).toContain('[image · too large to draw inline]');
    expect(written).toEqual([]);
  });

  it('names the file and the size in the chip, with no size when it is not readable', () => {
    expect(imageChip(SHOT)).toBe('[image 1200×800 · 84 KB]');
    expect(imageChip(SHOT, 'shot.png')).toBe('[image shot.png 1200×800 · 84 KB]');
    expect(imageChip(png(16, 16))).toBe('[image 16×16 · 33 B]');
    expect(imageChip(JPEG, 'photo.jpg')).toBe('[image photo.jpg · 64 B]');
  });
});

/* -------------------------------------------------------------------------- */
/* The lines the picture is painted on                                        */
/* -------------------------------------------------------------------------- */

describe('the reservation', () => {
  it('is exactly the fitted height, with the caption under it', async () => {
    // 1200×800 in 40 columns wants 13 rows at a 2:1 cell; six is all it may
    // have, so it gives up columns instead and keeps its aspect ratio.
    const fitted = fitCells(1200, 800, 40, 6);
    expect(fitted).toEqual({ columns: 18, rows: 6 });

    const { frame, unmount } = mount(
      <ImageRow png={SHOT} name="shot.png" columns={40} protocol="kitty" maxRows={6} write={() => undefined} />,
    );
    await tick();
    const lines = frame().split('\n');
    unmount();

    // Blank, and there have to be exactly this many: the terminal paints over
    // them, and a row one line short is a row the next one is written on top of.
    expect(lines).toHaveLength(fitted.rows + 1);
    expect(lines.slice(0, fitted.rows).every((line) => line.trim().length === 0)).toBe(true);

    // The caption is what is left when the picture never arrives — which is
    // every terminal that claims a protocol and does not implement it, since
    // `q=2` means none of them will ever say so.
    expect(lines.at(-1)?.trim()).toBe('shot.png · 1200×800');
  });

  it('falls back to the pixel size alone when the image had no name', async () => {
    const { frame, unmount } = mount(<ImageRow png={SHOT} columns={40} protocol="kitty" maxRows={6} write={() => undefined} />);
    await tick();
    const lines = frame().split('\n');
    unmount();

    // A pasted screenshot has no filename, and `· 1200×800` with nothing before
    // the separator reads as a missing word.
    expect(lines.at(-1)?.trim()).toBe('1200×800');
  });

  it('is twelve lines at most when the caller does not say', () => {
    expect(DEFAULT_IMAGE_ROWS).toBe(12);
    expect(fitCells(1200, 800, 200, DEFAULT_IMAGE_ROWS).rows).toBe(DEFAULT_IMAGE_ROWS);
  });
});

/* -------------------------------------------------------------------------- */
/* The bytes                                                                  */
/* -------------------------------------------------------------------------- */

/** The sequences inside a positioned write, with the wrapper checked and stripped. */
function unwrap(data: string): { readonly row: number; readonly column: number; readonly body: string } {
  const match = new RegExp(`^${ESC}7${ESC}\\[(\\d+);(\\d+)H([\\s\\S]*)${ESC}8$`).exec(data);
  expect(match, 'the write is a save, a cursor move, the sequence and a restore').not.toBeNull();
  return { row: Number(match?.[1]), column: Number(match?.[2]), body: match?.[3] ?? '' };
}

describe('what reaches stdout', () => {
  it('is a delete and then a transmission, at the row and in one write', async () => {
    const written: string[] = [];
    const { unmount } = mount(
      <ImageRow png={SHOT} name="shot.png" columns={40} protocol="kitty" maxRows={6} write={(data) => written.push(data)} />,
    );
    await tick();
    unmount();

    expect(written).toHaveLength(2);
    const { row, column, body } = unwrap(written[0] ?? '');

    // Somewhere in the frame, counting from the alternate screen's 1,1. The
    // exact cell is the layout's business; that it is a cell at all is this
    // test's, because an unpositioned sequence draws at the foot of the frame.
    expect(row).toBeGreaterThanOrEqual(1);
    expect(column).toBeGreaterThanOrEqual(1);

    // The id is minted per mounted row, so it is read back rather than assumed
    // — and the point of the test is that both halves name the *same* one.
    const id = Number(/i=(\d+)/.exec(body)?.[1]);
    expect(id).toBeGreaterThanOrEqual(1);

    // Delete first. The other order places the picture and then removes it; the
    // same order without the delete stacks a second copy on every redraw, and
    // that only shows up once the row scrolls.
    const fitted = fitCells(1200, 800, 40, 6);
    expect(body).toBe(deleteKitty(id) + encodeKitty(SHOT, { columns: fitted.columns, rows: fitted.rows, id }));
    expect(body.startsWith(`${ESC}_Ga=d,d=i,i=${String(id)},q=2${ST}`)).toBe(true);
  });

  it('takes the placement back off the screen when the row goes', async () => {
    const written: string[] = [];
    const { unmount } = mount(<ImageRow png={SHOT} columns={40} protocol="kitty" maxRows={6} write={(data) => written.push(data)} />);
    await tick();
    const placed = written.length;
    unmount();

    // A row scrolling out of the window takes its picture with it; an image
    // kitty was never told to forget outlives the conversation it belonged to.
    const id = Number(/i=(\d+)/.exec(written[0] ?? '')?.[1]);
    expect(written.slice(placed)).toContain(deleteKitty(id));
  });

  it('is iTerm2 own sequence, whole and named, on an iTerm2 terminal', async () => {
    const written: string[] = [];
    const { unmount } = mount(
      <ImageRow png={SHOT} name="shot.png" columns={40} protocol="iterm2" maxRows={6} write={(data) => written.push(data)} />,
    );
    await tick();
    unmount();

    const fitted = fitCells(1200, 800, 40, 6);
    const { body } = unwrap(written[0] ?? '');
    expect(body).toBe(encodeIterm2(SHOT, { columns: fitted.columns, rows: fitted.rows, name: 'shot.png' }));
    expect(body.endsWith(BEL)).toBe(true);

    // Nothing to take back: this protocol has no placement ids, and its pixels
    // live in the cells the next frame writes over.
    expect(written).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The wrapper, on its own                                                    */
/* -------------------------------------------------------------------------- */

describe('the cursor move around a sequence', () => {
  it('is a real escape sequence, and counts cells from one', () => {
    // A bare `7` and an `ESC 7` differ by one byte. Without the introducer the
    // terminal prints `7[1;1H` at the reader and draws the picture wherever
    // the cursor already was, which is the foot of the frame.
    expect(positioned({ row: 0, column: 0 }, 'X')).toBe(`${ESC}7${ESC}[1;1HX${ESC}8`);
    expect(positioned({ row: 11, column: 3 }, 'X')).toBe(`${ESC}7${ESC}[12;4HX${ESC}8`);
  });

  it('is nothing at all when there is nowhere to draw', () => {
    // Which is a layout that has not run, or a row some clipping ancestor does
    // not wholly contain. Writing `''` to stdout is a no-op; writing a picture
    // at a position Ink has declined to draw paints it over the composer.
    expect(positioned(null, 'X')).toBe('');
    expect(positioned({ row: 0, column: 0 }, '')).toBe('');
  });
});
