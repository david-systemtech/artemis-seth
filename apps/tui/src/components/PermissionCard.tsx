/**
 * The card that answers a `permission.request`.
 *
 * Three different things ride that one event, and each gets its own face:
 *
 *  - **An approval.** A tool wants to run. The card shows the provider's own
 *    sentence for it, the arguments (as a diff when they are an edit), and the
 *    choices: deny, allow once, and whatever standing rules the provider
 *    suggested — "allow always" is those suggestions echoed back verbatim.
 *  - **A question.** `AskUserQuestion`, decoded onto `request.question`. The
 *    card walks the questions one at a time; answering *is* allowing, and Esc
 *    is a skip — an allow with no answers, which is how the protocol spells it.
 *  - **A plan.** `ExitPlanMode`, decoded onto `request.plan`. The plan is shown
 *    as markdown and the two answers are "do that" and "think again"; there is
 *    no allow-for-session for a plan.
 *
 * Two rules from the desktop's card, carried over on purpose: **Esc denies**,
 * and **a bare Enter never authorises**. The list opens on the denying row, so
 * pressing Enter once too often does nothing worse than saying no.
 *
 * Option previews in a question are model-authored text and are shown as
 * text — never interpreted as markdown.
 *
 * ## An answer can carry a sentence
 *
 * A denial used to send one fixed sentence, which tells the model that it was
 * refused and nothing about what to do instead, so it guesses — and its guess
 * is usually the same call again. `Tab` on **Deny** opens a line for the
 * reason, and that reason becomes the decision's `message`. `Tab` on **Allow
 * once** opens the same line for what should happen *after* the tool runs;
 * that is not part of the decision, so it goes back to the caller as a second
 * argument to `onDecision` and is sent as an ordinary steer. The plan card's
 * "Think again" takes the same line, because "no" is far less useful there
 * than "no, and here is what to change".
 *
 * ## The rule is readable before it is saved
 *
 * "Allow always" echoed the provider's suggestion back verbatim with nothing on
 * screen saying what would actually be written down. Every suggested rule now
 * shows the rule itself under the row — `Bash(rm:*) · saved to project
 * settings` — `e` opens it in the same line editor so a rule too wide to want
 * can be narrowed, and `s` walks the scope it is remembered at. Neither key
 * decides anything: they change the row, the row still says what it will save,
 * and Enter on the row is what sends it. A suggestion with no `ruleContent` is
 * a bare tool name and has nothing to edit, so `e` does nothing there.
 *
 * ## What the command would touch
 *
 * `rm -rf build/*` asks a question the card cannot answer out of its own text:
 * how many files is that, and are any of them mine? So for a shell command the
 * card asks the disk instead — `blastRadius` expands the globs itself, runs
 * `git clean` with `-n`, counts the commits a force-push would drop — and draws
 * the answer as yellow `⚠` lines between the arguments and the choices. Every
 * one of those lines is a `readdir` or the command's own dry run, never a guess
 * about a filesystem nobody read.
 *
 * The preview is I/O and the card is a question with a person waiting on it, so
 * it gates nothing. The card draws and the picker answers the moment it appears;
 * the block turns up late, or shows one dim line while it is being worked out,
 * or never turns up at all. A command with nothing destructive in it gets no
 * block and no `checking` line, and neither does a preview that came back with
 * nothing to say — a `>` onto a file that is not there destroys nothing, and a
 * warning about it is a warning people learn to press Enter through.
 *
 * ## The one place Esc does not deny
 *
 * While a line is open the card is a box someone is typing in, and Esc closes
 * that box and nothing else — a denial fired by the key that gets you out of a
 * text field is a decision nobody made. The legend under the list says so for
 * as long as the line is open, because everywhere else on this card Esc is a
 * denial and that has to stay true where it is claimed.
 */

import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type {
  PermissionDecision,
  PermissionRequest,
  PermissionRule,
  PermissionRuleUpdate,
  PermissionScope,
  Question,
  QuestionAnswer,
} from '@rx-artemis/protocol';
import { classifyTool, detectFileEdit, formatJson, oneLine, summarizeToolInput } from '@rx-artemis/transcript';

