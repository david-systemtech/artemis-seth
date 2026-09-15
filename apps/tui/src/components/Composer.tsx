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
 *
 * ## What was typed comes back
 *
 * Three things put words into the box that the keystroke itself did not type,
 * and all three lean on one channel.
 *
 * **The channel is a handle**, not a controlled `value` prop and not a seed
 * paired with a nonce: `ref` gives the app `setText`, `getText` and
 * `isCapturing`. The buffer is not a string — it is text, a cursor, a kill
 * ring and an undo stack — so a prop that could only push a string would
 * either flatten all of that or need a counter to fake an event out of a
 * value, and the app would still have no way to *read* it. Reading is half of
 * what is wanted: whether the box is empty, and what is in it to hand to an
 * external editor. `setText` goes in through `replaceAll`, so whatever it
 * replaced is one undo away.
 *
 * **↑ and ↓ walk the history** once the text has no line left to offer them.
 * The walk lives here rather than in app.tsx because every question it has to
 * answer is one only the composer can: whether the slash menu is open, whether
 * the buffer is empty, and — the one that matters — whether the text has been
 * edited since the last press. That last is not tracked but noticed, the same
 * way the menu notices a stale highlight: the walk remembers the text it put
 * in the box, and a buffer that is not that text ends it, so the next ↑ starts
 * a fresh walk with whatever is now typed as its draft. No bookkeeping spread
 * through twenty key branches, and nothing to forget to clear.
 *
 * The history arrives as a prop — `recent` and `search`, the two methods of
 * `PromptHistory` that reading needs — so the composer neither opens a file
 * nor knows where one lives, and a test can hand it two arrays. Its scopes
 * come with it, best first, which is how ↑ prefers the prompts typed in this
 * folder and falls through to everything when there are none.
 *
 * **↑ on an empty box takes a queued message back** first, when there is one
 * to take. The composer cannot know that — the queue is the conversation's —
 * so it asks, and `onTakeBackQueued` answers with the words or with nothing;
 * nothing means carry on into the history. Asking rather than being told is
 * what keeps one keystroke with one owner: emptiness and the menu are known
 * here, the queue is known there, and the answer settles it in one place.
 *
 * **Ctrl+R is the reverse search**, bash's, drawn as a row under the box: the
 * query on the left and the match in the box itself, where the cursor already
 * is, with the draft set aside whole — the editor state, not the string — so
 * Esc puts back the buffer that was there, undo stack and all. Ctrl+R again
 * steps to an older match, Ctrl+S cycles the scope, Tab and → keep the match
 * to edit, Enter sends exactly what the box is showing, and Backspace past the
 * start of the query cancels, because a search with nothing in it is not a
 * search.
 *
 * Esc is the one key this has to take back from the app, which interrupts the
 * turn with it. Ink has no stop-propagation — every active `useInput` sees
 * every keystroke — so the app asks the handle whether the composer is
 * capturing Esc before acting on it. That flag is a ref rather than state, and
 * it is lowered in an effect rather than in the key handler: both handlers run
 * inside one dispatch, before any render, so a flag lowered as the search
 * closes would already read as lowered when the app looks, and the Esc that
 * closed the search would interrupt the turn as well.
 *
 * ## `@` names a file
 *
 * An `@` after whitespace opens the same kind of popup the slash menu uses,
 * over the files under the working directory. None of the thinking is here:
 * `fileIndex.ts` finds the token under the cursor, ranks the paths against
 * what has been typed into it, and writes the chosen one back over the token.
 * What this decides is which keystroke means which of those. ↑ and ↓ are the
 * popup's while it is open, ahead of the text and the history, for the reason
 * they are the menu's. Tab and Enter both insert — and Enter inserting is the
 * point: the popup is a word being finished, not a message being sent, so the
 * send is the *next* Enter. Esc is not bound here either.
 *
 * The two popups are never open together. A single word beginning with a slash
 * is a command being typed, and no command's name has an `@` in it, so the
 * slash wins by being asked first.
 *
 * The list is not this component's to build. It arrives as `fileIndex`, one
 * object per working directory, and `list()` is called at most once per
 * object: the first time the text contains an `@` at all. That is the last
 * moment before an answer is wanted and long after the first keystroke was
 * drawn, which is what keeps a repository of twenty thousand files out of the
 * way of someone typing "hello". A different directory is a different object,
 * and a different object is a fresh listing. Until it lands the popup says
 * `loading…` rather than lying with an empty list, and a query that matched
 * nothing says `no match`.
 *
 * What is *sent* is the other half. The message keeps its `@path` text, which
 * is what tells the agent which file was meant where, and the paths travel
 * beside it as `onSubmit`'s second argument for the app to attach. Only paths
 * the listing knows travel: an address, an `@media`, a path typed before the
 * list arrived are all left as the words they already were — and the app
 * checks each of the rest on disk before reading it, because a listing is a
 * snapshot and files move. The row under the box names everything that will
 * go, so what travels is never a guess.
 */

