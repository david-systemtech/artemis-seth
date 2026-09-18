/**
 * What a paste is, read off the paste itself.
 * ============================================================================
 *
 * Every terminal that collapses a long paste collapses it to the same thing:
 * `[Pasted text #1 +120 lines]`. The number of lines is the only fact in it,
 * and the number of lines is the one thing the person already knew — they
 * watched it go in. What they wanted to be told is *what* is in the box: that
 * the four hundred lines are a stack trace starting at `app.tsx:1442`, that
 * the eighty are a diff of three files, that the paste they just made was the
 * wrong one. So the chip gets a label, and the label is worked out here.
 *
 * The other half of knowing what something is, is handing it over as that
 * thing. A stack trace dropped naked into a sentence is a paragraph of
 * `at` lines the model has to re-derive the shape of; the same trace between
 * fences is a block, and a diff between ```diff fences is a diff. So this
 * module also says which fence a paste goes out in, and the composer wraps it
 * on the way to the agent — unless the person has already opened a fence
 * themselves, in which case they have said what they want and nothing here
 * second-guesses it.
 *
 * ## Why a module
 *
 * None of this is about a keystroke. It is a function of a string, it has one
 * obvious answer per input, and the interesting part is the hundred samples
 * that are nearly a diff, nearly a log, nearly JSON. That belongs in a test
 * table next to the rules rather than inside a component that can only be
 * driven through a fake terminal. The composer calls {@link classifyPaste}
 * once, when the paste arrives, and keeps the answer on the chip.
 *
 * ## The order the questions are asked in
 *
 * Specific before general, because nearly everything is also "text":
 *
 * 1. **URL** — one line, and the whole of it is a URL.
 * 2. **diff** — a `diff --git`, a `---`/`+++` pair, or an `@@` hunk with a
 *    majority of `+`/`-`/space lines under it. First, because a diff *of* a
 *    log or a trace is still a diff, and the `+` in front of every line is
 *    what the agent has to see to read it correctly.
 * 3. **JSON** — it parses, or it opens with `{`/`[` and closes to match and
 *    most of its lines are shaped like JSON. The second half is what catches
 *    the half of a payload somebody actually copied.
 * 4. **stack trace** — several frames that look like `at fn (file:line:col)`,
 *    Python's `File "…", line n`, or Go's tab-indented `file.go:12`. Two
 *    frames count when a header (`Traceback …`, `panic:`, `TypeError: …`)
 *    vouches for them; three stand on their own.
 * 5. **log** — most lines start with a timestamp or a level word. After the
 *    trace, because a log with a trace in it is usually pasted *for* the
 *    trace.
 * 6. **code** — a guessable language and the shape of code: braces,
 *    semicolons, indentation. A language nobody can name is not code here,
 *    because the only thing the label could then say is "code", which is
 *    worth less than the honest "text".
 * 7. **text** — everything else, and the answer to every question that goes
 *    wrong.
 *
 * ## It is a guess, and it never costs anything
 *
 * A wrong label is a small cost — a word in a chip — so the rules lean towards
 * the humble answer when they are unsure, and the paste itself is never
 * altered by what they decided. What *would* be a real cost is a paste that
 * hangs the box or throws inside a keystroke handler, so:
 *
 * - Only a sample is read: the first {@link SAMPLE_HEAD} lines and the last
 *   {@link SAMPLE_TAIL}, each clipped to {@link LINE_CHARS} characters, which
 *   bounds the regular expressions on a minified file or a megabyte on one
 *   line. The line *count* is exact — it comes from a scan that allocates
 *   nothing — so a ten-thousand-line log is counted as ten thousand and read
 *   as two hundred and fifty.
 * - {@link classifyPaste} never throws. Anything unexpected inside it is
 *   caught and answered with "text".
 */

/** The kinds a paste can be. `text` is the answer when nothing else fits. */
export type PasteKind = 'stack-trace' | 'diff' | 'json' | 'log' | 'code' | 'url' | 'text';