import {
  blastRadiusLines,
  destructiveParts,
  previewBlastRadius,
  type Destructive,
  type Preview,
} from '../blastRadius.js';
import {
  backspace,
  cellAt,
  deleteForward,
  deleteWordLeft,
  deleteWordRight,
  editorOf,
  insert,
  killToLineEnd,
  killToLineStart,
  left,
  lineEnd,
  lineStart,
  right,
  undo,
  wordLeft,
  wordRight,
  yank,
  type EditorState,
} from '../editor.js';
import { renderDiff } from '../render/diff.js';
import { renderMarkdown } from '../render/markdown.js';
import { Picker, type PickerItem } from './Picker.js';

export const DEFAULT_DENIAL = 'The user declined this action.';

/**
 * How the card finds out what a command would touch.
 *
 * A function rather than the module itself, because {@link previewBlastRadius}
 * reads directories and starts `git` processes, and a component test that did
 * that would be a test whose result depends on the machine it runs on. The card
 * hands over the parts and the directory and takes back lines; everything about
 * how they were found is on the other side of this type.
 */
export type BlastPreview = (parts: readonly Destructive[], cwd: string) => Promise<readonly Preview[]>;

/** How much narrower than the terminal the block is: two borders, two pads, and slack. */
const BLAST_CHROME = 6;

export interface PermissionCardProps {
  readonly request: PermissionRequest;
  /**
   * The answer, and — when the user asked for something to happen after an
   * allowed call — the sentence to steer with once it has run. The follow-up
   * is deliberately not part of the decision: a decision is what the provider
   * is told about *this* tool call, and "and then commit it" is a message for
   * the turn that comes after. Callers that have nothing to steer with can
   * take the first argument alone.
   */
  readonly onDecision: (decision: PermissionDecision, followUp?: string) => void;
  readonly isActive?: boolean;
  /**
   * Where a relative path in the command would land. The conversation's working
   * directory, which is not this process's once `/cwd` has been used — the
   * default is only the fallback for a caller that has not got one to hand.
   */
  readonly cwd?: string;
  /** The columns the card has. The blast block is clipped to fit inside them. */
  readonly columns?: number;
  /** Injectable so a test can answer without reading a disk. */
  readonly preview?: BlastPreview;
}

export function PermissionCard(props: PermissionCardProps): React.JSX.Element {
  const { request } = props;
  if (request.plan !== undefined) return <PlanCard {...props} />;
  if (request.question !== undefined) return <QuestionCard {...props} />;
  return <ApprovalCard {...props} />;
}

/* -------------------------------------------------------------------------- */
/* A line to type on                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One line of text, hanging off whichever row opened it.
 *
 * The composer's buffer does the work — the same word motions, the same kill
 * ring, the same undo — with the keys that make a second line left out, since
 * there is nowhere for one to go and Enter here means "done". A paste keeps its
 * words and loses its line breaks rather than being refused: someone pasting
 * two lines of reason meant the words.
 *
 * It owns no state. The card holds the buffer, because the card is what has to
 * know whether a line is open at all — that is what suspends the list's arrows
 * and what changes the legend underneath it.
 */
interface FieldProps {
  /** Shown dim when the line is empty. Also what an emptied line falls back to. */
  readonly placeholder: string;
  readonly state: EditorState;
  readonly onChange: (next: EditorState) => void;
  /** Enter. */
  readonly onSubmit: () => void;
  /** Tab: put the line away, keep what is in it. */
  readonly onClose: () => void;
  /** Esc: put the line away. Never a decision. */
  readonly onAbandon: () => void;
  readonly isActive: boolean;
}

