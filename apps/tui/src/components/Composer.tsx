/**
 * The box you type into.
 *
 * A multi-line editor over `editor.ts`, built on `useInput` rather than a text
 * input package so that the keys the TUI cares about — Esc to interrupt, `/` to
 * hint commands, Enter to send — are decided in one place. The component holds
 * one piece of state, the buffer, and every keystroke is one call into the
 * model: nothing about where a word ends, or which column ↑ lands on, is
 * decided here.
 *
 * Enter sends, because that is what Enter does in a chat, so a newline is
 * something to ask for. There are three ways to ask. Ctrl+J, which every
 * terminal can send and which arrives as a bare line feed. Shift+Enter, which
 * only some can: without the kitty keyboard protocol a terminal sends the same
 * carriage return for Enter and Shift+Enter and nothing here can tell them
 * apart, which is why the hint names Ctrl+J as well. And a line ending in a
 * backslash, the shell's own convention, where Enter drops the backslash and
 * opens the next line instead of sending.
 *
 * The box grows with the text to eight lines and then scrolls, counting what is
 * out of sight above and below, for the reason the picker does the same: a long
 * paste would otherwise push the conversation off the top of the screen.
 *
 * ↑ and ↓ belong to the text while there is text to move through. The presses
 * that run off the first and last line are handed back through
 * `onArrowOverflow`, which is how an arrow still has exactly one owner (see
 * app.tsx's "Who has the keys"): the composer moves the cursor, or the app
 * scrolls, never both on one keystroke.
 *
 * It owns no state of the conversation. It reports a submission and shows what
 * it is told: whether the agent is working (so Enter means "steer" rather than
 * "start"), whether the provider can even take a message right now, and any
 * one-line reason the last submission was refused.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { completeCommand, completeProviderCommand } from '../commands.js';
import {
  EMPTY_EDITOR,
  backspace,
  bufferEnd,
  bufferStart,
  cellAt,
  clear,
  continueLine,
  cursorPosition,
  deleteForward,
  deleteWordLeft,
  deleteWordRight,
  down,
  editorWindow,
  endsWithContinuation,
  insert,
  killToLineEnd,
  killToLineStart,
  left,
  lineEnd,
  lineStart,
  lines,
  newline,
  onFirstLine,
  onLastLine,
  replaceAll,
  right,
  undo,
  up,
  wordLeft,
  wordRight,
  yank,
} from '../editor.js';
import { ACCENT } from '../theme.js';

/** Lines drawn at once before the box scrolls instead of growing. */
const MAX_ROWS = 8;

/** Ctrl+_ , which most terminals send as a unit separator and no letter. */
const UNDO_INPUT = '\u001F';

const NEWLINE_HINT = 'Shift+Enter or Ctrl+J for a newline · Enter sends';

export interface ComposerProps {
  readonly onSubmit: (text: string) => void;
  /** The agent is mid-turn. Enter steers; the hint says so. */
  readonly live: boolean;
  /** The provider cannot take a message until the turn ends. */
  readonly locked: boolean;
  /** Why the last submission was refused, if it was. */
  readonly notice?: string;
  /** Names of files queued to go with the next message. */
  readonly attachments?: readonly string[];
  /** The provider's own slash commands, offered beside the TUI's. */
  readonly providerCommands?: readonly string[];
  readonly isActive?: boolean;
  /** ↑ on the first line, ↓ on the last: the app's to do something with. */
  readonly onArrowOverflow?: (direction: 'up' | 'down') => void;
}