import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { matchCommands } from '../commands.js';
import {
  EMPTY_EDITOR,
  type EditorState,
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
import { fuzzyMatch, mentionAt, replaceMention, type FileMatch, type FrecencyLike } from '../fileIndex.js';
import { HistoryCursor, type HistoryMatch, type HistoryScope } from '../history.js';
import { ACCENT } from '../theme.js';
import { Completions } from './Completions.js';

/** Lines drawn at once before the box scrolls instead of growing. */
const MAX_ROWS = 8;

/** Paths offered at once. The popup sits over the conversation; the menu's own window. */
const MENTION_ROWS = 8;

const MENTION_HINT = '↑↓ move · Tab/Enter insert';

/** Ctrl+_ , which most terminals send as a unit separator and no letter. */
const UNDO_INPUT = '\u001F';

const NEWLINE_HINT = 'Shift+Enter or Ctrl+J for a newline · Enter sends';

const SEARCH_HINT = 'Ctrl+R older · Ctrl+S scope · Tab edits · Enter sends · Esc cancels';

/** Everything: both the last resort and the only sensible default. */
const ALL_SCOPE: HistoryScope = { kind: 'all' };
const DEFAULT_SCOPES: readonly HistoryScope[] = [ALL_SCOPE];

/** What a row is typed as: `/attach <path>` is run by sending `/attach`. */
function commandWord(usage: string): string {
  return usage.split(' ')[0] ?? usage;
}

/**
 * The reading half of `PromptHistory`, which is all the composer wants.
 *
 * An interface rather than the class, so nothing here depends on a file being
 * on disk: `PromptHistory` satisfies it as it stands, and a test hands over
 * two arrays.
 */
export interface HistoryLookup {
  recent(scope: HistoryScope): readonly string[];
  search(query: string, scope: HistoryScope, limit?: number): readonly HistoryMatch[];
}

/** The two methods of `Frecency` the popup needs: reading an order, writing a pick. */
export interface MentionMemory extends FrecencyLike {
  /** This path was just chosen, so it floats next time. */
  record(path: string): void;
}

/**
 * Where `@` looks, and what it remembers.
 *
 * The composer neither lists a directory nor opens a file. It is handed one of
 * these per working directory, asks it for the paths once, and tells it which
 * one was picked; everything behind the two methods — git, a walk, a file of
 * counts — is `fileIndex.ts`'s business, and a test hands over an array and a
 * `record` that does nothing.
 */
export interface FileIndex {
  /** The paths under the working directory, relative to it, forward slashes. */
  list(): Promise<readonly string[]>;
  /** What settles a near-tie, and where an accepted path is written down. */
  readonly frecency: MentionMemory;
}

/** An `@` that starts a token: at the very start of the text, or after whitespace. */
const MENTION_TOKEN = /(?:^|\s)@(\S+)/gu;

/**
 * The `@paths` in `text` that the listing knows, in the order they appear and
 * once each.
 *
 * Filtering against the listing is the point rather than a nicety: it is what
 * keeps an address, an `@media` and half a typed path as the words they are.
 */
function mentionsIn(text: string, known: ReadonlySet<string>): readonly string[] {
  if (known.size === 0) return [];
  const found: string[] = [];
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const path = match[1];
    if (path !== undefined && known.has(path) && !found.includes(path)) found.push(path);
  }
  return found;
}

