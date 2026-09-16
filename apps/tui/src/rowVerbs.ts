/**
 * What a row answers to, and how much of it the fold is holding back.
 *
 * A transcript row is not only text. A tool call that rewrote a file knows
 * which file and which line; a `Bash` row knows the command it ran; every row
 * knows the text it would be if you pasted it somewhere. Until now none of
 * that was reachable: the conversation was a picture of what happened, and
 * acting on any of it meant retyping a path the agent had already printed.
 *
 * So each row gets **verbs** — a small ordered list of `key`, `label`, `kind`
 * — and the cursor in the viewport prints them as a hint under the row it is
 * on. The list is data rather than a chain of `if`s at the keystroke, for the
 * same reason `keymap.ts` is data: the hint the reader sees and the keys the
 * app answers are then one thing, and a key cannot go on being advertised
 * after the row it belonged to stopped offering it.
 *
 * Each verb that needs a payload has a function here that produces it —
 * {@link rowTarget} for `o`, {@link rowCommand} for `r`, {@link rowDiff} for
 * `d`, {@link rowYankText} for `y` — and `rowVerbs` offers the verb exactly
 * when that function returns something. One decision, one place; a verb that
 * is offered can always be carried out.
 *
 * Pure, and free of Ink: none of this draws anything, and all of it is worth
 * testing without mounting a terminal.
 *
 * ## Why the fold's sizes live here
 *
 * `Enter unfold` has to know whether anything is behind the fold, which is the
 * same question the row asks when it decides how much to draw. Two copies of
 * "three lines of a result, twenty of an edit" would drift, and the failure
 * would be silent and exactly backwards: a row offering to unfold something it
 * is already showing whole, or holding lines back with no key that reveals
 * them. So the sizes are here, `components/Transcript.tsx` imports them, and
 * the preview and the verb cannot disagree.
 */

import {
  basename,
  classifyTool,
  describeActivity,
  detectFileEdit,
  formatDuration,
  formatTokens,
  formatUsd,
  oneLine,
  summarizeToolInput,
  totalInputTokens,
  type ActivityGroup,
  type FileEdit,
  type ToolItem,
  type TranscriptItem,
} from '@rx-artemis/transcript';

/* -------------------------------------------------------------------------- */
/* How much a collapsed row shows                                             */
/* -------------------------------------------------------------------------- */

/**
 * How much of what a call returned is shown, and how it is split.
 *
 * Head *and* tail rather than head alone. The head says which call this was;
 * the tail is where the error is — a build that fails prints two hundred lines
 * and the one that matters is the last of them — so a preview that is all head
 * is a preview of the half nobody needs. The count between them says how much
 * is missing and which key shows it.
 */
export const RESULT_HEAD = 2;
export const RESULT_TAIL = 1;

/**
 * How much of a diff is shown. An edit is usually small and the change is the
 * point, so most of it fits; a whole written file is content rather than
 * change, and a screenful of `+` lines says nothing a count does not.
 */
export const EDIT_LINES = 20;
export const WRITE_LINES = 6;

/**
 * The lines of a call's result that a preview is made of.
 *
 * Blank lines go: a result that is mostly whitespace would otherwise spend its
 * three-line budget on nothing. Empty for a call that wrote a file — the diff
 * is the interesting half and the row draws that instead — and for a call that
 * did not return normally, whose row says what went wrong rather than what
 * came back.
 *
 * `edit` is passed in rather than detected here because the caller has already
 * paid for it: recognising an edit means diffing it.
 */
export function resultPreviewLines(item: ToolItem, edit: FileEdit | null): readonly string[] {
  if (edit !== null || item.status !== 'ok' || item.resultText === undefined) return [];
  return item.resultText.split('\n').filter((line) => line.trim().length > 0);
}

/* -------------------------------------------------------------------------- */
/* The verbs                                                                  */
/* -------------------------------------------------------------------------- */

/** What the app does when the key is pressed. The label is for the reader. */
export type RowVerbKind = 'open' | 'rerun' | 'yank' | 'diff' | 'unfold' | 'stop';

