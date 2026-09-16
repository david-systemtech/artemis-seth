/**
 * Syntax colour for fenced code, one line at a time.
 *
 * The markdown renderer is line-based because the text it draws is still
 * arriving: a fenced block is re-rendered on every frame and its last line is
 * usually half-written. A highlighter that needed the whole block before it
 * could colour any of it would either leave the block grey until the closing
 * fence landed or re-lex it from the top on every token. So this colours one
 * line and hands back the little that carries over — whether the line left a
 * block comment or a multi-line string open — for the next line to start from.
 * Pass `HIGHLIGHT_START` for the first line of a block and thread the returned
 * state through the rest.
 *
 * It is a lexer, not a parser. It knows quotes, comments, numbers and a list of
 * words per language, and nothing about scope, types or syntax errors. That is
 * the whole trade: a fraction of the cost of a real highlighter, and a failure
 * shows up as a word in the wrong weight rather than as a crash. Nothing here
 * throws. An unterminated single-line string runs to the end of the line and
 * stops there; an unclosed block comment simply continues onto the next line,
 * which is also what the author will see in their editor.
 *
 * The palette is the terminal's own: keywords bold, strings green, numbers
 * cyan, comments dim italic, shell variables magenta, shell flags blue.
 * Capitalised identifiers are a named class drawn in the default foreground —
 * a type is worth recognising and worth *not* painting, because a code block
 * with six colours in it reads as decoration rather than as code. Punctuation
 * is left alone for the same reason.
 *
 * Two kinds of "unknown". A language this does not have a grammar for gets the
 * shape every language shares — strings, comments, numbers — because guessing
 * those is nearly always right. A language whose highlighting would be
 * actively wrong gets nothing at all: a `markdown` fence inside a fence is
 * prose, a `diff` carries its own marks, and a block with no language on it is
 * as likely to be output as it is to be code.
 */

import {
  BLUE,
  BOLD,
  BOLD_OFF,
  CYAN,
  DIM,
  DIM_OFF,
  FG_OFF,
  GREEN,
  ITALIC,
  ITALIC_OFF,
  MAGENTA,
} from './ansi.js';

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

type TokenClass =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'type'
  | 'variable'
  | 'flag'
  | 'plain';

/**
 * The one place a token class turns into colour. `type` and `plain` are the
 * default foreground on purpose; they are listed so the decision is visible
 * here rather than implied by their absence.
 */
const STYLE: Readonly<Record<TokenClass, (s: string) => string>> = {
  keyword: (s) => `${BOLD}${s}${BOLD_OFF}`,
  string: (s) => `${GREEN}${s}${FG_OFF}`,
  number: (s) => `${CYAN}${s}${FG_OFF}`,
  comment: (s) => `${DIM}${ITALIC}${s}${ITALIC_OFF}${DIM_OFF}`,
  variable: (s) => `${MAGENTA}${s}${FG_OFF}`,
  flag: (s) => `${BLUE}${s}${FG_OFF}`,
  type: (s) => s,
  plain: (s) => s,
};

/* -------------------------------------------------------------------------- */
/* Grammars                                                                   */
/* -------------------------------------------------------------------------- */

interface Grammar {
  readonly keywords: ReadonlySet<string>;
  /** Markers that comment out the rest of the line. */
  readonly line: readonly string[];
  /** Open and close of a comment that may cross lines. */
  readonly block: readonly [string, string] | null;
  /** Quote characters for strings that end with the line if unterminated. */
  readonly quotes: readonly string[];
  /** Delimiters for strings that may cross lines, longest first. */
  readonly spans: readonly string[];
  readonly numbers: boolean;
  /** `$name`, `${name}` — shell. */
  readonly sigil: boolean;
  /** `-x`, `--long` — shell. */
  readonly flags: boolean;
  /** A key at the head of the line, captured as indent, key, colon — YAML. */
  readonly keys: RegExp | null;
}

const BASE: Grammar = {
  keywords: new Set<string>(),
  line: [],
  block: null,
  quotes: [],
  spans: [],
  numbers: true,
  sigil: false,
  flags: false,
  keys: null,
};

