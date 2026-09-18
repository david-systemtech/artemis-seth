/**
 * Pictures in the terminal.
 * ============================================================================
 *
 * Artemis is the agent terminal with a browser in it. A screenshot of the page
 * the agent just clicked through is the one piece of tool output that is worth
 * nothing as text, and a transcript that answers it with `[image 1440x900]` has
 * thrown away the only thing the tool produced. The same is true of an image
 * the person pastes into the composer: they pasted a picture because the
 * picture was the point.
 *
 * Two terminals can draw one, by two unrelated protocols invented by two people
 * who were not talking to each other. kitty's is an APC sequence carrying
 * chunked base64; iTerm2's is an OSC 1337 with the whole file in one go.
 * WezTerm and Ghostty implement kitty's. Everything else gets nothing, and the
 * row falls back to a chip the reader can open in a real viewer.
 *
 * This module is the encoders and the detection, and none of the drawing. It
 * produces strings; it never writes, never measures the terminal, never asks it
 * a question and never throws. That keeps the whole of it testable as bytes on
 * a machine that is none of these terminals — which is the only way any of it
 * *can* be tested, because a passing test here is not evidence the picture
 * appeared. See "What a real terminal would have to confirm" below.
 *
 * ## What the row that calls this has to do, that this does not
 *
 * Three things, all of them outside what a string can carry:
 *
 *  1. **Reserve the lines.** Both protocols draw *over* the screen at the
 *     cursor. Ink has no idea it happened: as far as the layout is concerned
 *     the row is empty, and the next row will be placed on top of the picture.
 *     So the row must render `rows` blank lines — `<Box height={rows} />` — and
 *     the image is then painted onto them. `fitCells` exists to produce that
 *     number before anything is encoded.
 *  2. **Re-emit on every redraw.** Ink repaints by rewriting the frame, and the
 *     alternate screen is cleared out from under any image sitting on it. An
 *     image written once is an image that survives until the first keystroke.
 *     The sequence has to go out again each time that row is drawn, which is
 *     what `deleteKitty` is for: clear the previous placement by id, then place
 *     it again, so a redraw cannot leave two copies stacked up.
 *  3. **Write outside Ink's frame.** These sequences must not go through
 *     `<Text>`. Ink measures and truncates the strings it lays out and escapes
 *     what it does not recognise, so an APC sequence handed to a `<Text>` comes
 *     out as visible rubbish or as nothing at all. The bytes belong on stdout
 *     directly — a `useStdout().write` in an effect that runs after layout,
 *     with a ref holding the row's own placement id. Mounting that is the
 *     row's problem and is deliberately not solved here.
 *
 * ## Decisions worth knowing
 *
 *  - **`q=2` on every kitty sequence.** kitty answers a graphics command with
 *    an APC of its own — `ESC _ G i=1;OK ESC \`. Nobody is reading stdin here
 *    except Ink, which is parsing it for keystrokes, so that reply arrives as a
 *    burst of characters in the composer. `q=2` suppresses both the success and
 *    the failure reply. The cost is real and accepted: with responses off there
 *    is no way to learn that a placement failed, so a terminal that says it
 *    speaks the protocol and does not simply shows nothing.
 *  - **Detection is an allow-list on what a terminal calls itself.** There is no
 *    capability query that does not put bytes back in the input stream, which
 *    is the thing `q=2` exists to avoid. So the protocol is chosen from the
 *    environment variables these terminals set for themselves, exactly as
 *    `terminal.ts` chooses a notification route, and anything unrecognised gets
 *    `'none'`. Guessing wrong here is not a cosmetic failure: it sprays several
 *    thousand characters of base64 across the transcript.
 *  - **tmux is `'none'`.** tmux owns the screen and rewrites what passes
 *    through it; kitty's chunked APC does not survive that, and an image tmux
 *    does not know about is one it cannot scroll, clear or redraw in the right
 *    pane. `ARTEMIS_TUI_IMAGES=force` says try anyway — for tmux 3.5a and later,
 *    which handles the protocol itself. Note that `force` only lifts the tmux
 *    veto; it cannot conjure a protocol out of a terminal that announces none,
 *    because there would be no way to choose between the two.
 *  - **Nothing here wraps a sequence for tmux passthrough.** An OSC can be
 *    smuggled through a DCS wrapper the way `osc52Sequence` does, but a kitty
 *    image cannot: it is many sequences, and tmux's own graphics handling —
 *    not passthrough — is what makes it work. So the sequences are exactly the
 *    protocol's and the tmux question is settled in `imageProtocol` instead.
 *  - **Bad input is an empty string, never an exception.** An empty buffer, a
 *    zero id, a size that is not a number: every one of them produces `''`, and
 *    writing `''` to stdout is a no-op. The caller is a render, and a render has
 *    nothing useful to do with a thrown error.
 *
 * ## What a real terminal would have to confirm
 *
 * The tests assert bytes, and bytes are all that can be asserted off a
 * terminal. Four things are unverifiable here and need a person with kitty,
 * WezTerm, Ghostty and iTerm2 open:
 *
 *  - that the cell arithmetic in `fitCells` produces a picture that is not
 *    stretched, since the 2:1 cell is an assumption and the real ratio is the
 *    font's;
 *  - that a scroll moves the image with its row rather than leaving it pinned;
 *  - that `q=2` really does silence both replies in all four (kitty documents
 *    it; the three that reimplemented the protocol are taken on trust);
 *  - and that 4096 is a chunk size every one of them accepts, which is the
 *    maximum kitty's own documentation specifies.
 */