/**
 * `replaceAll`, with the cursor left somewhere other than the end.
 *
 * A path completed in the middle of a sentence wants the cursor just past the
 * space it added, not past the rest of the line. `editor.ts` keeps its cursor
 * moves private and its whole-text replacement ends at the end, so the walk
 * back is made of its own `left`: no second undo entry, and no chance of
 * landing inside a surrogate pair.
 */
function replaceLeavingCursor(state: EditorState, text: string, cursor: number): EditorState {
  let next = replaceAll(state, text);
  while (next.cursor > cursor) {
    const back = left(next);
    if (back.cursor === next.cursor) break;
    next = back;
  }
  return next;
}

/** What the app can do to the box from outside a keystroke. */
export interface ComposerHandle {
  /** Replace the text, undoably, with the cursor at its end. */
  setText(text: string): void;
  /** What is in the box right now. */
  getText(): string;
  /** True while the composer owns Esc — its reverse search is open. */
  isCapturing(): boolean;
}

/**
 * A walk through the history, alive for exactly as long as the text it put in
 * the box is still the text in the box.
 */
interface Walk {
  /** What this walk last wrote. Any other buffer means someone has edited. */
  readonly text: string;
  readonly cursor: HistoryCursor;
  /** How many entries there are to walk, for the hint. */
  readonly total: number;
  /** `-1` is the draft, `0` the newest entry — the cursor's own numbering. */
  readonly position: number;
}

/** An open reverse search: the query, where it is looking, what it displaced. */
interface Search {
  readonly query: string;
  /** Into the scopes the composer was given; Ctrl+S moves it on. */
  readonly scopeIndex: number;
  /** The buffer as it was when the search opened, so Esc is lossless. */
  readonly draft: EditorState;
  readonly matches: readonly HistoryMatch[];
  /** Which match is showing; Ctrl+R steps it towards the older ones. */
  readonly at: number;
}

export interface ComposerProps {
  /**
   * What was typed, and the `@paths` in it that name a real file — in order,
   * once each. The text keeps the mentions; the second argument is what the
   * app turns into attachments.
   */
  readonly onSubmit: (text: string, mentions: readonly string[]) => void;
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
  /**
   * ↑ on the first line, ↓ on the last, once the history has had its say:
   * the app's to do something with.
   */
  readonly onArrowOverflow?: (direction: 'up' | 'down') => void;
  /** What `@` completes against. Without it `@` is an ordinary character. */
  readonly fileIndex?: FileIndex;
  /** What ↑ and Ctrl+R read. Without it neither key does anything new. */
  readonly history?: HistoryLookup;
  /** The slices ↑ prefers and Ctrl+S cycles, best first. */
  readonly historyScopes?: readonly HistoryScope[];
  /**
   * ↑ on an empty box asks for the newest queued message back. The words, or
   * nothing at all when there is no queue — which means "carry on".
   */
  readonly onTakeBackQueued?: () => string | undefined;
  /** React 19 passes this through as a prop; see {@link ComposerHandle}. */
  readonly ref?: React.Ref<ComposerHandle>;
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
  fileIndex,
  history,
  historyScopes = DEFAULT_SCOPES,
  onTakeBackQueued,
  ref,
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
  const typingCommand = value.startsWith('/') && !/\s/u.test(value);
  const menu = typingCommand ? matchCommands(value, providerCommands) : [];
  const selected =
    menu.length === 0
      ? null
      : picked !== null && picked.text === value
        ? Math.max(0, Math.min(picked.index, menu.length - 1))
        : 0;
  const highlighted = selected === null ? undefined : menu[selected];

  /*
   * A walk, and the walk that is still live. Remembered against the text it
   * wrote for the same reason `picked` is: an edit must end it, and noticing
   * that here is one line, where clearing it in every branch that touches the
   * buffer is twenty and one of them would be forgotten.
   */
  const [walk, setWalk] = useState<Walk | null>(null);
  const walking = walk !== null && walk.text === value ? walk : null;

  const [search, setSearch] = useState<Search | null>(null);

