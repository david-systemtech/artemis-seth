/**
 * The conversation as text you can take with you.
 * ============================================================================
 *
 * Two things every other agent terminal offers and this one did not: `/copy`,
 * which puts the last reply on the clipboard, and `/export`, which writes the
 * whole conversation out as markdown. Both are the same idea — the transcript
 * is a model, not a screen, and it should be possible to get the model back out
 * as text — so both live here, as pure functions over a {@link TranscriptModel}.
 *
 * Pure on purpose. The clipboard is four programs wearing one name (see
 * `clipboard.ts`) and writing a file is I/O; neither has anything to do with
 * deciding what the text *says*, and the deciding is the part worth testing. So
 * nothing in this file touches the filesystem, the clipboard or the process.
 *
 * ## What the markdown is for
 *
 * A pasted export has to survive two very different readers: a person skimming
 * it in a chat window, and a markdown renderer. That drives most of the shape
 * decisions below.
 *
 *  - **Headings, not blockquotes, for the turns.** `## You` / `## Agent` is
 *    greppable, folds in every outliner, and — crucially — leaves the agent's
 *    own markdown *untouched*. Quoting a reply means prefixing every line with
 *    `> `, which turns its fenced code blocks into quoted fenced code blocks and
 *    destroys the round trip. The reply goes in exactly as the model holds it.
 *  - **The work is bullets, the output is fences.** A tool call is one line you
 *    can skim past; what it returned is a fenced block underneath, cut at
 *    {@link MAX_OUTPUT_LINES} because a `Bash` that cats a log should not be the
 *    bulk of the document. An edit comes out as a fenced `diff`, which is the
 *    one rendering of an edit that pastes into a review and still reads.
 *  - **Fences are counted, not assumed.** Tool output frequently contains
 *    ``` — it is often itself markdown — so every fence here is opened with one
 *    more backtick than the longest run inside it. Same for inline code.
 *  - **Thinking is off by default and folded when on.** It is the model working
 *    out what to say rather than the saying of it; in a document handed to
 *    someone else it is noise, and `<details>` is the one fold that works in
 *    GitHub, most chat renderers and plain text alike.
 *
 * ## Order
 *
 * The same order the terminal draws — see `inOrderOfStart` in
 * `components/Transcript.tsx`, whose rule is copied here rather than imported
 * because importing it would drag Ink into a module that has no business
 * rendering anything. The model parks a run's calls in one group at the *foot*
 * of the run, which is right for a desktop pane where the fold sits under the
 * prose and wrong for a document read top to bottom: it puts "Ran 3 commands"
 * after the answer those commands produced. Sorting rows by when they started
 * puts the fold where the first call was made. The sort is stable, so rows that
 * began in the same millisecond keep the model's own order.
 *
 * ## A folded group, unfolded
 *
 * The screen folds a run's calls into one summary line and shows only what
 * failed, because forty rows of machinery between two sentences is unreadable.
 * A document has no such pressure — nothing is scrolling past — and an export
 * that dropped every successful call would be missing the entire record of what
 * the agent *did*, including every diff it wrote. So the group contributes its
 * summary sentence as a lead-in and then its calls in full. `toolOutput: false`
 * is the reading copy: the summary, and the failures the screen never hides.
 */

import {
  describeActivity,
  detectFileEdit,
  formatDuration,
  formatJson,
  formatTokens,
  formatUsd,
  isGroupId,
  oneLine,
  summarizeToolInput,
  totalInputTokens,
  type FileEdit,
  type ToolItem,
  type TranscriptItem,
  type TranscriptModel,
} from '@rx-artemis/transcript';

/* -------------------------------------------------------------------------- */
/* The last reply                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The text of the most recent thing the agent said, as markdown source.
 *
 * What `/copy` copies. Source and not a rendering: the point of copying a reply
 * is to paste it somewhere that will render it again, and the terminal's own
 * rendering is ANSI escapes and hard-wrapped lines.
 *
 * Walks back over the items rather than the rows because it wants the *last*
 * one, and a reply that is still streaming or that ended empty is not it — a
 * provider routinely opens a text block it never fills, and copying that would
 * silently put the empty string on the clipboard. One item, not one message: a
 * message can be several blocks with tool calls between them, and the thing a
 * person means by "the last reply" is the paragraph at the bottom of the screen.
 */