export function Composer({
  onSubmit,
  live,
  locked,
  notice,
  attachments = [],
  providerCommands = [],
  isActive = true,
  onArrowOverflow,
}: ComposerProps): React.JSX.Element {
  const [buffer, setBuffer] = useState(EMPTY_EDITOR);
  const value = buffer.text;

  const typed = value.startsWith('/') && !value.includes(' ') ? value.slice(1).toLowerCase() : null;
  const completions =
    typed === null
      ? []
      : [
          ...completeCommand(value),
          ...completeProviderCommand(value, providerCommands).map((name) => ({
            name,
            usage: `/${name}`,
            // The plugin's name is already the front half of the row; saying
            // it again in the description column is noise. What the column is
            // for is the distinction the name does not carry — whether this
            // came from the user's own skills or from the provider itself.
            summary: name.includes(':') ? 'skill' : 'provider command',
          })),
        ].slice(0, 10);

  useInput(
    (input, key) => {
      /*
       * The newline keys come first, because each of them is a Return that
       * must not be read as "send". Shift+Enter and Option+Enter only arrive
       * as their own keystroke from a terminal that reports modifiers; Ctrl+J
       * is a bare line feed, which Ink names `enter` and leaves unmodified,
       * and the same key under the kitty protocol which reports it as Ctrl
       * with the letter.
       */
      if ((key.return && (key.shift || key.meta)) || input === '\n' || (key.ctrl && input === 'j')) {
        setBuffer(newline);
        return;
      }
      if (key.return) {
        if (endsWithContinuation(buffer)) {
          setBuffer(continueLine);
          return;
        }
        if (value.trim().length === 0 && attachments.length === 0) return;
        onSubmit(value);
        setBuffer(clear);
        return;
      }
      if (key.backspace) {
        setBuffer(backspace);
        return;
      }
      if (key.delete) {
        setBuffer(deleteForward);
        return;
      }
      if (key.leftArrow) {
        setBuffer(key.ctrl || key.meta ? wordLeft : left);
        return;
      }
      if (key.rightArrow) {
        setBuffer(key.ctrl || key.meta ? wordRight : right);
        return;
      }
      if (key.upArrow || key.downArrow) {
        // A modified arrow is the app's half-screen scroll, never the text's.
        if (key.shift || key.ctrl || key.meta) return;
        if (key.upArrow) {
          if (onFirstLine(buffer)) onArrowOverflow?.('up');
          else setBuffer(up);
          return;
        }
        if (onLastLine(buffer)) onArrowOverflow?.('down');
        else setBuffer(down);
        return;
      }
      if (key.home) {
        setBuffer(key.ctrl ? bufferStart : lineStart);
        return;
      }
      if (key.end) {
        setBuffer(key.ctrl ? bufferEnd : lineEnd);
        return;
      }
      if (key.ctrl) {
        // Readline's editing keys. Anything else with Ctrl — Ctrl+C above all
        // — belongs to the app, so it is left alone rather than swallowed.
        switch (input) {
          case 'a':
            setBuffer(lineStart);
            return;
          case 'e':
            setBuffer(lineEnd);
            return;
          case 'u':
            setBuffer(killToLineStart);
            return;
          case 'k':
            setBuffer(killToLineEnd);
            return;
          case 'y':
            setBuffer(yank);
            return;
          case 'w':
            setBuffer(deleteWordLeft);
            return;
          case '_':
            setBuffer(undo);
            return;
          default:
            return;
        }
      }
      if (input === UNDO_INPUT) {
        setBuffer(undo);
        return;
      }
      if (key.meta) {
        // Alt with a letter, which is how Ink reports the Escape-prefixed
        // sequence a terminal sends for it.
        switch (input) {
          case 'b':
            setBuffer(wordLeft);
            return;
          case 'f':
            setBuffer(wordRight);
            return;
          case 'd':
            setBuffer(deleteWordRight);
            return;
          default:
            return;
        }
      }
      if (key.tab) {
        // Complete to the first match — the canonical name, prefix and all,
        // which is what makes a bridged `/plugin:command` typeable.
        const first = completions[0];
        if (first !== undefined) {
          setBuffer((current) => replaceAll(current, `${first.usage.split(' ')[0] ?? first.usage} `));
        }
        return;
      }
      if (key.escape || input.length === 0) return;
      // More than one character at once is a paste, and Ink hands it over
      // whole. Line endings are normalised and a single trailing newline —
      // the one a terminal adds when you copy a whole line — is dropped
      // rather than inserted, because it would otherwise sit invisibly at the
      // end of the message; a paste never submits by itself.
      const text = input.length > 1 ? input.replace(/\r\n?/g, '\n').replace(/\n$/, '') : input;
      if (text.length === 0) return;
      setBuffer((current) => insert(current, text));
    },
    { isActive },
  );

  // Wide enough for the longest row on offer, so the descriptions line up:
  // a bridged `/marketplace:command` is far longer than `/help`, and a fixed
  // column put the two halves of those rows flush against each other.
  const nameColumn = completions.reduce((widest, command) => Math.max(widest, command.usage.length), 0) + 1;

  const rows = lines(buffer);
  const { row, col } = cursorPosition(buffer);
  const { top, size } = editorWindow(row, rows.length, MAX_ROWS);
  const hiddenBelow = rows.length - top - size;
  const placeholder = locked ? 'working — wait for this turn' : live ? 'steer the agent…' : 'message, or / for commands';
  const prompt = (
    <Text color={locked ? undefined : ACCENT} dimColor={locked} bold>
      {'❯ '}
    </Text>
  );

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={isActive ? ACCENT : undefined}
        borderDimColor={!isActive}
        paddingX={1}
      >
        {top > 0 && <Text dimColor>{`  ↑ ${String(top)} more`}</Text>}
        {value.length === 0 ? (
          <Text>
            {prompt}
            {isActive ? <Text inverse> </Text> : ' '}
            <Text dimColor>{placeholder}</Text>
          </Text>
        ) : (
          rows.slice(top, top + size).map((line, offset) => {
            const index = top + offset;
            // The cursor is an inverse cell on its own row, and an inverse
            // space where the row has run out of characters to stand on.
            const at = index === row ? cellAt(line, col) || ' ' : '';
            return (
              <Text key={index} wrap="wrap">
                {index === 0 ? prompt : '  '}
                {index === row ? (
                  <>
                    {line.slice(0, col)}
                    {isActive ? <Text inverse>{at}</Text> : at}
                    {line.slice(col + at.length)}
                  </>
                ) : (
                  line
                )}
              </Text>
            );
          })
        )}
        {hiddenBelow > 0 && <Text dimColor>{`  ↓ ${String(hiddenBelow)} more`}</Text>}
      </Box>
      {(rows.length > 1 || row > 0) && (
        <Text dimColor>
          {'  '}
          {NEWLINE_HINT}
        </Text>
      )}
      {completions.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {completions.map((command) => (
            <Text key={command.usage} dimColor>
              {command.usage.padEnd(nameColumn)} {command.summary}
            </Text>
          ))}
        </Box>
      )}
      {attachments.length > 0 && (
        <Text dimColor>
          {'  ⎘ '}
          {attachments.join(', ')} · goes with the next message · /attach clear
        </Text>
      )}
      {notice !== undefined && (
        <Text color="yellow">
          {'  '}
          {notice}
        </Text>
      )}
    </Box>
  );
}