function Field({ placeholder, state, onChange, onSubmit, onClose, onAbandon, isActive }: FieldProps): React.JSX.Element {
  useInput(
    (input, key) => {
      if (key.escape) {
        onAbandon();
        return;
      }
      if (key.tab) {
        onClose();
        return;
      }
      // Every Return, however the terminal dresses it up: one line has no
      // newline to insert, so Shift+Enter and Ctrl+J are submissions too.
      if (key.return || input === '\n') {
        onSubmit();
        return;
      }
      if (key.backspace) {
        onChange(backspace(state));
        return;
      }
      if (key.delete) {
        onChange(deleteForward(state));
        return;
      }
      if (key.leftArrow) {
        onChange(key.ctrl || key.meta ? wordLeft(state) : left(state));
        return;
      }
      if (key.rightArrow) {
        onChange(key.ctrl || key.meta ? wordRight(state) : right(state));
        return;
      }
      // ↑ and ↓ are the list's, and the list is suspended while this is open:
      // a row moving under a line being typed is a rule edited onto the wrong
      // suggestion.
      if (key.upArrow || key.downArrow) return;
      if (key.home) {
        onChange(lineStart(state));
        return;
      }
      if (key.end) {
        onChange(lineEnd(state));
        return;
      }
      if (key.ctrl) {
        switch (input) {
          case 'a':
            onChange(lineStart(state));
            return;
          case 'e':
            onChange(lineEnd(state));
            return;
          case 'u':
            onChange(killToLineStart(state));
            return;
          case 'k':
            onChange(killToLineEnd(state));
            return;
          case 'w':
            onChange(deleteWordLeft(state));
            return;
          case 'y':
            onChange(yank(state));
            return;
          case '_':
            onChange(undo(state));
            return;
          default:
            return;
        }
      }
      if (key.meta) {
        switch (input) {
          case 'b':
            onChange(wordLeft(state));
            return;
          case 'f':
            onChange(wordRight(state));
            return;
          case 'd':
            onChange(deleteWordRight(state));
            return;
          default:
            return;
        }
      }
      if (input.length === 0) return;
      onChange(insert(state, input.replace(/[\r\n]+/gu, ' ')));
    },
    { isActive },
  );

  const line = state.text;
  const col = state.cursor;
  // The cursor is an inverse cell, as it is in the composer, and an inverse
  // space where the line has run out of characters to stand on.
  const at = cellAt(line, col) === '' ? ' ' : cellAt(line, col);
  return (
    <Text>
      <Text color="cyan">{'  ✎ '}</Text>
      {line.length === 0 ? (
        <>
          {isActive ? <Text inverse> </Text> : <Text> </Text>}
          <Text dimColor>{` ${placeholder}`}</Text>
        </>
      ) : (
        <>
          {line.slice(0, col)}
          {isActive ? <Text inverse>{at}</Text> : <Text>{at}</Text>}
          {line.slice(col + at.length)}
        </>
      )}
    </Text>
  );
}

/* -------------------------------------------------------------------------- */
/* Approval                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The shell command an approval is asking to run, or null when it is not one.
 *
 * Either half is enough to call a request Bash-like. `classifyTool` knows a
 * shell tool by name whatever the provider called it — `Bash`, `shell`,
 * `run_command` all land on `command` — and a tool this app has never heard of
 * still names its argument `command`, which is the miss that would matter: an
 * `rm -rf` is no less destructive for arriving under an unfamiliar name. In
 * practice the second test is the one that finds anything, because the line
 * itself lives in `input.command` either way; the first is what says a string
 * found there is meant to be read as shell.
 *
 * Only a string counts. An argv array joined by spaces is a *different* command
 * from the array — `['rm', 'my file']` would come back as two paths — and a
 * preview of the wrong command is worse than no preview at all. Where the
 * string is not a shell line, nothing is lost: `destructiveParts` recognises a
 * short list of verbs and finds none of them in `{"command": "click"}`.
 */
function commandOf(request: PermissionRequest): string | null {
  const raw = request.input['command'];
  const bashLike = classifyTool(request.toolName) === 'command' || 'command' in request.input;
  if (!bashLike || typeof raw !== 'string' || raw.trim().length === 0) return null;
  return raw;
}

/** A rule as it is written down: `Bash(rm:*)`, or a bare tool name. */
const formatRule = (rule: PermissionRule): string =>
  rule.ruleContent !== undefined ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;

