/**
 * Pictures in the terminal, asserted as bytes.
 *
 * Everything in `images.ts` is a string a terminal will either understand or
 * print at the reader, and there is no middle outcome — a kitty sequence with
 * one key wrong is four thousand characters of base64 sprayed across the
 * transcript. So the tests here are exact sequences rather than shapes, and the
 * environment is always passed explicitly: the machine running the suite may
 * well be inside kitty or tmux, and a test that changes its mind depending on
 * the terminal it was started from is not a test.
 *
 * What these tests cannot tell anyone is whether a picture appeared. That needs
 * a person with the four terminals open; the header of `images.ts` lists the
 * four things they would have to check.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CELL_ASPECT,
  KITTY_CHUNK_BYTES,
  deleteKitty,
  encodeIterm2,
  encodeKitty,
  fitCells,
  imageProtocol,
  pngDimensions,
  type ImageProtocol,
} from './images.js';

const ESC = '\u001b';
const BEL = '\u0007';
/** The string terminator that closes a kitty APC. Base64 contains neither byte. */
const ST = `${ESC}\\`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Three bytes whose base64 is `AQID`, short enough to write a whole sequence out. */
const TINY = Uint8Array.of(1, 2, 3);

/** Deterministic bytes, so the base64 in a chunking test is the same every run. */
const bytes = (count: number): Uint8Array => Uint8Array.from({ length: count }, (_, index) => index % 251);

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function writeBe32(into: Uint8Array, at: number, value: number): void {
  into[at] = Math.floor(value / 0x1000000) & 0xff;
  into[at + 1] = (value >>> 16) & 0xff;
  into[at + 2] = (value >>> 8) & 0xff;
  into[at + 3] = value & 0xff;
}

/**
 * A PNG header built by hand: the signature, then the IHDR chunk's length, its
 * type, and the two dimensions. `length` and `type` are overridable so the
 * tests can build a file that starts like a PNG and is not one.
 */
function pngHeader(width: number, height: number, options: { readonly length?: number; readonly type?: string } = {}): Uint8Array {
  const file = new Uint8Array(33);
  file.set(PNG_SIGNATURE, 0);
  writeBe32(file, 8, options.length ?? 13);
  const type = options.type ?? 'IHDR';
  for (let index = 0; index < 4; index += 1) file[12 + index] = type.charCodeAt(index);
  writeBe32(file, 16, width);
  writeBe32(file, 20, height);
  file[24] = 8; // bit depth
  file[25] = 6; // colour type: RGBA
  return file;
}

interface KittySequence {
  readonly control: string;
  readonly payload: string;
}

/** Take an encoded run apart into its sequences, checking each one's frame as it goes. */
function kittySequences(encoded: string): readonly KittySequence[] {
  if (encoded.length === 0) return [];
  const parts = encoded.split(ST);
  // Every sequence ends with ST, so the split leaves one empty tail and no more.
  expect(parts.at(-1)).toBe('');
  return parts.slice(0, -1).map((part) => {
    expect(part.startsWith(`${ESC}_G`)).toBe(true);
    const body = part.slice(3);
    const semicolon = body.indexOf(';');
    expect(semicolon).toBeGreaterThan(-1);
    return { control: body.slice(0, semicolon), payload: body.slice(semicolon + 1) };
  });
}

// ---------------------------------------------------------------------------