  /*
   * `@`, and the files it could mean.
   *
   * The listing is asked for once per index — the identity of the object is
   * the directory it lists — and only once the text has an `@` in it at all.
   * That trigger is the cheapest honest one: it catches a pasted message as
   * well as a typed `@`, and it costs nothing at all for the messages that
   * name no file, which is most of them. A listing that fails is an empty one,
   * because a completion is not worth an error in front of a prompt.
   */
  const [listed, setListed] = useState<{ readonly index: FileIndex; readonly paths: readonly string[] } | null>(null);
  const requested = useRef<FileIndex | null>(null);
  const couldName = fileIndex !== undefined && value.includes('@');
  useEffect(() => {
    if (fileIndex === undefined || !couldName || requested.current === fileIndex) return;
    requested.current = fileIndex;
    void fileIndex.list().then(
      (found) => {
        setListed({ index: fileIndex, paths: found });
      },
      () => {
        setListed({ index: fileIndex, paths: [] });
      },
    );
  }, [fileIndex, couldName]);
  // Compared rather than cleared: a new directory arrives as a new index, and
  // the last one's paths must not answer for it, even for a frame.
  const paths = listed !== null && listed.index === fileIndex ? listed.paths : null;

  /*
   * The slash menu wins. The only word the two could both claim is one that
   * begins with a slash and has an `@` in it, and that word is someone typing
   * a command. A reverse search owns the whole keyboard, this included.
   */
  const mention = fileIndex === undefined || typingCommand || search !== null ? null : mentionAt(value, buffer.cursor);
  const query = mention === null ? null : mention.query;
  const suggestions = useMemo<readonly FileMatch[]>(() => {
    if (fileIndex === undefined || query === null || paths === null) return [];
    return fuzzyMatch(query, paths, { limit: MENTION_ROWS, frecency: fileIndex.frecency });
  }, [fileIndex, query, paths]);
  /*
   * The highlighted path, on the same terms as `picked`: remembered against
   * the token it was chosen over, so any edit — which is a new query and a new
   * list — falls back to the first row rather than pointing somewhere else.
   */
  const [pickedPath, setPickedPath] = useState<{ readonly token: string; readonly index: number } | null>(null);
  const token = mention === null ? '' : `${String(mention.start)} ${mention.query}`;
  const mentionSelected =
    suggestions.length === 0
      ? null
      : pickedPath !== null && pickedPath.token === token
        ? Math.max(0, Math.min(pickedPath.index, suggestions.length - 1))
        : 0;
  const mentionChoice = mentionSelected === null ? undefined : suggestions[mentionSelected];
  /** What is in the box that will travel as a file: the row under it says so too. */
  const known = useMemo(() => new Set(paths ?? []), [paths]);
  const mentions = useMemo(() => mentionsIn(value, known), [value, known]);

  /*
   * Read by the app, on the same keystroke the composer is answering, so it
   * cannot be state: state is a render away. It is raised as the search opens
   * and lowered only after the render that closed it, which is what keeps the
   * Esc that closed a search from also interrupting the turn.
   */
  const capturing = useRef(false);
  useEffect(() => {
    capturing.current = isActive && search !== null;
  }, [isActive, search]);

  // Focus moving away ends a search rather than leaving a row on screen that
  // no key can reach: the composer stops answering keys entirely when it is
  // not the focus.
  useEffect(() => {
    if (isActive || search === null) return;
    setBuffer(search.draft);
    setSearch(null);
  }, [isActive, search]);

  useImperativeHandle(
    ref,
    () => ({
      setText: (text: string) => {
        setBuffer((current) => replaceAll(current, text));
      },
      getText: () => buffer.text,
      isCapturing: () => capturing.current,
    }),
    [buffer],
  );

  /**
   * Write the chosen path over the token under the cursor, and remember that
   * it was chosen. `fileIndex.ts` decides what the text and the cursor become;
   * the space it leaves after the path is why the next word can just be typed.
   */
  const acceptMention = (path: string): void => {
    if (mention === null) return;
    const written = replaceMention(value, mention.start, mention.end, `@${path}`);
    setBuffer((current) => replaceLeavingCursor(current, written.text, written.cursor));
    fileIndex?.frecency.record(path);
    setPickedPath(null);
  };

  /** Put `text` in the box, undoably, and hand back the buffer that makes. */
  const put = (text: string): EditorState => {
    const next = replaceAll(buffer, text);
    setBuffer(next);
    return next;
  };

