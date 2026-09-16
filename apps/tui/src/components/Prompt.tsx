/**
 * One line, asked for.
 *
 * ```
 * ╭─────────────────────────────────────────────╮
 * │ Name this conversation                      │
 * │ ✎ the rail filters as you type▌              │
 * │ Enter names it · Esc leaves it as it was     │
 * ╰─────────────────────────────────────────────╯
 * ```
 *
 * The terminal already had two ways to take text and neither fits here. The
 * composer is the message being written — handing it a title would mean
 * emptying a draft somebody is in the middle of, and putting it back afterwards
 * — and a {@link Picker} chooses between things that already exist, which a
 * name is not. What was missing is the small third thing: a box that opens over
 * a list, holds one line, and hands it back.
 *
 * So this is `PermissionCard`'s `Field` with a border round it and a question
 * above it. The line editing is `editor.ts`'s, which is the same buffer the
 * composer uses and therefore the same word motions, the same kill ring and the
 * same Ctrl+_ — a person who has learned the composer has learned this. The
 * keys that would make a *second* line are left out, because there is nowhere
 * for one to go: Enter means "done", and a paste keeps its words and loses its
 * line breaks rather than being refused.
 *
 * It decides nothing and remembers nothing beyond the line. Esc hands back
 * nothing at all, and Enter hands back the text — the caller is what knows
 * whether an empty line means "clear it" or "never mind", and this must not
 * guess on its behalf.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

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
import { ACCENT } from '../theme.js';

/** What the box says it can do, under the line. */
const HINT = 'Enter · Esc leaves it as it was';

export interface PromptProps {
  /** The question, drawn above the line. */
  readonly title: string;
  /** What the line starts with; the cursor lands after it. */
  readonly initial?: string;
  /** Enter, with whatever is in the line — the empty string included. */
  readonly onSubmit: (text: string) => void;
  /** Esc. Never carries a value: nothing was agreed to. */
  readonly onCancel: () => void;
  /** Shown dim while the line is empty. */
  readonly placeholder?: string;
  readonly isActive?: boolean;
}

export function Prompt({
  title,
  initial = '',
  onSubmit,
  onCancel,
  placeholder = '',
  isActive = true,
}: PromptProps): React.JSX.Element {
  /*
   * The buffer is the box's own, unlike `Field`'s — there is no list underneath
   * whose arrows have to be suspended, so nothing outside needs to know whether
   * a line is open. It is seeded once: a caller that re-renders with a different
   * `initial` is not changing the question, and a line rewritten under somebody
   * typing is the bug this avoids.
   */
  const [state, setState] = useState<EditorState>(() => editorOf(initial));

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      // Every Return, however the terminal dresses it up: one line has no
      // newline to insert, so Shift+Enter and Ctrl+J are submissions too.
      if (key.return || input === '\n') {
        onSubmit(state.text);
        return;
      }
      if (key.backspace) {
        setState(backspace(state));
        return;
      }
      if (key.delete) {
        setState(deleteForward(state));
        return;
      }
      if (key.leftArrow) {
        setState(key.ctrl || key.meta ? wordLeft(state) : left(state));
        return;
      }
      if (key.rightArrow) {
        setState(key.ctrl || key.meta ? wordRight(state) : right(state));
        return;
      }
      // There is one line, so there is nowhere up or down to go.
      if (key.upArrow || key.downArrow || key.tab) return;
      if (key.home) {
        setState(lineStart(state));
        return;
      }
      if (key.end) {
        setState(lineEnd(state));
        return;
      }
      if (key.ctrl) {
        switch (input) {
          case 'a':
            setState(lineStart(state));
            return;
          case 'e':
            setState(lineEnd(state));
            return;
          case 'u':
            setState(killToLineStart(state));
            return;
          case 'k':
            setState(killToLineEnd(state));
            return;
          case 'w':
            setState(deleteWordLeft(state));
            return;
          case 'y':
            setState(yank(state));
            return;
          case '_':
            setState(undo(state));
            return;
          default:
            return;
        }
      }
      if (key.meta) {
        switch (input) {
          case 'b':
            setState(wordLeft(state));
            return;
          case 'f':
            setState(wordRight(state));
            return;
          case 'd':
            setState(deleteWordRight(state));
            return;
          default:
            return;
        }
      }
      if (input.length === 0) return;
      setState(insert(state, input.replace(/[\r\n]+/gu, ' ')));
    },
    { isActive },
  );

  const line = state.text;
  const col = state.cursor;
  // The cursor is an inverse cell, as it is in the composer, and an inverse
  // space where the line has run out of characters to stand on.
  const at = cellAt(line, col) === '' ? ' ' : cellAt(line, col);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text bold color={ACCENT}>
        {title}
      </Text>
      <Text>
        <Text color="cyan">{'✎ '}</Text>
        {line.length === 0 ? (
          <>
            {isActive ? <Text inverse> </Text> : <Text> </Text>}
            {placeholder.length > 0 && <Text dimColor>{` ${placeholder}`}</Text>}
          </>
        ) : (
          <>
            {line.slice(0, col)}
            {isActive ? <Text inverse>{at}</Text> : <Text>{at}</Text>}
            {line.slice(col + at.length)}
          </>
        )}
      </Text>
      <Text dimColor>{HINT}</Text>
    </Box>
  );
}
