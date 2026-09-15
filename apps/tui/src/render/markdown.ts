/**
 * Markdown, for a terminal.
 *
 * The assistant writes markdown; a terminal draws characters. This is the
 * smallest translation that reads well: headings bold, emphasis as the
 * terminal's own bold and italic, code in a colour, fenced blocks set off with
 * a gutter and syntax-coloured, bullets normalised to one glyph, tables drawn
 * as tables, links clickable where the terminal can do it. It is not a markdown
 * parser and does not try to be one — nested structures keep their indentation
 * and nothing more.
 *
 * Why hand-rolled: the desktop's `Markdown.tsx` is `react-markdown` over a DOM,
 * and the terminal libraries that render markdown pull in a highlighter and a
 * parser to do what forty lines of regex do adequately for a transcript.
 *
 * Streaming is the constraint that shapes the code. Text arrives a token at a
 * time and is re-rendered whole on every frame, so this must be cheap, must
 * never throw on a half-written construct — an unclosed fence, a `**` with no
 * partner — and must produce output that does not jump around as the closing
 * marker arrives. Line-based processing with inline rules that leave an
 * unmatched marker alone gives all three, and the three things added since had
 * to fit inside it:
 *
 * - The highlighter (`highlight.ts`) colours one line at a time and carries
 *   what it left open — a block comment, a template string — to the next.
 * - A table is the one construct here that has to see more than one line, and
 *   it is gated on the `|---|` separator. Until that arrives its rows are
 *   drawn as the source text they are, so a half-arrived table never appears
 *   as a lopsided box that then rearranges itself.
 * - Hyperlinks depend on the terminal, so support is sniffed from the
 *   environment once and can be forced either way for a test. Where they are
 *   not supported the address is printed beside the text, as it always was.
 */

import {
  BOLD,
  BOLD_OFF,
  CYAN,
  DIM,
  FG_OFF,
  ITALIC,
  ITALIC_OFF,
  RESET,
  UNDERLINE,
  UNDERLINE_OFF,
  cutVisible,
  hyperlink,
  visibleWidth,
} from './ansi.js';
import { HIGHLIGHT_START, highlightLine, type HighlightState } from './highlight.js';

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** How wide a table column may grow before its cells are cut. */
const MAX_COLUMN = 40;

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface MarkdownOptions {
  /**
   * Emit OSC 8 hyperlinks. Defaults to whether `env` names a terminal known to
   * support them; a terminal that does not would print the escape sequence as
   * visible rubbish, so the default is off for anything unrecognised.
   */
  readonly hyperlinks?: boolean;
  /** The environment to sniff. Defaults to `process.env`; a test passes its own. */
  readonly env?: NodeJS.ProcessEnv;
  /** How wide a table column may grow before its cells are cut. */
  readonly maxColumnWidth?: number;
}

/**
 * Terminals known to draw OSC 8. There is no capability query for this — no
 * terminfo entry, nothing to ask — so the only honest implementation is a list
 * of the ones that do, recognised by whatever each announces itself with.
 */
function terminalLinks(env: NodeJS.ProcessEnv): boolean {
  const term = (env['TERM'] ?? '').toLowerCase();
  if (term === 'dumb') return false;

  const program = (env['TERM_PROGRAM'] ?? '').toLowerCase();
  if (program === 'iterm.app' || program === 'wezterm' || program === 'ghostty') return true;
  if (term === 'xterm-kitty' || term === 'xterm-ghostty' || term === 'alacritty') return true;
  if (term === 'wezterm' || term === 'foot' || term.startsWith('foot-')) return true;

  if (
    env['KITTY_WINDOW_ID'] !== undefined ||
    env['WEZTERM_PANE'] !== undefined ||
    env['GHOSTTY_RESOURCES_DIR'] !== undefined ||
    env['ALACRITTY_WINDOW_ID'] !== undefined ||
    // Windows Terminal, which announces itself with nothing else.
    env['WT_SESSION'] !== undefined
  ) {
    return true;
  }

  // GNOME Terminal and the rest of the VTE family, from 0.50 on.
  const vte = Number.parseInt(env['VTE_VERSION'] ?? '', 10);
  return Number.isFinite(vte) && vte >= 5000;
}

/** Sniffing the real environment is worth doing once, not once per frame. */
let sniffed: boolean | null = null;

function hyperlinksOn(options: MarkdownOptions | undefined): boolean {
  if (options?.hyperlinks !== undefined) return options.hyperlinks;
  if (options?.env !== undefined) return terminalLinks(options.env);
  sniffed ??= terminalLinks(process.env);
  return sniffed;
}

interface InlineContext {
  readonly hyperlinks: boolean;
}

/* -------------------------------------------------------------------------- */
/* Inline                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The three things worth making clickable, in the order they must be tried:
 * a markdown link first, then a bare URL, then something with the shape of a
 * file and a line number. They are matched in one pass so that a URL's
 * underscores and asterisks are never read as emphasis — the address is lifted
 * out of the text before the emphasis rules ever see it.
 */