// ---------------------------------------------------------------------------
// Which protocol, if any
// ---------------------------------------------------------------------------

/** kitty's APC graphics protocol, iTerm2's OSC 1337, or no pictures at all. */
export type ImageProtocol = 'kitty' | 'iterm2' | 'none';

/** The switch, and the only variable this module reads by name for its own sake. */
const IMAGES_ENV = 'ARTEMIS_TUI_IMAGES';

const present = (value: string | undefined): boolean => value !== undefined && value.length > 0;

/**
 * Which protocol this terminal gets.
 *
 * `platform` is accepted so that every detector in the TUI has the same shape
 * as `terminal.ts`, and is deliberately not consulted: these protocols are
 * properties of the terminal emulator rather than of the operating system, and
 * every terminal on the list below identifies itself the same way on all three.
 * A Windows console that is not one of them already falls out as `'none'`.
 *
 * The environment is read, never the terminal. See the header on why asking is
 * not an option.
 */
export function imageProtocol(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): ImageProtocol {
  void platform; // Accepted for symmetry, deliberately not consulted; see above.
  const setting = (env[IMAGES_ENV] ?? '').trim().toLowerCase();
  if (setting === 'off' || setting === '0' || setting === 'false') return 'none';
  // Naming a protocol outright is the answer for SSH, where the variables that
  // identify a terminal belong to a login shell that never ran. It is a
  // stronger statement than `force`, so it passes the tmux veto as well.
  if (setting === 'kitty') return 'kitty';
  if (setting === 'iterm2' || setting === 'iterm') return 'iterm2';
  // Inside tmux the identifying variables are still inherited from whatever
  // started the server, so a forced session can still tell the two apart.
  if (present(env['TMUX']) && setting !== 'force') return 'none';
  return announced(env);
}

/**
 * The allow-list. kitty first, because a terminal claiming to be kitty is
 * claiming kitty's protocol, and iTerm2 — which has since grown a partial
 * implementation of it — is better served by the one it wrote.
 */
function announced(env: NodeJS.ProcessEnv): ImageProtocol {
  const term = (env['TERM'] ?? '').toLowerCase();
  const program = (env['TERM_PROGRAM'] ?? '').toLowerCase();

  if (term.includes('kitty') || present(env['KITTY_WINDOW_ID'])) return 'kitty';
  if (program === 'wezterm' || term === 'wezterm' || present(env['WEZTERM_PANE'])) return 'kitty';
  if (program === 'ghostty' || term === 'xterm-ghostty' || present(env['GHOSTTY_RESOURCES_DIR'])) return 'kitty';

  // `LC_TERMINAL` is the one identifying variable iTerm2 forwards over SSH,
  // which it sets for exactly this purpose.
  if (program === 'iterm.app' || (env['LC_TERMINAL'] ?? '').toLowerCase() === 'iterm2') return 'iterm2';

  return 'none';
}

// ---------------------------------------------------------------------------
// Numbers and bytes that have to be safe to put in a sequence
// ---------------------------------------------------------------------------

/**
 * A cell count, as a positive whole number. Everything downstream of a bad one
 * is a malformed escape sequence printed at the reader, so there is no value
 * here worth passing through unexamined.
 */
const cells = (value: number): number => (Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1);

/** kitty's image ids are a 32-bit unsigned integer, and zero means "unset". */
const MAX_IMAGE_ID = 4_294_967_295;

function imageId(id: number | undefined): number | null {
  if (typeof id !== 'number' || !Number.isFinite(id)) return null;
  const whole = Math.floor(id);
  return whole >= 1 && whole <= MAX_IMAGE_ID ? whole : null;
}

const ESC = '\u001b';
/** The APC introducer kitty's protocol lives in, and the string terminator that ends it. */
const APC = `${ESC}_`;
const ST = `${ESC}\\`;
const BEL = '\u0007';

// ---------------------------------------------------------------------------
// kitty
// ---------------------------------------------------------------------------