export function lastAssistantText(model: TranscriptModel): string | null {
  const ids = model.getListSnapshot();
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const id = ids[i];
    if (id === undefined) continue;
    const item = model.getItem(id);
    if (item?.kind !== 'assistant') continue;
    if (item.text.trim().length === 0) continue;
    return item.text;
  }
  return null;
}

/** One fenced block of a reply. `lang` is `''` when the fence named no language. */
export interface CodeBlock {
  readonly lang: string;
  readonly code: string;
}

/**
 * The fenced code blocks of a piece of markdown, in order.
 *
 * `/copy` offers "the whole reply, or one of its code blocks", which is the
 * thing people actually want most of the time: the agent explained something
 * and the part you need is the command in the middle of it.
 *
 * CommonMark's fence rules, as far as they matter here: a fence is three or
 * more backticks or tildes, indented up to three spaces; it closes on a fence of
 * the same character and at least the same length with nothing after it; an
 * unclosed fence runs to the end of the document; and the opening indent is
 * stripped from each line of the body. The info string's first word is the
 * language, so ```` ```ts title=x ```` is `ts`.
 */
export function codeBlocksOf(text: string): readonly CodeBlock[] {
  const lines = text.split('\n');
  const blocks: CodeBlock[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE.exec(lines[i] ?? '');
    if (open === null) continue;

    const indent = (open[1] ?? '').length;
    const fence = open[2] ?? '';
    const lang = (open[3] ?? '').trim().split(/\s+/)[0] ?? '';
    const body: string[] = [];

    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const line = lines[j] ?? '';
      if (closes(line, fence)) break;
      body.push(undent(line, indent));
    }

    blocks.push({ lang, code: body.join('\n') });
    i = j;
  }

  return blocks;
}

/** Opening or closing fence: up to three spaces, three or more ``` or ~~~. */
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n`]*)$/;

function closes(line: string, fence: string): boolean {
  const match = FENCE.exec(line);
  if (match === null) return false;
  const bars = match[2] ?? '';
  return bars[0] === fence[0] && bars.length >= fence.length && (match[3] ?? '').trim().length === 0;
}

/** Strip at most `indent` leading spaces — the opening fence's own indent. */
function undent(line: string, indent: number): string {
  let cut = 0;
  while (cut < indent && line[cut] === ' ') cut += 1;
  return line.slice(cut);
}

/* -------------------------------------------------------------------------- */
/* The whole conversation                                                     */
/* -------------------------------------------------------------------------- */

export interface ExportOptions {
  /** Include the agent's reasoning, folded into `<details>`. Off by default. */
  readonly thinking?: boolean;
  /**
   * Include what each call returned, and the successful calls themselves.
   *
   * On by default — an export is a record. Off gives a reading copy: prose, the
   * one-line summary of each run's work, and the calls that failed.
   */
  readonly toolOutput?: boolean;
  /** Heading for the document. Omitted entirely when absent. */
  readonly title?: string;
  /** When the conversation began. Defaults to the first row's timestamp. */
  readonly startedAt?: number;
}

/** Lines of one tool result or one diff past which the rest is a count. */
export const MAX_OUTPUT_LINES = 200;

/**
 * The conversation as a markdown document.
 *
 * See the file header for the shape and why it is that shape. Never throws: a
 * transcript is whatever a provider sent, and an export that failed on a
 * malformed row would fail at the one moment someone was trying to save it.
 */
export function transcriptToMarkdown(model: TranscriptModel, options: ExportOptions = {}): string {
  const withThinking = options.thinking === true;
  const withOutput = options.toolOutput !== false;

  const blocks: string[] = [];
  /** Which heading is open, so consecutive blocks of one turn share it. */
  let voice: 'You' | 'Agent' | null = null;

  /** Anything that is not speech closes the open heading. */
  const emit = (block: string): void => {
    if (block.length === 0) return;
    voice = null;
    blocks.push(block);
  };
  const say = (who: 'You' | 'Agent', body: string): void => {
    if (body.length === 0) return;
    if (voice !== who) blocks.push(`## ${who}`);
    voice = who;
    blocks.push(body);
  };

  if (options.title !== undefined && options.title.trim().length > 0) {
    emit(`# ${oneLine(options.title, 200)}`);
  }
  const meta = [dateLine(options.startedAt ?? firstTimestamp(model)), folderOf(model)].filter(
    (part): part is string => part !== undefined,
  );
  if (meta.length > 0) emit(`_${meta.join(' · ')}_`);

  for (const rowId of inOrderOfStart(model.getRowsSnapshot(), model)) {
    if (isGroupId(rowId)) {
      const group = model.getGroup(rowId);
      if (group === undefined) continue;
      const summary = describeActivity(group.counts, group.running > 0);
      if (summary.length > 0) emit(`- ${summary}`);
      for (const memberId of group.ids) {
        const call = model.getItem(memberId);
        if (call?.kind !== 'tool') continue;
        if (!withOutput && !failed(call)) continue;
        for (const block of toolBlocks(call, withOutput)) emit(block);
      }
      continue;
    }

    const item = model.getItem(rowId);
    if (item === undefined) continue;
    for (const block of itemBlocks(item, withThinking, withOutput)) {
      if (block.voice === undefined) emit(block.text);
      else say(block.voice, block.text);
    }
  }

  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}

