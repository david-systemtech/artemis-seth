/**
 * Turning a file-editing tool call into a reviewable diff.
 *
 * A tool call that rewrites a file is the single most consequential thing an
 * agent does, and the raw JSON of an `Edit` — two long strings under
 * `old_string` and `new_string` — is unreadable at exactly the moment it most
 * needs reading. So edits are detected here and rendered as a real diff with
 * +/- gutters, rather than being left to the generic argument dump.
 *
 * ## Provider-neutral by construction
 *
 * Nothing in this file names a provider or a tool. Detection is driven by
 * *argument shape*: a path-ish key plus either a before/after pair or a
 * whole-content key. That is deliberate — Claude calls it `Edit` with
 * `old_string`/`new_string`, another CLI will call it `apply_patch` with
 * `before`/`after`, and a diff view that only works for one vendor's tool names
 * would have to be rewritten for every provider added. The alias tables below
 * are the whole of the provider-specific knowledge, and they are additive.
 *
 * ## Several edits to one file, and several files in one call
 *
 * Two shapes do not fit "one call, one before/after pair", and both were being
 * dropped on the floor. A *multi-edit* applies a list of replacements to a
 * single file in order; a *patch* rewrites several files at once.
 *
 * The first is still one {@link FileEdit}. The replacements are chained onto a
 * running text — an edit whose `old_string` is found in what an earlier edit
 * produced is applied there, so the diff shows where the file actually ended
 * up rather than every intermediate state — and an edit that lands somewhere
 * the running text has never seen starts a new region, stacked after it with a
 * gap row between. Stacking is not a failure mode, it is the normal case: the
 * tool sends fragments and never the file, so fragments are all there is to
 * reconstruct from, and two fragments of one file are honestly rendered as two
 * regions rather than as adjacent lines.
 *
 * The second cannot be one `FileEdit`, so {@link detectFileEdits} returns every
 * file a call touches and {@link detectFileEdit} keeps its old promise by
 * returning the first of them.
 *
 * ## What a Codex `ApplyPatch` can and cannot say
 *
 * Given the patch text this parses it: the `*** Begin Patch` envelope Codex's
 * `apply_patch` uses, and a plain unified diff, which is what a per-file diff
 * arrives as.
 *
 * The Codex adapter passes the patch's `changes` through as they arrive — one
 * entry per file with `path`, `kind` and the per-file `diff` the protocol
 * declares on `CodexFileUpdateChange` — so a patch now yields one
 * {@link FileEdit} per file with rows. The paths-only shape is kept for any
 * caller that still sends one: it yields one edit per path marked
 * {@link FileEdit.summaryOnly} with no rows, because naming the files a run
 * touched is worth more than silence, and `added`/`removed` are zero because
 * zero is what is *known*, not a claim that nothing changed.
 *
 * ## Cost
 *
 * This runs inside a transcript row, which may be re-rendered while a run
 * streams, so it is bounded twice over: common prefix and suffix lines are
 * stripped before any quadratic work happens (which is what makes the common
 * case — a three-line change in a thousand-line file — linear), and the
 * remaining window is refused outright past {@link LCS_CELL_BUDGET}, falling
 * back to a block replacement rather than locking the frame.
 */

import type { JsonObject, JsonValue } from '@rx-artemis/protocol';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One rendered line of a diff.
 *
 * Both renderers consume the line numbers, and differently: the desktop has the
 * width for a two-column gutter, while the terminal shows one column and picks
 * the number that tells the reader where to put their cursor — `newNo` for
 * additions and context, `oldNo` for deletions. Both of those only work if a
 * row that has a number always has the right one, so they are set from the
 * diff's own indices rather than counted up at render time.
 */
export interface DiffRow {
  /** `gap` is a collapsed run of unchanged lines, not a line of the file. */
  readonly kind: 'add' | 'del' | 'ctx' | 'gap';
  readonly text: string;
  /** 1-based line number in the original file. Absent on `add` and `gap`. */
  readonly oldNo?: number;
  /** 1-based line number in the new file. Absent on `del` and `gap`. */
  readonly newNo?: number;
  /** How many unchanged lines a `gap` row stands for. */
  readonly skipped?: number;
  /**
   * Character ranges within {@link text} that differ from the line this one
   * replaced, as `[start, end)` pairs.
   *
   * Only populated for lines that pair up one-to-one with a counterpart, which
   * is the case that matters: a "changed" line is otherwise rendered as a whole
   * red line and a whole green line, and the reader has to diff two long lines
   * by eye to find the one identifier that moved.
   */
  readonly spans?: readonly (readonly [number, number])[];
}