const LINKISH = new RegExp(
  [
    /\[(?<label>[^\][\n]+)\]\((?<href>[^()\s]+)\)/,
    /(?<bare>https?:\/\/[^\s<>()[\]`"']+)/,
    /(?<path>(?:\.{0,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]*\.[A-Za-z][\w+]*(?::\d+(?::\d+)?)?)/,
  ]
    .map((part) => part.source)
    .join('|'),
  'g',
);

/** Sentence punctuation that follows a URL rather than belonging to it. */
const TRAILING = /[.,;:!?]+$/;

function linked(label: string, url: string, ctx: InlineContext, address: boolean): string {
  if (ctx.hyperlinks) return hyperlink(`${UNDERLINE}${label}${UNDERLINE_OFF}`, url);
  return address ? `${UNDERLINE}${label}${UNDERLINE_OFF} ${DIM}${url}${RESET}` : label;
}

function renderLinkish(match: RegExpMatchArray, ctx: InlineContext): string {
  const groups: Partial<Record<string, string>> = match.groups ?? {};
  const label = groups['label'];
  const href = groups['href'];
  // Only a markdown link keeps its address printed beside it when the terminal
  // cannot make it clickable; the other two forms already *are* the address.
  if (label !== undefined && href !== undefined) return linked(label, href, ctx, true);

  const bare = groups['bare'];
  if (bare !== undefined) {
    const url = bare.replace(TRAILING, '');
    return `${linked(url, url, ctx, false)}${bare.slice(url.length)}`;
  }

  // A relative path is left as it was written: there is no telling what it is
  // relative *to* from here, and a link to the wrong file is worse than none.
  const path = groups['path'] ?? match[0] ?? '';
  if (!path.startsWith('/')) return path;
  return linked(path, `file://${path.replace(/:\d+(?::\d+)?$/, '')}`, ctx, false);
}

function emphasis(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${BOLD_OFF}`)
    .replace(/__(.+?)__/g, `${BOLD}$1${BOLD_OFF}`)
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, `$1${ITALIC}$2${ITALIC_OFF}`)
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, `$1${ITALIC}$2${ITALIC_OFF}`);
}

/**
 * Inline emphasis. Code spans are split out first and the rest never looks
 * inside them — a `**` inside backticks is a literal. Addresses are split out
 * second, for the same reason.
 */
function inline(text: string, ctx: InlineContext): string {
  const parts = text.split(/(`+[^`]*`+)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        const code = part.replace(/^`+|`+$/g, '');
        return `${CYAN}${code}${FG_OFF}`;
      }
      let out = '';
      let last = 0;
      for (const match of part.matchAll(LINKISH)) {
        const at = match.index ?? 0;
        out += emphasis(part.slice(last, at));
        out += renderLinkish(match, ctx);
        last = at + (match[0]?.length ?? 0);
      }
      return out + emphasis(part.slice(last));
    })
    .join('');
}

/* -------------------------------------------------------------------------- */
/* Lines                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One rendered line: what hangs in the margin — a bullet, a number, a quote
 * bar, a fence gutter — and the text beside it. A terminal wraps a long line
 * back to column zero, under the bullet; a renderer that keeps the two apart
 * can wrap the text under itself instead, which is what makes a list read as
 * a list. `hang` is the prefix's visible width, so the caller need not
 * measure through the escape codes.
 */
export interface MarkdownLine {
  readonly prefix: string;
  readonly hang: number;
  readonly body: string;
}

const line = (body: string, prefix = '', hang = 0): MarkdownLine => ({ prefix, hang, body });

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

type Align = 'left' | 'centre' | 'right';

const TABLE_ROW = /^\s*\|/;
const DASHES = /^:?-+:?$/;

/**
 * The cells of one row. A leading and trailing pipe are furniture; a `\|` is a
 * pipe inside a cell and not a wall.
 */