/** What a paste turned out to be. */
export interface PasteClassification {
  readonly kind: PasteKind;
  /**
   * The short phrase a chip shows: `Node stack trace from app.tsx:1442`,
   * `diff, 3 files`, `JSON`, `log, 84 lines`, `TypeScript`, `URL`, `text`.
   * Never empty, never more than one line.
   */
  readonly label: string;
  /** The fence tag for a `code` or `json` or `diff` paste: `ts`, `py`, `json`… */
  readonly lang?: string;
  /**
   * What the paste points at, where it points at something: the first
   * `file:line` a trace names — the whole path as it was written, which the
   * label shortens to a basename — or the URL itself.
   */
  readonly source?: string;
}

/** Lines read from the front of a paste. */
export const SAMPLE_HEAD = 200;

/** Lines read from the end of it. Everything between the two is not read at all. */
export const SAMPLE_TAIL = 50;

/** How much of one line is ever looked at. A minified bundle is one line. */
export const LINE_CHARS = 400;

/** Past this, JSON is recognised by its shape rather than by parsing it. */
const PARSE_CHARS = 512 * 1024;

/** How wide a chip's marker is allowed to get, label and all. */
export const MARKER_CHARS = 60;

const TEXT: PasteClassification = { kind: 'text', label: 'text' };

/* ------------------------------------------------------------------------ */
/* Reading a sample                                                          */
/* ------------------------------------------------------------------------ */

interface Sample {
  /** The lines examined: the first {@link SAMPLE_HEAD} and the last {@link SAMPLE_TAIL}. */
  readonly sampled: readonly string[];
  /** Of those, the ones with something on them. */
  readonly filled: readonly string[];
  /** How many lines the whole paste has. A single trailing newline is not one. */
  readonly lines: number;
  /** Whether anything between the head and the tail went unread. */
  readonly skipped: boolean;
}

/** One line, shortened to what is worth reading and without its carriage return. */
const clip = (line: string): string => {
  const bare = line.endsWith('\r') ? line.slice(0, -1) : line;
  return bare.length > LINE_CHARS ? bare.slice(0, LINE_CHARS) : bare;
};

/**
 * The head, the tail and the count, in one pass and one walk back.
 *
 * `indexOf`/`lastIndexOf` rather than `split`, because `split` on a paste of
 * any size allocates an array as long as the paste to answer a question about
 * two hundred and fifty of its lines.
 */
function sampleOf(text: string): Sample {
  const head: string[] = [];
  let count = 0;
  let at = 0;
  let read = 0; // Index just past the last character taken into `head`.
  for (;;) {
    const nl = text.indexOf('\n', at);
    const end = nl === -1 ? text.length : nl;
    count += 1;
    if (head.length < SAMPLE_HEAD) {
      head.push(clip(text.slice(at, end)));
      read = end;
    }
    if (nl === -1) break;
    at = nl + 1;
  }

  const tail: string[] = [];
  if (count > SAMPLE_HEAD) {
    let cut = text.length;
    while (tail.length < SAMPLE_TAIL) {
      const nl = cut === 0 ? -1 : text.lastIndexOf('\n', cut - 1);
      const start = nl + 1;
      if (start <= read) break;
      tail.push(clip(text.slice(start, cut)));
      if (nl <= 0) break;
      cut = nl;
    }
    tail.reverse();
  }

  const sampled = [...head, ...tail];
  return {
    sampled,
    filled: sampled.filter((line) => line.trim().length > 0),
    // The newline a terminal puts after the last line it copied is the
    // terminal's, not a line somebody wrote.
    lines: count > 1 && text.endsWith('\n') ? count - 1 : count,
    skipped: count > SAMPLE_HEAD + SAMPLE_TAIL,
  };
}

/** `3 files`, `1 file`. */
const plural = (count: number, one: string): string => `${String(count)} ${one}${count === 1 ? '' : 's'}`;

/** How many of `lines` a test holds for. */
const share = (lines: readonly string[], test: (line: string) => boolean): number =>
  lines.length === 0 ? 0 : lines.filter(test).length / lines.length;

/* ------------------------------------------------------------------------ */
/* A URL                                                                     */
/* ------------------------------------------------------------------------ */