/** A block of the document, and whose turn it belongs under if anyone's. */
interface Block {
  readonly text: string;
  readonly voice?: 'You' | 'Agent';
}

/**
 * One row of the transcript, as blocks.
 *
 * Exhaustive on `kind` so that a new kind of row is a compile error here rather
 * than something quietly missing from every export — the same argument
 * `searchableText` makes in `packages/transcript/src/search.ts`.
 */
function itemBlocks(item: TranscriptItem, withThinking: boolean, withOutput: boolean): readonly Block[] {
  switch (item.kind) {
    case 'user': {
      const blocks: Block[] = [{ text: body(item.text), voice: 'You' }];
      const images = item.attachments?.length ?? 0;
      // Said without words. An export that dropped them silently would claim
      // the person sent a bare sentence when they sent a screenshot with it.
      if (images > 0) blocks.push({ text: `_${String(images)} image${images === 1 ? '' : 's'} attached_`, voice: 'You' });
      return blocks;
    }

    case 'assistant':
      // Exactly as the model holds it: the point of the export is that the
      // reply round-trips into whatever renders it next.
      return [{ text: body(item.text), voice: 'Agent' }];

    case 'thinking': {
      if (!withThinking) return [];
      const text = item.redacted ? '_Thinking (redacted)_' : body(item.text);
      if (text.length === 0) return [];
      // Blank lines inside the element on purpose: that is what tells a
      // CommonMark renderer the HTML block has ended and the markdown in it is
      // markdown again.
      return [{ text: `<details><summary>Thinking</summary>\n\n${text}\n\n</details>` }];
    }

    case 'tool':
      return toolBlocks(item, withOutput).map((text) => ({ text }));

    case 'permission': {
      const note = item.note === undefined ? '' : `: ${oneLine(item.note, 200)}`;
      return [{ text: `- ⚿ ${item.request.toolName} — ${item.state}${note}` }];
    }

    case 'notice': {
      const glyph = item.level === 'error' ? '✗' : item.level === 'warn' ? '!' : 'ℹ';
      const lines = [item.text, ...(item.detail === undefined ? [] : [item.detail])].join('\n').split('\n');
      return [{ text: lines.map((line, i) => (i === 0 ? `> ${glyph} ${line}` : `> ${line}`)).join('\n') }];
    }

    case 'command': {
      const args = item.args === undefined || item.args.length === 0 ? '' : ` ${item.args}`;
      // The shell's prompt character for a `!` line: exported as `/ git status`
      // it reads as a slash command, and the document is read by people who
      // would go looking for one.
      const mark = item.source === 'shell' ? '$' : '/';
      const blocks: Block[] = [{ text: `- ${mark} ${item.name}${args}${item.failed === true ? ' — failed' : ''}` }];
      if (withOutput && item.output !== undefined && item.output.trim().length > 0) {
        blocks.push({ text: fence(cap(item.output.split('\n')).join('\n')) });
      }
      return blocks;
    }

    case 'run-end': {
      const tokens = totalInputTokens(item.usage?.tokens);
      const parts = [
        item.durationMs === undefined ? undefined : formatDuration(item.durationMs),
        tokens === undefined ? undefined : `${formatTokens(tokens)} tok`,
        item.usage?.costUsd === undefined ? undefined : formatUsd(item.usage.costUsd),
      ].filter((part): part is string => part !== undefined);

      if (item.reason === 'completed') {
        // A run that produced nothing is named rather than left as a bare
        // duration: `52ms · 0 tok` on its own reads as the agent shrugging.
        const words = [...(item.silent ? ['no reply'] : []), ...parts];
        return words.length === 0 ? [] : [{ text: `_${words.join(' · ')}_` }];
      }

      const how = item.reason === 'interrupted' ? 'Interrupted' : item.reason.replace(/_/g, ' ');
      const why = item.error === undefined ? '' : ` — ${oneLine(item.error.message, 300)}`;
      return [{ text: `_${[how, ...parts].join(' · ')}${why}_` }];
    }

    default: {
      const unhandled: never = item;
      void unhandled;
      return [];
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Tool calls                                                                 */
/* -------------------------------------------------------------------------- */

function failed(call: ToolItem): boolean {
  return call.status !== 'ok' && call.status !== 'cancelled';
}

/**
 * One call: a bullet, and underneath it either the diff it wrote or what it
 * returned.
 *
 * The diff wins over the result text when both exist, for the reason the
 * terminal rows give it the same precedence — a `Write` returns "wrote 42
 * lines", and the 42 lines are the interesting half.
 */
function toolBlocks(call: ToolItem, withOutput: boolean): readonly string[] {
  const blocks = [bulletFor(call)];
  if (!withOutput) return blocks;

  const edit = detectFileEdit(call.name, call.input);
  if (edit !== null) {
    blocks.push(fence(cap(diffLines(edit)).join('\n'), 'diff'));
    return blocks;
  }

  const result = call.resultText ?? formatJson(call.result);
  if (result.trim().length > 0) blocks.push(fence(cap(result.split('\n')).join('\n')));
  return blocks;
}

function bulletFor(call: ToolItem): string {
  // `title` only as a fallback: it is the provider's own prose ("Read
  // foo.txt"), which is friendlier than the arguments but is not always there
  // and is never greppable in the way a path or a command line is.
  const gloss = summarizeToolInput(call.input) || (call.title === undefined ? '' : oneLine(call.title, 96));
  const named = gloss.length === 0 ? `**${call.name}**` : `**${call.name}** ${inlineCode(gloss)}`;
  const tail = [
    ...(call.durationMs === undefined ? [] : [formatDuration(call.durationMs)]),
    call.status,
  ];
  const why = call.error === undefined ? '' : ` — ${oneLine(call.error.message, 300)}`;
  return `- ${named} · ${tail.join(' · ')}${why}`;
}

/**
 * A {@link FileEdit} as unified-diff lines.
 *
 * The `---`/`+++` header is worth the two lines: it makes the block something
 * that can be pasted into a review tool rather than a decorated excerpt, and it
 * names the file when the bullet above has scrolled out of sight. A write has no
 * "before", so its header says so in the way `diff` itself does.
 */
function diffLines(edit: FileEdit): readonly string[] {
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

/** Cut a block of output and say by how much. */
function cap(lines: readonly string[]): readonly string[] {
  if (lines.length <= MAX_OUTPUT_LINES) return lines;
  const hidden = lines.length - MAX_OUTPUT_LINES;
  return [...lines.slice(0, MAX_OUTPUT_LINES), `… +${String(hidden)} line${hidden === 1 ? '' : 's'}`];
}

/* -------------------------------------------------------------------------- */
/* Markdown mechanics                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Text as a block of the document.
 *
 * Trailing whitespace goes, and so do leading *blank lines* — but not the
 * leading indentation of the first line that has content, because four spaces
 * there is an indented code block and trimming it would change what the text
 * means.
 */
function body(text: string): string {
  return text.replace(/^[ \t]*\r?\n+/, '').trimEnd();
}

/**
 * A fenced block whose fence is longer than anything inside it.
 *
 * Tool output is very often itself markdown, and a three-backtick fence around
 * a result that contains one ends the block in the middle of the output — the
 * rest of the document then renders as prose, or as code, depending on how many
 * more it finds. Counting is cheap and the failure is silent, which is the
 * combination that makes it worth doing every time.
 */
function fence(content: string, lang = ''): string {
  const bars = '`'.repeat(Math.max(3, longestRun(content) + 1));
  return `${bars}${lang}\n${content}\n${bars}`;
}

/** The same trick for inline code, which also has to survive a lone backtick. */
function inlineCode(text: string): string {
  const bars = '`'.repeat(longestRun(text) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${bars}${pad}${text}${pad}${bars}`;
}

function longestRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (const char of text) {
    run = char === '`' ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/* -------------------------------------------------------------------------- */
/* Where and when                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Rows in the order they began — the terminal's order.
 *
 * Copied from `inOrderOfStart` in `components/Transcript.tsx` rather than
 * imported, because that module is Ink components and this one renders text.
 * See the file header for why the model's own row order is not this one.
 */
function inOrderOfStart(ids: readonly string[], model: TranscriptModel): readonly string[] {
  const startOf = (id: string): number =>
    (isGroupId(id) ? model.getGroup(id)?.ts : model.getItem(id)?.ts) ?? 0;
  return ids
    .map((id, index) => ({ id, index, ts: startOf(id) }))
    .sort((a, b) => a.ts - b.ts || a.index - b.index)
    .map((entry) => entry.id);
}

function firstTimestamp(model: TranscriptModel): number | undefined {
  for (const id of model.getListSnapshot()) {
    const ts = model.getItem(id)?.ts;
    if (ts !== undefined && ts > 0) return ts;
  }
  return undefined;
}

/** `2026-03-05 14:30`, in the reader's own timezone. */
function dateLine(ts: number | undefined): string | undefined {
  if (ts === undefined || Number.isNaN(ts)) return undefined;
  const at = new Date(ts);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Argument names that name a file the agent touched. `cwd` is handled apart. */
const PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path', 'file'];

/**
 * Which folder this conversation was about, if the transcript says.
 *
 * It does not say directly. The working directory is a fact about the *run* —
 * it arrives on `session.started`, which the model deliberately drops as
 * something that was never said — so the only record of it in a transcript is
 * the paths the agent's own calls named. A call that carries a `cwd` argument
 * settles it outright; otherwise the deepest directory every absolute path has
 * in common is a good guess and a cheap one.
 *
 * A guess, and treated as one: two shared segments at minimum, so a session that
 * read one file under `/etc` and another under `/usr` is headed with no folder
 * rather than with `/`. Wrong here costs a wrong word in a subtitle, so the
 * balance is firmly towards saying nothing.
 */
function folderOf(model: TranscriptModel): string | undefined {
  let common: readonly string[] | undefined;
  let separator = '/';

  for (const id of model.getListSnapshot()) {
    const item = model.getItem(id);
    if (item?.kind !== 'tool') continue;

    const cwd = item.input['cwd'];
    if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd;

    for (const key of PATH_KEYS) {
      const value = item.input[key];
      if (typeof value !== 'string' || !isAbsolute(value)) continue;
      if (value.includes('\\')) separator = '\\';
      const directory = value.split(/[\\/]/).slice(0, -1);
      common = common === undefined ? directory : sharedPrefix(common, directory);
    }
  }

  if (common === undefined || common.filter((part) => part.length > 0).length < 2) return undefined;
  return common.join(separator);
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function sharedPrefix(a: readonly string[], b: readonly string[]): readonly string[] {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}

/* -------------------------------------------------------------------------- */
/* The filename                                                               */
/* -------------------------------------------------------------------------- */

/** Longest slug an export's name carries. Past this it is not being read. */
const MAX_SLUG = 40;

/**
 * What to call the file `/export` writes.
 *
 * `artemis-<slug>-<yyyy-mm-dd-hhmm>.md`, and `artemis-<yyyy-mm-dd-hhmm>.md`
 * when the conversation has no title. The stamp is local time, because the
 * person naming this file has a clock in front of them and it is not UTC; it
 * includes the hour and minute because exporting twice in an afternoon is the
 * normal case and two files called `artemis-2026-03-05.md` is not a name, it is
 * a collision.
 *
 * The slug is ASCII, lowercase and dashed: accents are folded to their base
 * letters, everything else becomes a dash, and it is cut at a word boundary so
 * a long title ends on a word rather than mid-syllable.
 */
export function exportFilename(title: string | undefined, now: Date | number = new Date()): string {
  const at = typeof now === 'number' ? new Date(now) : now;
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  const slug = slugify(title ?? '');
  return slug.length === 0 ? `artemis-${stamp}.md` : `artemis-${slug}-${stamp}.md`;
}

function slugify(title: string): string {
  const ascii = title
    .normalize('NFKD')
    // Combining marks, left behind by the decomposition above: `é` is now `e`
    // plus one of these, and dropping them is what makes it `e`.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length <= MAX_SLUG) return ascii;
  const cut = ascii.slice(0, MAX_SLUG);
  const lastWord = cut.lastIndexOf('-');
  return lastWord > 0 ? cut.slice(0, lastWord) : cut;
}