function cells(row: string): readonly string[] {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

/** `|---|:--:|` — the line that turns the rows above and below it into a table. */
function isSeparator(text: string): boolean {
  if (!TABLE_ROW.test(text)) return false;
  const parts = cells(text);
  return parts.length > 0 && parts.every((cell) => DASHES.test(cell));
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'centre';
  return right ? 'right' : 'left';
}

function pad(cell: string, width: number, align: Align): string {
  const gap = width - visibleWidth(cell);
  if (gap <= 0) return cell;
  if (align === 'right') return `${' '.repeat(gap)}${cell}`;
  if (align === 'centre') {
    const left = Math.floor(gap / 2);
    return `${' '.repeat(left)}${cell}${' '.repeat(gap - left)}`;
  }
  return `${cell}${' '.repeat(gap)}`;
}

/** Cut a cell that would push its column too wide, marking where it was cut. */
function fit(cell: string, max: number): string {
  return visibleWidth(cell) <= max ? cell : `${cutVisible(cell, Math.max(0, max - 1))}…`;
}

/**
 * The table, drawn. Column widths come from the widest cell in each column,
 * measured through the escape codes the inline rules have already put there.
 * There is no outer border: a transcript is a column of text and a box around
 * a table would fight the rest of it, so only the walls that separate columns
 * are drawn.
 */
function renderTable(
  rows: readonly string[],
  aligns: readonly Align[],
  ctx: InlineContext,
  max: number,
): readonly MarkdownLine[] {
  const grid = rows.map((row) => cells(row));
  const columns = grid.reduce((widest, row) => Math.max(widest, row.length), 0);
  if (columns === 0) return [];

  // Rows are padded out rather than trimmed to the header's width: a cell the
  // author wrote is worth showing even when the header forgot to make room.
  const drawn = grid.map((row) =>
    Array.from({ length: columns }, (_, column) => fit(inline(row[column] ?? '', ctx), max)),
  );
  const widths = Array.from({ length: columns }, (_, column) =>
    drawn.reduce((widest, row) => Math.max(widest, visibleWidth(row[column] ?? '')), 0),
  );

  const wall = ` ${DIM}│${RESET} `;
  const row = (values: readonly string[]): string =>
    values
      .map((cell, column) => pad(cell, widths[column] ?? 0, aligns[column] ?? 'left'))
      .join(wall)
      // Padding on the last column is width nothing sits in, and a line that
      // runs to the edge of the terminal in spaces wraps for no reason.
      .replace(/ +$/, '');

  const head = drawn[0] ?? [];
  const out: MarkdownLine[] = [
    line(row(head.map((cell) => (cell.length === 0 ? cell : `${BOLD}${cell}${BOLD_OFF}`)))),
    line(`${DIM}${widths.map((width) => '─'.repeat(width)).join('─┼─')}${RESET}`),
  ];
  for (const body of drawn.slice(1)) out.push(line(row(body)));
  return out;
}

/** The rendered markdown as one string, lines joined. */
export function renderMarkdown(source: string, options?: MarkdownOptions): string {
  return renderMarkdownLines(source, options)
    .map((entry) => entry.prefix + entry.body)
    .join('\n');
}

export function renderMarkdownLines(
  source: string,
  options?: MarkdownOptions,
): readonly MarkdownLine[] {
  const ctx: InlineContext = { hyperlinks: hyperlinksOn(options) };
  const maxColumn = options?.maxColumnWidth ?? MAX_COLUMN;
  const out: MarkdownLine[] = [];
  const lines = source.split('\n').map((raw) => raw.replace(/\r$/, ''));

  let fence: string | null = null;
  let lang = '';
  let code: HighlightState = HIGHLIGHT_START;

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? '';

    if (fence !== null) {
      if (FENCE.test(text) && text.trim().startsWith(fence)) {
        fence = null;
        code = HIGHLIGHT_START;
        continue;
      }
      const painted = highlightLine(text, lang, code);
      code = painted.state;
      out.push(line(painted.text, `${DIM}│${RESET} `, 2));
      continue;
    }

    const open = FENCE.exec(text);
    if (open !== null) {
      fence = open[1] ?? '```';
      lang = open[2] ?? '';
      code = HIGHLIGHT_START;
      out.push(line(`${DIM}│${lang.length > 0 ? ` ${lang}` : ''}${RESET}`));
      continue;
    }

    // A table, but only once the separator has arrived. Before that the rows
    // are ordinary lines and are drawn as the source they are.
    if (TABLE_ROW.test(text) && isSeparator(lines[i + 1] ?? '')) {
      const aligns = cells(lines[i + 1] ?? '').map(alignOf);
      const rows = [text];
      let end = i + 2;
      while (end < lines.length && TABLE_ROW.test(lines[end] ?? '')) {
        rows.push(lines[end] ?? '');
        end += 1;
      }
      out.push(...renderTable(rows, aligns, ctx, maxColumn));
      i = end - 1;
      continue;
    }

    if (RULE.test(text)) {
      out.push(line(`${DIM}${'─'.repeat(24)}${RESET}`));
      continue;
    }

    const heading = HEADING.exec(text);
    if (heading !== null) {
      const inner = inline(heading[2] ?? '', ctx);
      out.push(
        line(
          (heading[1]?.length ?? 2) === 1
            ? `${BOLD}${UNDERLINE}${inner}${UNDERLINE_OFF}${BOLD_OFF}`
            : `${BOLD}${inner}${BOLD_OFF}`,
        ),
      );
      continue;
    }

    const bullet = BULLET.exec(text);
    if (bullet !== null) {
      const indent = bullet[1] ?? '';
      out.push(
        line(inline(bullet[2] ?? '', ctx), `${indent}${DIM}•${RESET} `, indent.length + 2),
      );
      continue;
    }

    const ordered = ORDERED.exec(text);
    if (ordered !== null) {
      const indent = ordered[1] ?? '';
      const number = `${ordered[2] ?? ''}.`;
      out.push(
        line(
          inline(ordered[3] ?? '', ctx),
          `${indent}${DIM}${number}${RESET} `,
          indent.length + number.length + 1,
        ),
      );
      continue;
    }

    const quote = QUOTE.exec(text);
    if (quote !== null) {
      out.push(line(`${inline(quote[1] ?? '', ctx)}${RESET}`, `${DIM}▎ `, 2));
      continue;
    }

    out.push(line(inline(text, ctx)));
  }

  return out;
}