  /** The best scope that has anything in it: this folder, then everything. */
  const recentTexts = (): readonly string[] => {
    if (history === undefined) return [];
    for (const scope of historyScopes) {
      const texts = history.recent(scope);
      if (texts.length > 0) return texts;
    }
    return [];
  };

  /**
   * ↑ that the text had no line left for. True when it was spent here, which
   * is what stops the app scrolling the conversation on the same press.
   */
  const recallOlder = (): boolean => {
    if (walking !== null) {
      const next = put(walking.cursor.up());
      setWalk({ ...walking, text: next.text, position: Math.min(walking.position + 1, walking.total - 1) });
      return true;
    }
    if (value.length === 0) {
      // Empty box first, and only empty: with anything typed, ↑ is history,
      // so the two never compete for the same press.
      const back = onTakeBackQueued?.();
      if (back !== undefined) {
        put(back);
        return true;
      }
    }
    const texts = recentTexts();
    if (texts.length === 0) return false;
    // Whatever is typed becomes the draft, which is what walking back down
    // past the newest entry returns to.
    const cursor = new HistoryCursor(texts, value);
    const next = put(cursor.up());
    setWalk({ text: next.text, cursor, total: texts.length, position: 0 });
    return true;
  };

  /** ↓ likewise, and only a walk in progress has anything to do with it. */
  const recallNewer = (): boolean => {
    if (walking === null) return false;
    const next = put(walking.cursor.down());
    setWalk({ ...walking, text: next.text, position: Math.max(walking.position - 1, -1) });
    return true;
  };

  /**
   * Run a query and show what it found — which is every key the search row
   * answers, since opening, typing, rubbing out, stepping older and changing
   * scope all come down to "look again, then put the match in the box".
   */
  const searchFor = (query: string, scopeIndex: number, wanted: number, draft: EditorState): void => {
    const count = historyScopes.length;
    const index = count === 0 ? 0 : ((scopeIndex % count) + count) % count;
    const scope = historyScopes[index] ?? ALL_SCOPE;
    const matches = history === undefined ? [] : history.search(query, scope);
    const at = matches.length === 0 ? 0 : Math.min(Math.max(wanted, 0), matches.length - 1);
    setSearch({ query, scopeIndex: index, draft, matches, at });
    const match = matches[at];
    // A query that matches nothing leaves the last good match on screen, as
    // bash does: the row says `no match`, and nothing that was found is lost.
    if (match !== undefined) put(match.text);
  };