const URL_LINE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s]+$/iu;

/* ------------------------------------------------------------------------ */
/* A diff                                                                    */
/* ------------------------------------------------------------------------ */

const GIT_HEADER = /^diff --git /u;
const OLD_HEADER = /^--- \S/u;
const NEW_HEADER = /^\+\+\+ \S/u;
const HUNK = /^@@ .*@@/u;
const HUNK_LINE = /^[-+ ]/u;

function asDiff(sample: Sample): PasteClassification | null {
  const { sampled } = sample;
  let git = 0;
  let olds = 0;
  let news = 0;
  let pair = false;
  let hunk = -1;
  for (const [index, line] of sampled.entries()) {
    if (GIT_HEADER.test(line)) git += 1;
    if (OLD_HEADER.test(line)) {
      olds += 1;
      const next = sampled[index + 1];
      if (next !== undefined && NEW_HEADER.test(next)) pair = true;
    }
    if (NEW_HEADER.test(line)) news += 1;
    if (hunk === -1 && HUNK.test(line)) hunk = index;
  }

  let body = false;
  if (hunk !== -1) {
    const under = sampled.slice(hunk + 1);
    body = under.length >= 3 && share(under, (line) => line.length === 0 || HUNK_LINE.test(line)) > 0.5;
  }
  if (git === 0 && !pair && !body) return null;

  // Counted in the sample, so a diff long enough to be sampled says "3+ files"
  // rather than claiming to have counted every one of them.
  const files = git > 0 ? git : news > 0 ? news : olds;
  const label =
    files === 0 ? 'diff' : sample.skipped ? `diff, ${String(files)}+ files` : `diff, ${plural(files, 'file')}`;
  return { kind: 'diff', label, lang: 'diff' };
}

/* ------------------------------------------------------------------------ */
/* JSON                                                                      */
/* ------------------------------------------------------------------------ */

const JSON_LINE =
  /^\s*(?:[[\]{},]+\s*,?|"(?:[^"\\]|\\.)*"\s*:\s*.*|"(?:[^"\\]|\\.)*",?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?,?|true,?|false,?|null,?)\s*$/u;

function asJson(text: string, sample: Sample): PasteClassification | null {
  const first = sample.filled[0]?.trimStart().slice(0, 1) ?? '';
  const last = sample.filled.at(-1)?.trimEnd().slice(-1) ?? '';
  const closed = (first === '{' && last === '}') || (first === '[' && last === ']');
  if (!closed) return null;

  const json: PasteClassification = { kind: 'json', label: 'JSON', lang: 'json' };
  if (text.length <= PARSE_CHARS) {
    try {
      JSON.parse(text);
      return json;
    } catch {
      // Not valid, which a payload copied out of a log rarely is. The shape of
      // the lines is the second opinion.
    }
  }
  return share(sample.filled, (line) => JSON_LINE.test(line)) >= 0.8 ? json : null;
}

/* ------------------------------------------------------------------------ */
/* A stack trace                                                             */
/* ------------------------------------------------------------------------ */

/** `at Socket.emit (node:events:517:28)`, `at /app/x.ts:10:3`. */
const NODE_FRAME = /^\s*at\s+(?:[^()]*\()?([^\s()]+):(\d+):\d+\)?\s*$/u;

/** `  File "/app/main.py", line 42, in handler`. */
const PYTHON_FRAME = /^\s*File\s+"([^"]+)",\s+line\s+(\d+)/u;

/** Go's second line of every frame: a tab, the file, the line, the offset. */
const GO_FRAME = /^\t([^\s:]+\.go):(\d+)(?:\s|$)/u;

/** `at com.example.Server.handle(Server.java:88)`. */
const JAVA_FRAME = /^\s*at\s+[\w$.<>]+\(([\w$.-]+\.\w+):(\d+)\)\s*$/u;