export interface RowVerb {
  /** The press, spelled as the hint prints it: a letter, or `Enter`. */
  readonly key: string;
  /** What it does, in the fewest words that still say it. */
  readonly label: string;
  readonly kind: RowVerbKind;
}

/** A row of the transcript: an item, or the group a run's calls fold into. */
export type Row = TranscriptItem | ActivityGroup;

/** Where a row points in the tree, for the verb that opens an editor there. */
export interface RowTarget {
  readonly path: string;
  /** Where to put the cursor, when the row knows. */
  readonly line?: number;
}

const RERUN: RowVerb = { key: 'r', label: 're-run', kind: 'rerun' };
const DIFF: RowVerb = { key: 'd', label: 'diff', kind: 'diff' };
const YANK: RowVerb = { key: 'y', label: 'yank', kind: 'yank' };
const UNFOLD: RowVerb = { key: 'Enter', label: 'unfold', kind: 'unfold' };
const STOP: RowVerb = { key: 'x', label: 'stop', kind: 'stop' };

/** A group is an item's other shape; only items carry a `kind`. */
function isGroup(row: Row): row is ActivityGroup {
  return !('kind' in row);
}

/**
 * The verbs this row offers, in a fixed order.
 *
 * Fixed rather than by prominence, because the hint is read at a glance and a
 * key that moves between rows is a key nobody learns: `o` is always first when
 * it is there at all, `y` is always the one before last. Every row has `y` —
 * there is no row whose text is not worth taking — and everything else depends
 * on what the row is.
 */
export function rowVerbs(row: Row): readonly RowVerb[] {
  if (isGroup(row)) {
    const verbs: RowVerb[] = [YANK];
    // Only when the fold is actually holding calls back. A run whose every
    // call failed is already drawn in full, and offering to unfold it would
    // promise a change of view that never comes.
    if (hiddenCalls(row) > 0) verbs.push(UNFOLD);
    if (row.running > 0) verbs.push(STOP);
    return verbs;
  }

  const edit = row.kind === 'tool' ? detectFileEdit(row.name, row.input) : null;
  const verbs: RowVerb[] = [];

  if (row.kind === 'tool') {
    const target = targetOf(row, edit);
    // The basename, not the path: the hint has one line and the reader is
    // looking at the full path on the row above it already.
    if (target !== null) verbs.push({ key: 'o', label: `open ${basename(target.path)}`, kind: 'open' });
  }
  if (rowCommand(row) !== null) verbs.push(RERUN);
  if (edit !== null && edit.rows.length > 0) verbs.push(DIFF);
  verbs.push(YANK);
  if (isCut(row, edit)) verbs.push(UNFOLD);
  if (row.kind === 'tool' && row.status === 'running') verbs.push(STOP);
  return verbs;
}

/**
 * The verbs as one line of hint: `o open · d diff · y yank · Enter unfold`.
 *
 * The same separator the rest of the terminal uses for a run of small facts,
 * so the hint reads as part of the furniture rather than as a menu that has
 * opened over the conversation.
 */
export function rowVerbHint(verbs: readonly RowVerb[]): string {
  return verbs.map((verb) => `${verb.key} ${verb.label}`).join(' · ');
}

/** Calls the collapsed group is holding behind its count. */
function hiddenCalls(group: ActivityGroup): number {
  // What is running or went wrong is never folded, so the rest is what the
  // summary stands for. See `GroupRow`, which hides exactly these.
  return Math.max(0, group.ids.length - group.running - group.failed);
}

/** Whether the collapsed row is holding anything back. */
function isCut(item: TranscriptItem, edit: FileEdit | null): boolean {
  if (item.kind === 'permission') {
    // A note is flattened to one line and clipped until the row is unfolded,
    // so a note that survives that whole is not cut at all.
    const note = item.note;
    return note !== undefined && note.length > 0 && oneLine(note, 120) !== note;
  }
  if (item.kind !== 'tool') return false;
  if (edit !== null) return edit.rows.length > (edit.removed === 0 ? WRITE_LINES : EDIT_LINES);
  return resultPreviewLines(item, edit).length > RESULT_HEAD + RESULT_TAIL + 1;
}

