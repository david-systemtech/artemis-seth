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
 * scrolls, never both on one keystroke. While the slash menu is open the arrows
 * are its, ahead of both — the text is one word, so there is no second line for
 * them to reach, and a menu you cannot walk is a list.
 *
 * That menu is the other thing `/` does. While the text is a single word
 * beginning with a slash, the rows under the box are the commands it could
 * mean, the first of them highlighted; Tab fills the highlighted one in and
 * Enter runs it, as if its name had been typed out in full. Nothing is
 * highlighted when nothing matched, which is what keeps a typo — `/mdoel` — a
 * message to the agent rather than a command someone else guessed at. Esc is
 * deliberately not bound: Esc interrupts the turn, and a popup that swallowed
 * it would fight the app for the one key that has to work.
 *
 * It owns no state of the conversation. It reports a submission and shows what
 * it is told: whether the agent is working (so Enter means "steer" rather than
 * "start"), whether the provider can even take a message right now, and any
 * one-line reason the last submission was refused.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { matchCommands } from '../commands.js';
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
import { Completions } from './Completions.js';

/** Lines drawn at once before the box scrolls instead of growing. */
const MAX_ROWS = 8;

/** Ctrl+_ , which most terminals send as a unit separator and no letter. */
const UNDO_INPUT = '\u001F';

const NEWLINE_HINT = 'Shift+Enter or Ctrl+J for a newline · Enter sends';

/** What a row is typed as: `/attach <path>` is run by sending `/attach`. */
function commandWord(usage: string): string {
  return usage.split(' ')[0] ?? usage;
}

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
  /*
   * The highlighted row, remembered against the text it was chosen on. Any edit
   * to the text makes it stale, and a stale index over a fresh list is exactly
   * how Enter runs a command nobody chose — so it is thrown away rather than
   * kept in step, and the menu falls back to its first row.
   */
  const [picked, setPicked] = useState<{ readonly text: string; readonly index: number } | null>(null);
  const value = buffer.text;

  // A single word beginning with a slash is a command being typed. Whitespace
  // of any kind ends that: what follows is arguments, or a second line.
  const menu = value.startsWith('/') && !/\s/u.test(value) ? matchCommands(value, providerCommands) : [];
  const selected =
    menu.length === 0
      ? null
      : picked !== null && picked.text === value
        ? Math.max(0, Math.min(picked.index, menu.length - 1))
        : 0;
  const highlighted = selected === null ? undefined : menu[selected];

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
        /*
         * Enter on a highlighted row runs it — by submitting the words someone
         * would have typed to run it themselves. Everything downstream, the
         * parser above all, sees exactly what it always saw, and the composer
         * still knows nothing about what any command does.
         */
        if (highlighted !== undefined) {
          onSubmit(commandWord(highlighted.usage));
          setBuffer(clear);
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
        if (selected !== null) {
          // The open menu takes a plain arrow ahead of the text and ahead of
          // the app: the text is one word, so it has no second line to move
          // to, and scrolling the conversation out from under a menu someone
          // is reading is not what they asked for. Walking off either end
          // comes back round, as it does in the picker.
          const step = key.upArrow ? -1 : 1;
          setPicked({ text: value, index: (selected + step + menu.length) % menu.length });
          return;
        }
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
        // Fill in the highlighted row — the canonical name, prefix and all,
        // which is what makes a bridged `/plugin:command` typeable. Through
        // the editor, so one undo gets back the letters that were typed.
        if (highlighted !== undefined) {
          setBuffer((current) => replaceAll(current, `${commandWord(highlighted.usage)} `));
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
      <Completions
        items={menu.map((match) => ({
          key: match.key,
          label: match.usage,
          detail: match.summary,
          indices: match.indices,
        }))}
        selected={selected}
      />
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