function describeRules(update: PermissionRuleUpdate): string {
  switch (update.type) {
    case 'addRules':
    case 'replaceRules':
      return `${update.behavior === 'allow' ? 'Allow always' : update.behavior === 'deny' ? 'Deny always' : 'Always ask'}: ${update.rules
        .map(formatRule)
        .join(', ')}`;
    case 'removeRules':
      return `Remove rule: ${update.rules.map((rule) => rule.toolName).join(', ')}`;
    case 'setMode':
      return `Switch to ${update.mode} mode`;
    case 'addDirectories':
      return `Allow access to ${update.directories.join(', ')}`;
    case 'removeDirectories':
      return `Remove access to ${update.directories.join(', ')}`;
    default:
      return 'Apply the suggested rule';
  }
}

const scopeNote = (scope: PermissionScope): string =>
  scope === 'once' ? 'just this once' : scope === 'session' ? 'for this session' : `saved to ${scope} settings`;

/**
 * What the row would write down, and where — the line under the row.
 *
 * The label says what the row *does*; this says what it *saves*, which is the
 * part worth reading before agreeing to it and the part `e` and `s` change.
 */
function ruleLine(update: PermissionRuleUpdate): string {
  const what =
    update.type === 'setMode'
      ? `mode: ${update.mode}`
      : update.type === 'addDirectories' || update.type === 'removeDirectories'
        ? update.directories.join(', ')
        : update.rules.map(formatRule).join(', ');
  return oneLine(`${what} · ${scopeNote(update.scope)}`, 160);
}

/**
 * The scopes `s` walks through.
 *
 * `once` is left out on purpose: a rule nobody writes down is exactly the
 * "Allow once" row above, and offering it here would be two names for the same
 * answer. A suggestion that arrives scoped `once` therefore lands on `session`
 * at the first press, which is the smallest thing "always" can honestly mean.
 */
const RULE_SCOPES: readonly PermissionScope[] = ['session', 'local', 'project', 'user'];

const nextScope = (scope: PermissionScope): PermissionScope =>
  RULE_SCOPES[(RULE_SCOPES.indexOf(scope) + 1) % RULE_SCOPES.length] ?? 'session';

/**
 * The text `e` puts in the line, or null when there is nothing to edit.
 *
 * A rule with no `ruleContent` is a bare tool name — `Read`, every call of it —
 * and there is no pattern to narrow. A suggestion bundling several rules is
 * shown but not edited: one line cannot stand for two patterns, and guessing
 * which of them was meant would silently widen the other.
 */
function editableContent(update: PermissionRuleUpdate): string | null {
  if (update.type !== 'addRules' && update.type !== 'replaceRules' && update.type !== 'removeRules') return null;
  if (update.rules.length !== 1) return null;
  return update.rules[0]?.ruleContent ?? null;
}

/** The same update with a narrower pattern; everything else left alone. */
function withContent(update: PermissionRuleUpdate, content: string): PermissionRuleUpdate {
  if (update.type !== 'addRules' && update.type !== 'replaceRules' && update.type !== 'removeRules') return update;
  const rule = update.rules[0];
  if (rule === undefined) return update;
  return { ...update, rules: [{ ...rule, ruleContent: content }] };
}

/** The line that is open, and the row it belongs to. */
type OpenField =
  | { readonly kind: 'comment'; readonly row: 'deny' | 'allow'; readonly editor: EditorState }
  | { readonly kind: 'rule'; readonly index: number; readonly editor: EditorState };