describe('imageProtocol', () => {
  const terminals: readonly (readonly [string, NodeJS.ProcessEnv, ImageProtocol])[] = [
    ['kitty by its terminfo', { TERM: 'xterm-kitty' }, 'kitty'],
    ['kitty by its window id', { KITTY_WINDOW_ID: '1', TERM: 'xterm-256color' }, 'kitty'],
    ['WezTerm by its program', { TERM_PROGRAM: 'WezTerm' }, 'kitty'],
    ['WezTerm by its pane', { WEZTERM_PANE: '3' }, 'kitty'],
    ['WezTerm by its terminfo', { TERM: 'wezterm' }, 'kitty'],
    ['Ghostty by its program', { TERM_PROGRAM: 'ghostty' }, 'kitty'],
    ['Ghostty by its terminfo', { TERM: 'xterm-ghostty' }, 'kitty'],
    ['Ghostty by its resources directory', { GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty' }, 'kitty'],
    ['iTerm2 by its program', { TERM_PROGRAM: 'iTerm.app' }, 'iterm2'],
    ['iTerm2 over ssh, by the variable it forwards', { LC_TERMINAL: 'iTerm2', TERM: 'xterm-256color' }, 'iterm2'],
    ['the macOS Terminal', { TERM_PROGRAM: 'Apple_Terminal' }, 'none'],
    ['VS Code', { TERM_PROGRAM: 'vscode' }, 'none'],
    ['Windows Terminal', { WT_SESSION: 'x' }, 'none'],
    ['Alacritty', { TERM: 'alacritty', ALACRITTY_WINDOW_ID: '9' }, 'none'],
    ['a bare xterm', { TERM: 'xterm-256color' }, 'none'],
    ['a terminal that says nothing about itself', {}, 'none'],
  ];

  it.each(terminals)('draws in %s', (_name, env, expected) => {
    expect(imageProtocol(env)).toBe(expected);
  });

  it('reads the terminal name without caring how it was capitalised', () => {
    expect(imageProtocol({ TERM_PROGRAM: 'WEZTERM' })).toBe('kitty');
    expect(imageProtocol({ TERM_PROGRAM: 'Ghostty' })).toBe('kitty');
    expect(imageProtocol({ TERM_PROGRAM: 'iterm.app' })).toBe('iterm2');
    expect(imageProtocol({ LC_TERMINAL: 'iterm2' })).toBe('iterm2');
    expect(imageProtocol({ TERM: 'XTERM-KITTY' })).toBe('kitty');
  });

  it('prefers iTerm2 its own protocol, even though it also speaks some of kitty', () => {
    expect(imageProtocol({ TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' })).toBe('iterm2');
  });

  it('ignores the platform, because these protocols belong to the terminal and not the OS', () => {
    expect(imageProtocol({ TERM_PROGRAM: 'WezTerm' }, 'win32')).toBe('kitty');
    expect(imageProtocol({ TERM_PROGRAM: 'WezTerm' }, 'darwin')).toBe('kitty');
    expect(imageProtocol({ TERM: 'xterm-256color' }, 'darwin')).toBe('none');
  });

  describe('inside tmux', () => {
    const TMUX = { TMUX: '/tmp/tmux-1000/default,123,0' };

    it('draws nothing, whatever the outer terminal is', () => {
      expect(imageProtocol({ ...TMUX, TERM_PROGRAM: 'WezTerm' })).toBe('none');
      expect(imageProtocol({ ...TMUX, KITTY_WINDOW_ID: '1' })).toBe('none');
      expect(imageProtocol({ ...TMUX, TERM_PROGRAM: 'iTerm.app' })).toBe('none');
    });

    it('draws again when told to force it, using the variables tmux inherited', () => {
      expect(imageProtocol({ ...TMUX, KITTY_WINDOW_ID: '1', ARTEMIS_TUI_IMAGES: 'force' })).toBe('kitty');
      expect(imageProtocol({ ...TMUX, TERM_PROGRAM: 'iTerm.app', ARTEMIS_TUI_IMAGES: 'force' })).toBe('iterm2');
    });

    it('cannot force a protocol out of a terminal that announces none', () => {
      expect(imageProtocol({ ...TMUX, TERM: 'xterm-256color', ARTEMIS_TUI_IMAGES: 'force' })).toBe('none');
    });

    it('is not tmux when the variable is empty', () => {
      expect(imageProtocol({ TMUX: '', KITTY_WINDOW_ID: '1' })).toBe('kitty');
    });
  });

  describe('the switch', () => {
    it('switches pictures off outright', () => {
      expect(imageProtocol({ TERM: 'xterm-kitty', ARTEMIS_TUI_IMAGES: 'off' })).toBe('none');
      expect(imageProtocol({ TERM_PROGRAM: 'iTerm.app', ARTEMIS_TUI_IMAGES: 'off' })).toBe('none');
    });

    it('takes off in the spellings a person would reach for', () => {
      for (const value of ['off', 'OFF', '  Off  ', '0', 'false']) {
        expect(imageProtocol({ TERM: 'xterm-kitty', ARTEMIS_TUI_IMAGES: value })).toBe('none');
      }
    });

    it('names a protocol outright, for a terminal that identifies itself with nothing', () => {
      expect(imageProtocol({ TERM: 'xterm-256color', ARTEMIS_TUI_IMAGES: 'kitty' })).toBe('kitty');
      expect(imageProtocol({ TERM: 'xterm-256color', ARTEMIS_TUI_IMAGES: 'iterm2' })).toBe('iterm2');
      expect(imageProtocol({ TERM: 'xterm-256color', ARTEMIS_TUI_IMAGES: 'iterm' })).toBe('iterm2');
      expect(imageProtocol({ TERM: 'xterm-kitty', ARTEMIS_TUI_IMAGES: 'ITERM2' })).toBe('iterm2');
    });

    it('lets a named protocol through tmux as well, being the stronger statement', () => {
      expect(imageProtocol({ TMUX: '/tmp/tmux-1000/default,123,0', TERM: 'screen-256color', ARTEMIS_TUI_IMAGES: 'kitty' })).toBe('kitty');
    });

    it('ignores a value that means nothing, rather than guessing from it', () => {
      expect(imageProtocol({ TERM: 'xterm-kitty', ARTEMIS_TUI_IMAGES: 'sixel' })).toBe('kitty');
      expect(imageProtocol({ TERM: 'xterm-256color', ARTEMIS_TUI_IMAGES: 'yes' })).toBe('none');
    });
  });
});

// ---------------------------------------------------------------------------

describe('encodeKitty', () => {
  it('writes one sequence for a payload that fits in one', () => {
    expect(encodeKitty(TINY, { columns: 4, rows: 2 })).toBe(`${ESC}_Ga=T,f=100,t=d,c=4,r=2,q=2,m=0;AQID${ST}`);
  });

  it('carries the placement id when it is given one', () => {
    expect(encodeKitty(TINY, { columns: 4, rows: 2, id: 7 })).toBe(`${ESC}_Ga=T,f=100,t=d,c=4,r=2,i=7,q=2,m=0;AQID${ST}`);
  });

  it('suppresses the terminal reply on every sequence, including the continuations', () => {
    const single = encodeKitty(TINY, { columns: 1, rows: 1 });

    expect(single).toContain('q=2');
    // The continuations carry `m` alone, which is what keeps the reply
    // suppressed for the transmission as a whole rather than per chunk.
    for (const sequence of kittySequences(encodeKitty(bytes(10_000), { columns: 20, rows: 10 })).slice(1)) {
      expect(sequence.control).toMatch(/^m=[01]$/);
    }
  });

  it('cuts the base64 into 4096-byte chunks, keys on the first and m on the rest', () => {
    const png = bytes(10_000);
    const sequences = kittySequences(encodeKitty(png, { columns: 20, rows: 10, id: 3 }));

    // 10000 bytes is 13336 characters of base64: three full chunks and a tail.
    expect(sequences).toHaveLength(4);
    expect(sequences[0]?.control).toBe('a=T,f=100,t=d,c=20,r=10,i=3,q=2,m=1');
    expect(sequences[1]?.control).toBe('m=1');
    expect(sequences[2]?.control).toBe('m=1');
    expect(sequences[3]?.control).toBe('m=0');
  });

  it('sends every byte of the payload exactly once, in order', () => {
    const png = bytes(10_000);
    const sequences = kittySequences(encodeKitty(png, { columns: 20, rows: 10 }));

    expect(sequences.map((sequence) => sequence.payload).join('')).toBe(Buffer.from(png).toString('base64'));
    expect(sequences.slice(0, -1).map((sequence) => sequence.payload.length)).toEqual([KITTY_CHUNK_BYTES, KITTY_CHUNK_BYTES, KITTY_CHUNK_BYTES]);
    expect(sequences.at(-1)?.payload.length).toBe(13_336 - 3 * KITTY_CHUNK_BYTES);
  });

  it('does not add an empty final chunk when the base64 lands exactly on the boundary', () => {
    // 3072 bytes is 4096 characters of base64, to the character.
    const sequences = kittySequences(encodeKitty(bytes(3072), { columns: 8, rows: 4 }));

    expect(sequences).toHaveLength(1);
    expect(sequences[0]?.payload).toHaveLength(KITTY_CHUNK_BYTES);
    expect(sequences[0]?.control.endsWith(',m=0')).toBe(true);
  });

  it('starts a second chunk for the one byte past the boundary', () => {
    const sequences = kittySequences(encodeKitty(bytes(3073), { columns: 8, rows: 4 }));

    expect(sequences).toHaveLength(2);
    expect(sequences[0]?.control.endsWith(',m=1')).toBe(true);
    expect(sequences[1]).toEqual({ control: 'm=0', payload: 'PA==' });
  });

  it('never emits a cell count a terminal would reject', () => {
    expect(encodeKitty(TINY, { columns: 0, rows: 0 })).toContain('c=1,r=1,');
    expect(encodeKitty(TINY, { columns: -4, rows: -2 })).toContain('c=1,r=1,');
    expect(encodeKitty(TINY, { columns: Number.NaN, rows: Number.POSITIVE_INFINITY })).toContain('c=1,r=1,');
    expect(encodeKitty(TINY, { columns: 12.9, rows: 3.1 })).toContain('c=12,r=3,');
  });

  it('leaves the id out rather than sending one kitty would refuse', () => {
    for (const id of [0, -1, Number.NaN, 4_294_967_296, 0.5]) {
      expect(encodeKitty(TINY, { columns: 4, rows: 2, id })).not.toContain('i=');
    }
    expect(encodeKitty(TINY, { columns: 4, rows: 2, id: 4_294_967_295 })).toContain('i=4294967295,');
  });

  it('writes nothing for an empty buffer', () => {
    expect(encodeKitty(new Uint8Array(0), { columns: 4, rows: 2, id: 1 })).toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('deleteKitty', () => {
  it('deletes the placement by id', () => {
    expect(deleteKitty(7)).toBe(`${ESC}_Ga=d,d=i,i=7,q=2${ST}`);
  });

  it('writes nothing for an id kitty would not accept', () => {
    for (const id of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 4_294_967_296]) {
      expect(deleteKitty(id)).toBe('');
    }
  });

  it('names the same id the placement used', () => {
    expect(deleteKitty(42)).toBe(`${ESC}_Ga=d,d=i,i=42,q=2${ST}`);
    expect(encodeKitty(TINY, { columns: 1, rows: 1, id: 42 })).toContain('i=42,');
  });
});

// ---------------------------------------------------------------------------

describe('encodeIterm2', () => {
  it('writes the whole file in one OSC 1337', () => {
    expect(encodeIterm2(TINY, { columns: 4, rows: 2 })).toBe(`${ESC}]1337;File=inline=1;size=3;width=4;height=2;preserveAspectRatio=1:AQID${BEL}`);
  });

  it('carries the name base64, after the rest of the header', () => {
    expect(encodeIterm2(TINY, { columns: 4, rows: 2, name: 'shot.png' })).toBe(
      `${ESC}]1337;File=inline=1;size=3;width=4;height=2;preserveAspectRatio=1;name=c2hvdC5wbmc=:AQID${BEL}`,
    );
  });

  it('carries a name that is not ASCII, which is why the name is base64 at all', () => {
    expect(encodeIterm2(TINY, { columns: 1, rows: 1, name: 'screenshot — café.png' })).toContain(';name=c2NyZWVuc2hvdCDigJQgY2Fmw6kucG5n:');
  });

  it('leaves the name out when there is not one', () => {
    expect(encodeIterm2(TINY, { columns: 1, rows: 1, name: '' })).not.toContain('name=');
    expect(encodeIterm2(TINY, { columns: 1, rows: 1 })).not.toContain('name=');
  });

  it('sizes the header in decoded bytes, not in base64 characters', () => {
    const png = bytes(300);

    expect(encodeIterm2(png, { columns: 10, rows: 5 })).toContain('size=300;');
    expect(encodeIterm2(png, { columns: 10, rows: 5 })).toContain(Buffer.from(png).toString('base64'));
  });

  it('never emits a cell count a terminal would reject', () => {
    expect(encodeIterm2(TINY, { columns: 0, rows: -3 })).toContain('width=1;height=1;');
    expect(encodeIterm2(TINY, { columns: Number.NaN, rows: 7.8 })).toContain('width=1;height=7;');
  });

  it('writes nothing for an empty buffer', () => {
    expect(encodeIterm2(new Uint8Array(0), { columns: 4, rows: 2 })).toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('fitCells', () => {
  it('assumes a cell twice as tall as it is wide', () => {
    expect(DEFAULT_CELL_ASPECT).toBe(0.5);
    // A square picture in a box with room to spare is half as many rows as columns.
    expect(fitCells(100, 100, 40, 40)).toEqual({ columns: 40, rows: 20 });
  });

  it('fills the width for a landscape picture', () => {
    // 4:3 across 40 columns: 40 cells wide is 80 half-cells, so 30 tall is 15 rows.
    expect(fitCells(800, 600, 40, 30)).toEqual({ columns: 40, rows: 15 });
    expect(fitCells(1920, 1080, 80, 40)).toEqual({ columns: 80, rows: 23 });
  });

  it('falls back to the rows when the height is what runs out', () => {
    expect(fitCells(600, 800, 40, 20)).toEqual({ columns: 30, rows: 20 });
    expect(fitCells(1080, 1920, 80, 20)).toEqual({ columns: 23, rows: 20 });
  });

  it('never returns a box larger than it was given, at any shape', () => {
    for (const [width, height] of [
      [1, 4000],
      [4000, 1],
      [16, 16],
      [1440, 900],
      [3, 7],
    ]) {
      const box = fitCells(width ?? 1, height ?? 1, 37, 11);

      expect(box.columns).toBeLessThanOrEqual(37);
      expect(box.rows).toBeLessThanOrEqual(11);
      expect(box.columns).toBeGreaterThanOrEqual(1);
      expect(box.rows).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps the aspect ratio it was given, when the cells are square', () => {
    expect(fitCells(800, 600, 40, 40, 1)).toEqual({ columns: 40, rows: 30 });
    expect(fitCells(100, 100, 40, 40, 1)).toEqual({ columns: 40, rows: 40 });
  });

  it('scales a small picture up, because a cell has no knowable pixel size', () => {
    expect(fitCells(16, 16, 40, 40)).toEqual({ columns: 40, rows: 20 });
  });

  it('gives one cell to a picture whose size could not be read', () => {
    expect(fitCells(0, 0, 40, 20)).toEqual({ columns: 1, rows: 1 });
    expect(fitCells(Number.NaN, 100, 40, 20)).toEqual({ columns: 1, rows: 1 });
    expect(fitCells(100, Number.POSITIVE_INFINITY, 40, 20)).toEqual({ columns: 1, rows: 1 });
    expect(fitCells(-100, -100, 40, 20)).toEqual({ columns: 1, rows: 1 });
  });

  it('treats a box that is not a box as one cell of room', () => {
    expect(fitCells(800, 600, 0, 0)).toEqual({ columns: 1, rows: 1 });
    expect(fitCells(800, 600, Number.NaN, Number.NaN)).toEqual({ columns: 1, rows: 1 });
  });

  it('falls back to the default rather than dividing by a nonsense cell aspect', () => {
    expect(fitCells(100, 100, 40, 40, 0)).toEqual({ columns: 40, rows: 20 });
    expect(fitCells(100, 100, 40, 40, Number.NaN)).toEqual({ columns: 40, rows: 20 });
  });
});

// ---------------------------------------------------------------------------

describe('pngDimensions', () => {
  it('reads the size out of the IHDR chunk', () => {
    expect(pngDimensions(pngHeader(1440, 900))).toEqual({ width: 1440, height: 900 });
    expect(pngDimensions(pngHeader(1, 1))).toEqual({ width: 1, height: 1 });
  });

  it('reads a width past the sign bit, which a shift would have made negative', () => {
    expect(pngDimensions(pngHeader(0x8000_0010, 0xffff_ffff))).toEqual({ width: 0x8000_0010, height: 0xffff_ffff });
  });

  it('reads a header with the rest of the file after it', () => {
    const header = pngHeader(64, 32);
    const file = new Uint8Array(header.length + 500);
    file.set(header, 0);

    expect(pngDimensions(file)).toEqual({ width: 64, height: 32 });
  });

  it('reads a header that is a view into a larger buffer', () => {
    const padded = new Uint8Array(40);
    padded.set(pngHeader(8, 4), 7);

    expect(pngDimensions(padded.subarray(7))).toEqual({ width: 8, height: 4 });
  });

  it('is null for something that is not a PNG', () => {
    expect(pngDimensions(new Uint8Array(0))).toBeNull();
    expect(pngDimensions(Uint8Array.from(Buffer.from('not an image at all, just words', 'utf8')))).toBeNull();
    // A JPEG, which the clipboard could hand us if the extension lied.
    expect(pngDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(30).fill(0)]))).toBeNull();
  });

  it('is null for a file too short to hold a header', () => {
    expect(pngDimensions(pngHeader(10, 10).subarray(0, 23))).toBeNull();
    expect(pngDimensions(PNG_SIGNATURE)).toBeNull();
  });

  it('is null when the signature is right and the chunk after it is not IHDR', () => {
    expect(pngDimensions(pngHeader(10, 10, { type: 'IDAT' }))).toBeNull();
  });

  it('is null when the IHDR length is not the 13 the format fixes it at', () => {
    expect(pngDimensions(pngHeader(10, 10, { length: 12 }))).toBeNull();
    expect(pngDimensions(pngHeader(10, 10, { length: 0 }))).toBeNull();
  });

  it('is null for a header that claims no pixels', () => {
    expect(pngDimensions(pngHeader(0, 100))).toBeNull();
    expect(pngDimensions(pngHeader(100, 0))).toBeNull();
  });

  it('is the input fitCells wants', () => {
    const size = pngDimensions(pngHeader(1200, 800));
    if (size === null) throw new Error('fixture is not a PNG');

    expect(fitCells(size.width, size.height, 60, 40)).toEqual({ columns: 60, rows: 20 });
  });
});