  useInput(
    (input, key) => {
      /*
       * An open reverse search has the keyboard, ahead of everything — the
       * newline keys included, because inside a search every one of them
       * means something else.
       */
      if (search !== null) {
        if (key.escape) {
          setBuffer(search.draft);
          setSearch(null);
          return;
        }
        if (key.return) {
          /*
           * What the box is showing is what goes. That is the whole promise of
           * putting the match in the box rather than beside it, and it is also
           * the honest answer when the last keystroke matched nothing: the
           * words on screen are the words sent.
           */
          setSearch(null);
          if (value.trim().length === 0) {
            setBuffer(search.draft);
            return;
          }
          onSubmit(value, mentions);
          setBuffer(clear);
          return;
        }
        if (key.tab || key.rightArrow) {
          // Accept and stay. The match is already the buffer, so closing the
          // row is all there is to do, and the cursor is at its end.
          setSearch(null);
          return;
        }
        if (key.ctrl && input === 'r') {
          searchFor(search.query, search.scopeIndex, search.at + 1, search.draft);
          return;
        }
        if (key.ctrl && input === 's') {
          searchFor(search.query, search.scopeIndex + 1, 0, search.draft);
          return;
        }
        if (key.backspace || key.delete) {
          // Rubbing out the last of the query is a cancel, because a search
          // with nothing in it is not a search.
          if (search.query.length === 0) {
            setBuffer(search.draft);
            setSearch(null);
            return;
          }
          searchFor(search.query.slice(0, -1), search.scopeIndex, 0, search.draft);
          return;
        }
        if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow) return;
        if (input.length === 0 || input === '\n') return;
        // A pasted query is still a query; its line breaks would be a row the
        // search cannot draw, so they become spaces.
        searchFor(search.query + input.replace(/[\r\n]+/gu, ' '), search.scopeIndex, 0, search.draft);
        return;
      }
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
        /*
         * The file popup takes Enter before anything else can: what it means
         * there is "that one", and the message goes on the Enter after. A
         * popup that sent instead would attach a file and end the sentence in
         * the same keystroke, which is not what anyone meant by picking a row.
         */
        if (mentionChoice !== undefined) {
          acceptMention(mentionChoice.path);
          return;
        }
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
          onSubmit(commandWord(highlighted.usage), []);
          setBuffer(clear);
          return;
        }
        if (value.trim().length === 0 && attachments.length === 0) return;
        onSubmit(value, mentions);
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
        if (mentionSelected !== null) {
          // The file popup walks for the same reason the menu does, and wraps
          // for the same reason the picker does.
          const step = key.upArrow ? -1 : 1;
          setPickedPath({ token, index: (mentionSelected + step + suggestions.length) % suggestions.length });
          return;
        }
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
        /*
         * Off the end of the text, the press is offered to the history and
         * only then to the app: ↑ means "what did I type" far more often than
         * it means "scroll one line", and a recalled prompt is a keystroke
         * that scrolling would have thrown away. Shift or Ctrl with an arrow
         * still moves the conversation half a screen, from anywhere.
         */
        if (key.upArrow) {
          if (!onFirstLine(buffer)) {
            setBuffer(up);
            return;
          }
          if (recallOlder()) return;
          onArrowOverflow?.('up');
          return;
        }
        if (!onLastLine(buffer)) {
          setBuffer(down);
          return;
        }
        if (recallNewer()) return;
        onArrowOverflow?.('down');
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
          case 'r':
            // Reverse search, over the buffer that is there — which Esc will
            // put back exactly as it is now, undo stack and all.
            if (history !== undefined) searchFor('', 0, 0, buffer);
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
        // The path the popup is on, written over the token it was typed into.
        if (mentionChoice !== undefined) {
          acceptMention(mentionChoice.path);
          return;
        }
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
  /** Everything one row under the box promises: what was attached, and what was named. */
  const carried = [...attachments, ...mentions];
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
      {/*
       * One line under the box for whatever the arrows are doing: the search
       * and its keys while it is open, where a walk has got to while one is
       * running, and otherwise the newline hint that was always here. They are
       * never wanted at once — the search *is* the arrows' owner while it is
       * open — so they share the row rather than stacking up under the box.
       */}
      {search !== null ? (
        <>
          <Text dimColor>
            {`  reverse-i-search [${historyScopes[search.scopeIndex]?.kind ?? ALL_SCOPE.kind}]: ${search.query}`}
            {search.matches.length === 0
              ? ' · no match'
              : ` · ${String(search.at + 1)}/${String(search.matches.length)}`}
          </Text>
          <Text dimColor>
            {'  '}
            {SEARCH_HINT}
          </Text>
        </>
      ) : (
        <>
          {walking !== null && walking.position >= 0 && (
            <Text dimColor>
              {`  history ${String(walking.position + 1)}/${String(walking.total)} · ↓ back to draft`}
            </Text>
          )}
          {(rows.length > 1 || row > 0) && (
            <Text dimColor>
              {'  '}
              {NEWLINE_HINT}
            </Text>
          )}
        </>
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
      {/*
       * The files `@` could mean. `loading…` and `no match` are rows of their
       * own rather than a list with one apologetic entry in it, because
       * neither is something Tab should be able to insert.
       */}
      {mention !== null &&
        (paths === null ? (
          <Text dimColor>{'  loading…'}</Text>
        ) : suggestions.length === 0 ? (
          <Text dimColor>{'  no match'}</Text>
        ) : (
          <Completions
            items={suggestions.map((match) => ({ key: match.path, label: match.path, indices: match.indices }))}
            selected={mentionSelected}
            maxRows={MENTION_ROWS}
            hint={MENTION_HINT}
          />
        ))}
      {carried.length > 0 && (
        <Text dimColor>
          {'  ⎘ '}
          {carried.join(', ')} · goes with the next message
          {attachments.length > 0 ? ' · /attach clear' : ''}
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