const words = (list: string): ReadonlySet<string> =>
  new Set(list.split(/\s+/).filter((word) => word.length > 0));

/**
 * The control flow every language in the C family spells the same way. Each
 * language adds its own on top, so `fn` is a keyword in Rust and not in Java,
 * and the reader's eye is not trained on a word their language does not have.
 */
const C_SHARED = 'break case continue default do else for if return switch while';

const cLike = (extra: string, spans: readonly string[] = []): Grammar => ({
  ...BASE,
  keywords: words(`${C_SHARED} ${extra}`),
  line: ['//'],
  block: ['/*', '*/'],
  quotes: ['"', "'"],
  spans,
});

/** Backtick strings run to a closing backtick however many lines later. */
const BACKTICK: readonly string[] = ['`'];

const TS = cLike(
  `as async await catch class const constructor debugger declare delete enum export extends
   false finally from function get implements import in infer instanceof interface keyof let
   namespace new null of private protected public readonly satisfies set static super
   this throw true try type typeof undefined var void yield`,
  BACKTICK,
);

const GO = cLike(
  `append cap chan close const copy defer delete else fallthrough false float64 func go
   iota import int interface len make map new nil package panic print println range recover
   select string struct true type var`,
  BACKTICK,
);

const RUST = cLike(
  `as async await const crate dyn enum extern false fn impl in let loop match mod move mut
   pub ref self Self static struct super trait true type unsafe use where`,
);

const JAVA = cLike(
  `abstract assert boolean byte char class const double extends final finally float
   implements import instanceof int interface long native new null package private
   protected public record short static strictfp super synchronized this throw throws
   transient true false try var void volatile`,
);

const C = cLike(
  `auto char const double extern float goto inline int long register restrict short signed
   sizeof static struct typedef union unsigned void volatile NULL`,
);

const CPP = cLike(
  `auto bool catch char class const constexpr decltype delete double explicit extern false
   float friend inline int long namespace new noexcept nullptr operator private protected
   public short signed sizeof static struct template this throw true try typedef typename
   union unsigned using virtual void volatile`,
);

const SWIFT = cLike(
  `as associatedtype async await catch class defer deinit enum extension fileprivate final
   fingerprint func guard import in init inout internal is let mutating nil open operator
   private protocol public repeat self Self static struct subscript super throw throws true
   false try typealias var weak where`,
);

const KOTLIN = cLike(
  `as by catch class companion const constructor crossinline data enum external false final
   finally fun get if import in infix init inner interface internal is lateinit null object
   open operator out override package private protected public reified sealed set super
   suspend tailrec this throw true try typealias val var vararg when where`,
);

const CSHARP = cLike(
  `abstract as async await base bool byte catch char checked class const decimal delegate
   double enum event explicit extern false finally fixed float foreach get global goto
   implicit in int interface internal is lock long namespace new null object operator out
   override params private protected public readonly record ref sbyte sealed set short
   sizeof stackalloc static string struct this throw true try typeof uint ulong unchecked
   unsafe ushort using var virtual void volatile where yield`,
);

const PYTHON: Grammar = {
  ...BASE,
  keywords: words(
    `and as assert async await break class continue def del elif else except False finally
     for from global if import in is lambda None nonlocal not or pass raise return self
     True try while with yield`,
  ),
  line: ['#'],
  quotes: ['"', "'"],
  spans: ['"""', "'''"],
};

const SHELL: Grammar = {
  ...BASE,
  keywords: words(
    `case cd do done elif else esac exec exit export fi for function if in local read
     readonly return set shift source then trap unset until while`,
  ),
  line: ['#'],
  quotes: ['"', "'"],
  sigil: true,
  flags: true,
};

const JSON_: Grammar = {
  ...BASE,
  keywords: words('true false null'),
  // A `//` can only appear inside a string in strict JSON, where the string
  // rule has already claimed it — so allowing it costs nothing and JSONC,
  // which the tooling world writes everywhere, comes out right.
  line: ['//'],
  block: ['/*', '*/'],
  quotes: ['"'],
};