/* -------------------------------------------------------------------------- */
/* What each verb acts on                                                     */
/* -------------------------------------------------------------------------- */

/** Argument names a file path arrives under, across the providers. */
const PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path', 'file'];

/** Argument names a shell line arrives under. */
const COMMAND_KEYS = ['command', 'cmd', 'script'];

/**
 * The file a row is about, and where in it to land.
 *
 * An edit knows both: the path it rewrote, and the first line it changed —
 * which is the number the reader wants, because a diff read on a screen is
 * answered by opening the file *at the change* rather than at the top. A call
 * that only read or wrote a named file knows the path alone, and `+1` is as
 * good an answer as any for where to start in it.
 *
 * Deliberately narrow about which calls count. A `Glob` or a `Grep` carries a
 * `path` too, and it is a directory it searched; offering to open that in an
 * editor would be a verb that does something surprising on rows where it is
 * least expected.
 */
export function rowTarget(item: TranscriptItem): RowTarget | null {
  if (item.kind !== 'tool') return null;
  return targetOf(item, detectFileEdit(item.name, item.input));
}

function targetOf(item: ToolItem, edit: FileEdit | null): RowTarget | null {
  if (edit !== null && edit.path.length > 0) {
    const line = firstChangedLine(edit);
    return line === undefined ? { path: edit.path } : { path: edit.path, line };
  }
  const category = classifyTool(item.name);
  if (category !== 'read' && category !== 'edit') return null;
  const path = PATH_KEYS.map((key) => item.input[key]).find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return path === undefined ? null : { path };
}

/**
 * The new-file line number of the first row a diff changed.
 *
 * `newNo` and not `oldNo`, because the file being opened is the one on disk,
 * which is the new one — and a deletion has no line in it at all. So a run of
 * deletions is answered by the line that replaced them where one did, and
 * otherwise by the line that closed over the gap, which is where the removed
 * text used to begin. A diff of nothing but context answers nothing.
 */
function firstChangedLine(edit: FileEdit): number | undefined {
  let above: number | undefined;
  for (const [index, row] of edit.rows.entries()) {
    if (row.kind === 'add') return row.newNo ?? (above ?? 0) + 1;
    if (row.kind !== 'del') {
      if (row.newNo !== undefined) above = row.newNo;
      continue;
    }
    let after = index;
    while (edit.rows[after]?.kind === 'del') after += 1;
    const replacement = edit.rows[after];
    return (replacement?.kind === 'add' ? replacement.newNo : undefined) ?? (above ?? 0) + 1;
  }
  return undefined;
}

/**
 * The shell line a row ran, for the verb that puts it back in the composer.
 *
 * Two rows have one: a tool call the provider classifies as a command, and the
 * `!` line a person ran themselves. Some providers send the command as argv
 * rather than as a line, which is joined back up — a row that re-runs
 * `["pnpm","test"]` would otherwise put a JSON array in the box.
 */
export function rowCommand(item: TranscriptItem): string | null {
  if (item.kind === 'command') {
    if (item.source !== 'shell') return null;
    const args = item.args === undefined || item.args.length === 0 ? '' : ` ${item.args}`;
    return `${item.name}${args}`;
  }
  if (item.kind !== 'tool' || classifyTool(item.name) !== 'command') return null;
  for (const key of COMMAND_KEYS) {
    const value = item.input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === 'string') && value.length > 0) {
      return value.join(' ');
    }
  }
  return null;
}

/**
 * The diff a row wrote, for the verb that shows the whole of it.
 *
 * The same edit the row drew a preview of, so what `d` opens is the rest of
 * what is already on the screen and not a second reading of the arguments. A
 * call that names files without saying what it did to them has no rows and is
 * not offered: a diff view of nothing is a blank box with a border.
 */
export function rowDiff(item: TranscriptItem): FileEdit | null {
  if (item.kind !== 'tool') return null;
  const edit = detectFileEdit(item.name, item.input);
  return edit === null || edit.rows.length === 0 ? null : edit;
}