const TRACE_HEADER =
  /^(?:Traceback \(most recent call last\):|panic:|fatal error:|goroutine \d+ \[|Exception in thread |Caused by: |[\w.$]*(?:Error|Exception)\b)/u;

type Flavour = 'Node' | 'Python' | 'Go' | 'Java';

interface Frame {
  readonly flavour: Flavour;
  readonly file: string;
  readonly line: string;
}

/** The first pattern that matches wins, most distinctive first. */
const FRAMES: readonly (readonly [Flavour, RegExp])[] = [
  ['Python', PYTHON_FRAME],
  ['Go', GO_FRAME],
  ['Node', NODE_FRAME],
  ['Java', JAVA_FRAME],
];

function frameIn(line: string): Frame | null {
  for (const [flavour, pattern] of FRAMES) {
    const found = pattern.exec(line);
    const file = found?.[1];
    const at = found?.[2];
    if (file !== undefined && at !== undefined) return { flavour, file, line: at };
  }
  return null;
}

/** `/code/apps/tui/src/app.tsx` → `app.tsx`. A label has no room for a path. */
const basename = (file: string): string => {
  const parts = file.split(/[\\/]/u);
  const last = parts[parts.length - 1];
  return last === undefined || last.length === 0 ? file : last;
};

function asTrace(sample: Sample): PasteClassification | null {
  let frames = 0;
  let header = false;
  let first: Frame | null = null;
  for (const line of sample.sampled) {
    if (!header && TRACE_HEADER.test(line)) header = true;
    const frame = frameIn(line);
    if (frame === null) continue;
    frames += 1;
    first ??= frame;
  }
  if (first === null) return null;
  if (frames < 3 && !(frames >= 2 && header)) return null;

  const source = `${first.file}:${first.line}`;
  return {
    kind: 'stack-trace',
    label: `${first.flavour} stack trace from ${basename(first.file)}:${first.line}`,
    source,
  };
}

/* ------------------------------------------------------------------------ */
/* A log                                                                     */
/* ------------------------------------------------------------------------ */

const TIMESTAMP_START =
  /^[[(]?(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|\d{4}\/\d{2}\/\d{2}[T ]\d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?|[A-Z][a-z]{2}\s{1,2}\d{1,2}\s\d{2}:\d{2}:\d{2})/u;

/** A shouted level, and something after it: prose does not start `ERROR |`. */
const LEVEL_START = /^[[(]?(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRIT|CRITICAL|PANIC)[\])]?[\s:|-]/u;

/** The lower-case one every logger writes in brackets: `[info]`, `[warn]`. */
const BRACKET_LEVEL = /^\[(?:trace|debug|info|notice|warn|warning|error|err|fatal|crit|critical|panic)\]/u;

function asLog(sample: Sample): PasteClassification | null {
  if (sample.filled.length < 3) return null;
  const logged = share(
    sample.filled,
    (line) => TIMESTAMP_START.test(line) || LEVEL_START.test(line) || BRACKET_LEVEL.test(line),
  );
  if (logged < 0.6) return null;
  return { kind: 'log', label: `log, ${plural(sample.lines, 'line')}` };
}

/* ------------------------------------------------------------------------ */
/* Code, and which language                                                  */
/* ------------------------------------------------------------------------ */

/*
 * `render/highlight.ts` has a keyword set per language, but it keeps them to
 * itself — it exports one function, over a fence tag somebody else already
 * decided. Rather than prise that open for a guess, this is its own small
 * table: a handful of cues per language, weighted by how little else they
 * could be. `func (r *Repo) Get(` is Go and nothing else; `const` is every
 * language written this decade.
 */
interface Cue {
  readonly re: RegExp;
  readonly weight: number;
}

interface Language {
  /** The fence tag. */
  readonly lang: string;
  /** What the label calls it. */
  readonly label: string;
  readonly cues: readonly Cue[];
}

const cue = (re: RegExp, weight: number): Cue => ({ re, weight });

/**
 * Ordered: the first of two equal scores wins, so the more specific language
 * of a pair goes first.
 */
const LANGUAGES: readonly Language[] = [
  {
    lang: 'ts',
    label: 'TypeScript',
    cues: [
      cue(/\b(?:interface|type)\s+[A-Z]\w*\b/u, 3),
      cue(/:\s*(?:string|number|boolean|void|unknown|never|any|Promise<|readonly\s)/u, 3),
      cue(/\b(?:readonly|implements|enum|declare|namespace|satisfies)\b/u, 2),
      cue(/\bas\s+(?:const|unknown|string|number)\b/u, 2),
      cue(/\b(?:public|private|protected)\s+\w+\s*[:(]/u, 2),
    ],
  },
  {
    lang: 'js',
    label: 'JavaScript',
    cues: [
      cue(/\b(?:const|let|var)\s+[\w{[]/u, 2),
      cue(/\bfunction\s*\w*\s*\(/u, 2),
      cue(/=>\s*[{([]/u, 2),
      cue(/\b(?:require\(|module\.exports|console\.log\()/u, 2),
      cue(/\b(?:import|export)\b.*\bfrom\b\s*['"]/u, 2),
    ],
  },
  {
    lang: 'py',
    label: 'Python',
    cues: [
      cue(/^\s*(?:async\s+)?def\s+\w+\s*\(.*\)\s*(?:->.*)?:\s*$/u, 3),
      cue(/^\s*class\s+\w+(?:\(.*\))?\s*:\s*$/u, 3),
      cue(/^\s*(?:from\s+[\w.]+\s+)?import\s+[\w.,*\s]+$/u, 2),
      cue(/\bself\./u, 2),
      cue(/^\s*(?:elif|except|finally|with|while|for)\b.*:\s*$/u, 2),
    ],
  },
  {
    lang: 'go',
    label: 'Go',
    cues: [
      cue(/^\s*func\s+(?:\(\w+\s+\*?\w+\)\s*)?\w*\s*\(/u, 3),
      cue(/^package\s+\w+\s*$/u, 3),
      cue(/\bif\s+err\s*!=\s*nil\b/u, 3),
      cue(/:=/u, 2),
      cue(/\b(?:fmt|errors)\.\w+\(/u, 2),
    ],
  },
  {
    lang: 'rust',
    label: 'Rust',
    cues: [
      cue(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+/u, 3),
      cue(/\blet\s+mut\b/u, 3),
      cue(/^\s*impl\s+\w/u, 2),
      cue(/\b(?:println!|vec!|format!|Some\(|Ok\(|Err\()/u, 2),
      cue(/^\s*use\s+[\w:]+(?:::\{.*\})?;\s*$/u, 2),
    ],
  },
  {
    lang: 'java',
    label: 'Java',
    cues: [
      cue(/\bSystem\.out\.print/u, 3),
      cue(/\b(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>[\]]+\s+\w+\s*\(/u, 3),
      cue(/^\s*(?:package|import)\s+[\w.]+;\s*$/u, 2),
      cue(/^\s*@Override\b/u, 2),
      cue(/\bnew\s+[A-Z]\w*\s*\(/u, 1),
    ],
  },
  {
    lang: 'bash',
    label: 'Shell',
    cues: [
      cue(/^#!.*\b(?:ba|z|k|fi|da)?sh\b/u, 4),
      cue(/^\s*(?:echo|export|source|sudo|cd|set -e|trap)\s/u, 2),
      cue(/^\s*(?:fi|done|esac)\s*$/u, 2),
      cue(/\|\s*(?:grep|awk|sed|jq|xargs|head|tail)\b/u, 2),
      cue(/\$\{?\w+\}?/u, 1),
    ],
  },
  {
    lang: 'ruby',
    label: 'Ruby',
    cues: [
      cue(/\bdo\s*\|\w/u, 3),
      cue(/^\s*def\s+\w+[?!]?(?:\(.*\))?\s*$/u, 3),
      cue(/^\s*end\s*$/u, 2),
      cue(/^\s*require(?:_relative)?\s+['"]/u, 2),
      cue(/\bputs\s/u, 2),
    ],
  },
  {
    lang: 'sql',
    label: 'SQL',
    cues: [
      cue(/\bselect\b.*\bfrom\b/iu, 3),
      cue(/\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+(?:table|index))\b/iu, 3),
      // Shouted, and at the start of a line: a query is written in clauses,
      // and `From what I can tell` is not one of them.
      cue(/^\s*(?:SELECT|FROM|WHERE|VALUES|JOIN|LIMIT|(?:ORDER|GROUP)\s+BY)\b/u, 2),
      cue(/\b(?:inner|left|right|outer)\s+join\b/iu, 2),
      cue(/\b(?:group|order)\s+by\b/iu, 2),
    ],
  },
  {
    lang: 'html',
    label: 'HTML',
    cues: [
      cue(/<!DOCTYPE\s+html/iu, 4),
      cue(/^\s*<\/?(?:html|head|body|div|span|p|a|ul|li|script|style|section|main)\b/iu, 2),
      cue(/<\/\w+>/u, 1),
    ],
  },
  {
    lang: 'css',
    label: 'CSS',
    cues: [
      cue(/^\s*@(?:media|import|keyframes|supports)\b/u, 3),
      cue(/^\s*[a-z-]+\s*:\s*[^;{]+;\s*$/u, 2),
      cue(/^\s*[.#]?[\w-][\w\-.#:>[\] ]*\{\s*$/u, 1),
    ],
  },
];

/** A line ending in a brace, a semicolon, a colon — or one that is indented at all. */
const CODE_SHAPE = /(?:[{};]\s*$|^\s+\S|\)\s*(?:->\s*[\w[]+\s*)?[:{]\s*$|^\s*(?:#!|@\w|<\/?\w))/u;

function asCode(sample: Sample): PasteClassification | null {
  const scores = new Map<string, number>();
  for (const language of LANGUAGES) {
    let score = 0;
    for (const { re, weight } of language.cues) {
      if (sample.sampled.some((line) => re.test(line))) score += weight;
    }
    scores.set(language.lang, score);
  }

  // TypeScript is JavaScript with types on it, so its cues are worth what they
  // score *plus* what the JavaScript ones did; without that, a typed file
  // loses to itself.
  const ts = scores.get('ts') ?? 0;
  if (ts > 0) {
    scores.set('ts', ts + (scores.get('js') ?? 0));
    scores.set('js', 0);
  }

  let best: Language | null = null;
  let bestScore = 0;
  for (const language of LANGUAGES) {
    const score = scores.get(language.lang) ?? 0;
    if (score > bestScore) {
      best = language;
      bestScore = score;
    }
  }
  if (best === null || bestScore < 3) return null;

  // The shape as well as the words, so a sentence that happens to contain
  // `import` is not Python. A language that scored this strongly is its own
  // evidence of shape — a query has no braces and every line of it is a clause.
  const shaped = sample.sampled.filter((line) => CODE_SHAPE.test(line)).length;
  if (shaped < 2 && bestScore < 4) return null;
  return { kind: 'code', label: best.label, lang: best.lang };
}

/* ------------------------------------------------------------------------ */
/* The answer                                                                */
/* ------------------------------------------------------------------------ */

function classify(text: string): PasteClassification {
  if (text.trim().length === 0) return TEXT;
  const sample = sampleOf(text);

  const only = sample.lines === 1 ? sample.filled[0]?.trim() : undefined;
  if (only !== undefined && URL_LINE.test(only)) return { kind: 'url', label: 'URL', source: only };

  return asDiff(sample) ?? asJson(text, sample) ?? asTrace(sample) ?? asLog(sample) ?? asCode(sample) ?? TEXT;
}

/**
 * What this paste is. Never throws: anything it cannot make sense of is text,
 * which is what every terminal calls every paste anyway.
 */
export function classifyPaste(text: string): PasteClassification {
  try {
    return classify(text);
  } catch {
    return TEXT;
  }
}

/* ------------------------------------------------------------------------ */
/* The chip's marker                                                         */
/* ------------------------------------------------------------------------ */

/** One line, single-spaced: a label goes inside a marker inside a line of text. */
const oneLine = (label: string): string => label.replace(/\s+/gu, ' ').trim();

/**
 * `[Pasted #1 · 412 lines · Node stack trace from app.tsx:1442]`.
 *
 * The marker is a token the cursor walks over in a box eight rows tall, so it
 * is kept under {@link MARKER_CHARS} and the label is what gives way: a label
 * too long for the room left is cut with an ellipsis, and one that has nothing
 * to add is left off altogether.
 *
 * `log, 84 lines` in a marker that opens `[Pasted #1 · 84 lines` is one of
 * those: the count is already there, so the suffix is dropped and the label
 * reads `log`.
 */
export function pasteMarker(number: number, lines: number, label: string): string {
  const count = plural(lines, 'line');
  const open = `[Pasted #${String(number)} · ${count}`;
  const said = oneLine(label).replace(new RegExp(`,\\s*${count}$`, 'u'), '');
  const room = MARKER_CHARS - open.length - 4; // ' · ' and the closing bracket.
  if (said.length === 0 || room < 4) return `${open}]`;
  return `${open} · ${said.length <= room ? said : `${said.slice(0, room - 1)}…`}]`;
}

/* ------------------------------------------------------------------------ */
/* The fence                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * The tag a chip of this kind expands inside — `''` for a fence with no
 * language on it — or `null` for no fence at all.
 *
 * Prose is not fenced, because fencing a paragraph tells the agent it is a
 * block of something when it is a paragraph; a URL is not fenced, because a
 * link in a sentence is a link.
 */
export function fenceFor(paste: PasteClassification): string | null {
  switch (paste.kind) {
    case 'diff':
      return 'diff';
    case 'json':
      return 'json';
    case 'code':
      return paste.lang ?? '';
    case 'stack-trace':
    case 'log':
      return '';
    case 'text':
    case 'url':
      return null;
  }
}

/** Three backticks, or one more than the longest run inside — CommonMark's own rule. */
export function fenced(body: string, tag: string): string {
  let longest = 0;
  for (const run of body.matchAll(/`+/gu)) longest = Math.max(longest, run[0]?.length ?? 0);
  const rail = '`'.repeat(Math.max(3, longest + 1));
  return `${rail}${tag}\n${body}\n${rail}`;
}

/** A line that opens or closes a fence: up to three spaces, then the rail. */
function fenceLine(text: string, from: number, to: number): boolean {
  let at = from;
  while (at < to && at - from < 3 && text[at] === ' ') at += 1;
  const mark = text[at];
  if (mark !== '`' && mark !== '~') return false;
  let run = 0;
  while (at + run < to && text[at + run] === mark) run += 1;
  return run >= 3;
}

/**
 * Whether the text so far leaves a fence open.
 *
 * Counted rather than parsed: an odd number of fence lines means the next
 * thing written lands inside one. That is the whole of what is needed — the
 * question is only ever "would wrapping this be wrapping it twice".
 */
export function insideFence(before: string): boolean {
  let open = false;
  let at = 0;
  for (;;) {
    const nl = before.indexOf('\n', at);
    const end = nl === -1 ? before.length : nl;
    if (fenceLine(before, at, end)) open = !open;
    if (nl === -1) return open;
    at = nl + 1;
  }
}

/** A block put into running text keeps its own lines. */
const placed = (block: string, before: string, after: string): string => {
  const head = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  const tail = after.length > 0 && !after.startsWith('\n') ? '\n' : '';
  return `${head}${block}${tail}`;
};

/**
 * Put `body` back wherever `marker` stands in `text`, fenced if its kind asks
 * for a fence and the words around it have not already opened one.
 *
 * Each occurrence is decided on its own, against what has been written out so
 * far, so a marker inside a fence the person opened three lines above goes in
 * bare while the same chip later in the message is wrapped.
 */
export function expandChip(text: string, marker: string, body: string, paste: PasteClassification): string {
  const tag = fenceFor(paste);
  if (tag === null || marker.length === 0) return text.split(marker).join(body);

  let out = '';
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at === -1) return out + text.slice(from);
    out += text.slice(from, at);
    from = at + marker.length;
    const after = text.slice(from);
    out += insideFence(out) ? body : placed(fenced(body, tag), out, after);
  }
}