/** A file edit, ready to render. */
export interface FileEdit {
  /** Path as the tool named it. Displayed verbatim; never resolved or opened. */
  readonly path: string;
  /** Lower-case file extension, for the language chip. Empty when there is none. */
  readonly extension: string;
  readonly rows: readonly DiffRow[];
  readonly added: number;
  readonly removed: number;
  /** True when the payload was clipped for size; the UI must say so. */
  readonly truncated: boolean;
  /**
   * True when the tool supplied whole new content rather than a before/after
   * pair — a file write. Every line is an addition, and the UI should not
   * imply that the absence of deletions means the file was empty before.
   */
  readonly whole: boolean;
  /**
   * What the call does to the file as a whole, when the tool said so.
   *
   * Only a patch says it outright. A deletion is the case that needs it: a
   * deleted file arrives with no content at all, so `rows` is empty and the
   * counts are zero, which is indistinguishable from "nothing happened" unless
   * something records that the file is gone.
   */
  readonly operation?: 'update' | 'add' | 'delete';
  /** The file's previous path, when the call also renamed it. */
  readonly renamedFrom?: string;
  /**
   * True when the tool named the file but supplied no content for it.
   *
   * The counts are zero and `rows` is empty because nothing is known, not
   * because nothing changed — a UI must name the file and say no more. See the
   * header for which provider does this and what it would take to fix.
   */
  readonly summaryOnly?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/** Unchanged lines kept either side of a change before collapsing to a gap. */
const CONTEXT_LINES = 3;

/** Rows past this are dropped; a diff longer than this is not being read. */
const MAX_ROWS = 600;

/**
 * Ceiling on the LCS table. 250k cells is roughly a 500×500-line window, which
 * is far past any edit a person reviews, and it bounds the work at a few
 * milliseconds rather than letting a machine-generated rewrite of a large file
 * stall the frame.
 */
const LCS_CELL_BUDGET = 250_000;

/** Lines past this in a single payload are not diffed at all. */
const MAX_LINES = 20_000;

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

/** Argument names that carry the path being edited, in order of preference. */
const PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path', 'file'];

/**
 * Before/after argument pairs, in order of preference.
 *
 * Ordered so that a tool supplying several pairs (a notebook edit carrying both
 * source and content) resolves to the most specific one first.
 */
const EDIT_PAIRS: readonly (readonly [string, string])[] = [
  ['old_string', 'new_string'],
  ['oldString', 'newString'],
  ['old_source', 'new_source'],
  ['old_text', 'new_text'],
  ['old_content', 'new_content'],
  ['old_str', 'new_str'],
  ['before', 'after'],
];

/** Argument names that carry whole new file content, for a write. */
const WHOLE_KEYS = ['content', 'contents', 'new_source', 'newSource', 'text', 'source'];

/** Argument names that carry a list of before/after pairs for one file. */
const EDIT_LIST_KEYS = ['edits', 'replacements'];

/**
 * Argument names that carry patch text.
 *
 * Deliberately narrow, and deliberately not `content`: a tool that *writes* a
 * `.patch` file puts the same characters under `content`, and reading that as a
 * patch would render the file's contents as the changes it describes.
 */
const PATCH_KEYS = ['patch', 'diff', 'patch_text', 'patchText', 'unified_diff', 'unifiedDiff'];

/** Argument names that carry a list of files a single call touches. */
const FILE_LIST_KEYS = ['paths', 'changes', 'files'];

/**
 * Tool names that sound like a mutation.
 *
 * The one place a name is consulted at all, and only ever to *reject*: an input
 * that looks like an edit on a tool that reads is a read echoing the file back.
 */
const MUTATION_NAME = /write|create|save|put|add|edit|patch|update|replace/i;

function str(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The path an object names, under whichever key it uses for it. */
function pathOf(input: JsonObject): string | undefined {
  return PATH_KEYS.map((key) => str(input[key])).find(
    (value): value is string => value !== undefined && value.length > 0,
  );
}

/**
 * Every file a tool call edits, in the order the call names them.
 *
 * Empty for anything that is not an edit, which is the overwhelming majority of
 * tool calls — the caller falls back to the generic argument view.
 *
 * Four shapes, tried most specific first: patch text, a list of replacements to
 * one file, a single before/after pair or whole-content write, and last a bare
 * list of paths, which yields files with no diff at all rather than nothing.
 */
export function detectFileEdits(
  toolName: string,
  input: JsonObject | undefined,
): readonly FileEdit[] {
  if (!input) return [];

  const patch = PATCH_KEYS.map((key) => str(input[key])).find(isPatchText);
  if (patch !== undefined) {
    const files = parsePatch(patch, pathOf(input));
    if (files.length > 0) return files;
  }

  const multi = detectMultiEdit(input);
  if (multi !== null) return [multi];

  const single = detectSingleEdit(toolName, input);
  if (single !== null) return [single];

  return detectNamedFiles(toolName, input);
}

/**
 * Recognise a file-editing tool call and build its diff.
 *
 * Returns `null` for anything that is not an edit. A call that edits several
 * files reports the first of them; {@link detectFileEdits} reports all of them.
 *
 * `toolName` is accepted but deliberately **not** matched against a list of
 * known editor tools: it is used only to distinguish a write from a read-like
 * call that happens to carry content. Matching on names would make this file
 * provider-specific for no gain, since the argument shape is already decisive.
 */
export function detectFileEdit(toolName: string, input: JsonObject | undefined): FileEdit | null {
  return detectFileEdits(toolName, input)[0] ?? null;
}

/** One file, one before/after pair — the original shape, unchanged. */
function detectSingleEdit(toolName: string, input: JsonObject): FileEdit | null {
  const path = pathOf(input);
  if (path === undefined) return null;

  const extension = extensionOf(path);

  for (const [oldKey, newKey] of EDIT_PAIRS) {
    const before = str(input[oldKey]);
    const after = str(input[newKey]);
    if (before === undefined || after === undefined) continue;
    // An edit whose halves are identical is not an edit. Rendering an all-context
    // diff would claim a change happened; falling through to the raw view says
    // less but says nothing false.
    if (before === after) return null;
    return build(path, extension, before, after, false);
  }

  // A whole-content write. Guarded on the tool name only to the extent of
  // requiring it to look like a mutation: a `Read` result is not an edit, and
  // some providers echo the file's content back in the *input* of a read.
  if (!MUTATION_NAME.test(toolName)) return null;
  const whole = WHOLE_KEYS.map((key) => str(input[key])).find(
    (value): value is string => value !== undefined,
  );
  if (whole === undefined) return null;
  return build(path, extension, '', whole, true);
}

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/* -------------------------------------------------------------------------- */
/* Several edits to one file                                                  */
/* -------------------------------------------------------------------------- */

/** One replacement, normalised out of whichever key names the tool used. */
interface EditStep {
  readonly before: string;
  readonly after: string;
  /** The tool said to replace every occurrence, not just the first. */
  readonly all: boolean;
}

/** A contiguous stretch of the file, before and after everything done to it. */
interface Region {
  readonly before: string;
  after: string;
}

/** One file, a list of replacements. `null` when the list holds no usable one. */
function detectMultiEdit(input: JsonObject): FileEdit | null {
  const path = pathOf(input);
  if (path === undefined) return null;

  const list = EDIT_LIST_KEYS.map((key) => input[key]).find(isJsonArray);
  if (list === undefined) return null;

  const steps = readSteps(list);
  if (steps.length === 0) return null;

  return buildRegions(path, extensionOf(path), applySteps(steps));
}

function readSteps(list: readonly JsonValue[]): readonly EditStep[] {
  const steps: EditStep[] = [];
  for (const entry of list) {
    if (!isJsonObject(entry)) continue;
    for (const [oldKey, newKey] of EDIT_PAIRS) {
      const before = str(entry[oldKey]);
      const after = str(entry[newKey]);
      if (before === undefined || after === undefined) continue;
      // A step whose halves are identical changed nothing; showing it would
      // claim otherwise, exactly as for a single edit.
      if (before !== after) {
        steps.push({
          before,
          after,
          all: entry['replace_all'] === true || entry['replaceAll'] === true,
        });
      }
      break;
    }
  }
  return steps;
}

/**
 * Chain the steps, opening a new region for each one that lands elsewhere.
 *
 * Searched newest-first because a step that edits an earlier step's output is
 * overwhelmingly editing the *last* one, and because a later region is the one
 * whose text is freshest if the same fragment somehow appears twice.
 */
function applySteps(steps: readonly EditStep[]): readonly Region[] {
  const regions: Region[] = [];

  for (const step of steps) {
    let applied = false;
    for (let i = regions.length - 1; i >= 0; i -= 1) {
      const region = regions[i];
      if (region === undefined) continue;
      if (step.before.length === 0 || !region.after.includes(step.before)) continue;
      region.after = step.all
        ? replaceEvery(region.after, step.before, step.after)
        : replaceFirst(region.after, step.before, step.after);
      applied = true;
      break;
    }
    if (!applied) regions.push({ before: step.before, after: step.after });
  }

  return regions;
}

/**
 * Literal replacement.
 *
 * `String.prototype.replace` with a string pattern still interprets `$&`, `$1`
 * and friends in the *replacement*, which is a live hazard here: the
 * replacement is source code, and a regex literal or a shell string containing
 * `$&` would be silently rewritten into something the agent never asked for.
 */
function replaceFirst(text: string, find: string, put: string): string {
  const at = text.indexOf(find);
  return at < 0 ? text : text.slice(0, at) + put + text.slice(at + find.length);
}

function replaceEvery(text: string, find: string, put: string): string {
  return text.split(find).join(put);
}

/** Diff every region in order and lay them end to end, separated by a gap. */
function buildRegions(path: string, extension: string, regions: readonly Region[]): FileEdit {
  const joinedBefore = regions.map((region) => region.before).join('\n');
  const joinedAfter = regions.map((region) => region.after).join('\n');
  // The size guard, and the shape it bails out with, belong to one place.
  if (countLines(joinedBefore) + countLines(joinedAfter) > MAX_LINES) {
    return build(path, extension, joinedBefore, joinedAfter, false);
  }

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let oldBase = 0;
  let newBase = 0;

  regions.forEach((region, index) => {
    // An empty `before` is an insertion with no anchor, not a deletion of a
    // blank line, so it contributes no old lines at all.
    const oldLines = region.before.length === 0 ? [] : region.before.split('\n');
    const newLines = region.after.split('\n');
    const regionRows = collapse(pairSpans(diffLines(oldLines, newLines)));

    // Two regions of one file are not two adjacent lines of it, and rendering
    // them as if they were would invent a change that is not in the file.
    if (index > 0) rows.push({ kind: 'gap', text: 'elsewhere in the file' });

    for (const row of regionRows) {
      if (row.kind === 'add') added += 1;
      else if (row.kind === 'del') removed += 1;
      rows.push(shift(row, oldBase, newBase));
    }

    oldBase += oldLines.length;
    newBase += newLines.length;
  });

  const truncated = rows.length > MAX_ROWS;
  return {
    path,
    extension,
    rows: truncated ? rows.slice(0, MAX_ROWS) : rows,
    added,
    removed,
    truncated,
    whole: false,
  };
}

/**
 * Move a region's rows down past the regions before it.
 *
 * The numbers are still relative to the reconstruction rather than to the file
 * — nothing here has ever seen the file — but they stay unique and ascending,
 * which is what a gutter has to be to be read at all.
 */
function shift(row: DiffRow, oldBase: number, newBase: number): DiffRow {
  if (oldBase === 0 && newBase === 0) return row;
  return {
    ...row,
    ...(row.oldNo === undefined ? {} : { oldNo: row.oldNo + oldBase }),
    ...(row.newNo === undefined ? {} : { newNo: row.newNo + newBase }),
  };
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

/* -------------------------------------------------------------------------- */
/* Patches                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The two dialects worth parsing: the `*** Begin Patch` envelope Codex's
 * `apply_patch` speaks, and the unified diff everything else does.
 */
const PATCH_MARKER =
  /^(?:\*\*\* (?:Begin Patch|Update File:|Add File:|Delete File:)|diff --git |--- |\+\+\+ |@@ -\d)/m;

/** `@@ -12,7 +12,9 @@ trailing anchor`, when the hunk carries line numbers. */
const HUNK_NUMBERS = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

function isPatchText(text: string | undefined): text is string {
  return text !== undefined && PATCH_MARKER.test(text);
}

/** One file of a patch, while it is still being read. */
interface Draft {
  path: string;
  operation: 'update' | 'add' | 'delete';
  renamedFrom: string | undefined;
  readonly rows: DiffRow[];
  added: number;
  removed: number;
  /**
   * Where the next row sits in each file, or `undefined` when the patch does
   * not say. `apply_patch` hunks carry no numbers at all, and a made-up number
   * in a gutter is worse than an empty one: it sends the reader to the wrong
   * line of the right file and looks authoritative doing it.
   */
  oldNo: number | undefined;
  newNo: number | undefined;
  /** A hunk header has been seen, so `---` is a deleted line and not a header. */
  sawHunk: boolean;
  /**
   * The file was announced by a `*** Add File:` keyword rather than by a
   * unified header. Its body starts immediately, with no `@@` to separate the
   * two, so a first line of `+++ x` is a line of the file and not a header.
   */
  fromEnvelope: boolean;
  truncated: boolean;
}

/**
 * Parse patch text into one {@link FileEdit} per file it touches.
 *
 * `fallbackPath` names the file for patch text that carries only hunks — a
 * per-file diff handed over beside its path, which is how a provider that
 * reports changes file by file tends to send them.
 *
 * Unparseable lines are skipped rather than rejected: a patch that has been
 * clipped, or that carries a provider's own trailer, should still show the
 * changes it did describe.
 */
function parsePatch(text: string, fallbackPath: string | undefined): readonly FileEdit[] {
  const all = text.split('\n');
  // Patch text ends in a newline, which splits into a trailing empty string.
  // That is the end of the last line, not a blank context line after it.
  if (all.at(-1) === '') all.pop();
  const clipped = all.length > MAX_LINES;
  const lines = clipped ? all.slice(0, MAX_LINES) : all;

  const drafts: Draft[] = [];
  let current: Draft | undefined;

  const open = (path: string, operation: Draft['operation'], fromEnvelope: boolean): Draft => {
    const draft: Draft = {
      path,
      operation,
      renamedFrom: undefined,
      rows: [],
      added: 0,
      removed: 0,
      oldNo: undefined,
      // An added file starts at its first line: the one case where a patch
      // without numbers still implies them, exactly as a whole-file write does.
      newNo: operation === 'add' ? 1 : undefined,
      sawHunk: false,
      fromEnvelope,
      truncated: false,
    };
    drafts.push(draft);
    current = draft;
    return draft;
  };

  /** True while `---` and `+++` are still a file header rather than content. */
  const atHeader = (): boolean =>
    current === undefined ||
    (!current.sawHunk && current.rows.length === 0 && !current.fromEnvelope);

  /** Name the file being opened, or open one if the header started elsewhere. */
  const name = (path: string): Draft => {
    if (current !== undefined && atHeader()) {
      current.path = path;
      return current;
    }
    return open(path, 'update', false);
  };

  const mark = (operation: Draft['operation']): void => {
    const draft = current !== undefined && atHeader() ? current : open('', operation, false);
    draft.operation = operation;
    if (operation === 'add' && draft.newNo === undefined) draft.newNo = 1;
  };

  for (const raw of lines) {
    // A patch that travelled through a Windows tool keeps its carriage returns,
    // and a stray `\r` at the end of every line would diff against itself.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (line.startsWith('*** ')) {
      const rest = line.slice(4);
      // The envelope ends where it says it does. Whatever a provider appends
      // after it is prose about the patch and not part of one.
      if (rest.startsWith('End Patch')) break;
      const update = suffixAfter(rest, 'Update File:');
      if (update !== undefined) {
        open(update, 'update', true);
        continue;
      }
      const added = suffixAfter(rest, 'Add File:');
      if (added !== undefined) {
        open(added, 'add', true);
        continue;
      }
      const deleted = suffixAfter(rest, 'Delete File:');
      if (deleted !== undefined) {
        open(deleted, 'delete', true);
        continue;
      }
      const moved = suffixAfter(rest, 'Move to:');
      if (moved !== undefined && current !== undefined) {
        current.renamedFrom = current.path;
        current.path = moved;
      }
      // `*** Begin Patch` and anything a newer CLI adds.
      continue;
    }

    // The one header line that can never be content, so it always separates.
    if (line.startsWith('diff --git ')) {
      const paths = line.slice('diff --git '.length).split(' ');
      const to = stripGitPrefix(paths.at(-1) ?? '');
      const from = stripGitPrefix(paths[0] ?? '');
      const draft = open(to.length > 0 ? to : from, 'update', false);
      if (from.length > 0 && to.length > 0 && from !== to) draft.renamedFrom = from;
      continue;
    }

    if (atHeader() && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      const target = line.slice(4).trim();
      const removal = line.startsWith('+++');
      if (target === '/dev/null') mark(removal ? 'delete' : 'add');
      else name(stripGitPrefix(target));
      continue;
    }

    if (line.startsWith('@@')) {
      const draft = current ?? open(fallbackPath ?? '', 'update', false);
      const numbers = HUNK_NUMBERS.exec(line);
      const oldStart = numbers === null ? undefined : Number(numbers[1]);
      const newStart = numbers === null ? undefined : Number(numbers[2]);
      const anchor = (numbers === null ? line.replace(/^@@+/, '') : (numbers[3] ?? '')).trim();

      const gap = hunkGap(draft, oldStart, anchor);
      if (gap !== undefined) draft.rows.push(gap);

      draft.oldNo = oldStart;
      draft.newNo = newStart;
      draft.sawHunk = true;
      continue;
    }

    // A body line before any header belongs to no file. Opening one for it
    // would invent a file out of a blank line above the patch.
    const kind = bodyKind(line);
    if (kind === undefined || current === undefined) continue;
    pushBody(current, kind, line.length === 0 ? '' : line.slice(1));
  }

  const files = drafts.filter((draft) => draft.path.length > 0);
  const last = files.at(-1);
  if (clipped && last !== undefined) last.truncated = true;
  return files.map(toFileEdit);
}

/** The text after a `*** ` keyword, or `undefined` if that is not the keyword. */
function suffixAfter(rest: string, keyword: string): string | undefined {
  return rest.startsWith(keyword) ? rest.slice(keyword.length).trim() : undefined;
}

/** `a/src/x.ts` → `src/x.ts`. Git's own convention; nothing else uses it. */
function stripGitPrefix(path: string): string {
  return /^[ab]\//.test(path) ? path.slice(2) : path;
}

function bodyKind(line: string): DiffRow['kind'] | undefined {
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  // A patch generator that trims trailing whitespace turns a blank context line
  // into a blank line; `\ No newline at end of file` and anything else is not a
  // line of the file at all.
  if (line.startsWith(' ') || line.length === 0) return 'ctx';
  return undefined;
}

function pushBody(draft: Draft, kind: DiffRow['kind'], text: string): void {
  if (kind === 'add') {
    draft.rows.push({ kind, text, ...(draft.newNo === undefined ? {} : { newNo: draft.newNo }) });
    draft.added += 1;
    if (draft.newNo !== undefined) draft.newNo += 1;
    return;
  }
  if (kind === 'del') {
    draft.rows.push({ kind, text, ...(draft.oldNo === undefined ? {} : { oldNo: draft.oldNo }) });
    draft.removed += 1;
    if (draft.oldNo !== undefined) draft.oldNo += 1;
    return;
  }
  draft.rows.push({
    kind: 'ctx',
    text,
    ...(draft.oldNo === undefined ? {} : { oldNo: draft.oldNo }),
    ...(draft.newNo === undefined ? {} : { newNo: draft.newNo }),
  });
  if (draft.oldNo !== undefined) draft.oldNo += 1;
  if (draft.newNo !== undefined) draft.newNo += 1;
}

/**
 * What sits between two hunks, if anything.
 *
 * A hunk header's trailing text is the enclosing function or class — git prints
 * it for the same reason, because "12 unchanged lines" says how far the reader
 * jumped and the anchor says where they landed. When the patch carries numbers
 * the count is known exactly; when it does not, the row says only that
 * something was skipped, which is all that is true.
 */
function hunkGap(draft: Draft, oldStart: number | undefined, anchor: string): DiffRow | undefined {
  const base = draft.sawHunk ? draft.oldNo : 1;
  const skipped = oldStart !== undefined && base !== undefined ? oldStart - base : undefined;

  if (skipped !== undefined) {
    if (skipped <= 0) return anchor === '' ? undefined : { kind: 'gap', text: anchor };
    return {
      kind: 'gap',
      text: anchor === '' ? `${skipped} unchanged line${skipped === 1 ? '' : 's'}` : anchor,
      skipped,
    };
  }

  // The first hunk of a numberless patch: nothing is known to precede it, and a
  // gap row at the top would be an assertion that something does.
  if (!draft.sawHunk && anchor === '') return undefined;
  return { kind: 'gap', text: anchor === '' ? 'unchanged lines' : anchor };
}

function toFileEdit(draft: Draft): FileEdit {
  const rows = pairSpans(draft.rows);
  const overflow = rows.length > MAX_ROWS;
  return {
    path: draft.path,
    extension: extensionOf(draft.path),
    rows: overflow ? rows.slice(0, MAX_ROWS) : rows,
    added: draft.added,
    removed: draft.removed,
    truncated: overflow || draft.truncated,
    // An added file is whole new content by definition; a deleted one is the
    // opposite, and neither is a fragment.
    whole: draft.operation === 'add',
    operation: draft.operation,
    ...(draft.renamedFrom === undefined ? {} : { renamedFrom: draft.renamedFrom }),
  };
}

/* -------------------------------------------------------------------------- */
/* Files named but not shown                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Files a call names without saying what it did to them.
 *
 * The last resort, and the only branch that produces a {@link FileEdit} with no
 * diff in it. A list of paths is what an adapter sends when it has nothing
 * more, and a change ledger that lists the files a run touched is still worth
 * having when the diffs are missing. An entry that carries a diff beside its
 * path is read in full, which is how a Codex patch arrives today.
 */
function detectNamedFiles(toolName: string, input: JsonObject): readonly FileEdit[] {
  if (!MUTATION_NAME.test(toolName)) return [];

  const list = FILE_LIST_KEYS.map((key) => input[key]).find(isJsonArray);
  if (list === undefined) return [];

  const edits: FileEdit[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (entry.length > 0) edits.push(namedFile(entry, undefined));
      continue;
    }
    if (!isJsonObject(entry)) continue;

    const path = pathOf(entry);
    // An entry that carries its own diff is not summary-only at all. Nothing
    // emits this today; it is the shape the follow-up in the mapper produces.
    const patch = PATCH_KEYS.map((key) => str(entry[key])).find(isPatchText);
    if (patch !== undefined) {
      const files = parsePatch(patch, path);
      if (files.length > 0) {
        edits.push(...files);
        continue;
      }
    }
    if (path !== undefined) edits.push(namedFile(path, operationOf(str(entry['kind']))));
  }
  return edits;
}

function namedFile(path: string, operation: FileEdit['operation']): FileEdit {
  return {
    path,
    extension: extensionOf(path),
    rows: [],
    added: 0,
    removed: 0,
    truncated: false,
    whole: false,
    summaryOnly: true,
    ...(operation === undefined ? {} : { operation }),
  };
}

function operationOf(kind: string | undefined): FileEdit['operation'] {
  switch (kind?.toLowerCase()) {
    case 'add':
    case 'create':
      return 'add';
    case 'delete':
    case 'remove':
      return 'delete';
    case 'update':
    case 'modify':
    case 'edit':
      return 'update';
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

function build(
  path: string,
  extension: string,
  before: string,
  after: string,
  whole: boolean,
): FileEdit {
  const oldLines = before.length === 0 && whole ? [] : before.split('\n');
  const newLines = after.split('\n');

  if (oldLines.length + newLines.length > MAX_LINES) {
    return {
      path,
      extension,
      rows: [
        { kind: 'gap', text: 'Payload too large to diff', skipped: oldLines.length },
        ...newLines.slice(0, 40).map((text, i) => ({ kind: 'add' as const, text, newNo: i + 1 })),
      ],
      added: newLines.length,
      removed: oldLines.length,
      truncated: true,
      whole,
    };
  }

  const raw = diffLines(oldLines, newLines);
  const paired = pairSpans(raw);
  const collapsed = collapse(paired);

  let added = 0;
  let removed = 0;
  for (const row of raw) {
    if (row.kind === 'add') added += 1;
    else if (row.kind === 'del') removed += 1;
  }

  const truncated = collapsed.length > MAX_ROWS;
  return {
    path,
    extension,
    rows: truncated ? collapsed.slice(0, MAX_ROWS) : collapsed,
    added,
    removed,
    truncated,
    whole,
  };
}

/**
 * Line diff: strip the common prefix and suffix, then LCS the middle.
 *
 * The stripping is not an optimisation detail — it is what makes this usable.
 * A typical agent edit changes a handful of lines in a file of hundreds, and
 * the affixes account for nearly all of it, leaving an LCS table small enough
 * to be free. It also produces a better diff than LCS alone, which is free to
 * "match" identical blank lines or braces from anywhere in the file and
 * generate a shredded result.
 */
function diffLines(oldLines: readonly string[], newLines: readonly string[]): DiffRow[] {
  let start = 0;
  const maxStart = Math.min(oldLines.length, newLines.length);
  while (start < maxStart && oldLines[start] === newLines[start]) start += 1;

  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i += 1) {
    rows.push({ kind: 'ctx', text: oldLines[i] ?? '', oldNo: i + 1, newNo: i + 1 });
  }

  const midOld = oldLines.slice(start, endOld);
  const midNew = newLines.slice(start, endNew);

  if (midOld.length * midNew.length > LCS_CELL_BUDGET) {
    // Too big to align properly. A block replacement is honest — it says every
    // one of these lines changed, which is true, just less precise than it
    // could be — and it is bounded.
    midOld.forEach((text, i) => rows.push({ kind: 'del', text, oldNo: start + i + 1 }));
    midNew.forEach((text, i) => rows.push({ kind: 'add', text, newNo: start + i + 1 }));
  } else {
    rows.push(...lcsRows(midOld, midNew, start));
  }

  for (let i = 0; i < oldLines.length - endOld; i += 1) {
    rows.push({
      kind: 'ctx',
      text: oldLines[endOld + i] ?? '',
      oldNo: endOld + i + 1,
      newNo: endNew + i + 1,
    });
  }
  return rows;
}

/** Classic LCS table walk. Only ever called on a window inside the budget. */
function lcsRows(a: readonly string[], b: readonly string[], offset: number): DiffRow[] {
  const n = a.length;
  const m = b.length;
  // (n+1)*(m+1) Int32 cells; the budget above keeps this to about 1 MB worst case.
  const table = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => table[i * (m + 1) + j] ?? 0;

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * (m + 1) + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'ctx', text: a[i] ?? '', oldNo: offset + i + 1, newNo: offset + j + 1 });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      rows.push({ kind: 'del', text: a[i] ?? '', oldNo: offset + i + 1 });
      i += 1;
    } else {
      rows.push({ kind: 'add', text: b[j] ?? '', newNo: offset + j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ kind: 'del', text: a[i] ?? '', oldNo: offset + i + 1 });
    i += 1;
  }
  while (j < m) {
    rows.push({ kind: 'add', text: b[j] ?? '', newNo: offset + j + 1 });
    j += 1;
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Intra-line spans                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Mark the characters that actually changed on lines that pair up.
 *
 * Without this a one-character change to a 200-character line renders as a
 * whole red line above a whole green line, and finding the difference is left
 * to the reader — which is exactly the work the diff was supposed to do. Only
 * runs where deletions and additions are the same length are paired: anything
 * else is an insertion or a removal rather than a modification, and inventing a
 * correspondence would highlight noise.
 */
function pairSpans(rows: readonly DiffRow[]): DiffRow[] {
  const out: DiffRow[] = [];
  let index = 0;

  while (index < rows.length) {
    const row = rows[index];
    if (row === undefined) break;
    if (row.kind !== 'del') {
      out.push(row);
      index += 1;
      continue;
    }

    let delEnd = index;
    while (rows[delEnd]?.kind === 'del') delEnd += 1;
    let addEnd = delEnd;
    while (rows[addEnd]?.kind === 'add') addEnd += 1;

    const dels = rows.slice(index, delEnd);
    const adds = rows.slice(delEnd, addEnd);

    if (dels.length > 0 && dels.length === adds.length) {
      for (let k = 0; k < dels.length; k += 1) {
        const del = dels[k];
        const add = adds[k];
        if (!del || !add) continue;
        const [delSpans, addSpans] = charSpans(del.text, add.text);
        out.push({ ...del, spans: delSpans });
        adds[k] = { ...add, spans: addSpans };
      }
      out.push(...adds);
    } else {
      out.push(...dels, ...adds);
    }
    index = addEnd;
  }
  return out;
}

/**
 * The differing middles of two strings, as one span each.
 *
 * Prefix/suffix trimming rather than a character-level LCS: it is O(n), it
 * cannot produce the confetti a character LCS makes of reordered code, and for
 * the case this exists to serve — a renamed identifier, a changed literal, an
 * added argument — it lands on exactly the right range.
 */
function charSpans(
  before: string,
  after: string,
): [readonly (readonly [number, number])[], readonly (readonly [number, number])[]] {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start += 1;

  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }

  // A line whose every character differs gets no spans: highlighting the whole
  // line adds nothing over the row's own colour.
  if (start === 0 && endBefore === before.length && endAfter === after.length) return [[], []];

  return [
    endBefore > start ? [[start, endBefore] as const] : [],
    endAfter > start ? [[start, endAfter] as const] : [],
  ];
}

/* -------------------------------------------------------------------------- */
/* Context collapsing                                                         */
/* -------------------------------------------------------------------------- */

/** Replace long unchanged runs with a single gap row. */
function collapse(rows: readonly DiffRow[]): DiffRow[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, i) => {
    if (row.kind === 'add' || row.kind === 'del') {
      for (let k = Math.max(0, i - CONTEXT_LINES); k <= Math.min(rows.length - 1, i + CONTEXT_LINES); k += 1) {
        keep[k] = true;
      }
    }
  });

  const out: DiffRow[] = [];
  let skipped = 0;
  rows.forEach((row, i) => {
    if (keep[i]) {
      if (skipped > 0) {
        out.push({ kind: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}`, skipped });
        skipped = 0;
      }
      out.push(row);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) {
    out.push({ kind: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}`, skipped });
  }
  return out;
}