/**
 * The most base64 kitty will accept in one escape sequence. It is the protocol's
 * documented maximum, not a guess, and it is a multiple of four — so a payload
 * cut here never splits a base64 quantum, which matters to the reimplementations
 * that decode chunk by chunk rather than concatenating first.
 */
export const KITTY_CHUNK_BYTES = 4096;

export interface KittyOptions {
  /** How many columns the picture occupies. The terminal scales the PNG to fit. */
  readonly columns: number;
  /** How many rows. The row must have reserved this many blank lines; see the header. */
  readonly rows: number;
  /**
   * The placement id, so a later `deleteKitty` can take this picture back off
   * the screen. Omitted, the terminal assigns one and the image can never be
   * deleted by name — fine for a one-shot, wrong for anything that redraws.
   */
  readonly id?: number;
}

/**
 * The kitty sequence — or sequences — that draw `png` at the cursor.
 *
 * `a=T` transmits and displays in one command, `f=100` says the payload is a
 * PNG rather than raw pixels (so the terminal does the decoding and we never
 * carry an uncompressed bitmap through a pipe), and `t=d` says the data is
 * here, inline, rather than in a file the terminal should go and open — which
 * is the only form that works when Artemis is running over SSH or in a
 * container and the terminal shares no filesystem with it.
 *
 * Long payloads are cut into `KITTY_CHUNK_BYTES` pieces. The first carries every
 * key; the rest carry only `m`, because kitty reads the control data of the
 * first chunk and would reject a repeat of `a=T` on a transmission already in
 * progress. `m=1` means "more to come" and the last chunk's `m=0` is what
 * commits the image, so an interrupted write leaves nothing drawn rather than
 * half a picture.
 */
export function encodeKitty(png: Uint8Array, opts: KittyOptions): string {
  if (png.length === 0) return '';
  const payload = Buffer.from(png).toString('base64');

  const keys = ['a=T', 'f=100', 't=d', `c=${cells(opts.columns)}`, `r=${cells(opts.rows)}`];
  const id = imageId(opts.id);
  if (id !== null) keys.push(`i=${id}`);
  keys.push('q=2');
  const first = keys.join(',');

  let out = '';
  for (let at = 0; at < payload.length; at += KITTY_CHUNK_BYTES) {
    const piece = payload.slice(at, at + KITTY_CHUNK_BYTES);
    const more = at + KITTY_CHUNK_BYTES < payload.length ? '1' : '0';
    const control = at === 0 ? `${first},m=${more}` : `m=${more}`;
    out += `${APC}G${control};${piece}${ST}`;
  }
  return out;
}

/**
 * Take a placed image back off the screen by id.
 *
 * `a=d` deletes, `d=i` says the thing being named is an image id rather than a
 * position or a range. Without this a redraw stacks a second copy on the first,
 * and the difference only shows up once the row scrolls. An id kitty would
 * refuse — zero, negative, past 32 bits — produces `''` rather than a sequence
 * that means something else.
 */
export function deleteKitty(id: number): string {
  const image = imageId(id);
  if (image === null) return '';
  return `${APC}Ga=d,d=i,i=${image},q=2${ST}`;
}

// ---------------------------------------------------------------------------
// iTerm2
// ---------------------------------------------------------------------------

export interface Iterm2Options {
  readonly columns: number;
  readonly rows: number;
  /**
   * What the picture is called. iTerm2 shows it when the image is clicked or
   * saved, so a browser screenshot should say which page it was. Carried base64
   * because the name is arbitrary text inside a semicolon-separated header.
   */
  readonly name?: string;
}

/**
 * iTerm2's OSC 1337, which takes the whole file in one sequence — there is no
 * chunking in this protocol, and no length limit documented for it either.
 *
 * `size` is the decoded byte count, which iTerm2 uses to know when it has the
 * whole image; it must be the length of the *bytes*, not of the base64.
 * `width` and `height` are bare numbers, which this protocol reads as cells
 * (it would also take `Npx`, `N%` or `auto`). `preserveAspectRatio=1` makes
 * that box a bound rather than a stretch, so a cell ratio guessed slightly
 * wrong letterboxes instead of distorting — the one place either protocol
 * offers any protection against the assumption in `fitCells`.
 */
export function encodeIterm2(png: Uint8Array, opts: Iterm2Options): string {
  if (png.length === 0) return '';
  const keys = ['inline=1', `size=${png.length}`, `width=${cells(opts.columns)}`, `height=${cells(opts.rows)}`, 'preserveAspectRatio=1'];
  const name = opts.name;
  if (name !== undefined && name.length > 0) keys.push(`name=${Buffer.from(name, 'utf8').toString('base64')}`);
  return `${ESC}]1337;File=${keys.join(';')}:${Buffer.from(png).toString('base64')}${BEL}`;
}