const YAML: Grammar = {
  ...BASE,
  keywords: words('true false null yes no on off'),
  line: ['#'],
  quotes: ['"', "'"],
  keys: /^(\s*(?:-\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*:)(?=\s|$)/,
};

/** Everything an unrecognised language is likely to share with every other. */
const FALLBACK: Grammar = {
  ...BASE,
  line: ['#', '//'],
  block: ['/*', '*/'],
  quotes: ['"', "'"],
};

const GRAMMARS = new Map<string, Grammar>([
  ['ts', TS],
  ['tsx', TS],
  ['typescript', TS],
  ['js', TS],
  ['jsx', TS],
  ['javascript', TS],
  ['mjs', TS],
  ['cjs', TS],
  ['go', GO],
  ['golang', GO],
  ['rs', RUST],
  ['rust', RUST],
  ['java', JAVA],
  ['c', C],
  ['h', C],
  ['cpp', CPP],
  ['c++', CPP],
  ['cc', CPP],
  ['cxx', CPP],
  ['hpp', CPP],
  ['swift', SWIFT],
  ['kt', KOTLIN],
  ['kts', KOTLIN],
  ['kotlin', KOTLIN],
  ['cs', CSHARP],
  ['csharp', CSHARP],
  ['py', PYTHON],
  ['python', PYTHON],
  ['sh', SHELL],
  ['bash', SHELL],
  ['zsh', SHELL],
  ['shell', SHELL],
  ['console', SHELL],
  ['json', JSON_],
  ['jsonc', JSON_],
  ['json5', JSON_],
  ['yml', YAML],
  ['yaml', YAML],
]);

/** Languages left exactly as they were written. */
const UNTOUCHED = new Set([
  '',
  'diff',
  'log',
  'markdown',
  'md',
  'mdx',
  'patch',
  'plain',
  'plaintext',
  'text',
  'txt',
]);

/** The grammar for a fence's language tag, or `null` to leave the code alone. */
function grammarFor(lang: string): Grammar | null {
  const key = lang.trim().toLowerCase();
  if (UNTOUCHED.has(key)) return null;
  return GRAMMARS.get(key) ?? FALLBACK;
}

/* -------------------------------------------------------------------------- */
/* Lexing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a line left open for the next one. `close` is the text that will end it
 * and `token` is what to paint until then, which is all the next line needs to
 * know — one field covers the end of a C block comment, a backtick and a
 * Python triple quote alike.
 */
export interface HighlightState {
  readonly open: { readonly close: string; readonly token: 'comment' | 'string' } | null;
}

/** The state the first line of a block starts in. */
export const HIGHLIGHT_START: HighlightState = { open: null };

export interface Highlighted {
  readonly text: string;
  readonly state: HighlightState;
}

const NUMBER = /(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z_]*/y;
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const VARIABLE = /\$(?:\{[^}\n]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/y;
const FLAG = /--?[A-Za-z][A-Za-z0-9_-]*/y;
const IDENT_START = /[A-Za-z_$]/;
const CAPITALISED = /^[A-Z]/;
const SPACE = /\s/;
/** Where a flag or a `#` comment may begin: after nothing, space, or a shell operator. */
const WORD_EDGE = /[\s(|;&]/;

/** True when the character at `at` is preceded by an odd number of backslashes. */
function escaped(text: string, at: number): boolean {
  let back = 0;
  while (at - back - 1 >= 0 && text.charAt(at - back - 1) === '\\') back += 1;
  return back % 2 === 1;
}

/** The next unescaped `close` at or after `from`, or -1. */
function closeAt(text: string, from: number, close: string, escapes: boolean): number {
  let at = text.indexOf(close, from);
  while (at !== -1 && escapes && escaped(text, at)) at = text.indexOf(close, at + 1);
  return at;
}

/**
 * Colour one line of code. `lang` is the fence's language tag, `state` is what
 * the line above left open. The returned state belongs to the line below.
 */
export function highlightLine(
  text: string,
  lang: string,
  state: HighlightState = HIGHLIGHT_START,
): Highlighted {
  const grammar = grammarFor(lang);
  if (grammar === null) return { text, state: HIGHLIGHT_START };

  let out = '';
  let open = state.open;
  let i = 0;

  // A YAML key is the one thing here that depends on being at the head of a
  // line, so it is read before the scan rather than inside it.
  if (open === null && grammar.keys !== null) {
    const key = grammar.keys.exec(text);
    if (key !== null) {
      out = `${key[1] ?? ''}${STYLE.keyword(key[2] ?? '')}${key[3] ?? ''}`;
      i = key[0].length;
    }
  }

  while (i < text.length) {
    if (open !== null) {
      const at = closeAt(text, i, open.close, open.token === 'string');
      if (at === -1) {
        out += STYLE[open.token](text.slice(i));
        break;
      }
      const end = at + open.close.length;
      out += STYLE[open.token](text.slice(i, end));
      i = end;
      open = null;
      continue;
    }

    const char = text.charAt(i);
    const before = i === 0 ? '' : text.charAt(i - 1);

    // Line comments. A `#` has to open a word — `git log --oneline#1` is not a
    // comment in any shell — and a `//` must not be the middle of a URL.
    const marker = grammar.line.find((mark) => text.startsWith(mark, i));
    if (
      marker !== undefined &&
      (marker !== '#' || i === 0 || WORD_EDGE.test(before)) &&
      (marker !== '//' || before !== ':')
    ) {
      out += STYLE.comment(text.slice(i));
      break;
    }

    // Strings that may outlive the line, longest delimiter first so `"""`
    // wins over `"`.
    const span = grammar.spans.find((mark) => text.startsWith(mark, i));
    if (span !== undefined) {
      const at = closeAt(text, i + span.length, span, true);
      if (at === -1) {
        out += STYLE.string(text.slice(i));
        open = { close: span, token: 'string' };
        break;
      }
      const end = at + span.length;
      out += STYLE.string(text.slice(i, end));
      i = end;
      continue;
    }

    if (grammar.block !== null && text.startsWith(grammar.block[0], i)) {
      const close = grammar.block[1];
      const at = closeAt(text, i + grammar.block[0].length, close, false);
      if (at === -1) {
        out += STYLE.comment(text.slice(i));
        open = { close, token: 'comment' };
        break;
      }
      out += STYLE.comment(text.slice(i, at + close.length));
      i = at + close.length;
      continue;
    }

    if (grammar.quotes.includes(char)) {
      const at = closeAt(text, i + 1, char, true);
      const end = at === -1 ? text.length : at + 1;
      out += STYLE.string(text.slice(i, end));
      i = end;
      continue;
    }

    if (grammar.sigil && char === '$') {
      VARIABLE.lastIndex = i;
      const found = VARIABLE.exec(text);
      if (found !== null) {
        out += STYLE.variable(found[0]);
        i += found[0].length;
        continue;
      }
    }

    if (grammar.flags && char === '-' && (i === 0 || WORD_EDGE.test(before))) {
      FLAG.lastIndex = i;
      const found = FLAG.exec(text);
      if (found !== null) {
        out += STYLE.flag(found[0]);
        i += found[0].length;
        continue;
      }
    }

    if (grammar.numbers && char >= '0' && char <= '9') {
      NUMBER.lastIndex = i;
      const found = NUMBER.exec(text);
      if (found !== null) {
        out += STYLE.number(found[0]);
        i += found[0].length;
        continue;
      }
    }

    if (IDENT_START.test(char)) {
      IDENT.lastIndex = i;
      const found = IDENT.exec(text);
      const word = found?.[0] ?? char;
      out += grammar.keywords.has(word)
        ? STYLE.keyword(word)
        : CAPITALISED.test(word)
          ? STYLE.type(word)
          : word;
      i += word.length;
      continue;
    }

    out += char;
    i += 1;
  }

  return { text: out, state: open === state.open ? state : { open } };
}