function ApprovalCard({
  request,
  onDecision,
  isActive = true,
  cwd = process.cwd(),
  columns = 80,
  preview = previewBlastRadius,
}: PermissionCardProps): React.JSX.Element {
  const title = request.title ?? `${request.toolName} ${summarizeToolInput(request.input)}`.trim();
  const edit = detectFileEdit(request.toolName, request.input);
  const body = edit === null ? formatJson(request.input).split('\n').slice(0, 14) : renderDiff(edit, 30);
  const suggestions = request.suggestions ?? [];

  /*
   * The cursor, kept a second time.
   *
   * The picker owns the selection and does not hand it out, but three keys here
   * — Tab, `e`, `s` — mean different things on different rows, and the legend
   * has to name only the keys the row underneath actually answers. So the two
   * arrow rules are mirrored, exactly as `Picker` writes them, over a list whose
   * length never changes while the card is up. It is duplication, and the
   * alternative — this card drawing its own list — is a great deal more of it.
   */
  const [cursor, setCursor] = useState(0);
  const [field, setField] = useState<OpenField | null>(null);
  /** What was typed on a row and put away with Tab. Kept until the card goes. */
  const [comments, setComments] = useState<{ readonly deny: string; readonly allow: string }>({ deny: '', allow: '' });
  /** Suggestions the user changed, by their position in `suggestions`. */
  const [edits, setEdits] = useState<ReadonlyMap<number, PermissionRuleUpdate>>(new Map());

  /*
   * What this command would touch.
   *
   * The recogniser is pure and runs in render, so a card for a command with no
   * destructive verb in it costs a string scan and draws nothing. The previews
   * start empty and an effect fills them in, which is the whole arrangement:
   * `previewBlastRadius` reads directories and may wait five seconds on a
   * `git`, and a card that waited with it would be an approval nobody could
   * answer for five seconds. Nothing below reads `checking` or `previews` — the
   * picker is mounted and live from the first frame either way.
   *
   * Keyed on the request id, because a new request is a new question and the
   * previous answer must not be left sitting under it.
   */
  const parts = useMemo(() => {
    const command = commandOf(request);
    return command === null ? [] : destructiveParts(command);
  }, [request]);
  const [previews, setPreviews] = useState<readonly Preview[]>([]);
  const [checking, setChecking] = useState(() => parts.length > 0);

  useEffect(() => {
    /*
     * The card can be answered while this is in flight, and then it is gone —
     * so the late arrival is dropped rather than set on a component that is no
     * longer mounted. `previewBlastRadius` does not reject, but an injected one
     * might, and an unhandled rejection over an otherwise healthy card is not a
     * trade worth making: a preview that failed is simply no preview.
     */
    let live = true;
    setPreviews([]);
    setChecking(parts.length > 0);
    if (parts.length > 0) {
      void preview(parts, cwd).then(
        (found) => {
          if (!live) return;
          setPreviews(found);
          setChecking(false);
        },
        () => {
          if (live) setChecking(false);
        },
      );
    }
    return () => {
      live = false;
    };
    // The id alone, deliberately: the parts and the directory are read off the
    // request, and re-running this because a parent re-rendered with an equal
    // `preview` would restart the I/O and blink the block off and on again.
  }, [request.id]);

  /** Already clipped to the card's width, and already `⚠`-headed; empty when there is nothing to say. */
  const warnings = blastRadiusLines(previews, columns - BLAST_CHROME);

  /** The suggestion as it now stands: edited if it was, the provider's if not. */
  const ruleAt = (index: number): PermissionRuleUpdate | undefined => edits.get(index) ?? suggestions[index];

  const items: PickerItem[] = [
    { key: 'deny', label: 'Deny', detail: 'tell the agent no and let it continue' },
    { key: 'allow', label: 'Allow once' },
    ...suggestions.map((update, index) => {
      const live = edits.get(index) ?? update;
      return { key: `suggest:${String(index)}`, label: describeRules(live), note: ruleLine(live) };
    }),
    { key: 'stop', label: 'Deny and stop the run', danger: true },
  ];

  /** The row `key` is a suggestion, and which one; null for the fixed rows. */
  const suggestionIndex = (key: string): number | null => {
    if (!key.startsWith('suggest:')) return null;
    const index = Number(key.slice('suggest:'.length));
    return Number.isInteger(index) && index >= 0 && index < suggestions.length ? index : null;
  };

  const denyWith = (comment: string, interrupt: boolean): void => {
    const message = comment.trim().length > 0 ? comment.trim() : DEFAULT_DENIAL;
    onDecision({ behavior: 'deny', message, ...(interrupt ? { interrupt: true } : {}) });
  };

  const allowOnce = (comment: string): void => {
    const followUp = comment.trim();
    // Called with one argument when there is nothing to steer with: the second
    // argument is a message for the next turn, not an empty string to send.
    if (followUp.length > 0) onDecision({ behavior: 'allow', scope: 'once' }, followUp);
    else onDecision({ behavior: 'allow', scope: 'once' });
  };

  const choose = (item: PickerItem): void => {
    if (item.key === 'deny') {
      denyWith(comments.deny, false);
      return;
    }
    if (item.key === 'stop') {
      denyWith(comments.deny, true);
      return;
    }
    if (item.key === 'allow') {
      allowOnce(comments.allow);
      return;
    }
    const index = suggestionIndex(item.key);
    const update = index === null ? undefined : ruleAt(index);
    onDecision({
      behavior: 'allow',
      scope: 'session',
      ...(update === undefined ? {} : { updatedPermissions: [update] }),
    });
  };

  const row = items[Math.max(0, Math.min(cursor, items.length - 1))];
  const rowIndex = row === undefined ? null : suggestionIndex(row.key);
  const rowRule = rowIndex === null ? undefined : ruleAt(rowIndex);

  useInput(
    (input, key) => {
      // The open line has the keyboard; `Field` answers every key while it is up.
      if (field !== null) return;
      if (key.upArrow || input === 'k') {
        setCursor((c) => (c - 1 + items.length) % Math.max(1, items.length));
        return;
      }
      if (key.downArrow || input === 'j') {
        setCursor((c) => (c + 1) % Math.max(1, items.length));
        return;
      }
      if (row === undefined) return;
      if (key.tab) {
        if (row.key === 'deny' || row.key === 'allow') {
          setField({ kind: 'comment', row: row.key, editor: editorOf(comments[row.key]) });
        }
        return;
      }
      if (key.ctrl || key.meta) return;
      if (rowIndex === null || rowRule === undefined) return;
      if (input === 'e') {
        const content = editableContent(rowRule);
        // Nothing to edit is nothing to open: a line pre-filled with nothing,
        // saved back, would turn a named tool into a pattern of its own name.
        if (content === null) return;
        setField({ kind: 'rule', index: rowIndex, editor: editorOf(content) });
        return;
      }
      if (input === 's') {
        const scoped = { ...rowRule, scope: nextScope(rowRule.scope) };
        setEdits((current) => new Map(current).set(rowIndex, scoped));
      }
    },
    { isActive },
  );

  const rememberComment = (which: 'deny' | 'allow', text: string): void => {
    setComments((current) => (which === 'deny' ? { ...current, deny: text } : { ...current, allow: text }));
  };

  /** Tab and Esc both: the line goes away, only Enter keeps a rule edit. */
  const closeField = (): void => {
    if (field === null) return;
    if (field.kind === 'comment') rememberComment(field.row, field.editor.text);
    setField(null);
  };

  const placeholderFor = (open: OpenField): string => {
    if (open.kind === 'comment') return open.row === 'deny' ? 'why?' : 'and then…';
    const live = ruleAt(open.index);
    return (live === undefined ? null : editableContent(live)) ?? 'rule';
  };

  const submitField = (): void => {
    if (field === null) return;
    const text = field.editor.text.trim();
    if (field.kind === 'comment') {
      if (field.row === 'deny') denyWith(text, false);
      else allowOnce(text);
      return;
    }
    const live = ruleAt(field.index);
    // An emptied line keeps the rule it was opened with: the pattern gone is a
    // rule that matches everything the tool can do, which is the opposite of
    // the narrowing this key exists for.
    if (live !== undefined && text.length > 0) {
      setEdits((current) => new Map(current).set(field.index, withContent(live, text)));
    }
    setField(null);
  };

  const hint =
    field === null
      ? [
          '↑↓ move · Enter choose',
          ...(row?.key === 'deny' || row?.key === 'allow' ? ['Tab comment'] : []),
          ...(rowRule === undefined ? [] : editableContent(rowRule) === null ? ['s scope'] : ['e edit · s scope']),
          'Esc denies',
        ].join(' · ')
      : field.kind === 'rule'
        ? 'Enter keeps the edited rule · Esc abandons it · neither denies'
        : field.row === 'deny'
          ? 'Enter denies with this · Tab keeps it · Esc closes the line and does not deny'
          : 'Enter allows, then sends this · Tab keeps it · Esc closes the line and does not deny';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text>
        <Text color="yellow" bold>
          ⚿ Permission{' '}
        </Text>
        <Text bold>{request.toolName}</Text>
      </Text>
      <Text>{oneLine(title, 200)}</Text>
      {request.description !== undefined && <Text dimColor>{request.description}</Text>}
      {request.reason !== undefined && <Text color="yellow">{request.reason}</Text>}
      {request.blockedPath !== undefined && <Text dimColor>path: {request.blockedPath}</Text>}
      <Box flexDirection="column" paddingLeft={2} marginY={1}>
        {body.map((line, i) => (
          <Text key={i} dimColor={edit === null}>
            {line}
          </Text>
        ))}
      </Box>
      {/*
       * Under the arguments and above the choices, which is the order someone
       * reads the card in: this is what the command *means*, and it belongs
       * between the text of it and the answer to it. No heading — every line
       * out of `blastRadiusLines` already opens with a `⚠`, and a title over
       * one line of warning is a line of chrome over a line of fact.
       */}
      {(checking || warnings.length > 0) && (
        <Box flexDirection="column" marginBottom={1}>
          {checking && <Text dimColor>checking what this would touch…</Text>}
          {warnings.map((line, i) => (
            <Text key={i} color="yellow">
              {line}
            </Text>
          ))}
        </Box>
      )}
      <Picker
        title=""
        items={items}
        initialKey="deny"
        onSelect={choose}
        onCancel={() => denyWith(comments.deny, false)}
        hint={hint}
        isActive={isActive && field === null}
      />
      {field !== null && (
        <Field
          placeholder={placeholderFor(field)}
          state={field.editor}
          onChange={(editor) => setField({ ...field, editor })}
          onSubmit={submitField}
          onClose={closeField}
          /*
           * Esc here is not a denial and not a decision. A comment survives it
           * — Tab reopens the line on the words already typed — and an edit
           * does not, because abandoning an edit is what Esc is for.
           */
          onAbandon={closeField}
          isActive={isActive}
        />
      )}
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

const MAX_PLAN_LINES = 80;

/** What "think again" tells the agent, with whatever the user added to it. */
const KEEP_PLANNING = 'Keep planning; the plan was not approved.';
const keepPlanning = (comment: string): string =>
  comment.trim().length > 0 ? `Keep planning; ${comment.trim()}` : KEEP_PLANNING;

function PlanCard({ request, onDecision, isActive = true }: PermissionCardProps): React.JSX.Element {
  const plan = request.plan?.plan ?? '';
  const lines = renderMarkdown(plan).split('\n');
  const shown = lines.slice(0, MAX_PLAN_LINES);
  const items: PickerItem[] = [
    { key: 'again', label: 'Think again', detail: 'send it back to planning' },
    { key: 'go', label: 'Do that', detail: 'approve the plan and leave plan mode' },
  ];
  const suggestions = request.suggestions ?? [];

  // The same two pieces of state the approval card keeps, for the one row that
  // can carry a sentence: "no" is worth much less to a planner than "no, and
  // here is what to change".
  const [cursor, setCursor] = useState(0);
  const [comment, setComment] = useState('');
  const [field, setField] = useState<EditorState | null>(null);

  useInput(
    (input, key) => {
      if (field !== null) return;
      if (key.upArrow || input === 'k') {
        setCursor((c) => (c - 1 + items.length) % items.length);
        return;
      }
      if (key.downArrow || input === 'j') {
        setCursor((c) => (c + 1) % items.length);
        return;
      }
      if (key.tab && items[cursor]?.key === 'again') setField(editorOf(comment));
    },
    { isActive },
  );

  const hint =
    field !== null
      ? 'Enter sends it back with this · Tab keeps it · Esc closes the line and does not answer'
      : `↑↓ move · Enter choose${items[cursor]?.key === 'again' ? ' · Tab comment' : ''} · Esc sends it back`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
      <Text color="blue" bold>
        Plan
      </Text>
      {request.plan?.planPath !== undefined && <Text dimColor>{request.plan.planPath}</Text>}
      <Box flexDirection="column" marginY={1}>
        {shown.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
        {lines.length > shown.length && (
          <Text dimColor>⋯ {String(lines.length - shown.length)} more lines in the plan file</Text>
        )}
      </Box>
      <Picker
        title=""
        items={items}
        initialKey="again"
        onSelect={(item) => {
          if (item.key === 'go') {
            onDecision({
              behavior: 'allow',
              ...(suggestions.length > 0 ? { updatedPermissions: suggestions } : {}),
            });
          } else {
            onDecision({ behavior: 'deny', message: keepPlanning(comment) });
          }
        }}
        onCancel={() => onDecision({ behavior: 'deny', message: keepPlanning(comment) })}
        hint={hint}
        isActive={isActive && field === null}
      />
      {field !== null && (
        <Field
          placeholder="what should change?"
          state={field}
          onChange={setField}
          onSubmit={() => onDecision({ behavior: 'deny', message: keepPlanning(field.text) })}
          onClose={() => {
            setComment(field.text);
            setField(null);
          }}
          onAbandon={() => {
            setComment(field.text);
            setField(null);
          }}
          isActive={isActive}
        />
      )}
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/* Question                                                                   */
/* -------------------------------------------------------------------------- */

function QuestionCard({ request, onDecision, isActive = true }: PermissionCardProps): React.JSX.Element {
  const questions: readonly Question[] = request.question?.questions ?? [];
  const [index, setIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [answers, setAnswers] = useState<readonly QuestionAnswer[]>([]);

  const question = questions[index];

  const finish = (all: readonly QuestionAnswer[]): void => {
    onDecision({ behavior: 'allow', answers: all });
  };

  useInput(
    (input, key) => {
      if (question === undefined) return;
      if (key.escape) {
        // A skip: allowing with no answers is how the protocol spells "the
        // user did not want to answer".
        onDecision({ behavior: 'allow', answers: [] });
        return;
      }
      const count = question.options.length;
      if (key.upArrow || input === 'k') {
        setCursor((c) => (c - 1 + count) % Math.max(1, count));
        return;
      }
      if (key.downArrow || input === 'j') {
        setCursor((c) => (c + 1) % Math.max(1, count));
        return;
      }
      if (input === ' ' && question.multiSelect) {
        setPicked((current) => {
          const next = new Set(current);
          if (next.has(cursor)) next.delete(cursor);
          else next.add(cursor);
          return next;
        });
        return;
      }
      if (key.return) {
        const chosen = question.multiSelect
          ? [...picked].sort((a, b) => a - b).map((i) => question.options[i]?.label ?? '')
          : [question.options[cursor]?.label ?? ''];
        if (chosen.length === 0 || chosen[0] === '') return;
        const next: QuestionAnswer[] = [...answers, { question: question.question, options: chosen }];
        if (index + 1 >= questions.length) {
          finish(next);
          return;
        }
        setAnswers(next);
        setIndex(index + 1);
        setCursor(0);
        setPicked(new Set());
      }
    },
    { isActive },
  );

  if (question === undefined) {
    return (
      <Box borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
        <Text dimColor>The agent asked a question with nothing to choose from.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
      <Text>
        <Text color="magenta" bold>
          ? {question.header}
        </Text>
        {questions.length > 1 && <Text dimColor>{`  ${String(index + 1)}/${String(questions.length)}`}</Text>}
      </Text>
      <Text>{question.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {question.options.map((option, i) => {
          const selected = i === cursor;
          const checked = picked.has(i);
          return (
            <Box key={option.label} flexDirection="column">
              <Text>
                <Text color={selected ? 'cyan' : undefined}>{selected ? '❯ ' : '  '}</Text>
                {question.multiSelect && <Text>{checked ? '[x] ' : '[ ] '}</Text>}
                <Text bold={selected}>{option.label}</Text>
                <Text dimColor>{`  ${option.description}`}</Text>
              </Text>
              {selected && option.preview !== undefined && (
                <Text dimColor>
                  {'      '}
                  {oneLine(option.preview, 200)}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Text dimColor>
        {question.multiSelect ? '↑↓ move · Space toggle · Enter confirm · Esc skip' : '↑↓ move · Enter choose · Esc skip'}
      </Text>
    </Box>
  );
}