// ---------------------------------------------------------------------------
// Fitting a picture to a grid
// ---------------------------------------------------------------------------

/**
 * The ratio of a cell's width to its height, which for every monospace font
 * anyone runs a terminal in is about one to two. A picture given equal numbers
 * of columns and rows comes out twice as tall as it should be, which is what
 * this number is here to prevent.
 *
 * The real ratio belongs to the font and can only be had by asking the terminal
 * (CSI 14 t, CSI 16 t), whose answer arrives in the input stream Ink is
 * parsing — the same reason `q=2` is on every sequence above. So it is an
 * assumption, and `preserveAspectRatio` on the iTerm2 side softens it.
 */
export const DEFAULT_CELL_ASPECT = 0.5;

export interface CellBox {
  readonly columns: number;
  readonly rows: number;
}

/**
 * The largest box of cells, no bigger than `maxColumns` × `maxRows`, that holds
 * a `pixelWidth` × `pixelHeight` picture at its own aspect ratio.
 *
 * It always fills one of the two bounds — a small picture is scaled *up* rather
 * than drawn at its natural size, because natural size is measured in device
 * pixels and nothing here knows how many of those a cell is. The caller controls
 * that by passing a sensible box: a transcript row's width and a row budget
 * somewhere around a third of the viewport, not the whole screen.
 *
 * Dimensions that are not usable numbers produce a single cell. A picture whose
 * size could not be read is not one to hand the viewport to.
 */
export function fitCells(pixelWidth: number, pixelHeight: number, maxColumns: number, maxRows: number, cellAspect: number = DEFAULT_CELL_ASPECT): CellBox {
  const boxColumns = cells(maxColumns);
  const boxRows = cells(maxRows);
  if (!usable(pixelWidth) || !usable(pixelHeight)) return { columns: 1, rows: 1 };
  const aspect = usable(cellAspect) ? cellAspect : DEFAULT_CELL_ASPECT;

  // Widest first: a transcript is short of rows long before it is short of
  // columns, so the common case is one comparison and no second pass.
  let columns = boxColumns;
  let rows = Math.max(1, Math.round((columns * aspect * pixelHeight) / pixelWidth));
  if (rows > boxRows) {
    rows = boxRows;
    columns = Math.max(1, Math.min(boxColumns, Math.round((rows * pixelWidth) / (pixelHeight * aspect))));
  }
  return { columns, rows };
}

const usable = (value: number): boolean => Number.isFinite(value) && value > 0;

// ---------------------------------------------------------------------------
// Reading a PNG's header
// ---------------------------------------------------------------------------

/** Eight bytes every PNG starts with, and nothing else does. */
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** `IHDR`, in ASCII. It is always the first chunk, and its length is always 13. */
const IHDR_TYPE = Uint8Array.of(0x49, 0x48, 0x44, 0x52);
const IHDR_LENGTH = 13;

/** Signature, chunk length, chunk type, width, height: the least a header can be. */
const MIN_PNG_BYTES = 24;

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The picture's size in pixels, read from the IHDR chunk, or `null` for
 * anything that is not a PNG whose header says something.
 *
 * Both protocols can be handed a PNG without being told how big it is, but
 * neither can be told how many *cells* to use without someone having worked
 * that out — so this is the input to `fitCells`, and the whole reason it exists.
 * Only PNG: it is what the clipboard reader produces, what the browser surface
 * screenshots to, and the one format whose dimensions sit at a fixed offset
 * rather than behind a parser.
 *
 * The length field is checked as well as the type, because a file that begins
 * with the PNG signature and does not continue as a PNG is a file whose bytes
 * 16 to 23 mean something else entirely, and reporting those as a size would
 * send a picture of unknown provenance to the terminal at some arbitrary scale.
 */
export function pngDimensions(png: Uint8Array): PixelSize | null {
  if (png.length < MIN_PNG_BYTES) return null;
  if (!matches(png, PNG_SIGNATURE, 0)) return null;
  if (!matches(png, IHDR_TYPE, 12)) return null;
  if (be32(png, 8) !== IHDR_LENGTH) return null;
  const width = be32(png, 16);
  const height = be32(png, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function matches(bytes: Uint8Array, expected: Uint8Array, at: number): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[at + index] !== expected[index]) return false;
  }
  return true;
}

/**
 * A big-endian 32-bit integer. Multiplied rather than shifted for the top byte:
 * `<<` in JavaScript is a signed 32-bit operation, and a width past 2^31 would
 * come back negative.
 */
const be32 = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) * 0x1000000 + ((bytes[at + 1] ?? 0) << 16) + ((bytes[at + 2] ?? 0) << 8) + (bytes[at + 3] ?? 0);