/* -------------------------------------------------------------------------- */
/* The row as text                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One row, as the text a person means when they say "copy that".
 *
 * The same reading `exportTranscript.ts` takes of a whole conversation, minus
 * the document around it: speech goes out as the markdown source it arrived
 * as, so it round-trips into whatever renders it next; an edit goes out as a
 * unified diff, which is the one rendering of an edit that can be pasted into
 * a review and still read; everything else goes out as the line the row draws,
 * with what it returned under it. Nothing is folded — the fold is a property
 * of a screen with a finite number of lines, and the clipboard has none.
 *
 * `members` is only wanted for a group, whose calls live in the model rather
 * than on the group itself.
 */
export function rowYankText(row: Row, members: readonly TranscriptItem[] = []): string {
  if (isGroup(row)) {
    const calls = members.filter((member): member is ToolItem => member.kind === 'tool');
    return [describeActivity(row.counts, row.running > 0), ...calls.map(toolText)]
      .filter((block) => block.length > 0)
      .join('\n\n');
  }

  switch (row.kind) {
    case 'user':
      return row.text;
    case 'assistant':
      return row.text;
    case 'thinking':
      return row.redacted ? 'Thinking (redacted)' : row.text;
    case 'tool':
      return toolText(row);
    case 'permission': {
      const note = row.note === undefined || row.note.length === 0 ? '' : `: ${row.note}`;
      return `${row.request.toolName} — ${row.state}${note}`;
    }
    case 'notice':
      return [row.text, row.detail].filter((part): part is string => part !== undefined).join('\n');
    case 'command': {
      const mark = row.source === 'shell' ? '$' : '/';
      const args = row.args === undefined || row.args.length === 0 ? '' : ` ${row.args}`;
      return [`${mark} ${row.name}${args}`, row.output?.trimEnd() ?? '']
        .filter((part) => part.length > 0)
        .join('\n');
    }
    case 'run-end': {
      const tokens = totalInputTokens(row.usage?.tokens);
      const parts = [
        row.reason === 'completed' ? undefined : row.reason === 'interrupted' ? 'Interrupted' : row.reason.replace(/_/g, ' '),
        row.silent ? 'no reply' : undefined,
        row.durationMs === undefined ? undefined : formatDuration(row.durationMs),
        tokens === undefined ? undefined : `${formatTokens(tokens)} tok`,
        row.usage?.costUsd === undefined ? undefined : formatUsd(row.usage.costUsd),
      ].filter((part): part is string => part !== undefined);
      const why = row.error === undefined ? '' : ` — ${row.error.message}`;
      return `${parts.join(' · ')}${why}`;
    }
    default: {
      const unhandled: never = row;
      void unhandled;
      return '';
    }
  }
}

/** One call: the line the row draws, and under it the diff or the result. */
function toolText(call: ToolItem): string {
  const summary = summarizeToolInput(call.input);
  const head =
    call.title !== undefined && call.title.length > 0
      ? call.title
      : summary.length > 0
        ? `${call.name}(${summary})`
        : call.name;

  const edit = detectFileEdit(call.name, call.input);
  if (edit !== null && edit.rows.length > 0) return [head, ...unifiedDiff(edit)].join('\n');

  const error = call.error === undefined ? '' : `Error: ${call.error.message}`;
  return [head, call.resultText?.trimEnd() ?? '', error].filter((part) => part.length > 0).join('\n');
}

/**
 * A file edit as unified-diff lines.
 *
 * The `---`/`+++` header earns its two lines: it is what makes the block
 * something a review tool will accept rather than a decorated excerpt, and it
 * names the file once the row it came from is no longer in front of the
 * reader. A write has no "before", and says so the way `diff` itself does.
 */
function unifiedDiff(edit: FileEdit): readonly string[] {
  const lines = [edit.whole ? '--- /dev/null' : `--- ${edit.path}`, `+++ ${edit.path}`];
  for (const row of edit.rows) {
    if (row.kind === 'add') lines.push(`+${row.text}`);
    else if (row.kind === 'del') lines.push(`-${row.text}`);
    else if (row.kind === 'ctx') lines.push(` ${row.text}`);
    else lines.push(`@@ … ${String(row.skipped ?? 0)} unchanged lines @@`);
  }
  if (edit.truncated) lines.push('@@ … clipped for size @@');
  return lines;
}
