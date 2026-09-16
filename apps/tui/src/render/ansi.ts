/**
 * The handful of SGR codes the TUI styles text with.
 *
 * Ink's `<Text>` props cover most styling, but three places produce *strings*
 * rather than elements — the markdown renderer, the syntax highlighter and the
 * diff renderer — and a string can only carry style as escape codes. These are
 * the codes, named, so no other file spells the escape byte and the palette can
 * change in one place.
 *
 * Only the eight named colours, never a truecolor triple: a named colour is the
 * one kind of colour the reader's own terminal theme can restyle, and a
 * transcript that ignores the theme it is drawn into looks broken rather than
 * designed.
 *
 * Deliberately not a dependency: `chalk` is in the tree only as Ink's own
 * dependency, and under the isolated linker nothing here may import what it
 * did not declare. A dozen constants do not justify declaring one.
 *
 * The three functions at the foot are here for the same reason the constants
 * are — they are the only other code that has to know what an escape sequence
 * looks like. `hyperlink` writes an OSC 8 sequence, the one escape in the TUI
 * that is not SGR; `visibleWidth` and `cutVisible` measure and cut a string as
 * though none of this were in it, which is what a table needs to line a column
 * up under text that is already styled.
 */

const ESC = '\u001b';

/** OSC string terminator. `ESC \` is the standard one; BEL is the old habit. */
const ST = `${ESC}\\`;

export const RESET = `${ESC}[0m`;
export const BOLD = `${ESC}[1m`;
export const DIM = `${ESC}[2m`;
export const ITALIC = `${ESC}[3m`;
export const UNDERLINE = `${ESC}[4m`;
export const BOLD_OFF = `${ESC}[22m`;
/**
 * SGR 22 is "normal intensity" — one code turns off both bold and dim. Named
 * twice because the caller knows which of the two it is undoing, and a
 * `${DIM}…${BOLD_OFF}` pair reads like a mistake even when it is not.
 */
export const DIM_OFF = `${ESC}[22m`;
export const ITALIC_OFF = `${ESC}[23m`;
export const UNDERLINE_OFF = `${ESC}[24m`;
export const RED = `${ESC}[31m`;
export const GREEN = `${ESC}[32m`;
export const YELLOW = `${ESC}[33m`;
export const BLUE = `${ESC}[34m`;
export const MAGENTA = `${ESC}[35m`;
export const CYAN = `${ESC}[36m`;
export const FG_OFF = `${ESC}[39m`;

export const bold = (s: string): string => `${BOLD}${s}${BOLD_OFF}`;
export const dim = (s: string): string => `${DIM}${s}${RESET}`;
export const italic = (s: string): string => `${ITALIC}${s}${ITALIC_OFF}`;
export const red = (s: string): string => `${RED}${s}${FG_OFF}`;
export const green = (s: string): string => `${GREEN}${s}${FG_OFF}`;
export const yellow = (s: string): string => `${YELLOW}${s}${FG_OFF}`;
export const blue = (s: string): string => `${BLUE}${s}${FG_OFF}`;
export const magenta = (s: string): string => `${MAGENTA}${s}${FG_OFF}`;
export const cyan = (s: string): string => `${CYAN}${s}${FG_OFF}`;

/** An OSC 8 with no address, which is how a link is closed. */
const LINK_CLOSE = `${ESC}]8;;${ST}`;
const LINK_OPEN = `${ESC}]8;;`;
const EMPTY_LINK = /^\u001b\]8;;(?:\u0007|\u001b\\)$/;

/**
 * Text a capable terminal will make clickable, and every other terminal will
 * print as plain text — the sequence carries the address out of band, so a
 * terminal that does not understand OSC 8 shows the label and silently drops
 * the rest. Control characters are stripped from the address because an escape
 * byte inside the sequence would end it early and spill the URL onto the
 * screen.
 */
export function hyperlink(text: string, url: string): string {
  const safe = url.replace(/[\u0000-\u001f\u007f]/g, '');
  return `${ESC}]8;;${safe}${ST}${text}${LINK_CLOSE}`;
}

/** SGR runs, and OSC sequences terminated by either BEL or `ESC \`. */
const SGR = /\u001b\[[0-9;:]*m/g;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** One escape sequence at a fixed offset: CSI, OSC, or a lone two-byte escape. */
const ESCAPE_AT = /\u001b(?:\[[0-9;:]*[A-Za-z]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\s\S])/y;

/**
 * How many columns a styled string occupies. Escape sequences are zero-width,
 * and code points are counted rather than UTF-16 units, so an emoji counts
 * once. It does not know about East Asian double-width characters: a column
 * holding those comes out one narrow per character, which is a cosmetic fault
 * in a table and not worth a width table to fix.
 */
export function visibleWidth(text: string): number {
  return [...text.replace(OSC, '').replace(SGR, '')].length;
}

/**
 * Cut to `width` visible columns, passing escape sequences through whole — a
 * string cut in the middle of an escape prints the tail of it as text.
 * Anything actually cut is closed — with a reset, and with the end of a
 * hyperlink if one was still open — since the sequences that would have done
 * that may have been in the part removed.
 */
export function cutVisible(text: string, width: number): string {
  let out = '';
  let seen = 0;
  let styled = false;
  let linked = false;
  let i = 0;
  while (i < text.length) {
    ESCAPE_AT.lastIndex = i;
    const escape = ESCAPE_AT.exec(text);
    if (escape !== null) {
      out += escape[0];
      styled = true;
      // A hyperlink cut in half would swallow whatever came after it, so note
      // whether one is open and close it below if the cut lands inside.
      if (escape[0].startsWith(LINK_OPEN)) linked = !EMPTY_LINK.test(escape[0]);
      i = ESCAPE_AT.lastIndex;
      continue;
    }
    if (seen >= width) {
      return `${out}${linked ? LINK_CLOSE : ''}${styled ? RESET : ''}`;
    }
    const point = text.codePointAt(i);
    const char = point === undefined ? text.charAt(i) : String.fromCodePoint(point);
    out += char;
    seen += 1;
    i += char.length;
  }
  return out;
}
